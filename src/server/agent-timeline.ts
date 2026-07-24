import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  AgentSessionTimeline,
  AgentTimelineEntry,
  AgentTimelineSnapshotLink,
  DelegationState,
  WorkingTreeSnapshot,
} from "../shared/protocol.js";
import { createId } from "./id.js";

export const CURRENT_AGENT_TIMELINE_SCHEMA_VERSION = 1;
export const CURRENT_REPOSITORY_SNAPSHOT_SCHEMA_VERSION = 1;

const MAX_SESSIONS = 1_000;
const MAX_ENTRIES_PER_SESSION = 5_000;

const defaultTimelinePath = (): string =>
  path.join(os.homedir(), ".wmux", "agent-timelines.json");

const timelineIdSchema = z.string().min(1).max(128);
const timestampSchema = z.string().min(1).max(80);
const delegationStateSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "error",
  "cancelled",
  "stopped",
  "timed_out",
  "interrupted",
]);
const snapshotLinkSchema: z.ZodType<AgentTimelineSnapshotLink> = z.object({
  id: timelineIdSchema,
  kind: z.literal("working-tree"),
  url: z.string().min(1).max(512),
  capturedAt: timestampSchema,
  complete: z.boolean(),
  filesTouched: z.array(z.string().max(4_096)).max(2_000),
}).strict();
const timelineEntrySchema: z.ZodType<AgentTimelineEntry> = z.object({
  id: timelineIdSchema,
  sessionId: timelineIdSchema,
  turnId: timelineIdSchema,
  runId: timelineIdSchema.optional(),
  kind: z.enum(["prompt", "status", "outcome", "snapshot"]),
  actor: z.enum(["user", "agent", "system"]),
  text: z.string().max(128 * 1_024),
  state: delegationStateSchema.optional(),
  filesTouched: z.array(z.string().max(4_096)).max(2_000),
  snapshot: snapshotLinkSchema.optional(),
  createdAt: timestampSchema,
}).strict();
const sessionTimelineSchema: z.ZodType<AgentSessionTimeline> = z.object({
  id: timelineIdSchema,
  runtime: z.string().min(1).max(128),
  workspaceId: timelineIdSchema,
  tabId: timelineIdSchema,
  paneId: timelineIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  entries: z.array(timelineEntrySchema).max(MAX_ENTRIES_PER_SESSION),
}).strict();
const timelineEnvelopeSchema = z.object({
  schemaVersion: z.literal(CURRENT_AGENT_TIMELINE_SCHEMA_VERSION),
  sessions: z.array(sessionTimelineSchema).max(MAX_SESSIONS),
}).strict();

interface TimelineEnvelope {
  schemaVersion: number;
  sessions: AgentSessionTimeline[];
}

export interface AgentTimelineLifecycleInput {
  sessionId: string;
  turnId: string;
  runId?: string;
  runtime: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  prompt?: string;
  state?: DelegationState;
  text: string;
  createdAt: string;
  observerError?: boolean;
}

export interface AgentTimelinePromptInput {
  paneId: string;
  runtime: string;
  text: string;
  workspaceId: string;
  tabId: string;
  createdAt?: string;
}

export class UnsupportedAgentTimelineVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `agent timeline schema ${version} is newer than this wmux build supports (${CURRENT_AGENT_TIMELINE_SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedAgentTimelineVersionError";
  }
}

export class UnsupportedRepositorySnapshotVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `repository snapshot schema ${version} is newer than this wmux build supports (${CURRENT_REPOSITORY_SNAPSHOT_SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedRepositorySnapshotVersionError";
  }
}

export class AgentTimelineStore extends EventEmitter {
  private sessions: AgentSessionTimeline[];
  private readonly archiveDirectory?: string;

  constructor(private readonly filePath?: string) {
    super();
    this.archiveDirectory = filePath
      ? path.join(path.dirname(filePath), "repository-snapshots")
      : undefined;
    this.sessions = this.load();
  }

  static persistent(
    filePath = process.env.WMUX_AGENT_TIMELINE_PATH ?? defaultTimelinePath(),
  ): AgentTimelineStore {
    return new AgentTimelineStore(filePath);
  }

  snapshot(): AgentSessionTimeline[] {
    return structuredClone(this.sessions);
  }

  recordLifecycle(input: AgentTimelineLifecycleInput): AgentSessionTimeline {
    const session = this.ensureSession(input);
    let changed = false;
    if (input.prompt) {
      changed = this.appendEntry(session, {
        id: createId("timeline"),
        sessionId: session.id,
        turnId: input.turnId,
        ...(input.runId ? { runId: input.runId } : {}),
        kind: "prompt",
        actor: "user",
        text: cleanTimelineText(input.prompt),
        filesTouched: [],
        createdAt: input.createdAt,
      }) || changed;
    }
    const kind = input.state && isTerminalState(input.state)
      ? "outcome"
      : "status";
    changed = this.appendEntry(session, {
      id: createId("timeline"),
      sessionId: session.id,
      turnId: input.turnId,
      ...(input.runId ? { runId: input.runId } : {}),
      kind,
      actor: input.observerError ? "system" : "agent",
      text: cleanTimelineText(input.text),
      ...(input.state ? { state: input.state } : {}),
      filesTouched: [],
      createdAt: input.createdAt,
    }) || changed;
    if (changed) this.persistChange(session, input.createdAt);
    return structuredClone(session);
  }

  recordPrompt(input: AgentTimelinePromptInput): AgentSessionTimeline {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const existing = this.sessions.find(
      (candidate) =>
        candidate.paneId === input.paneId
        && candidate.runtime === input.runtime,
    );
    const session = existing ?? this.ensureSession({
      sessionId: createId("session"),
      turnId: createId("turn"),
      runtime: input.runtime || "agent",
      workspaceId: input.workspaceId,
      tabId: input.tabId,
      paneId: input.paneId,
      text: "",
      createdAt,
    });
    const latest = session.entries.at(-1);
    const turnId = latest && !(
      latest.kind === "outcome"
      && latest.state
      && isTerminalState(latest.state)
    )
      ? latest.turnId
      : createId("turn");
    const changed = this.appendEntry(session, {
      id: createId("timeline"),
      sessionId: session.id,
      turnId,
      ...(latest?.runId ? { runId: latest.runId } : {}),
      kind: "prompt",
      actor: "user",
      text: cleanTimelineText(input.text),
      filesTouched: [],
      createdAt,
    });
    if (changed) this.persistChange(session, createdAt);
    return structuredClone(session);
  }

  archiveWorkingTreeSnapshot(
    paneId: string,
    snapshot: WorkingTreeSnapshot,
    capturedAt = new Date().toISOString(),
  ): AgentTimelineSnapshotLink | undefined {
    const session = this.sessions.find(
      (candidate) => candidate.paneId === paneId,
    );
    if (!session) return undefined;
    const id = createId("snapshot");
    const link: AgentTimelineSnapshotLink = {
      id,
      kind: "working-tree",
      url: `/api/repository-snapshots/${encodeURIComponent(id)}`,
      capturedAt,
      complete: snapshot.complete,
      filesTouched: snapshot.files.map((file) => file.path).slice(0, 2_000),
    };
    this.writeSnapshotArchive(id, capturedAt, snapshot);
    const latest = session.entries.at(-1);
    const changed = this.appendEntry(session, {
      id: createId("timeline"),
      sessionId: session.id,
      turnId: latest?.turnId ?? createId("turn"),
      ...(latest?.runId ? { runId: latest.runId } : {}),
      kind: "snapshot",
      actor: "system",
      text: `${link.filesTouched.length} working-tree file${link.filesTouched.length === 1 ? "" : "s"} captured`,
      filesTouched: link.filesTouched,
      snapshot: link,
      createdAt: capturedAt,
    });
    if (changed) this.persistChange(session, capturedAt);
    return structuredClone(link);
  }

  readWorkingTreeSnapshot(id: string): WorkingTreeSnapshot | undefined {
    if (!this.archiveDirectory || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
      return undefined;
    }
    const archivePath = path.join(this.archiveDirectory, `${id}.json`);
    if (!fs.existsSync(archivePath)) return undefined;
    const input = JSON.parse(fs.readFileSync(archivePath, "utf8")) as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("repository snapshot archive must be an object");
    }
    const record = input as Record<string, unknown>;
    const version = record.schemaVersion;
    if (
      typeof version === "number"
      && Number.isInteger(version)
      && version > CURRENT_REPOSITORY_SNAPSHOT_SCHEMA_VERSION
    ) {
      throw new UnsupportedRepositorySnapshotVersionError(version);
    }
    if (
      version !== CURRENT_REPOSITORY_SNAPSHOT_SCHEMA_VERSION
      || record.id !== id
      || !record.snapshot
      || typeof record.snapshot !== "object"
    ) {
      throw new Error("invalid repository snapshot archive");
    }
    return structuredClone(record.snapshot as WorkingTreeSnapshot);
  }

  private ensureSession(
    input: AgentTimelineLifecycleInput,
  ): AgentSessionTimeline {
    const existing = this.sessions.find(
      (candidate) => candidate.id === input.sessionId,
    );
    if (existing) {
      existing.runtime = input.runtime || existing.runtime;
      existing.workspaceId = input.workspaceId || existing.workspaceId;
      existing.tabId = input.tabId || existing.tabId;
      existing.paneId = input.paneId || existing.paneId;
      return existing;
    }
    const session: AgentSessionTimeline = {
      id: input.sessionId,
      runtime: input.runtime || "agent",
      workspaceId: input.workspaceId,
      tabId: input.tabId,
      paneId: input.paneId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      entries: [],
    };
    this.sessions.unshift(session);
    this.sessions = this.sessions.slice(0, MAX_SESSIONS);
    return session;
  }

  private appendEntry(
    session: AgentSessionTimeline,
    entry: AgentTimelineEntry,
  ): boolean {
    if (!entry.text && entry.kind !== "snapshot") return false;
    const duplicate = session.entries.some(
      (candidate) =>
        candidate.turnId === entry.turnId
        && candidate.kind === entry.kind
        && candidate.state === entry.state
        && candidate.text === entry.text,
    );
    if (duplicate) return false;
    session.entries.push(entry);
    session.entries = session.entries.slice(-MAX_ENTRIES_PER_SESSION);
    return true;
  }

  private persistChange(
    session: AgentSessionTimeline,
    updatedAt: string,
  ): void {
    session.updatedAt = updatedAt;
    const index = this.sessions.indexOf(session);
    if (index > 0) {
      this.sessions.splice(index, 1);
      this.sessions.unshift(session);
    }
    this.writeToDisk();
    this.emit("change");
  }

  private load(): AgentSessionTimeline[] {
    if (!this.filePath) return [];
    const loaded = this.tryLoad(this.filePath);
    if (loaded) return loaded;
    if (fs.existsSync(this.filePath)) this.quarantine(this.filePath);
    const backupPath = `${this.filePath}.bak`;
    const backup = this.tryLoad(backupPath);
    if (backup) {
      console.error(`wmux: recovered agent timelines from ${backupPath}`);
      return backup;
    }
    if (fs.existsSync(backupPath)) this.quarantine(backupPath);
    return [];
  }

  private tryLoad(filePath: string): AgentSessionTimeline[] | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      const input = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!input || typeof input !== "object" || Array.isArray(input)) return null;
      const version = (input as Record<string, unknown>).schemaVersion;
      if (
        typeof version === "number"
        && Number.isInteger(version)
        && version > CURRENT_AGENT_TIMELINE_SCHEMA_VERSION
      ) {
        throw new UnsupportedAgentTimelineVersionError(version);
      }
      return timelineEnvelopeSchema.parse(input).sessions;
    } catch (error) {
      if (error instanceof UnsupportedAgentTimelineVersionError) throw error;
      return null;
    }
  }

  private writeToDisk(): void {
    if (!this.filePath) return;
    const envelope: TimelineEnvelope = {
      schemaVersion: CURRENT_AGENT_TIMELINE_SCHEMA_VERSION,
      sessions: this.sessions,
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    try {
      const handle = fs.openSync(temporaryPath, "w", 0o600);
      try {
        fs.writeFileSync(handle, JSON.stringify(envelope, null, 2));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.chmodSync(temporaryPath, 0o600);
      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
        fs.chmodSync(`${this.filePath}.bak`, 0o600);
      }
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private writeSnapshotArchive(
    id: string,
    capturedAt: string,
    snapshot: WorkingTreeSnapshot,
  ): void {
    if (!this.archiveDirectory) return;
    fs.mkdirSync(this.archiveDirectory, { recursive: true });
    const archivePath = path.join(this.archiveDirectory, `${id}.json`);
    const temporaryPath = `${archivePath}.tmp`;
    try {
      const handle = fs.openSync(temporaryPath, "wx", 0o600);
      try {
        fs.writeFileSync(handle, JSON.stringify({
          schemaVersion: CURRENT_REPOSITORY_SNAPSHOT_SCHEMA_VERSION,
          id,
          capturedAt,
          snapshot,
        }, null, 2));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, archivePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private quarantine(filePath: string): void {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const quarantinePath = `${filePath}.corrupt-${stamp}`;
      fs.renameSync(filePath, quarantinePath);
      console.error(
        `wmux: unreadable agent timeline file quarantined to ${quarantinePath}`,
      );
    } catch (error) {
      console.error(
        `wmux: failed to quarantine unreadable agent timeline file: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

const cleanTimelineText = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 128 * 1_024);

const isTerminalState = (state: DelegationState): boolean =>
  !["running", "waiting"].includes(state);
