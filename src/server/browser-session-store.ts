import crypto from "node:crypto";
import fs from "node:fs";
import { hasPrivatePermissions } from "./private-permissions.js";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const CURRENT_BROWSER_SESSION_SCHEMA_VERSION = 2;
const MAX_BROWSER_SESSIONS = 1_000;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SESSION_LABEL_LENGTH = 256;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

const defaultBrowserSessionPath = (): string =>
  path.join(os.homedir(), ".wmux", "browser-sessions.json");

const browserSessionRecordSchema = z.object({
  id: z.string().min(1).max(128),
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  lastSeenAt: z.number().int().nonnegative(),
  device: z.string().min(1).max(MAX_SESSION_LABEL_LENGTH),
  address: z.string().min(1).max(MAX_SESSION_LABEL_LENGTH),
}).strict();

const legacyBrowserSessionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  sessions: z.array(z.object({
    id: z.string().min(1).max(128),
    tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  }).strict()).max(MAX_BROWSER_SESSIONS),
}).strict();

const browserSessionEnvelopeSchema = z.object({
  schemaVersion: z.literal(CURRENT_BROWSER_SESSION_SCHEMA_VERSION),
  sessions: z.array(browserSessionRecordSchema).max(MAX_BROWSER_SESSIONS),
}).strict();

export interface BrowserSessionRecord {
  id: string;
  tokenDigest: string;
  issuedAt: number;
  expiresAt: number;
  lastSeenAt: number;
  device: string;
  address: string;
}

export interface IssuedBrowserSession {
  id: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export interface BrowserSessionMetadata {
  id: string;
  issuedAt: number;
  expiresAt: number;
  lastSeenAt: number;
  device: string;
  address: string;
}

export interface BrowserSessionObservation {
  device?: string;
  address?: string;
}

interface BrowserSessionEnvelope {
  schemaVersion: number;
  sessions: BrowserSessionRecord[];
}

export class UnsupportedBrowserSessionVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `browser session schema ${version} is newer than this wmux build supports (${CURRENT_BROWSER_SESSION_SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedBrowserSessionVersionError";
  }
}

export class BrowserSessionStore {
  private sessions: BrowserSessionRecord[];
  private readonly revocationListeners = new Set<(sessionId: string) => void>();

  constructor(
    private readonly secret: string,
    private readonly filePath?: string,
  ) {
    if (filePath) this.ensureSecureParent();
    this.sessions = this.load();
  }

  static persistent(
    secret: string,
    filePath = process.env.WMUX_BROWSER_SESSION_PATH
      ?? defaultBrowserSessionPath(),
  ): BrowserSessionStore {
    return new BrowserSessionStore(secret, filePath);
  }

  issue(
    ttlMs: number,
    nowMs = Date.now(),
    observation: BrowserSessionObservation = {},
  ): IssuedBrowserSession {
    this.pruneExpired(nowMs);
    const token = crypto.randomBytes(32).toString("base64url");
    const record: BrowserSessionRecord = {
      id: `session_${crypto.randomBytes(16).toString("base64url")}`,
      tokenDigest: this.digest(token),
      issuedAt: nowMs,
      expiresAt: nowMs + ttlMs,
      lastSeenAt: nowMs,
      device: this.normalizeLabel(observation.device, "Unknown browser"),
      address: this.normalizeLabel(observation.address, "unknown"),
    };
    this.sessions.push(record);
    this.sessions = this.sessions
      .sort((left, right) => left.issuedAt - right.issuedAt)
      .slice(-MAX_BROWSER_SESSIONS);
    this.persist();
    return {
      id: record.id,
      token,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    };
  }

  authenticate(
    token: string | null,
    nowMs = Date.now(),
    observation: BrowserSessionObservation = {},
  ): BrowserSessionRecord | undefined {
    if (!token || !SESSION_TOKEN_PATTERN.test(token)) return undefined;
    const tokenDigest = this.digest(token);
    const record = this.sessions.find(
      (candidate) => candidate.tokenDigest === tokenDigest,
    );
    if (!record) return undefined;
    if (record.expiresAt <= nowMs) {
      this.sessions = this.sessions.filter(
        (candidate) => candidate.id !== record.id,
      );
      this.persist();
      return undefined;
    }
    const device = this.normalizeLabel(observation.device, record.device);
    const address = this.normalizeLabel(observation.address, record.address);
    if (
      device !== record.device
      || address !== record.address
      || nowMs - record.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS
    ) {
      record.device = device;
      record.address = address;
      record.lastSeenAt = nowMs;
      this.persist();
    }
    return structuredClone(record);
  }

  list(nowMs = Date.now()): BrowserSessionMetadata[] {
    this.pruneExpired(nowMs);
    return this.sessions
      .slice()
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map(({ tokenDigest: _tokenDigest, ...metadata }) =>
        structuredClone(metadata)
      );
  }

  revoke(sessionId: string): boolean {
    const retained = this.sessions.filter((session) => session.id !== sessionId);
    if (retained.length === this.sessions.length) return false;
    this.sessions = retained;
    this.persist();
    for (const listener of this.revocationListeners) listener(sessionId);
    return true;
  }

  onRevoke(listener: (sessionId: string) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  private digest(token: string): string {
    return crypto
      .createHmac("sha256", this.secret)
      .update(token)
      .digest("hex");
  }

  private normalizeLabel(value: string | undefined, fallback: string): string {
    const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    return (normalized || fallback).slice(0, MAX_SESSION_LABEL_LENGTH);
  }

  private pruneExpired(nowMs: number): void {
    const retained = this.sessions.filter(
      (session) => session.expiresAt > nowMs,
    );
    if (retained.length === this.sessions.length) return;
    this.sessions = retained;
    this.persist();
  }

  private load(): BrowserSessionRecord[] {
    if (!this.filePath) return [];
    const primary = this.readEnvelope(this.filePath);
    if (primary) return this.retainCurrent(primary.sessions);
    const backup = this.readEnvelope(`${this.filePath}.bak`);
    if (!backup) return [];
    if (fs.existsSync(this.filePath)) {
      const quarantinePath = `${this.filePath}.corrupt-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}`;
      fs.renameSync(this.filePath, quarantinePath);
    }
    return this.retainCurrent(backup.sessions);
  }

  private retainCurrent(sessions: BrowserSessionRecord[]): BrowserSessionRecord[] {
    return sessions
      .filter((session) => session.expiresAt > Date.now())
      .sort((left, right) => left.issuedAt - right.issuedAt)
      .slice(-MAX_BROWSER_SESSIONS);
  }

  private readEnvelope(
    filePath: string,
  ): BrowserSessionEnvelope | undefined {
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
        && version > CURRENT_BROWSER_SESSION_SCHEMA_VERSION
      ) {
        throw new UnsupportedBrowserSessionVersionError(version);
      }
      if (version === 1) {
        const legacy = legacyBrowserSessionEnvelopeSchema.parse(input);
        return {
          schemaVersion: CURRENT_BROWSER_SESSION_SCHEMA_VERSION,
          sessions: legacy.sessions.map((session) => ({
            ...session,
            lastSeenAt: session.issuedAt,
            device: "Unknown browser",
            address: "unknown",
          })),
        };
      }
      return browserSessionEnvelopeSchema.parse(input);
    } catch (error) {
      if (error instanceof UnsupportedBrowserSessionVersionError) throw error;
      return undefined;
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    this.ensureSecureParent();
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto
      .randomBytes(8)
      .toString("hex")}.tmp`;
    const envelope: BrowserSessionEnvelope = {
      schemaVersion: CURRENT_BROWSER_SESSION_SCHEMA_VERSION,
      sessions: this.sessions,
    };
    try {
      const handle = fs.openSync(temporaryPath, "wx", 0o600);
      try {
        fs.writeFileSync(handle, JSON.stringify(envelope));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.chmodSync(temporaryPath, 0o600);
      if (fs.existsSync(this.filePath)) {
        this.assertSecureFile(this.filePath);
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
        fs.chmodSync(`${this.filePath}.bak`, 0o600);
      }
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private ensureSecureParent(): void {
    if (!this.filePath) return;
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
      throw new Error("browser session parent directory must not use symlinks");
    }
    if (
      typeof process.getuid === "function"
      && parent.uid !== process.getuid()
    ) {
      throw new Error("browser session parent directory must be owned by the wmux user");
    }
    if (!hasPrivatePermissions(parentPath, parent, true)) {
      throw new Error("browser session parent directory must be owner-only");
    }
  }

  private assertSecureFile(filePath: string): void {
    const file = fs.lstatSync(filePath);
    if (
      !file.isFile()
      || file.isSymbolicLink()
      || fs.realpathSync(filePath) !== path.resolve(filePath)
    ) {
      throw new Error("browser session record must be a regular non-symlink file");
    }
    if (
      typeof process.getuid === "function"
      && file.uid !== process.getuid()
    ) {
      throw new Error("browser session record must be owned by the wmux user");
    }
    if (!hasPrivatePermissions(filePath, file)) {
      throw new Error("browser session record permissions must be 0600");
    }
  }
}
