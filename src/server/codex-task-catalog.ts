import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { CodexTask, CodexTaskDetail, CodexTaskEndpoint, CodexTaskPage, CodexTaskTurn } from "../shared/codex-tasks.js";
import type { MachineConfig } from "./types.js";
import { queryCodexCatalog } from "./codex-catalog-rpc.js";
import { attestCodexAttachment, type AttachmentAttestation } from "./codex-attachment-route.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const absolute = z.string().min(1).max(4096).refine(value => value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value));
const managedLaunchSchema = z.object({
  // These are absolute installation paths supplied by the private
  // catalog.  They are never returned by the browser endpoint.
  launcherPath: absolute,
  deploymentPath: absolute,
}).strict();
const endpointSchema = z.object({
  id, label: z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/), machineId: id,
  transport: z.enum(["local", "ssh"]), socketPath: absolute,
  bridgePath: absolute.optional(), nodePath: absolute.optional(),
  allowFreshLaunch: z.boolean().optional(),
  managedLaunch: managedLaunchSchema.optional(),
}).strict();
export type CodexCatalogEndpointConfig = z.infer<typeof endpointSchema>;
export type CodexManagedLaunchConfig = z.infer<typeof managedLaunchSchema>;
type Query = Parameters<typeof queryCodexCatalog>[0];
export class CodexCatalogError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}

export function loadCodexCatalogConfig(file = process.env.WMUX_CODEX_CATALOG_CONFIG): CodexCatalogEndpointConfig[] {
  if (!file) return [];
  if (!path.isAbsolute(file)) throw new Error("Codex catalog config requires an absolute private file path");
  const stat = fs.lstatSync(file);
  const parent = fs.lstatSync(path.dirname(file));
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.normalize(file)
    || !parent.isDirectory() || parent.isSymbolicLink()
    || stat.size > 64 * 1024 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)
      || parent.uid !== process.getuid() || (parent.mode & 0o077)))) {
    throw new Error("Codex catalog config must be a private owned regular file");
  }
  const result = z.object({ schemaVersion: z.literal(1), endpoints: z.array(endpointSchema).max(8) }).strict()
    .parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (new Set(result.endpoints.map(e => e.id)).size !== result.endpoints.length) throw new Error("Duplicate Codex catalog endpoint id");
  return result.endpoints;
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const text = (value: unknown, max = 4096): string => typeof value === "string" ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, max) : "";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identityFor = (config: CodexCatalogEndpointConfig, machine: MachineConfig): string => createHash("sha256")
  .update(JSON.stringify([config, machine.id, machine.kind, machine.host, machine.user, machine.port, machine.source])).digest("hex");

async function remoteQuery(config: CodexCatalogEndpointConfig, machine: MachineConfig, input: Query): Promise<unknown> {
  if (!config.bridgePath || !config.nodePath || machine.kind !== "ssh" || !machine.host || machine.source === "registered") {
    throw new CodexCatalogError("remote_bridge_unconfigured");
  }
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=yes"];
  if (machine.port) args.push("-p", String(machine.port));
  args.push("--", machine.user ? `${machine.user}@${machine.host}` : machine.host,
    `${quote(config.nodePath)} ${quote(config.bridgePath)}`);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let bytes = 0, done = false;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, result?: unknown): void => {
      if (done) return; done = true; clearTimeout(timer); child.kill();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new CodexCatalogError("endpoint_timeout")), 8_000);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024) finish(new CodexCatalogError("endpoint_response_limit"));
      else chunks.push(data);
    });
    child.stderr.resume();
    child.on("error", () => finish(new CodexCatalogError("endpoint_unavailable")));
    child.stdin.on("error", () => finish(new CodexCatalogError("endpoint_unavailable")));
    child.on("close", code => {
      if (done) return;
      try {
        const result = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (code !== 0 || result.ok !== true || !("result" in result)) throw new Error();
        finish(undefined, result.result);
      } catch { finish(new CodexCatalogError("endpoint_unavailable")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export class CodexTaskCatalog {
  private readonly configs = new Map<string, CodexCatalogEndpointConfig>();
  private readonly endpoints = new Map<string, CodexTaskEndpoint>();
  private readonly taskCache = new Map<string, CodexTask>();
  private readonly pageCache = new Map<string, CodexTaskPage>();
  private readonly cooldown = new Map<string, number>();
  private readonly readingTasks = new Set<string>();
  private inflight = 0;
  constructor(private readonly machines: () => MachineConfig[], configs = loadCodexCatalogConfig(),
    private readonly localQuery: typeof queryCodexCatalog = queryCodexCatalog) {
    for (const input of configs) {
      const config = endpointSchema.parse(input);
      const machine = machines().find(m => m.id === config.machineId);
      if (!machine || (config.transport === "local" ? machine.kind !== "local" : machine.kind !== "ssh")
        || machine.source === "registered") throw new Error("Codex catalog endpoint requires a configured matching static host");
      if (this.configs.has(config.id)) throw new Error("Duplicate Codex catalog endpoint id");
      this.configs.set(config.id, config);
      this.endpoints.set(config.id, { id: config.id, label: config.label, machineId: config.machineId,
        transport: config.transport, identity: identityFor(config, machine), status: "unknown", reason: null,
        sampledAt: null, freshLaunch: config.allowFreshLaunch === true,
        launchReason: config.allowFreshLaunch === true ? null : "Fresh CLI views are not enabled for this endpoint." });
    }
  }
  listEndpoints(): CodexTaskEndpoint[] { return structuredClone([...this.endpoints.values()]); }
  disableFreshLaunch(reason: string): void {
    for (const endpoint of this.endpoints.values()) {
      endpoint.freshLaunch = false;
      endpoint.launchReason = reason;
    }
  }
  launchConfig(endpointId: string): CodexCatalogEndpointConfig {
    const endpoint = this.endpoint(endpointId);
    const config = this.configs.get(endpointId)!;
    if (!config.allowFreshLaunch || !endpoint.freshLaunch) throw new CodexCatalogError("fresh_launch_disabled", 409);
    return structuredClone(config);
  }
  /** Private launch material for exact-existing-task attachment.  Callers must
   * attest it immediately before spawning; it is never browser metadata. */
  attachmentConfig(endpointId: string): CodexCatalogEndpointConfig {
    this.endpoint(endpointId);
    const config = this.configs.get(endpointId)!;
    if (config.transport !== "local") throw new CodexCatalogError("attachment_ssh_unsupported", 409);
    if (!config.managedLaunch) throw new CodexCatalogError("attachment_unconfigured", 409);
    return structuredClone(config);
  }
  /** Private preflight for an exact existing-task launch.  This is read-only
   * and intentionally does not resume or otherwise load a thread. */
  async attestAttachment(endpointId: string, threadId: string): Promise<AttachmentAttestation> {
    const config = this.attachmentConfig(endpointId);
    return attestCodexAttachment({ endpoint: config, endpoints: [...this.configs.values()], threadId,
      probe: value => this.localQuery({ ...value, operation: "attachment" }),
      loadedProbe: endpoint => this.query(endpoint.id, { operation: "loaded" }) });
  }
  identity(endpointId: string): string | null {
    const config = this.configs.get(endpointId), endpoint = this.endpoints.get(endpointId);
    const machine = config && this.machines().find(m => m.id === config.machineId);
    return config && endpoint && machine && identityFor(config, machine) === endpoint.identity ? endpoint.identity : null;
  }
  private endpoint(endpointId: string): CodexTaskEndpoint {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) throw new CodexCatalogError("endpoint_not_found", 404);
    if (!this.identity(endpointId)) throw new CodexCatalogError("endpoint_identity_changed", 409);
    return endpoint;
  }
  private async query(endpointId: string, input: Omit<Query, "socketPath">): Promise<unknown> {
    const endpoint = this.endpoint(endpointId), config = this.configs.get(endpointId)!;
    if (this.inflight >= 4) throw new CodexCatalogError("catalog_busy", 429);
    if ((this.cooldown.get(endpointId) ?? 0) > Date.now()) throw new CodexCatalogError("endpoint_backing_off");
    const machine = this.machines().find(m => m.id === config.machineId)!;
    this.inflight++;
    try {
      const params = { ...input, socketPath: config.socketPath };
      const result = await (config.transport === "local" ? this.localQuery(params) : remoteQuery(config, machine, params));
      if (!this.identity(endpointId)) throw new CodexCatalogError("endpoint_identity_changed", 409);
      endpoint.status = "available"; endpoint.reason = null; endpoint.sampledAt = new Date().toISOString();
      this.cooldown.delete(endpointId);
      return result;
    } catch (error) {
      const unsupported = object(error).reason === "unsupported_endpoint";
      if (unsupported && input.operation === "turns") throw new CodexCatalogError("turn_history_unsupported");
      endpoint.status = "unavailable";
      endpoint.reason = error instanceof CodexCatalogError ? error.code : unsupported ? "unsupported_endpoint" : "endpoint_unavailable";
      this.cooldown.set(endpointId, Date.now() + 5_000);
      throw error instanceof CodexCatalogError ? error : new CodexCatalogError(endpoint.reason);
    } finally { this.inflight--; }
  }
  private cacheTask(task: CodexTask): void {
    const key = `${task.endpointId}/${task.threadId}`;
    this.taskCache.delete(key); this.taskCache.set(key, structuredClone(task));
    while (this.taskCache.size > 200) this.taskCache.delete(this.taskCache.keys().next().value!);
  }
  private task(endpointId: string, value: unknown, expected?: string, cache = true): CodexTask {
    const raw = object(value), endpoint = this.endpoint(endpointId);
    if (!id.safeParse(raw.id).success || (expected && raw.id !== expected)) throw new CodexCatalogError("native_identity_mismatch");
    const status = object(raw.status).type;
    const source = typeof raw.source === "string" ? raw.source : Object.keys(object(raw.source))[0];
    const result: CodexTask = {
      endpointId, endpointIdentity: endpoint.identity, threadId: raw.id as string,
      name: text(raw.name, 2048) || null, preview: text(raw.preview, 512), cwd: text(raw.cwd) || null,
      modelProvider: text(raw.modelProvider, 100) || null, source: text(source, 100) || "unknown",
      parentThreadId: id.safeParse(raw.parentThreadId).success ? raw.parentThreadId as string : null,
      status: status === "active" || status === "idle" || status === "notLoaded" ? status : "unknown",
      // Native Thread timestamps use Unix seconds; browser Date expects ms.
      updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0 && raw.updatedAt < 8.64e12
        ? raw.updatedAt * 1000 : null,
      sampledAt: new Date().toISOString(), stale: false, latestTurn: null,
    };
    if (cache) this.cacheTask(result);
    return result;
  }
  async list(endpointId: string, cursor: string | null = null, archived = false): Promise<CodexTaskPage> {
    this.endpoint(endpointId);
    if (cursor !== null && (typeof cursor !== "string" || cursor.length > 4096)) throw new CodexCatalogError("invalid_cursor", 400);
    const key = JSON.stringify([endpointId, cursor, archived]);
    try {
      const response = object(await this.query(endpointId, { operation: "list", cursor, archived }));
      if (!Array.isArray(response.data) || response.data.length > 40) throw new CodexCatalogError("invalid_native_page");
      const nextCursor = response.nextCursor;
      if (nextCursor != null && (typeof nextCursor !== "string" || nextCursor.length > 4096)) throw new CodexCatalogError("invalid_native_cursor");
      // Do not let a valid prefix of a malformed page become stale fallback
      // metadata. Cache only after every row and the cursor have validated.
      const tasks = response.data.map(t => this.task(endpointId, t, undefined, false));
      for (const task of tasks) this.cacheTask(task);
      const page = { endpoint: structuredClone(this.endpoint(endpointId)), tasks, nextCursor: nextCursor as string | null ?? null };
      this.pageCache.set(key, structuredClone(page));
      while (this.pageCache.size > 16) this.pageCache.delete(this.pageCache.keys().next().value!);
      return page;
    } catch (error) {
      if (error instanceof CodexCatalogError && ["native_identity_mismatch", "endpoint_identity_changed"].includes(error.code)) throw error;
      const endpoint = this.endpoints.get(endpointId)!;
      endpoint.status = "unavailable";
      endpoint.reason = error instanceof CodexCatalogError ? error.code : "invalid_native_page";
      const cached = this.pageCache.get(key);
      if (!cached || !this.identity(endpointId)) throw error;
      return { ...structuredClone(cached), endpoint: structuredClone(this.endpoint(endpointId)),
        tasks: cached.tasks.map(task => ({ ...structuredClone(task), stale: true, status: "unavailable" })) };
    }
  }
  async read(endpointId: string, threadId: string, history = false): Promise<CodexTaskDetail> {
    this.endpoint(endpointId);
    if (!id.safeParse(threadId).success) throw new CodexCatalogError("invalid_thread_id", 400);
    const key = `${endpointId}/${threadId}`;
    if (this.readingTasks.has(key)) throw new CodexCatalogError("catalog_busy", 429);
    this.readingTasks.add(key);
    try { return await this.readOnce(endpointId, threadId, history); }
    finally { this.readingTasks.delete(key); }
  }
  private async readOnce(endpointId: string, threadId: string, history: boolean): Promise<CodexTaskDetail> {
    let task: CodexTask;
    try { task = this.task(endpointId, object(await this.query(endpointId, { operation: "read", threadId })).thread, threadId); }
    catch (error) {
      if (error instanceof CodexCatalogError && ["native_identity_mismatch", "endpoint_identity_changed"].includes(error.code)) throw error;
      const cached = this.taskCache.get(`${endpointId}/${threadId}`);
      if (!cached || !this.identity(endpointId)) throw error;
      return { task: { ...structuredClone(cached), stale: true, status: "unavailable" }, turns: [], historyReason: "Native endpoint unavailable; showing the last sample.", resume: this.resumeReason() };
    }
    let turns: CodexTaskTurn[] = [], historyReason: string | null = null;
    try {
      const response = object(await this.query(endpointId, { operation: "turns", threadId }));
      if (!Array.isArray(response.data) || response.data.length > 8) throw new Error("invalid turns");
      turns = response.data.map(value => {
        const turn = object(value);
        if (!id.safeParse(turn.id).success) throw new Error("invalid turn id");
        const items = Array.isArray(turn.items) ? turn.items.slice(0, 20) : [];
        const content = items.map(item => {
          const row = object(item);
          if (row.type === "agentMessage") return text(row.text);
          if (row.type === "userMessage" && Array.isArray(row.content)) return row.content.slice(0, 20).map(c => text(object(c).text)).join("\n");
          return "";
        }).filter(Boolean).join("\n");
        return { id: turn.id as string, status: text(turn.status, 40) || "unknown", text: history ? content.slice(0, 4096) : "", truncated: content.length > 4096 || items.length >= 20 };
      });
      if (turns[0]) task.latestTurn = { id: turns[0].id, status: turns[0].status };
    } catch { historyReason = "Turn metadata is unavailable for this endpoint."; }
    this.taskCache.set(`${endpointId}/${threadId}`, structuredClone(task));
    return { task, turns: history ? turns : [], historyReason, resume: this.resumeReason() };
  }
  private resumeReason(): CodexTaskDetail["resume"] {
    return { enabled: false, reason: "This endpoint cannot prove exclusive client ownership. Open the task in its native client; display associations do not authorize resume." };
  }
}
