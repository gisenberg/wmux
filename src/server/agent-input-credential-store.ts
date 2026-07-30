import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { StateStore } from "./state.js";
import {
  OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
  SUPPORTED_OPENCODE_SDK_VERSION,
} from "./opencode-question-contract.js";

export const CURRENT_AGENT_INPUT_CREDENTIAL_SCHEMA_VERSION = 2;
export const DEFAULT_AGENT_INPUT_CAPABILITY_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_AGENT_INPUT_RELAY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_AGENT_INPUT_SOURCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_AGENT_INPUT_CREDENTIAL_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

const defaultPath = (): string =>
  process.env.WMUX_AGENT_INPUT_CREDENTIAL_PATH
  ?? path.join(os.homedir(), ".wmux", "agent-input-credentials.json");

const value = (max = 256) => z.string().min(1).max(max);
const contextSchema = z.object({
  workspaceId: value(),
  tabId: value(),
  paneId: value(),
  machineId: value().optional(),
  sourceKind: z.literal("opencode"),
}).strict();
const legacyHashSchema = z.object({
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const verifierSchema = z.object({
  kind: z.literal("hmac-sha256"),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const capabilitySchema = z.object({
  id: z.string().uuid(),
  verifier: verifierSchema,
  context: contextSchema,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  usedAt: z.number().int().nonnegative().optional(),
  exchangeNonce: value().optional(),
  sourceId: value().optional(),
}).strict();
const sourceSchema = z.object({
  id: value(),
  credentialId: z.string().uuid(),
  secretVerifier: verifierSchema,
  credentialGeneration: z.number().int().positive(),
  context: contextSchema,
  instanceNonce: value(),
  pluginVersion: value(64),
  sdkVersion: value(64),
  compatibilityFingerprint: value(256),
  supported: z.boolean(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  refreshedAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().optional(),
}).strict();
const capabilityTombstoneSchema = z.object({
  id: z.string().uuid(),
  sourceId: value(),
  exchangeNonce: value(),
  expiresAt: z.number().int().positive(),
}).strict();
const envelopeSchema = z.object({
  schemaVersion: z.literal(CURRENT_AGENT_INPUT_CREDENTIAL_SCHEMA_VERSION),
  capabilities: z.array(capabilitySchema).max(4_000),
  sources: z.array(sourceSchema).max(2_000),
  capabilityTombstones: z.array(capabilityTombstoneSchema).max(8_000),
}).strict();
const legacyCapabilitySchema = capabilitySchema.omit({ verifier: true }).extend({ hash: legacyHashSchema }).strict();
const legacySourceSchema = sourceSchema.omit({ secretVerifier: true }).extend({ secretHash: legacyHashSchema }).strict();
const envelopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  capabilities: z.array(legacyCapabilitySchema).max(4_000),
  sources: z.array(legacySourceSchema).max(2_000),
  capabilityTombstones: z.array(capabilityTombstoneSchema).max(8_000),
}).strict();
const envelopeV0Schema = z.object({
  schemaVersion: z.literal(0),
  capabilities: z.array(legacyCapabilitySchema).max(4_000),
  sources: z.array(legacySourceSchema).max(2_000),
}).strict();
type Envelope = z.infer<typeof envelopeSchema>;
export type AgentInputSourceRecord = z.infer<typeof sourceSchema>;
export type AgentInputSourceContext = z.infer<typeof contextSchema>;

export interface AgentInputRegistrationPrincipal {
  kind: "agent-input-registration";
  capabilityId: string;
  paneId: string;
}

export interface AgentInputSourcePrincipal {
  kind: "agent-input-source";
  sourceId: string;
  paneId: string;
  credentialId: string;
  credentialGeneration: number;
}

export class UnsupportedAgentInputCredentialVersionError extends Error {
  constructor(readonly version: number) {
    super(`agent input credential schema ${version} is newer than this wmux build supports (${CURRENT_AGENT_INPUT_CREDENTIAL_SCHEMA_VERSION})`);
    this.name = "UnsupportedAgentInputCredentialVersionError";
  }
}

export class AgentInputCredentialError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentInputCredentialError";
  }
}

export interface RegisterAgentInputSource {
  instanceNonce: string;
  kind: "opencode";
  pluginVersion: string;
  sdkVersion: string;
  compatibilityFingerprint: string;
}

export type AgentInputSourceExchange =
  | {
      outcome: "issued";
      sourceId: string;
      relaySecret: string;
      expiresAt: number;
      supported: boolean;
      credentialGeneration: number;
    }
  | { outcome: "already_exchanged"; sourceId: string };

export interface AgentInputCredentialStoreOptions {
  hashKey: string;
  capabilityTtlMs?: number;
  relayTtlMs?: number;
  beforeRename?: () => void;
  directoryFsync?: (directory: string, target: "backup" | "primary" | "quarantine") => void;
  pruneIntervalMs?: number;
}

export interface AgentInputRegistrationCapability {
  capability: string;
  capabilityId: string;
  expiresAt: number;
}

export class AgentInputCredentialStore extends EventEmitter {
  private data: Envelope;
  private readonly capabilityTtlMs: number;
  private readonly relayTtlMs: number;
  private readonly pruneTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    readonly filePath = defaultPath(),
    private readonly options: AgentInputCredentialStoreOptions,
  ) {
    super();
    if (!options.hashKey) throw new Error("agent input credential hash key is required");
    this.capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_AGENT_INPUT_CAPABILITY_TTL_MS;
    this.relayTtlMs = options.relayTtlMs ?? DEFAULT_AGENT_INPUT_RELAY_TTL_MS;
    this.ensureSecureParent();
    const loaded = this.load();
    this.data = loaded.recovered ? invalidateRecoveredEnvelope(loaded.data, this.options.hashKey) : loaded.data;
    if (loaded.recovered || loaded.migrated || !fs.existsSync(this.filePath)) this.persist(this.data, false);
    const pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_AGENT_INPUT_CREDENTIAL_PRUNE_INTERVAL_MS;
    if (pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
      this.pruneTimer.unref?.();
    }
  }

  issueRegistrationCapability(context: AgentInputSourceContext, nowMs = Date.now()): {
    capability: string;
    capabilityId: string;
    expiresAt: number;
  } {
    this.prune(nowMs);
    contextSchema.parse(context);
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString("base64url");
    const expiresAt = nowMs + this.capabilityTtlMs;
    this.commit((draft) => {
      draft.capabilities.push({
        id,
        verifier: this.verifier("capability", id, secret),
        context: structuredClone(context),
        issuedAt: nowMs,
        expiresAt,
      });
    });
    return { capability: `aic_${id}.${secret}`, capabilityId: id, expiresAt };
  }

  authenticate(presented: string, nowMs = Date.now()): AgentInputRegistrationPrincipal | AgentInputSourcePrincipal | undefined {
    const capability = /^aic_([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,256})$/.exec(presented);
    if (capability) {
      const record = this.data.capabilities.find((candidate) => candidate.id === capability[1]);
      if (!record || record.usedAt !== undefined || record.expiresAt <= nowMs
        || !this.verify("capability", record.id, capability[2], record.verifier)) return undefined;
      return { kind: "agent-input-registration", capabilityId: record.id, paneId: record.context.paneId };
    }
    const relay = /^ais_([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,256})$/.exec(presented);
    if (!relay) return undefined;
    const sourceId = `source_${relay[1]}`;
    const source = this.data.sources.find((candidate) => candidate.id === sourceId);
    if (!source || source.revokedAt !== undefined || source.expiresAt <= nowMs
      || !this.verify("source", source.id, relay[2], source.secretVerifier)) return undefined;
    return {
      kind: "agent-input-source",
      sourceId: source.id,
      paneId: source.context.paneId,
      credentialId: source.credentialId,
      credentialGeneration: source.credentialGeneration,
    };
  }

  exchange(
    principal: AgentInputRegistrationPrincipal,
    input: RegisterAgentInputSource,
    nowMs = Date.now(),
  ): AgentInputSourceExchange {
    const parsed = z.object({
      instanceNonce: value(),
      kind: z.literal("opencode"),
      pluginVersion: value(64),
      sdkVersion: value(64),
      compatibilityFingerprint: value(256),
    }).strict().parse(input);
    let plaintext = "";
    const result = this.commit((draft) => {
      const capability = draft.capabilities.find((candidate) => candidate.id === principal.capabilityId);
      if (!capability || capability.expiresAt <= nowMs || capability.context.paneId !== principal.paneId) {
        throw new AgentInputCredentialError("invalid_capability");
      }
      if (capability.usedAt !== undefined) {
        return { outcome: "already_exchanged" as const, sourceId: capability.sourceId ?? "unavailable" };
      }
      if (draft.sources.length >= 2_000) throw new AgentInputCredentialError("source_limit");
      const sourceUuid = crypto.randomUUID();
      const sourceId = `source_${sourceUuid}`;
      plaintext = crypto.randomBytes(32).toString("base64url");
      const credentialId = crypto.randomUUID();
      const supported = parsed.sdkVersion === SUPPORTED_OPENCODE_SDK_VERSION
        && parsed.pluginVersion === SUPPORTED_OPENCODE_SDK_VERSION
        && parsed.compatibilityFingerprint === OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT;
      const source: AgentInputSourceRecord = {
        id: sourceId,
        credentialId,
        secretVerifier: this.verifier("source", sourceId, plaintext),
        credentialGeneration: 1,
        context: structuredClone(capability.context),
        instanceNonce: parsed.instanceNonce,
        pluginVersion: parsed.pluginVersion,
        sdkVersion: parsed.sdkVersion,
        compatibilityFingerprint: parsed.compatibilityFingerprint,
        supported,
        issuedAt: nowMs,
        refreshedAt: nowMs,
        expiresAt: nowMs + this.relayTtlMs,
      };
      draft.sources.push(source);
      capability.usedAt = nowMs;
      capability.exchangeNonce = parsed.instanceNonce;
      capability.sourceId = sourceId;
      draft.capabilityTombstones.push({
        id: capability.id,
        sourceId,
        exchangeNonce: parsed.instanceNonce,
        expiresAt: nowMs + this.relayTtlMs,
      });
      return {
        outcome: "issued" as const,
        sourceId,
        relaySecret: `ais_${sourceUuid}.${plaintext}`,
        expiresAt: source.expiresAt,
        supported,
        credentialGeneration: 1,
      };
    });
    if (result.outcome === "issued") this.emit("issued", result.sourceId);
    return result;
  }

  refresh(principal: AgentInputSourcePrincipal, nowMs = Date.now()): {
    sourceId: string;
    relaySecret: string;
    expiresAt: number;
    credentialGeneration: number;
  } {
    let plaintext = "";
    return this.commit((draft) => {
      const source = draft.sources.find((candidate) => candidate.id === principal.sourceId);
      if (!source || source.revokedAt !== undefined || source.expiresAt <= nowMs
        || source.credentialId !== principal.credentialId
        || source.credentialGeneration !== principal.credentialGeneration
        || source.context.paneId !== principal.paneId) {
        throw new AgentInputCredentialError("unauthorized");
      }
      plaintext = crypto.randomBytes(32).toString("base64url");
       source.secretVerifier = this.verifier("source", source.id, plaintext);
      source.credentialId = crypto.randomUUID();
      source.credentialGeneration += 1;
      source.refreshedAt = nowMs;
      source.expiresAt = nowMs + this.relayTtlMs;
      return {
        sourceId: source.id,
        relaySecret: `ais_${source.id.slice("source_".length)}.${plaintext}`,
        expiresAt: source.expiresAt,
        credentialGeneration: source.credentialGeneration,
      };
    }, () => this.emit("rotated", principal.sourceId));
  }

  revoke(sourceId: string, nowMs = Date.now()): boolean {
    return this.commit((draft) => {
      const source = draft.sources.find((candidate) => candidate.id === sourceId);
      if (!source || source.revokedAt !== undefined) return false;
      source.revokedAt = nowMs;
      return true;
    }, () => this.emit("revoked", sourceId));
  }

  revokeAll(nowMs = Date.now()): number {
    const ids = this.data.sources.filter((source) => source.revokedAt === undefined).map((source) => source.id);
    const count = this.commit((draft) => {
      let changed = 0;
      for (const source of draft.sources) {
        if (source.revokedAt !== undefined) continue;
        source.revokedAt = nowMs;
        changed += 1;
      }
      return changed;
    });
    for (const id of ids) this.emit("revoked", id);
    return count;
  }

  invalidateCapabilities(nowMs = Date.now()): number {
    return this.commit((draft) => {
      let count = 0;
      for (const capability of draft.capabilities) {
        if (capability.expiresAt <= nowMs) continue;
        capability.expiresAt = nowMs;
        capability.usedAt ??= nowMs;
        count += 1;
      }
      return count;
    });
  }

  source(sourceId: string): AgentInputSourceRecord | undefined {
    const source = this.data.sources.find((candidate) => candidate.id === sourceId);
    return source ? structuredClone(source) : undefined;
  }

  sourceForPrincipal(principal: AgentInputSourcePrincipal, nowMs = Date.now()): AgentInputSourceRecord | undefined {
    const source = this.data.sources.find((candidate) => candidate.id === principal.sourceId);
    if (!source || source.revokedAt !== undefined || source.expiresAt <= nowMs
      || source.credentialId !== principal.credentialId
      || source.credentialGeneration !== principal.credentialGeneration
      || source.context.paneId !== principal.paneId) return undefined;
    return structuredClone(source);
  }

  registrationContext(capabilityId: string): AgentInputSourceContext | undefined {
    const capability = this.data.capabilities.find((candidate) => candidate.id === capabilityId);
    return capability ? structuredClone(capability.context) : undefined;
  }

  isAvailable(sourceId: string, nowMs = Date.now()): boolean {
    const source = this.data.sources.find((candidate) => candidate.id === sourceId);
    return Boolean(source && source.supported && source.revokedAt === undefined && source.expiresAt > nowMs);
  }

  snapshot(): Envelope {
    return structuredClone(this.data);
  }

  prune(nowMs = Date.now()): void {
    this.commit((draft) => {
      draft.capabilities = draft.capabilities.filter((capability) => capability.expiresAt > nowMs);
      draft.capabilityTombstones = draft.capabilityTombstones.filter((tombstone) => tombstone.expiresAt > nowMs);
      draft.sources = draft.sources.filter((source) =>
        (source.revokedAt ?? source.expiresAt) + DEFAULT_AGENT_INPUT_SOURCE_RETENTION_MS > nowMs);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  private verifier(kind: "capability" | "source", id: string, secret: string): z.infer<typeof verifierSchema> {
    return {
      kind: "hmac-sha256",
      digest: crypto.createHmac("sha256", this.options.hashKey)
        .update(`wmux-agent-input-${kind}\0${id}\0${secret}`)
        .digest("hex"),
    };
  }

  private verify(
    kind: "capability" | "source",
    id: string,
    secret: string,
    verifier: z.infer<typeof verifierSchema>,
  ): boolean {
    const actual = Buffer.from(this.verifier(kind, id, secret).digest, "hex");
    const expected = Buffer.from(verifier.digest, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  private commit<T>(mutate: (draft: Envelope) => T, after?: () => void): T {
    const draft = structuredClone(this.data);
    const result = mutate(draft);
    envelopeSchema.parse(draft);
    if (JSON.stringify(draft) !== JSON.stringify(this.data)) {
      this.persist(draft, true);
      this.data = draft;
      this.emit("change");
      after?.();
    }
    return structuredClone(result);
  }

  private load(): { data: Envelope; recovered: boolean; migrated: boolean } {
    if (!fs.existsSync(this.filePath)) return { data: emptyEnvelope(), recovered: false, migrated: false };
    const primary = this.readEnvelope(this.filePath);
    if (primary) return { data: primary.data, recovered: false, migrated: primary.migrated };
    const backup = this.readEnvelope(`${this.filePath}.bak`);
    if (!backup) throw new Error(`wmux agent input credential store is invalid: ${this.filePath}`);
    fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    this.fsyncContainingDirectory("quarantine");
    return { data: backup.data, recovered: true, migrated: backup.migrated };
  }

  private readEnvelope(filePath: string): { data: Envelope; migrated: boolean } | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    this.assertSecureFile(filePath);
    try {
      const input = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      const version = input && typeof input === "object" ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
      if (typeof version === "number" && Number.isInteger(version) && version > CURRENT_AGENT_INPUT_CREDENTIAL_SCHEMA_VERSION) {
        throw new UnsupportedAgentInputCredentialVersionError(version);
      }
      if (version === 0) {
        const old = envelopeV0Schema.parse(input);
        return {
          data: invalidateLegacyEnvelope(old.capabilities, old.sources, [], this.options.hashKey),
          migrated: true,
        };
      }
      if (version === 1) {
        const old = envelopeV1Schema.parse(input);
        return {
          data: invalidateLegacyEnvelope(old.capabilities, old.sources, old.capabilityTombstones, this.options.hashKey),
          migrated: true,
        };
      }
      const parsed = envelopeSchema.safeParse(input);
      return parsed.success ? { data: parsed.data, migrated: false } : undefined;
    } catch (error) {
      if (error instanceof UnsupportedAgentInputCredentialVersionError) throw error;
      return undefined;
    }
  }

  private persist(data: Envelope, rotateBackup: boolean): void {
    this.ensureSecureParent();
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(handle, `${JSON.stringify(data, null, 2)}\n`);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      if (rotateBackup && fs.existsSync(this.filePath) && this.readEnvelope(this.filePath)) {
        const backupPath = `${this.filePath}.bak`;
        if (fs.existsSync(backupPath)) this.assertSecureFile(backupPath);
        const backupTemporary = `${backupPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
        const backupHandle = fs.openSync(backupTemporary, "wx", 0o600);
        try {
          fs.writeFileSync(backupHandle, fs.readFileSync(this.filePath));
          fs.fsyncSync(backupHandle);
        } finally {
          fs.closeSync(backupHandle);
        }
        fs.renameSync(backupTemporary, backupPath);
        this.fsyncContainingDirectory("backup");
      }
      this.options.beforeRename?.();
      fs.renameSync(temporary, this.filePath);
      this.fsyncContainingDirectory("primary");
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  private ensureSecureParent(): void {
    const parentPath = path.dirname(path.resolve(this.filePath));
    if (!fs.existsSync(parentPath)) fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(parentPath) !== parentPath) {
      throw new Error("agent input credential parent directory must not use symlinks");
    }
    if (typeof process.getuid === "function" && parent.uid !== process.getuid()) {
      throw new Error("agent input credential parent directory must be owned by the wmux user");
    }
    if ((parent.mode & 0o077) !== 0) throw new Error("agent input credential parent directory must be owner-only");
  }

  private assertSecureFile(filePath: string): void {
    const file = fs.lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink() || fs.realpathSync(filePath) !== path.resolve(filePath)) {
      throw new Error("agent input credential store must be a regular non-symlink file");
    }
    if (typeof process.getuid === "function" && file.uid !== process.getuid()) {
      throw new Error("agent input credential store must be owned by the wmux user");
    }
    if ((file.mode & 0o777) !== 0o600) throw new Error("agent input credential store permissions must be 0600");
  }

  private fsyncContainingDirectory(target: "backup" | "primary" | "quarantine"): void {
    const directory = path.dirname(path.resolve(this.filePath));
    if (this.options.directoryFsync) {
      this.options.directoryFsync(directory, target);
      return;
    }
    fsyncDirectory(directory);
  }
}

/** Pane-staging seam: derive the immutable binding from server state, never caller input. */
export const issueAgentInputRegistrationCapabilityForPane = (
  store: AgentInputCredentialStore,
  state: StateStore,
  paneId: string,
  nowMs = Date.now(),
): AgentInputRegistrationCapability => {
  const context = state.findPaneContext(paneId);
  if (!context) throw new AgentInputCredentialError("pane_unavailable");
  return store.issueRegistrationCapability({
    workspaceId: context.workspace.id,
    tabId: context.tab.id,
    paneId: context.pane.id,
    machineId: context.pane.machineId,
    sourceKind: "opencode",
  }, nowMs);
};

const emptyEnvelope = (): Envelope => ({
  schemaVersion: 2,
  capabilities: [],
  sources: [],
  capabilityTombstones: [],
});

const invalidateLegacyEnvelope = (
  capabilities: Array<z.infer<typeof legacyCapabilitySchema>>,
  sources: Array<z.infer<typeof legacySourceSchema>>,
  capabilityTombstones: Envelope["capabilityTombstones"],
  hashKey: string,
): Envelope => {
  const invalid = (kind: string, id: string): z.infer<typeof verifierSchema> => ({
    kind: "hmac-sha256",
    digest: crypto.createHmac("sha256", hashKey).update(`invalidated-${kind}\0${id}`).digest("hex"),
  });
  return {
    schemaVersion: 2,
    capabilities: capabilities.map(({ hash: _hash, ...capability }) => ({
      ...capability,
      verifier: invalid("capability", capability.id),
      usedAt: capability.usedAt ?? capability.issuedAt,
    })),
    sources: sources.map(({ secretHash: _secretHash, ...source }) => ({
      ...source,
      secretVerifier: invalid("source", source.id),
      revokedAt: source.revokedAt ?? source.refreshedAt,
    })),
    capabilityTombstones,
  };
};

const invalidateRecoveredEnvelope = (input: Envelope, hashKey: string, nowMs = Date.now()): Envelope => {
  const invalid = (kind: string, id: string): z.infer<typeof verifierSchema> => ({
    kind: "hmac-sha256",
    digest: crypto.createHmac("sha256", hashKey).update(`recovery-invalidated-${kind}\0${id}\0${nowMs}`).digest("hex"),
  });
  return {
    ...structuredClone(input),
    capabilities: input.capabilities.map((capability) => ({
      ...capability,
      verifier: invalid("capability", capability.id),
      expiresAt: Math.min(capability.expiresAt, nowMs),
      usedAt: capability.usedAt ?? nowMs,
    })),
    sources: input.sources.map((source) => ({
      ...source,
      secretVerifier: invalid("source", source.id),
      revokedAt: source.revokedAt ?? nowMs,
    })),
  };
};

export const loadOrCreateAgentInputSecret = (filePath: string): string => {
  const parent = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent || (parentStat.mode & 0o077) !== 0) {
    throw new Error("agent input secret parent must be owner-only and must not use symlinks");
  }
  if (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) {
    throw new Error("agent input secret parent must be owned by the wmux user");
  }
  if (fs.existsSync(filePath)) {
    const file = fs.lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink() || fs.realpathSync(filePath) !== path.resolve(filePath)
      || (file.mode & 0o777) !== 0o600) {
      throw new Error("agent input secret must be a regular 0600 file");
    }
    if (typeof process.getuid === "function" && file.uid !== process.getuid()) {
      throw new Error("agent input secret must be owned by the wmux user");
    }
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
    throw new Error("agent input secret is invalid");
  }
  const secret = crypto.randomBytes(32).toString("base64url");
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, `${secret}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(parent);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return secret;
};

const fsyncDirectory = (directory: string): void => {
  const handle = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
};
