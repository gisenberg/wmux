import crypto from "node:crypto";
import fs from "node:fs";
import { hasPrivatePermissions } from "./private-permissions.js";
import path from "node:path";
import { z } from "zod";
import type { AuthConfig } from "./auth.js";

export const CURRENT_SCOPED_CREDENTIAL_SCHEMA_VERSION = 1;
export const DEFAULT_SCOPED_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_SCOPED_CREDENTIAL_TTL_MS = 60 * 60 * 1_000;
const MAX_SCOPED_CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

export type ScopedCredentialKind = "automation" | "helper";

const credentialRecordSchema = z.object({
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict();

const credentialEnvelopeSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCOPED_CREDENTIAL_SCHEMA_VERSION),
  credentials: z.object({
    automation: credentialRecordSchema.optional(),
    helper: credentialRecordSchema.optional(),
  }).strict(),
}).strict();

interface ScopedCredentialRecord {
  tokenDigest: string;
  issuedAt: number;
  expiresAt: number;
}

interface ScopedCredentialEnvelope {
  schemaVersion: number;
  credentials: Partial<Record<ScopedCredentialKind, ScopedCredentialRecord>>;
}

export interface ScopedCredentialMetadata {
  kind: ScopedCredentialKind;
  issuedAt: number;
  expiresAt: number;
  rotatable: boolean;
}

export class ScopedCredentialRotationError extends Error {
  constructor(readonly code: "credential_not_configured" | "credential_not_file_backed") {
    super(code);
    this.name = "ScopedCredentialRotationError";
  }
}

export class UnsupportedScopedCredentialVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `scoped credential schema ${version} is newer than this wmux build supports (${CURRENT_SCOPED_CREDENTIAL_SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedScopedCredentialVersionError";
  }
}

const configuredTtlMs = (): number => {
  const raw = process.env.WMUX_SCOPED_CREDENTIAL_TTL_MS?.trim();
  if (!raw) return DEFAULT_SCOPED_CREDENTIAL_TTL_MS;
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < MIN_SCOPED_CREDENTIAL_TTL_MS
    || parsed > MAX_SCOPED_CREDENTIAL_TTL_MS
  ) {
    throw new Error(
      `WMUX_SCOPED_CREDENTIAL_TTL_MS must be an integer from ${MIN_SCOPED_CREDENTIAL_TTL_MS} to ${MAX_SCOPED_CREDENTIAL_TTL_MS}`,
    );
  }
  return parsed;
};

export class ScopedCredentialStore {
  private records: Partial<Record<ScopedCredentialKind, ScopedCredentialRecord>>;

  constructor(
    private readonly auth: AuthConfig,
    private readonly filePath: string,
    private readonly ttlMs = configuredTtlMs(),
    nowMs = Date.now(),
  ) {
    this.ensureSecureParent();
    this.records = this.load();
    let changed = false;
    for (const kind of ["automation", "helper"] as const) {
      const token = this.token(kind);
      if (!token) {
        if (this.records[kind]) {
          delete this.records[kind];
          changed = true;
        }
        continue;
      }
      const digest = this.digest(token);
      if (this.records[kind]?.tokenDigest !== digest) {
        this.records[kind] = {
          tokenDigest: digest,
          issuedAt: nowMs,
          expiresAt: nowMs + ttlMs,
        };
        changed = true;
      }
    }
    if (changed || !fs.existsSync(this.filePath)) this.persist();
  }

  authenticate(
    presented: string,
    nowMs = Date.now(),
  ): ScopedCredentialKind | undefined {
    for (const kind of ["automation", "helper"] as const) {
      const token = this.token(kind);
      const record = this.records[kind];
      if (
        token
        && record
        && record.expiresAt > nowMs
        && this.safeEqual(token, presented)
      ) {
        return kind;
      }
    }
    return undefined;
  }

  list(): ScopedCredentialMetadata[] {
    return (["automation", "helper"] as const).flatMap((kind) => {
      const record = this.records[kind];
      if (!record || !this.token(kind)) return [];
      return [{
        kind,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        rotatable: Boolean(this.tokenPath(kind)),
      }];
    });
  }

  rotate(kind: ScopedCredentialKind, nowMs = Date.now()): ScopedCredentialMetadata {
    if (!this.token(kind)) {
      throw new ScopedCredentialRotationError("credential_not_configured");
    }
    const tokenPath = this.tokenPath(kind);
    if (!tokenPath) {
      throw new ScopedCredentialRotationError("credential_not_file_backed");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    this.persistToken(tokenPath, token);
    if (kind === "automation") this.auth.automationToken = token;
    else this.auth.helperToken = token;
    this.records[kind] = {
      tokenDigest: this.digest(token),
      issuedAt: nowMs,
      expiresAt: nowMs + this.ttlMs,
    };
    this.persist();
    return this.list().find((record) => record.kind === kind)!;
  }

  private token(kind: ScopedCredentialKind): string | undefined {
    return kind === "automation"
      ? this.auth.automationToken
      : this.auth.helperToken;
  }

  private tokenPath(kind: ScopedCredentialKind): string | undefined {
    return kind === "automation"
      ? this.auth.automationTokenPath
      : this.auth.helperTokenPath;
  }

  private digest(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private safeEqual(expected: string, presented: string): boolean {
    const left = Buffer.from(expected);
    const right = Buffer.from(presented);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  private load(): Partial<Record<ScopedCredentialKind, ScopedCredentialRecord>> {
    const primary = this.readEnvelope(this.filePath);
    if (primary) return primary.credentials;
    const backup = this.readEnvelope(`${this.filePath}.bak`);
    if (!backup) return {};
    if (fs.existsSync(this.filePath)) {
      const quarantinePath = `${this.filePath}.corrupt-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}`;
      fs.renameSync(this.filePath, quarantinePath);
    }
    return backup.credentials;
  }

  private readEnvelope(filePath: string): ScopedCredentialEnvelope | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    this.assertSecureFile(filePath);
    try {
      const input = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return undefined;
      }
      const version = (input as Record<string, unknown>).schemaVersion;
      if (
        typeof version === "number"
        && Number.isInteger(version)
        && version > CURRENT_SCOPED_CREDENTIAL_SCHEMA_VERSION
      ) {
        throw new UnsupportedScopedCredentialVersionError(version);
      }
      return credentialEnvelopeSchema.parse(input);
    } catch (error) {
      if (error instanceof UnsupportedScopedCredentialVersionError) throw error;
      return undefined;
    }
  }

  private persist(): void {
    const envelope: ScopedCredentialEnvelope = {
      schemaVersion: CURRENT_SCOPED_CREDENTIAL_SCHEMA_VERSION,
      credentials: this.records,
    };
    if (fs.existsSync(this.filePath)) {
      this.assertSecureFile(this.filePath);
      fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
      fs.chmodSync(`${this.filePath}.bak`, 0o600);
    }
    this.atomicWrite(this.filePath, JSON.stringify(envelope));
  }

  private persistToken(tokenPath: string, token: string): void {
    const parentPath = path.dirname(path.resolve(tokenPath));
    fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("scoped credential token parent must be a regular directory");
    }
    if (!hasPrivatePermissions(parentPath, parent, true)) {
      throw new Error("scoped credential token parent must be owner-only");
    }
    if (fs.existsSync(tokenPath)) this.assertSecureFile(tokenPath);
    this.atomicWrite(tokenPath, `${token}\n`);
  }

  private atomicWrite(targetPath: string, value: string): void {
    const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = fs.openSync(temporaryPath, "wx", 0o600);
      try {
        fs.writeFileSync(handle, value);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, targetPath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private ensureSecureParent(): void {
    const parentPath = path.dirname(path.resolve(this.filePath));
    fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(parentPath);
    if (
      !parent.isDirectory()
      || parent.isSymbolicLink()
      || fs.realpathSync(parentPath) !== parentPath
    ) {
      throw new Error("scoped credential parent directory must not use symlinks");
    }
    if (
      typeof process.getuid === "function"
      && parent.uid !== process.getuid()
    ) {
      throw new Error("scoped credential parent directory must be owned by the wmux user");
    }
    if (!hasPrivatePermissions(parentPath, parent, true)) {
      throw new Error("scoped credential parent directory must be owner-only");
    }
  }

  private assertSecureFile(filePath: string): void {
    const file = fs.lstatSync(filePath);
    if (
      !file.isFile()
      || file.isSymbolicLink()
      || fs.realpathSync(filePath) !== path.resolve(filePath)
    ) {
      throw new Error("scoped credential record must be a regular non-symlink file");
    }
    if (
      typeof process.getuid === "function"
      && file.uid !== process.getuid()
    ) {
      throw new Error("scoped credential record must be owned by the wmux user");
    }
    if (!hasPrivatePermissions(filePath, file)) {
      throw new Error("scoped credential record permissions must be 0600");
    }
  }
}
