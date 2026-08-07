import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SessionBackend } from "./backends/index.js";
import { sessionAgentOriginForEndpoint } from "./session-agent-origin.js";
import type { MachineConfig } from "./types.js";

export const CURRENT_DURABLE_ENDPOINT_SCHEMA_VERSION = 2;
const MAX_DURABLE_ENDPOINT_RECORDS = 10_000;

export type DurableEndpointBackend = Extract<
  SessionBackend["id"],
  "durable-multiplexer" | "windows-agent"
>;
export type DurableEndpointStatus = "active" | "stranded";

const storedMachineFields = {
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(500),
  kind: z.enum(["local", "ssh", "powershell", "powershell-ssh", "service"]),
  platform: z.enum(["linux", "mac", "win"]).optional(),
  host: z.string().min(1).max(255).optional(),
  user: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  shell: z.string().max(4096).optional(),
  cwd: z.string().max(8192).optional(),
  sessionBackend: z.enum(["auto", "pty", "tmux", "screen", "agent"]).optional(),
  loadPowerShellProfile: z.boolean().optional(),
  agentUrl: z.string().max(2048).url().optional(),
  agentPort: z.number().int().min(1).max(65535).optional(),
  agentToken: z.string().min(1).max(4096).optional(),
};

const storedMachineSchemaV1 = z.object({
  ...storedMachineFields,
  source: z.literal("registered"),
}).strict();

const storedMachineSchema = z.object({
  ...storedMachineFields,
  source: z.enum(["config", "registered"]),
}).strict();

const recordFields = {
  id: z.string().uuid(),
  paneId: z.string().min(1).max(120),
  backend: z.enum(["durable-multiplexer", "windows-agent"]),
  status: z.enum(["active", "stranded"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};

const recordSchemaV1 = z.object({
  ...recordFields,
  machine: storedMachineSchemaV1,
}).strict();

const recordSchema = z.object({
  ...recordFields,
  machine: storedMachineSchema,
}).strict();

const envelopeSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  records: z.array(recordSchemaV1).max(MAX_DURABLE_ENDPOINT_RECORDS),
}).strict();

const envelopeSchema = z.object({
  schemaVersion: z.literal(CURRENT_DURABLE_ENDPOINT_SCHEMA_VERSION),
  records: z.array(recordSchema).max(MAX_DURABLE_ENDPOINT_RECORDS),
}).strict();

export interface DurableEndpointRecord {
  id: string;
  paneId: string;
  backend: DurableEndpointBackend;
  status: DurableEndpointStatus;
  machine: MachineConfig & { source: "config" | "registered" };
  createdAt: string;
  updatedAt: string;
}

export class UnsupportedDurableEndpointVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `durable endpoint schema ${version} is newer than this wmux build supports (${CURRENT_DURABLE_ENDPOINT_SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedDurableEndpointVersionError";
  }
}

export class DurableEndpointStore {
  private records = new Map<string, DurableEndpointRecord>();

  constructor(readonly filePath: string) {
    this.ensureSecureParent();
    this.load();
  }

  snapshot(): DurableEndpointRecord[] {
    return structuredClone([...this.records.values()]);
  }

  find(recordId: string): DurableEndpointRecord | undefined {
    const record = this.records.get(recordId);
    return record ? structuredClone(record) : undefined;
  }

  activeForPane(paneId: string): DurableEndpointRecord | undefined {
    const records = [...this.records.values()]
      .filter((record) => record.paneId === paneId && record.status === "active")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return records[0] ? structuredClone(records[0]) : undefined;
  }

  recordsForPane(paneId: string): DurableEndpointRecord[] {
    return this.snapshot().filter((record) => record.paneId === paneId);
  }

  bind(
    paneId: string,
    machine: MachineConfig,
    backend: SessionBackend["id"],
  ): DurableEndpointRecord | undefined {
    if (!shouldPersistDurableEndpoint(machine, backend)) {
      this.markPaneStranded(paneId);
      return undefined;
    }
    const now = new Date().toISOString();
    const active = this.activeForPane(paneId);
    if (active && sameDisposalEndpoint(active.machine, machine) && active.backend === backend) {
      const updated: DurableEndpointRecord = {
        ...active,
        machine: storedMachine(machine),
        updatedAt: now,
      };
      this.records.set(updated.id, updated);
      this.persist();
      return structuredClone(updated);
    }
    this.markPaneStranded(paneId, false);
    const reusable = [...this.records.values()]
      .filter((record) =>
        record.paneId === paneId
        && record.status === "stranded"
        && record.backend === backend
        && sameDisposalEndpoint(record.machine, machine))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (reusable) {
      const updated: DurableEndpointRecord = {
        ...reusable,
        status: "active",
        machine: storedMachine(machine),
        updatedAt: now,
      };
      this.records.set(updated.id, updated);
      this.persist();
      return structuredClone(updated);
    }
    const record: DurableEndpointRecord = {
      id: crypto.randomUUID(),
      paneId,
      backend,
      status: "active",
      machine: storedMachine(machine),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    this.persist();
    return structuredClone(record);
  }

  updateActive(paneId: string, machine: MachineConfig): void {
    const active = this.activeForPane(paneId);
    if (!active) return;
    this.records.set(active.id, {
      ...active,
      machine: storedMachine(machine),
      updatedAt: new Date().toISOString(),
    });
    this.persist();
  }

  reconcile(
    paneIds: ReadonlySet<string>,
    currentMachines: readonly MachineConfig[],
    persistedPaneMachines: ReadonlyMap<string, MachineConfig> = new Map(),
  ): void {
    const machines = new Map(currentMachines.map((machine) => [machine.id, machine]));
    let changed = false;
    const now = new Date().toISOString();
    for (const record of this.records.values()) {
      if (record.status !== "active") continue;
      const current = persistedPaneMachines.get(record.paneId)
        ?? machines.get(record.machine.id);
      if (
        paneIds.has(record.paneId)
        && current
        && sameDisposalEndpoint(record.machine, current)
      ) {
        continue;
      }
      record.status = "stranded";
      record.updatedAt = now;
      changed = true;
    }
    if (changed) this.persist();
  }

  markPaneStranded(paneId: string, persist = true): void {
    let changed = false;
    const now = new Date().toISOString();
    for (const record of this.records.values()) {
      if (record.paneId !== paneId || record.status !== "active") continue;
      record.status = "stranded";
      record.updatedAt = now;
      changed = true;
    }
    if (changed && persist) this.persist();
  }

  delete(recordId: string): boolean {
    const removed = this.records.delete(recordId);
    if (removed) this.persist();
    return removed;
  }

  deleteActiveForPane(paneId: string): void {
    let changed = false;
    for (const [id, record] of this.records) {
      if (record.paneId !== paneId || record.status !== "active") continue;
      this.records.delete(id);
      changed = true;
    }
    if (changed) this.persist();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const primary = this.readEnvelope(this.filePath);
    if (primary) {
      this.install(primary.envelope);
      if (primary.migrated) this.persist();
      return;
    }
    const backup = this.readEnvelope(`${this.filePath}.bak`);
    if (!backup) throw new Error(`wmux durable endpoint ledger is invalid: ${this.filePath}`);
    this.install(backup.envelope);
    this.persist();
  }

  private readEnvelope(filePath: string): {
    envelope: z.infer<typeof envelopeSchema>;
    migrated: boolean;
  } | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    this.assertSecureFile(filePath);
    try {
      const input = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      const version = input && typeof input === "object"
        ? (input as { schemaVersion?: unknown }).schemaVersion
        : undefined;
      if (
        typeof version === "number"
        && Number.isInteger(version)
        && version > CURRENT_DURABLE_ENDPOINT_SCHEMA_VERSION
      ) {
        throw new UnsupportedDurableEndpointVersionError(version);
      }
      const parsed = envelopeSchema.safeParse(input);
      if (parsed.success) return { envelope: parsed.data, migrated: false };
      const legacy = envelopeSchemaV1.safeParse(input);
      if (!legacy.success) return undefined;
      return {
        envelope: {
          schemaVersion: CURRENT_DURABLE_ENDPOINT_SCHEMA_VERSION,
          records: legacy.data.records,
        },
        migrated: true,
      };
    } catch (error) {
      if (error instanceof UnsupportedDurableEndpointVersionError) throw error;
      return undefined;
    }
  }

  private install(envelope: z.infer<typeof envelopeSchema>): void {
    const records = new Map<string, DurableEndpointRecord>();
    for (const record of envelope.records) {
      if (records.has(record.id)) throw new Error(`duplicate durable endpoint id: ${record.id}`);
      records.set(record.id, structuredClone(record));
    }
    this.records = records;
  }

  private persist(): void {
    this.ensureSecureParent();
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const payload = {
      schemaVersion: CURRENT_DURABLE_ENDPOINT_SCHEMA_VERSION,
      records: [...this.records.values()],
    };
    envelopeSchema.parse(payload);
    try {
      const handle = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      if (fs.existsSync(this.filePath)) {
        const current = this.readEnvelope(this.filePath);
        if (current) {
          if (fs.existsSync(`${this.filePath}.bak`)) {
            this.assertSecureFile(`${this.filePath}.bak`);
          }
          fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
          fs.chmodSync(`${this.filePath}.bak`, 0o600);
        }
      }
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  private ensureSecureParent(): void {
    const parentPath = path.dirname(path.resolve(this.filePath));
    if (!fs.existsSync(parentPath)) {
      fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    }
    const parent = fs.lstatSync(parentPath);
    if (
      !parent.isDirectory()
      || parent.isSymbolicLink()
      || fs.realpathSync(parentPath) !== parentPath
    ) {
      throw new Error("durable endpoint parent directory must not use symlinks");
    }
    if (
      typeof process.getuid === "function"
      && parent.uid !== process.getuid()
    ) {
      throw new Error("durable endpoint parent directory must be owned by the wmux user");
    }
    if ((parent.mode & 0o077) !== 0) {
      throw new Error("durable endpoint parent directory must be owner-only");
    }
  }

  private assertSecureFile(filePath: string): void {
    const file = fs.lstatSync(filePath);
    if (
      !file.isFile()
      || file.isSymbolicLink()
      || fs.realpathSync(filePath) !== path.resolve(filePath)
    ) {
      throw new Error("durable endpoint ledger must be a regular non-symlink file");
    }
    if (
      typeof process.getuid === "function"
      && file.uid !== process.getuid()
    ) {
      throw new Error("durable endpoint ledger must be owned by the wmux user");
    }
    if ((file.mode & 0o777) !== 0o600) {
      throw new Error("durable endpoint ledger permissions must be 0600");
    }
  }
}

export const sameDisposalEndpoint = (
  left: MachineConfig,
  right: MachineConfig,
): boolean => durableEndpointKey(left) === durableEndpointKey(right);

export const durableEndpointKey = (machine: MachineConfig): string =>
  JSON.stringify(disposalIdentity(machine));

const disposalIdentity = (machine: MachineConfig) => {
  if (machine.sessionBackend === "agent") {
    const agentOrigin = sessionAgentOriginForEndpoint(machine);
    return agentOrigin
      ? {
          id: machine.id,
          sessionBackend: machine.sessionBackend,
          agentOrigin,
        }
      : {
          id: machine.id,
          sessionBackend: machine.sessionBackend,
          invalidAgentUrl: machine.agentUrl,
          host: machine.host,
          agentPort: machine.agentPort,
        };
  }
  return {
    id: machine.id,
    kind: machine.kind,
    host: machine.host,
    user: machine.user,
    port: machine.port,
    sessionBackend: machine.sessionBackend,
  };
};

const storedMachine = (
  machine: MachineConfig,
): MachineConfig & { source: "config" | "registered" } => {
  const candidate = {
    id: machine.id,
    name: machine.name,
    kind: machine.kind,
    platform: machine.platform,
    host: machine.host,
    user: machine.user,
    port: machine.port,
    shell: machine.shell,
    cwd: machine.cwd,
    sessionBackend: machine.sessionBackend,
    loadPowerShellProfile: machine.loadPowerShellProfile,
    agentUrl: machine.agentUrl,
    agentPort: machine.agentPort,
    agentToken: machine.agentToken,
    source: machine.source === "registered" ? "registered" : "config",
  };
  const parsed = storedMachineSchema.parse(
    Object.fromEntries(
      Object.entries(candidate).filter(([, value]) => value !== undefined),
    ),
  );
  return parsed;
};

const shouldPersistDurableEndpoint = (
  machine: MachineConfig,
  backend: SessionBackend["id"],
): backend is DurableEndpointBackend => {
  if (backend !== "durable-multiplexer" && backend !== "windows-agent") return false;
  if (machine.source === "registered") return true;
  if (backend === "windows-agent") return true;
  return machine.kind !== "local";
};
