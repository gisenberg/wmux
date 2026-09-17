import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CodexTaskLaunch, CodexTaskTarget } from "../shared/codex-tasks.js";
import { hasPrivatePermissions } from "./private-permissions.js";

export const CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION = 2;
export const MAX_CODEX_TASK_LAUNCHES = 200;
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const text = (max: number) => z.string().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const targetSchema = z.object({ workspaceId: text(120), tabId: text(120), paneId: text(120) }).strict();
const requestFields = {
  requestId: z.string().uuid(),
  endpointId: text(256),
  endpointIdentity: text(1_024).optional(),
};
const freshRequestSchema = z.object({ ...requestFields, operation: z.literal("fresh").optional(),
  cwd: text(4_096).refine((value) => value.startsWith("/"), "cwd must be absolute"),
}).strict();
const attachRequestSchema = z.object({ ...requestFields, operation: z.literal("attach"),
  endpointIdentity: z.string().regex(/^[0-9a-f]{64}$/), threadId: z.string().uuid(), generation: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const requestSchema = z.union([freshRequestSchema, attachRequestSchema]);
const launchFields = {
  status: z.enum(["opening", "opened", "unknown", "failed"]),
  target: targetSchema.nullable(),
  reason: z.string().max(512).nullable(),
  createdAt: z.string().datetime(),
  acknowledgedAt: z.string().datetime().optional(),
};
const launchSchema = z.union([freshRequestSchema.extend(launchFields).strict(), attachRequestSchema.extend(launchFields).strict()]);
const envelopeSchema = z.object({
  schemaVersion: z.literal(CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION),
  launches: z.array(launchSchema).max(MAX_CODEX_TASK_LAUNCHES),
}).strict();
type StoredLaunch = z.infer<typeof launchSchema>;
type Envelope = z.infer<typeof envelopeSchema>;
export type CodexAttachmentRequest = z.infer<typeof attachRequestSchema>;
export type CodexTaskLaunchRequest = z.infer<typeof requestSchema>;

export class UnsupportedCodexTaskLaunchVersionError extends Error {
  constructor(readonly version: number) {
    super(`Codex task launch schema ${version} is newer than this wmux build supports (${CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION})`);
    this.name = "UnsupportedCodexTaskLaunchVersionError";
  }
}

export class CodexTaskLaunchConflictError extends Error {
  readonly statusCode = 409;
  constructor(message = "Codex task launch request id is already bound to different input") { super(message); this.name = "CodexTaskLaunchConflictError"; }
}

/** The helper observed a concrete wmux display target, but cannot prove the native CLI outcome. */
export class CodexCliViewUncertainError extends Error {
  readonly target: CodexTaskTarget;
  constructor(target: CodexTaskTarget) {
    super("Codex CLI view outcome is uncertain");
    this.name = "CodexCliViewUncertainError";
    this.target = structuredClone(targetSchema.parse(target));
  }
}

export interface CodexTaskLaunchesOptions {
  filePath?: string;
  open: (endpointId: string, cwd: string, requestId: string) => Promise<CodexTaskTarget>;
  openAttached?: (request: CodexAttachmentRequest) => Promise<CodexTaskTarget>;
  verifyAttached?: (request: CodexAttachmentRequest, target: CodexTaskTarget) => Promise<boolean>;
  recoverAttached?: (request: CodexAttachmentRequest) => CodexTaskTarget | null;
}

/** Durable intent precedes delivery; uncertain delivery never creates an automatic retry. */
export class CodexTaskLaunches {
  private launches: StoredLaunch[] = [];
  private readonly inFlight = new Map<string, Promise<CodexTaskLaunch>>();
  private readonly attachmentFlights = new Map<string, Promise<CodexTaskLaunch>>();
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

  acknowledge(requestId: string): CodexTaskLaunch {
    const id = z.string().uuid().parse(requestId);
    const launch = this.launches.find((item) => item.requestId === id);
    if (!launch) throw new Error("Codex task launch was not found");
    if (launch.status !== "unknown") throw new CodexTaskLaunchConflictError("Only an unknown Codex task launch may be acknowledged");
    if (launch.acknowledgedAt) return structuredClone(launch);
    const acknowledgedAt = new Date().toISOString();
    // Concurrent request aliases describe the same uncertain delivery, not extra views.
    this.commit(this.launches.map(item => item.requestId === id || (launch.operation === "attach" && item.operation === "attach"
      && (item.status === "unknown" || item.status === "opened") && item.endpointIdentity === launch.endpointIdentity
      && item.threadId === launch.threadId && item.generation === launch.generation
      && JSON.stringify(item.target) === JSON.stringify(launch.target))
      ? { ...item, status: "unknown" as const, acknowledgedAt } : item));
    return this.get(id)!;
  }

  launch(input: CodexTaskLaunchRequest): Promise<CodexTaskLaunch> {
    const request = requestSchema.parse(input);
    const existing = this.launches.find((item) => item.requestId === request.requestId);
    if (existing) {
      if (
        existing.endpointId !== request.endpointId
        || (existing.operation ?? "fresh") !== (request.operation ?? "fresh")
        || (existing.operation === "attach" && request.operation === "attach"
          ? existing.threadId !== request.threadId || existing.generation !== request.generation
          : (existing as z.infer<typeof freshRequestSchema>).cwd !== (request as z.infer<typeof freshRequestSchema>).cwd)
        || (existing.endpointIdentity !== undefined && request.endpointIdentity !== undefined && existing.endpointIdentity !== request.endpointIdentity)
      ) throw new CodexTaskLaunchConflictError();
      return this.inFlight.get(request.requestId) ?? (existing.operation === "attach" ? this.reconcile(existing) : Promise.resolve(structuredClone(existing)));
    }
    if (this.launches.length >= MAX_CODEX_TASK_LAUNCHES) throw new Error(`Codex task launch limit (${MAX_CODEX_TASK_LAUNCHES}) reached`);
    const opening: StoredLaunch = { ...request, status: "opening", target: null, reason: null, createdAt: new Date().toISOString() };
    // Persist intent before any side effect. A write failure therefore cannot launch a view.
    this.commit([...this.launches, opening]);
    const key = request.operation === "attach" ? JSON.stringify([request.endpointIdentity, request.generation, request.threadId]) : null;
    const prior = key ? this.attachmentFlights.get(key) : undefined;
    const running = prior
      ? prior.then(result => this.replace({ ...opening, status: result.status, target: result.target, reason: result.reason }))
      : this.open(opening);
    if (key && !prior) this.attachmentFlights.set(key, running);
    this.inFlight.set(request.requestId, running);
    void running.then(
      () => { this.inFlight.delete(request.requestId); if (key && !prior) this.attachmentFlights.delete(key); },
      () => { this.inFlight.delete(request.requestId); if (key && !prior) this.attachmentFlights.delete(key); },
    );
    return running;
  }

  private async open(opening: StoredLaunch): Promise<CodexTaskLaunch> {
    try {
      if (opening.operation === "attach") {
        // Different browser request IDs still coalesce by exact owner/generation/task.
        for (const prior of this.launches.filter(item => item.requestId !== opening.requestId && item.operation === "attach"
          && item.endpointIdentity === opening.endpointIdentity && item.generation === opening.generation && item.threadId === opening.threadId)) {
          if (prior.status === "unknown" && !prior.acknowledgedAt) return this.replace({ ...opening, status: "unknown", target: prior.target, reason: "existing_attachment_uncertain" });
          if (prior.status === "opened" && prior.target) {
            if (await this.options.verifyAttached?.(prior as CodexAttachmentRequest, prior.target)) {
              return this.replace({ ...opening, status: "opened", target: prior.target, reason: null });
            }
            this.replace({ ...prior, status: "unknown", reason: "terminal_identity_unverified" });
            return this.replace({ ...opening, status: "unknown", target: prior.target, reason: "terminal_identity_unverified" });
          }
        }
        if (!this.options.openAttached) throw new Error("Attachment launcher unavailable");
      }
      const target = targetSchema.parse(opening.operation === "attach"
        ? await this.options.openAttached!(opening)
        : await this.options.open(opening.endpointId, opening.cwd, opening.requestId));
      if (opening.operation === "attach" && !await this.options.verifyAttached?.(opening, target)) {
        return this.replace({ ...opening, status: "unknown", target, reason: "terminal_identity_unverified" });
      }
      return this.replace({ ...opening, status: "opened", target, reason: null });
    } catch (error) {
      // The child can have created a native view before a transport failure.
      // Do not retry it or infer a native task identity.
      const target = error instanceof CodexCliViewUncertainError ? error.target : null;
      return this.replace({ ...opening, status: "unknown", target, reason: "launch_outcome_unknown" });
    }
  }

  async verifiedTarget(endpointIdentity: string, generation: string, threadId: string): Promise<CodexTaskTarget | null> {
    for (const item of this.launches) {
      if (item.operation === "attach" && item.endpointIdentity === endpointIdentity && item.generation === generation
        && item.threadId === threadId && item.target && await this.options.verifyAttached?.(item, item.target)) return structuredClone(item.target);
    }
    return null;
  }

  async reconcile(item: CodexTaskLaunch): Promise<CodexTaskLaunch> {
    let stored = this.launches.find(candidate => candidate.requestId === item.requestId);
    if (stored?.operation !== "attach") return structuredClone(item);
    if (!stored.target) {
      const target = this.options.recoverAttached?.(stored);
      if (!target) return structuredClone(stored);
      stored = { ...stored, target: targetSchema.parse(target) };
      this.replace(stored);
    }
    const target = stored.target;
    if (!target) return structuredClone(stored);
    const verified = await this.options.verifyAttached?.(stored, target);
    if (verified && stored.status !== "opened") return this.replace({ ...stored, status: "opened", reason: null });
    if (!verified && stored.status === "opened") return this.replace({ ...stored, status: "unknown", reason: "terminal_identity_unverified" });
    return structuredClone(stored);
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
      if (version === 1) return envelopeSchema.parse({ ...(input as object), schemaVersion: 2 }).launches;
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
