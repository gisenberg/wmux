import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { machineIdSchema, machineNameSchema, userSchema } from "./config.js";
import { isAllowedRegistrationAddress, normalizeIpAddress } from "./proxy-address.js";
import type { MachineConfig } from "./types.js";

export const DEFAULT_HOST_TTL_MS = 90 * 1000;
export const MIN_HOST_TTL_MS = 30 * 1000;
export const MAX_HOST_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_HOST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REGISTERED_HOSTS = 256;
export const MAX_HOSTS_PER_ADDRESS = 32;
export const MAX_METADATA_BYTES = 16 * 1024;
export const MIN_REGISTRATION_INTERVAL_MS = 5_000;
export const BOOTSTRAP_TOKEN_GRACE_MS = 30_000;
export const CURRENT_HOST_REGISTRY_SCHEMA_VERSION = 1;

const defaultPath = (): string => path.join(os.homedir(), ".wmux", "host-registry.json");
const portSchema = z.number().int().min(1).max(65_535);
const shellSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "shell must be a plain executable name");
const cwdSchema = z
  .string()
  .max(4096)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value), "cwd must not contain control characters");
const metadataValueSchema = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
const metadataSchema = z
  .record(metadataValueSchema)
  .refine((value) => Object.keys(value).length <= 64, { message: "metadata may contain at most 64 entries" })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_METADATA_BYTES, {
    message: `metadata may contain at most ${MAX_METADATA_BYTES} serialized bytes`,
  });

/**
 * Deliberately narrower than static MachineConfig. A registration may describe
 * a remote connection, but cannot inject a command, destination, service
 * endpoint, or stream gateway URL. The one accepted credential is an agent
 * token bound to the observed callback address and an explicit agent port; it
 * remains server-only and is removed from every registry response.
 */
const registeredMachineObjectSchema = z.object({
  id: machineIdSchema,
  name: machineNameSchema,
  kind: z.enum(["ssh", "powershell-ssh"]),
  // Accepted for compatibility with existing heartbeat files, then ignored.
  host: z.string().min(1).max(255).optional(),
  user: userSchema,
  port: portSchema.optional(),
  shell: shellSchema.optional(),
  cwd: cwdSchema.optional(),
  sessionBackend: z.enum(["auto", "pty", "tmux", "screen", "agent"]).optional(),
  agentPort: portSchema.optional(),
  agentToken: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/, "agentToken must contain printable ASCII without spaces")
    .optional(),
});

type RegisteredMachineInput = z.infer<typeof registeredMachineObjectSchema>;

const validateRegisteredMachine = (machine: RegisteredMachineInput, context: z.RefinementCtx): void => {
  if (machine.kind === "ssh" && machine.sessionBackend === "agent") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionBackend"], message: "agent is Windows-only" });
  }
  if (machine.kind === "ssh" && (machine.shell || machine.agentPort)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: machine.shell ? ["shell"] : ["agentPort"],
      message: "Windows-only fields are not valid for ssh machines",
    });
  }
  if (machine.kind === "powershell-ssh" && ["tmux", "screen"].includes(machine.sessionBackend ?? "")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sessionBackend"],
      message: "POSIX multiplexers are not valid for powershell-ssh machines",
    });
  }
  if (machine.agentPort && machine.sessionBackend !== "agent") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agentPort"],
      message: "agentPort requires the agent session backend",
    });
  }
  if (machine.agentToken && (machine.sessionBackend !== "agent" || !machine.agentPort)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agentToken"],
      message: "agentToken requires the observed-host agent backend and an explicit agentPort",
    });
  }
  if (machine.sessionBackend === "agent" && (!machine.agentPort || !machine.agentToken)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [!machine.agentPort ? "agentPort" : "agentToken"],
      message: "the agent backend requires an explicit agentPort and agentToken",
    });
  }
};

const registeredMachineSchema = registeredMachineObjectSchema.strict().superRefine(validateRegisteredMachine);
const persistedMachineSchema = registeredMachineObjectSchema.passthrough().superRefine(validateRegisteredMachine);

const registrationSchema = z
  .object({
    machine: registeredMachineSchema,
    ttlMs: z.number().int().min(MIN_HOST_TTL_MS).max(MAX_HOST_TTL_MS).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

type RegisteredMachineConfig = Omit<RegisteredMachineInput, "host">;
type PublicRegisteredMachineConfig = Omit<RegisteredMachineConfig, "agentToken">;

const persistedRecordFields = {
  id: machineIdSchema,
  registeredAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  ttlMs: z.number().int().min(MIN_HOST_TTL_MS).max(MAX_HOST_TTL_MS),
  observedAddress: z.string().refine(isAllowedRegistrationAddress, "invalid observed address"),
  previousBootstrapToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/).optional(),
  previousBootstrapTokenExpiresAt: z.string().datetime().optional(),
  metadata: metadataSchema.optional(),
};

const legacyPersistedRecordSchema = z
  .object({
    ...persistedRecordFields,
    machine: persistedMachineSchema,
    bootstrapToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/).optional(),
  })
  .passthrough()
  .refine((record) => record.id === record.machine.id, { message: "record id does not match machine id" });

const persistedRecordSchema = z
  .object({
    ...persistedRecordFields,
    machine: registeredMachineSchema,
    bootstrapToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  })
  .strict()
  .refine((record) => record.id === record.machine.id, { message: "record id does not match machine id" });

const legacyPersistedSchema = z.object({ hosts: z.array(z.unknown()).optional() }).passthrough();
const persistedSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_HOST_REGISTRY_SCHEMA_VERSION),
    hosts: z.array(z.unknown()),
  })
  .strict();

interface RegisteredHostRecord {
  id: string;
  machine: RegisteredMachineConfig;
  registeredAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ttlMs: number;
  observedAddress: string;
  bootstrapToken: string;
  previousBootstrapToken?: string;
  previousBootstrapTokenExpiresAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RegisteredHostSnapshot extends Omit<
  RegisteredHostRecord,
  "machine" | "bootstrapToken" | "previousBootstrapToken" | "previousBootstrapTokenExpiresAt"
> {
  machine: PublicRegisteredMachineConfig;
  active: boolean;
  shadowed: boolean;
}

export class HostRegistryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class HostRegistry extends EventEmitter {
  private readonly staticIds: Set<string>;
  private readonly hosts = new Map<string, RegisteredHostRecord>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly staticMachines: MachineConfig[],
    private readonly filePath: string = process.env.WMUX_REGISTRY_PATH ?? defaultPath(),
    private readonly retentionMs = DEFAULT_HOST_RETENTION_MS,
    private readonly shouldRetain: (machineId: string) => boolean = () => false,
    private readonly minimumRegistrationIntervalMs = MIN_REGISTRATION_INTERVAL_MS,
    private readonly hasLiveSession: (machineId: string) => boolean = () => false,
  ) {
    super();
    this.staticIds = new Set(["local", ...staticMachines.map((machine) => machine.id)]);
    this.load();
    this.prune();
    this.scheduleNextChange();
  }

  machines(nowMs = Date.now()): MachineConfig[] {
    const registered = [...this.hosts.values()]
      .filter((record) => !this.staticIds.has(record.id))
      .map((record) => this.machineForRecord(record, nowMs));
    return [...this.staticMachines.map((machine) => ({ ...machine, source: "config" as const })), ...registered];
  }

  snapshot(nowMs = Date.now()): RegisteredHostSnapshot[] {
    return [...this.hosts.values()].map((record) => this.publicRecord(record, nowMs));
  }

  bootstrapToken(machineId: string): string | undefined {
    return this.hosts.get(machineId)?.bootstrapToken;
  }

  acceptsBootstrapToken(machineId: string, presented: string | null, nowMs = Date.now()): boolean {
    if (!presented) return false;
    const record = this.hosts.get(machineId);
    if (!record || !this.isActive(record, nowMs)) return false;
    const matches = (expected: string | undefined): boolean => {
      if (!expected) return false;
      const expectedBytes = Buffer.from(expected);
      const presentedBytes = Buffer.from(presented);
      return expectedBytes.length === presentedBytes.length && crypto.timingSafeEqual(expectedBytes, presentedBytes);
    };
    if (matches(record.bootstrapToken)) return true;
    const graceExpiresAt = Date.parse(record.previousBootstrapTokenExpiresAt ?? "");
    return graceExpiresAt > nowMs && matches(record.previousBootstrapToken);
  }

  register(input: unknown, observedAddress: string | undefined, nowMs = Date.now()): RegisteredHostSnapshot {
    const parsed = registrationSchema.safeParse(input);
    if (!parsed.success) throw new HostRegistryError(400, "invalid_registration");
    const address = normalizeIpAddress(observedAddress);
    if (!address || !isAllowedRegistrationAddress(address)) {
      throw new HostRegistryError(400, "invalid_observed_address");
    }

    const machine = this.sanitizeMachine(parsed.data.machine);
    if (this.staticIds.has(machine.id)) throw new HostRegistryError(409, "static_machine_id");
    this.prune(nowMs);

    const now = new Date(nowMs).toISOString();
    const ttlMs = parsed.data.ttlMs ?? DEFAULT_HOST_TTL_MS;
    const previous = this.hosts.get(machine.id);
    if (!previous && this.hosts.size >= MAX_REGISTERED_HOSTS) {
      throw new HostRegistryError(429, "registry_capacity");
    }
    if (
      (!previous || previous.observedAddress !== address) &&
      [...this.hosts.values()].filter((record) => record.observedAddress === address).length >= MAX_HOSTS_PER_ADDRESS
    ) {
      throw new HostRegistryError(429, "address_capacity");
    }
    const previousSeenAt = previous ? Date.parse(previous.lastSeenAt) : Number.NaN;
    if (
      previous &&
      Number.isFinite(previousSeenAt) &&
      nowMs - previousSeenAt < this.minimumRegistrationIntervalMs
    ) {
      throw new HostRegistryError(429, "heartbeat_too_frequent");
    }
    const connectionUnchanged = previous ? this.sameConnection(previous, machine, address) : false;
    if (previous && this.shouldRetain(machine.id) && !this.sameConnectionDescriptor(previous.machine, machine)) {
      throw new HostRegistryError(409, "machine_in_use");
    }
    const previousGraceExpiresAt = Date.parse(previous?.previousBootstrapTokenExpiresAt ?? "");
    const preservePreviousGrace = connectionUnchanged && previousGraceExpiresAt > nowMs;
    if (
      previous &&
      this.hasLiveSession(machine.id) &&
      (previous.machine.sessionBackend === "agent" || machine.sessionBackend === "agent") &&
      !connectionUnchanged
    ) {
      throw new HostRegistryError(409, "machine_in_use");
    }
    const record: RegisteredHostRecord = {
      id: machine.id,
      machine,
      registeredAt: previous?.registeredAt ?? now,
      lastSeenAt: now,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      ttlMs,
      observedAddress: address,
      bootstrapToken: connectionUnchanged
        ? previous?.bootstrapToken ?? crypto.randomBytes(32).toString("base64url")
        : crypto.randomBytes(32).toString("base64url"),
      previousBootstrapToken: connectionUnchanged
        ? preservePreviousGrace
          ? previous?.previousBootstrapToken
          : undefined
        : previous?.bootstrapToken,
      previousBootstrapTokenExpiresAt: connectionUnchanged
        ? preservePreviousGrace
          ? previous?.previousBootstrapTokenExpiresAt
          : undefined
        : previous
          ? new Date(nowMs + BOOTSTRAP_TOKEN_GRACE_MS).toISOString()
          : undefined,
      metadata: parsed.data.metadata ?? (connectionUnchanged ? previous?.metadata : undefined),
    };
    this.hosts.set(record.id, record);
    this.persist();
    this.scheduleNextChange();
    this.emit("change");
    return this.publicRecord(record, nowMs);
  }

  unregister(id: string): boolean {
    if (this.hosts.has(id) && this.shouldRetain(id)) {
      throw new HostRegistryError(409, "machine_in_use");
    }
    const removed = this.hosts.delete(id);
    if (!removed) return false;
    this.persist();
    this.scheduleNextChange();
    this.emit("change");
    return true;
  }

  sweep(nowMs = Date.now()): boolean {
    const changed = this.prune(nowMs);
    this.scheduleNextChange();
    if (changed) this.emit("change");
    return changed;
  }

  dispose(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private load(): void {
    let currentSchema = false;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const input = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("host registry must be a JSON object");
      }
      const rawVersion = (input as Record<string, unknown>).schemaVersion;
      if (
        typeof rawVersion === "number" &&
        Number.isInteger(rawVersion) &&
        rawVersion > CURRENT_HOST_REGISTRY_SCHEMA_VERSION
      ) {
        throw new UnsupportedHostRegistryVersionError(rawVersion);
      }
      if (
        rawVersion !== undefined &&
        rawVersion !== 0 &&
        rawVersion !== CURRENT_HOST_REGISTRY_SCHEMA_VERSION
      ) {
        throw new Error("host registry schemaVersion must be a supported integer");
      }

      const migrated = rawVersion !== CURRENT_HOST_REGISTRY_SCHEMA_VERSION;
      currentSchema = !migrated;
      const persisted = migrated ? legacyPersistedSchema.parse(input) : persistedSchema.parse(input);
      const loadedHosts = new Map<string, RegisteredHostRecord>();
      for (const recordInput of persisted.hosts ?? []) {
        const parsed = (migrated ? legacyPersistedRecordSchema : persistedRecordSchema).safeParse(recordInput);
        if (!parsed.success) {
          if (!migrated) throw new InvalidHostRegistryError(`record failed validation: ${parsed.error.message}`);
          console.warn(`wmux: skipping an invalid host record in ${this.filePath}`);
          continue;
        }
        const record = parsed.data;
        if (!migrated && loadedHosts.has(record.id)) {
          throw new InvalidHostRegistryError(`duplicate machine id: ${record.id}`);
        }
        loadedHosts.set(record.id, {
          id: record.id,
          machine: this.sanitizeMachine(record.machine),
          registeredAt: record.registeredAt,
          lastSeenAt: record.lastSeenAt,
          expiresAt: record.expiresAt,
          ttlMs: record.ttlMs,
          observedAddress: normalizeIpAddress(record.observedAddress) ?? record.observedAddress,
          bootstrapToken: record.bootstrapToken ?? crypto.randomBytes(32).toString("base64url"),
          previousBootstrapToken: record.previousBootstrapToken,
          previousBootstrapTokenExpiresAt: record.previousBootstrapTokenExpiresAt,
          metadata: record.metadata,
        });
      }
      for (const [id, record] of loadedHosts) this.hosts.set(id, record);
      // Legacy files are re-saved once so unsafe fields and malformed siblings
      // are removed and future binaries can enforce downgrade refusal.
      if (migrated) this.persist();
    } catch (error) {
      if (error instanceof UnsupportedHostRegistryVersionError || error instanceof InvalidHostRegistryError) {
        throw error;
      }
      if (currentSchema) {
        throw new InvalidHostRegistryError(error instanceof Error ? error.message : String(error));
      }
      console.error(
        `wmux: could not load host registry ${this.filePath}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private prune(nowMs = Date.now()): boolean {
    let changed = false;
    for (const [id, record] of this.hosts) {
      const lastSeenAt = Date.parse(record.lastSeenAt);
      if ((!Number.isFinite(lastSeenAt) || nowMs - lastSeenAt >= this.retentionMs) && !this.shouldRetain(id)) {
        this.hosts.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
    return changed;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    try {
      const handle = fs.openSync(tempPath, "w", 0o600);
      try {
        fs.writeFileSync(
          handle,
          `${JSON.stringify({ schemaVersion: CURRENT_HOST_REGISTRY_SCHEMA_VERSION, hosts: [...this.hosts.values()] }, null, 2)}\n`,
        );
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.chmodSync(tempPath, 0o600);
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  private scheduleNextChange(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const nowMs = Date.now();
    const deadlines = [...this.hosts.values()].flatMap((record) => [
      Date.parse(record.expiresAt),
      Date.parse(record.lastSeenAt) + this.retentionMs,
    ]);
    const nextDeadline = deadlines
      .filter((deadline) => Number.isFinite(deadline) && deadline > nowMs)
      .sort((left, right) => left - right)[0];
    if (!nextDeadline) {
      this.expiryTimer = null;
      return;
    }

    const delayMs = Math.min(Math.max(nextDeadline - nowMs + 25, 1), 2_147_483_647);
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.prune();
      this.emit("change");
      this.scheduleNextChange();
    }, delayMs);
    this.expiryTimer.unref?.();
  }

  private isActive(record: RegisteredHostRecord, nowMs: number): boolean {
    const expiresAt = Date.parse(record.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > nowMs;
  }

  private machineForRecord(record: RegisteredHostRecord, nowMs: number): MachineConfig {
    return {
      ...record.machine,
      host: record.observedAddress,
      source: "registered",
      registeredAt: record.registeredAt,
      lastSeenAt: record.lastSeenAt,
      expiresAt: record.expiresAt,
      online: this.isActive(record, nowMs),
    };
  }

  private sanitizeMachine(machine: RegisteredMachineInput): RegisteredMachineConfig {
    const { host: _ignoredHost, ...safeMachine } = registeredMachineObjectSchema.parse(machine);
    return safeMachine;
  }

  private publicRecord(record: RegisteredHostRecord, nowMs: number): RegisteredHostSnapshot {
    const { agentToken: _secret, ...publicMachine } = record.machine;
    const {
      machine: _privateMachine,
      bootstrapToken: _bootstrapToken,
      previousBootstrapToken: _previousBootstrapToken,
      previousBootstrapTokenExpiresAt: _previousBootstrapTokenExpiresAt,
      ...publicRecord
    } = record;
    return {
      ...structuredClone(publicRecord),
      machine: structuredClone(publicMachine),
      active: this.isActive(record, nowMs),
      shadowed: this.staticIds.has(record.id),
    };
  }

  private sameConnection(
    previous: RegisteredHostRecord,
    nextMachine: RegisteredMachineConfig,
    nextAddress: string,
  ): boolean {
    return (
      previous.observedAddress === nextAddress &&
      this.sameConnectionDescriptor(previous.machine, nextMachine)
    );
  }

  private sameConnectionDescriptor(left: RegisteredMachineConfig, right: RegisteredMachineConfig): boolean {
    const descriptor = (machine: RegisteredMachineConfig): string =>
      JSON.stringify({
        kind: machine.kind,
        user: machine.user,
        port: machine.port,
        shell: machine.shell,
        sessionBackend: machine.sessionBackend,
        agentPort: machine.agentPort,
        agentToken: machine.agentToken,
      });
    return descriptor(left) === descriptor(right);
  }
}

export class InvalidHostRegistryError extends Error {
  constructor(detail: string) {
    super(`invalid host registry: ${detail}`);
    this.name = "InvalidHostRegistryError";
  }
}

export class UnsupportedHostRegistryVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `host registry schema ${version} is newer than this wmux build supports (${CURRENT_HOST_REGISTRY_SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedHostRegistryVersionError";
  }
}
