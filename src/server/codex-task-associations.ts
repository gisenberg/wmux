import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CodexTask, CodexTaskAssociation, CodexTaskTarget } from "../shared/codex-tasks.js";
import type { TerminalNotification } from "../shared/protocol.js";
import { hasPrivatePermissions } from "./private-permissions.js";

export const CURRENT_CODEX_TASK_ASSOCIATION_SCHEMA_VERSION = 1;
export const MAX_CODEX_TASK_ASSOCIATIONS = 200;
const MAX_OUTBOX = MAX_CODEX_TASK_ASSOCIATIONS * 16;
const MAX_LEDGER_BYTES = 24 * 1024 * 1024;
const text = (max: number) => z.string().min(1).max(max);

const targetSchema = z.object({
  workspaceId: text(120),
  tabId: text(120),
  paneId: text(120),
}).strict();
const associationSchema = z.object({
  id: text(120),
  endpointId: text(256),
  endpointIdentity: text(1_024),
  threadId: text(512),
  target: targetSchema,
  createdAt: z.string().datetime(),
}).strict();
const observationSchema = z.object({
  endpointIdentity: text(1_024),
  threadId: text(512),
  latestTurnId: text(512).nullable(),
  latestStatus: text(120).nullable(),
}).strict();
const outboxSchema = z.object({
  id: text(120),
  endpointIdentity: text(1_024).optional(),
  threadId: text(512).optional(),
  notification: z.object({
    id: text(120), workspaceId: text(120), tabId: text(120), paneId: text(120),
    title: text(256), subtitle: text(256), body: z.string().max(4_096),
    createdAt: z.string().datetime(), read: z.boolean(),
  }).strict(),
  delivered: z.boolean(),
}).strict();
const envelopeSchema = z.object({
  schemaVersion: z.literal(CURRENT_CODEX_TASK_ASSOCIATION_SCHEMA_VERSION),
  associations: z.array(associationSchema).max(MAX_CODEX_TASK_ASSOCIATIONS),
  observations: z.array(observationSchema).max(MAX_CODEX_TASK_ASSOCIATIONS),
  outbox: z.array(outboxSchema).max(MAX_OUTBOX),
}).strict();

type StoredAssociation = z.infer<typeof associationSchema>;
type StoredObservation = z.infer<typeof observationSchema>;
type StoredOutbox = z.infer<typeof outboxSchema>;
type Envelope = z.infer<typeof envelopeSchema>;

export class UnsupportedCodexTaskAssociationVersionError extends Error {
  constructor(readonly version: number) {
    super(`Codex task association schema ${version} is newer than this wmux build supports (${CURRENT_CODEX_TASK_ASSOCIATION_SCHEMA_VERSION})`);
    this.name = "UnsupportedCodexTaskAssociationVersionError";
  }
}

export interface CodexTaskAssociationsOptions {
  filePath?: string;
  resolveTarget: (target: CodexTaskTarget) => boolean;
  endpointIdentity: (id: string) => string | null;
  notify: (notification: TerminalNotification) => void;
}

/** A private display association ledger. It never grants task title or input authority. */
export class CodexTaskAssociations {
  private associations: StoredAssociation[] = [];
  private observations: StoredObservation[] = [];
  private outbox: StoredOutbox[] = [];
  private readonly filePath?: string;

  constructor(private readonly options: CodexTaskAssociationsOptions) {
    this.filePath = options.filePath;
    if (this.filePath) {
      this.ensureSecureParent();
      this.install(this.load());
      this.deliverPending();
    }
  }

  list(): CodexTaskAssociation[] {
    return this.associations.map((association) => this.present(association));
  }

  put(input: {
    id?: string;
    endpointId: string;
    endpointIdentity: string;
    threadId: string;
    target: CodexTaskTarget;
  }): CodexTaskAssociation {
    const endpointIdentity = this.options.endpointIdentity(input.endpointId);
    if (!endpointIdentity || endpointIdentity !== input.endpointIdentity) {
      throw new Error("Codex task endpoint identity does not match the current endpoint");
    }
    const { id: rawRequestedId, ...candidateInput } = input;
    const requestedId = rawRequestedId === undefined ? undefined : text(120).parse(rawRequestedId);
    const candidate = associationSchema.omit({ id: true, createdAt: true }).parse(candidateInput);
    const existingIndex = requestedId === undefined ? -1 : this.associations.findIndex((item) => item.id === requestedId);
    if (requestedId !== undefined && existingIndex === -1) throw new Error("Codex task association was not found");
    if (existingIndex === -1 && this.associations.length >= MAX_CODEX_TASK_ASSOCIATIONS) {
      throw new Error(`Codex task association limit (${MAX_CODEX_TASK_ASSOCIATIONS}) reached`);
    }
    const record: StoredAssociation = existingIndex === -1
      ? { ...candidate, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
      : { ...candidate, id: this.associations[existingIndex]!.id, createdAt: this.associations[existingIndex]!.createdAt };
    const associations = [...this.associations];
    if (existingIndex === -1) associations.push(record); else associations[existingIndex] = record;
    this.commit(associations, this.retainObservations(associations), this.outbox);
    return this.present(record);
  }

  remove(id: string): boolean {
    const associationId = text(120).parse(id);
    const associations = this.associations.filter((item) => item.id !== associationId);
    if (associations.length === this.associations.length) return false;
    this.commit(associations, this.retainObservations(associations), this.outbox);
    return true;
  }

  observe(task: CodexTask): void {
    // Catalog outages and partial snapshots must not overwrite a known active
    // turn or make a historical terminal transition look fresh on recovery.
    if (task.stale || task.status === "unavailable" || task.status === "unknown" || !task.latestTurn) return;
    const matching = this.associations.filter((association) =>
      association.endpointId === task.endpointId
      && association.endpointIdentity === task.endpointIdentity
      && association.threadId === task.threadId
      && this.isResolved(association).resolved,
    );
    if (matching.length === 0) return;
    // A prior successful notification write may have been interrupted before its
    // delivery marker was committed. Replaying its deterministic id is safe.
    this.deliverPending();
    const key = observationKey(task.endpointIdentity, task.threadId);
    const previous = this.observations.find((item) => observationKey(item.endpointIdentity, item.threadId) === key);
    const current: StoredObservation = {
      endpointIdentity: task.endpointIdentity,
      threadId: task.threadId,
      latestTurnId: task.latestTurn.id,
      latestStatus: task.latestTurn.status,
    };
    // A first sample establishes a baseline: it must never announce old history.
    if (!previous) {
      this.commit(this.associations, [...this.observations, current], this.outbox);
      return;
    }
    const terminal = terminalStatus(task.latestTurn.status);
    const transitioned = terminal !== null && (activeTurnStatus(previous.latestStatus)
      || previous.latestTurnId !== current.latestTurnId);
    const changed = previous.latestTurnId !== current.latestTurnId || previous.latestStatus !== current.latestStatus;
    if (!changed) return;

    let outbox = this.outbox;
    if (transitioned && task.latestTurn) {
      const id = notificationId(task.endpointIdentity, task.threadId, task.latestTurn.id, terminal!);
      if (!outbox.some((item) => item.id === id)) {
        const target = matching.slice().sort((left, right) => left.id.localeCompare(right.id))[0]!.target;
        outbox = [...outbox, {
          id,
          endpointIdentity: task.endpointIdentity,
          threadId: task.threadId,
          delivered: false,
          notification: notificationFor(id, target, terminal!),
        }];
      }
    }
    const observations = this.observations.map((item) => observationKey(item.endpointIdentity, item.threadId) === key ? current : item);
    this.commit(this.associations, observations, outbox);
    this.deliverPending();
  }

  private present(association: StoredAssociation): CodexTaskAssociation {
    return { ...structuredClone(association), ...this.isResolved(association) };
  }

  private isResolved(association: StoredAssociation): Pick<CodexTaskAssociation, "resolved" | "reason"> {
    const identity = this.options.endpointIdentity(association.endpointId);
    if (!identity || identity !== association.endpointIdentity) return { resolved: false, reason: "endpoint_unavailable" };
    if (!this.options.resolveTarget(structuredClone(association.target))) return { resolved: false, reason: "display_target_unavailable" };
    return { resolved: true, reason: null };
  }

  private retainObservations(associations: StoredAssociation[]): StoredObservation[] {
    const keys = new Set(associations.map((item) => observationKey(item.endpointIdentity, item.threadId)));
    return this.observations.filter((item) => keys.has(observationKey(item.endpointIdentity, item.threadId)));
  }

  private deliverPending(): void {
    for (const pending of this.outbox.filter((item) => !item.delivered)) {
      if (!this.canDeliver(pending)) continue;
      this.options.notify(structuredClone(pending.notification));
      const outbox = this.outbox.map((item) => item.id === pending.id ? { ...item, delivered: true } : item);
      this.commit(this.associations, this.observations, outbox);
    }
  }

  private canDeliver(pending: StoredOutbox): boolean {
    if (!pending.endpointIdentity || !pending.threadId) return false;
    return this.associations.some((association) =>
      association.endpointIdentity === pending.endpointIdentity
      && association.threadId === pending.threadId
      && association.target.workspaceId === pending.notification.workspaceId
      && association.target.tabId === pending.notification.tabId
      && association.target.paneId === pending.notification.paneId
      && this.isResolved(association).resolved,
    );
  }

  private commit(associations: StoredAssociation[], observations: StoredObservation[], outbox: StoredOutbox[]): void {
    const envelope: Envelope = envelopeSchema.parse({
      schemaVersion: CURRENT_CODEX_TASK_ASSOCIATION_SCHEMA_VERSION,
      associations,
      observations,
      outbox: outbox.slice(-MAX_OUTBOX),
    });
    this.persist(envelope);
    this.install(envelope);
  }

  private install(envelope: Envelope): void {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const association of envelope.associations) {
      if (ids.has(association.id)) throw new Error(`duplicate Codex task association id: ${association.id}`);
      ids.add(association.id);
    }
    for (const observation of envelope.observations) {
      const key = observationKey(observation.endpointIdentity, observation.threadId);
      if (keys.has(key)) throw new Error("duplicate Codex task observation");
      keys.add(key);
    }
    this.associations = structuredClone(envelope.associations);
    this.observations = structuredClone(envelope.observations);
    this.outbox = structuredClone(envelope.outbox);
  }

  private load(): Envelope {
    if (!this.filePath || !fs.existsSync(this.filePath)) return emptyEnvelope();
    this.assertSecureFile(this.filePath);
    try {
      if (fs.statSync(this.filePath).size > MAX_LEDGER_BYTES) throw new Error("ledger is too large");
      const input = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      const version = input && typeof input === "object" && !Array.isArray(input)
        ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
      if (typeof version === "number" && Number.isInteger(version) && version > CURRENT_CODEX_TASK_ASSOCIATION_SCHEMA_VERSION) {
        throw new UnsupportedCodexTaskAssociationVersionError(version);
      }
      return envelopeSchema.parse(input);
    } catch (error) {
      if (error instanceof UnsupportedCodexTaskAssociationVersionError) throw error;
      throw new Error(`wmux Codex task association ledger is invalid: ${this.filePath}`);
    }
  }

  private persist(envelope: Envelope): void {
    if (!this.filePath) return;
    this.ensureSecureParent();
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(handle, `${JSON.stringify(envelope, null, 2)}\n`); fs.fsyncSync(handle); }
      finally { fs.closeSync(handle); }
      fs.chmodSync(temporary, 0o600);
      if (fs.existsSync(this.filePath)) {
        this.assertSecureFile(this.filePath);
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
        fs.chmodSync(`${this.filePath}.bak`, 0o600);
      }
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  private ensureSecureParent(): void {
    if (!this.filePath) return;
    const parentPath = path.dirname(path.resolve(this.filePath));
    if (!fs.existsSync(parentPath)) fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(parentPath) !== parentPath) throw new Error("Codex task association parent directory must not use symlinks");
    if (typeof process.getuid === "function" && parent.uid !== process.getuid()) throw new Error("Codex task association parent directory must be owned by the wmux user");
    if (!hasPrivatePermissions(parentPath, parent, true)) throw new Error("Codex task association parent directory must be owner-only");
  }

  private assertSecureFile(filePath: string): void {
    const file = fs.lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink() || fs.realpathSync(filePath) !== path.resolve(filePath)) throw new Error("Codex task association ledger must be a regular non-symlink file");
    if (typeof process.getuid === "function" && file.uid !== process.getuid()) throw new Error("Codex task association ledger must be owned by the wmux user");
    if (!hasPrivatePermissions(filePath, file)) throw new Error("Codex task association ledger permissions must be 0600");
  }
}

const emptyEnvelope = (): Envelope => ({ schemaVersion: CURRENT_CODEX_TASK_ASSOCIATION_SCHEMA_VERSION, associations: [], observations: [], outbox: [] });
const observationKey = (identity: string, threadId: string): string => `${identity}\u0000${threadId}`;
const terminalStatus = (status: string | undefined): "completed" | "failed" | "interrupted" | null =>
  status === "completed" || status === "failed" || status === "interrupted" ? status : null;
const activeTurnStatus = (status: string | null): boolean => status === "inProgress" || status === "active";
const notificationId = (identity: string, threadId: string, turnId: string, _status: string): string =>
  `codex-task-${crypto.createHash("sha256").update(`${identity}\u0000${threadId}\u0000${turnId}`).digest("hex").slice(0, 64)}`;
const notificationFor = (id: string, target: CodexTaskTarget, status: "completed" | "failed" | "interrupted"): TerminalNotification => ({
  id, workspaceId: target.workspaceId, tabId: target.tabId, paneId: target.paneId,
  title: status === "completed" ? "Codex task completed" : status === "failed" ? "Codex task failed" : "Codex task interrupted",
  subtitle: "Native task activity · display association", body: "", createdAt: new Date().toISOString(), read: false,
});
