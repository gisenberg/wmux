import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CodexTaskLaunch, CodexTaskTarget } from "../shared/codex-tasks.js";
import { hasPrivatePermissions } from "./private-permissions.js";

export const CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION = 1;
export const MAX_CODEX_TASK_LAUNCHES = 200;
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const text = (max: number) => z.string().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const targetSchema = z.object({ workspaceId: text(120), tabId: text(120), paneId: text(120) }).strict();
const requestSchema = z.object({
  requestId: z.string().uuid(),
  endpointId: text(256),
  endpointIdentity: text(1_024).optional(),
  cwd: text(4_096).refine((value) => value.startsWith("/"), "cwd must be absolute"),
}).strict();
const launchSchema = requestSchema.extend({
  status: z.enum(["opening", "opened", "unknown", "failed"]),
  target: targetSchema.nullable(),
  reason: z.string().max(512).nullable(),
  createdAt: z.string().datetime(),
}).strict();
const envelopeSchema = z.object({
  schemaVersion: z.literal(CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION),
  launches: z.array(launchSchema).max(MAX_CODEX_TASK_LAUNCHES),
}).strict();
type StoredLaunch = z.infer<typeof launchSchema>;
type Envelope = z.infer<typeof envelopeSchema>;

export class UnsupportedCodexTaskLaunchVersionError extends Error {
  constructor(readonly version: number) {
    super(`Codex task launch schema ${version} is newer than this wmux build supports (${CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION})`);
    this.name = "UnsupportedCodexTaskLaunchVersionError";
  }
}

export class CodexTaskLaunchConflictError extends Error {
  readonly statusCode = 409;
  constructor() { super("Codex task launch request id is already bound to different input"); this.name = "CodexTaskLaunchConflictError"; }
}

export interface CodexTaskLaunchesOptions {
  filePath?: string;
  open: (endpointId: string, cwd: string, requestId: string) => Promise<CodexTaskTarget>;
}

/** Idempotency ledger for launching a fresh visible Codex view. It never resumes a task. */
export class CodexTaskLaunches {
  private launches: StoredLaunch[] = [];
  private readonly inFlight = new Map<string, Promise<CodexTaskLaunch>>();
  private readonly filePath?: string;

  constructor(private readonly options: CodexTaskLaunchesOptions) {
    this.filePath = options.filePath;
    if (this.filePath) {
      this.ensureSecureParent();
      const loaded = this.load();
      const recovered = loaded.map((item) => item.status === "opening"
        ? { ...item, status: "unknown" as const, reason: "launch_outcome_unknown" }
        : item);
      this.commit(recovered);
    }
  }

  get(requestId: string): CodexTaskLaunch | undefined {
    const id = z.string().uuid().parse(requestId);
    const launch = this.launches.find((item) => item.requestId === id);
    return launch ? structuredClone(launch) : undefined;
  }

  list(): CodexTaskLaunch[] {
    return structuredClone(this.launches);
  }

  launch(input: { requestId: string; endpointId: string; endpointIdentity?: string; cwd: string }): Promise<CodexTaskLaunch> {
    const request = requestSchema.parse(input);
    const existing = this.launches.find((item) => item.requestId === request.requestId);
    if (existing) {
      if (
        existing.endpointId !== request.endpointId
        || existing.cwd !== request.cwd
        || (existing.endpointIdentity !== undefined && request.endpointIdentity !== undefined && existing.endpointIdentity !== request.endpointIdentity)
      ) throw new CodexTaskLaunchConflictError();
      return this.inFlight.get(request.requestId) ?? Promise.resolve(structuredClone(existing));
    }
    if (this.launches.length >= MAX_CODEX_TASK_LAUNCHES) throw new Error(`Codex task launch limit (${MAX_CODEX_TASK_LAUNCHES}) reached`);
    const opening: StoredLaunch = { ...request, status: "opening", target: null, reason: null, createdAt: new Date().toISOString() };
    // Persist intent before any side effect. A write failure therefore cannot launch a view.
    this.commit([...this.launches, opening]);
    const running = this.open(opening);
    this.inFlight.set(request.requestId, running);
    void running.then(
      () => this.inFlight.delete(request.requestId),
      () => this.inFlight.delete(request.requestId),
    );
    return running;
  }

  private async open(opening: StoredLaunch): Promise<CodexTaskLaunch> {
    try {
      const target = targetSchema.parse(await this.options.open(opening.endpointId, opening.cwd, opening.requestId));
      return this.replace({ ...opening, status: "opened", target, reason: null });
    } catch {
      // The child can have created a native view before a transport failure.
      // Do not retry it or infer a native task identity.
      return this.replace({ ...opening, status: "unknown", target: null, reason: "launch_outcome_unknown" });
    }
  }

  private replace(next: StoredLaunch): CodexTaskLaunch {
    const index = this.launches.findIndex((item) => item.requestId === next.requestId);
    if (index < 0) throw new Error("Codex task launch disappeared");
    const launches = [...this.launches];
    launches[index] = next;
    this.commit(launches);
    return structuredClone(next);
  }

  private load(): StoredLaunch[] {
    if (!this.filePath || !fs.existsSync(this.filePath)) return [];
    this.assertSecureFile(this.filePath);
    try {
      if (fs.statSync(this.filePath).size > MAX_LEDGER_BYTES) throw new Error("ledger is too large");
      const input = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      const version = input && typeof input === "object" && !Array.isArray(input) ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
      if (typeof version === "number" && Number.isInteger(version) && version > CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION) throw new UnsupportedCodexTaskLaunchVersionError(version);
      return envelopeSchema.parse(input).launches;
    } catch (error) {
      if (error instanceof UnsupportedCodexTaskLaunchVersionError) throw error;
      throw new Error(`wmux Codex task launch ledger is invalid: ${this.filePath}`);
    }
  }

  private commit(launches: StoredLaunch[]): void {
    const envelope = envelopeSchema.parse({ schemaVersion: CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION, launches });
    this.persist(envelope);
    this.launches = structuredClone(envelope.launches);
  }

  private persist(envelope: Envelope): void {
    if (!this.filePath) return;
    this.ensureSecureParent();
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(handle, `${JSON.stringify(envelope, null, 2)}\n`); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.chmodSync(temporary, 0o600);
      if (fs.existsSync(this.filePath)) {
        this.assertSecureFile(this.filePath);
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
        fs.chmodSync(`${this.filePath}.bak`, 0o600);
      }
      fs.renameSync(temporary, this.filePath);
    } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  }

  private ensureSecureParent(): void {
    if (!this.filePath) return;
    const parentPath = path.dirname(path.resolve(this.filePath));
    if (!fs.existsSync(parentPath)) fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(parentPath) !== parentPath) throw new Error("Codex task launch parent directory must not use symlinks");
    if (typeof process.getuid === "function" && parent.uid !== process.getuid()) throw new Error("Codex task launch parent directory must be owned by the wmux user");
    if (!hasPrivatePermissions(parentPath, parent, true)) throw new Error("Codex task launch parent directory must be owner-only");
  }

  private assertSecureFile(filePath: string): void {
    const file = fs.lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink() || fs.realpathSync(filePath) !== path.resolve(filePath)) throw new Error("Codex task launch ledger must be a regular non-symlink file");
    if (typeof process.getuid === "function" && file.uid !== process.getuid()) throw new Error("Codex task launch ledger must be owned by the wmux user");
    if (!hasPrivatePermissions(filePath, file)) throw new Error("Codex task launch ledger permissions must be 0600");
  }
}
