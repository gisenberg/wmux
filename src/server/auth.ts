import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const wmuxHome = (): string => path.join(os.homedir(), ".wmux");
const defaultTokenPath = (): string => path.join(wmuxHome(), "token");
const defaultAuthPath = (): string => path.join(wmuxHome(), "auth.json");
const defaultSessionSecretPath = (): string => path.join(wmuxHome(), "session-secret");
const defaultRegistrationTokenPath = (): string => path.join(wmuxHome(), "registration-token");
const defaultAutomationTokenPath = (): string => path.join(wmuxHome(), "automation-token");
const defaultHelperTokenPath = (): string => path.join(wmuxHome(), "helper-token");

const SCRYPT_KEYLEN = 32;
const SCOPED_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export type BrowserAuthMode = "shared-or-login" | "login-only";

export type AuthPrincipal =
  | { kind: "anonymous" }
  | { kind: "legacy-shared" }
  | { kind: "browser-session"; expiresAt: number }
  | { kind: "automation" }
  | { kind: "helper" }
  | { kind: "registration" }
  | { kind: "registered-host"; machineId: string };

export interface AuthCredentials {
  username: string;
  passwordHash: string;
}

export interface AuthConfig {
  /** When false, every request is allowed (explicit opt-out for trusted setups). */
  enabled: boolean;
  /** Shared static token — the path machines/helpers/curl use. */
  token: string;
  /** Present when the shared token is backed by a file rather than WMUX_TOKEN. */
  tokenPath?: string;
  /** True only for the process invocation that created the shared token. */
  tokenGenerated?: boolean;
  /** Whether username/password login is configured (drives the browser login UI). */
  loginEnabled: boolean;
  credentials?: AuthCredentials;
  /** HMAC key for signing stateless session tokens; survives restarts. */
  sessionSecret: string;
  browserAuthMode?: BrowserAuthMode;
  automationToken?: string;
  automationTokenPath?: string;
  helperToken?: string;
  helperTokenPath?: string;
}

/**
 * Resolve compatibility and scoped credentials. Compatibility mode retains the
 * shared token, while login-only requires persistent browser, automation, and
 * helper credentials without generating any missing scoped secret.
 */
export const loadAuthConfig = (): AuthConfig => {
  const browserAuthMode = loadBrowserAuthMode();
  if (process.env.WMUX_DISABLE_AUTH === "1") {
    if (browserAuthMode === "login-only") {
      throw new Error("WMUX_DISABLE_AUTH cannot be used with WMUX_BROWSER_AUTH_MODE=login-only");
    }
    return { enabled: false, token: "", loginEnabled: false, sessionSecret: "", browserAuthMode };
  }

  const sharedToken = browserAuthMode === "login-only" ? resolveExistingSharedToken() : resolveSharedToken();
  const credentials = loadCredentials();
  const sessionSecret = browserAuthMode === "login-only" ? loadRequiredSessionSecret() : loadOrCreateSessionSecret();
  const automation = resolveOptionalScopedToken(
    "WMUX_AUTOMATION_TOKEN",
    "WMUX_AUTOMATION_TOKEN_PATH",
    defaultAutomationTokenPath(),
  );
  const helper = resolveOptionalScopedToken("WMUX_HELPER_TOKEN", "WMUX_HELPER_TOKEN_PATH", defaultHelperTokenPath());
  const auth: AuthConfig = {
    enabled: true,
    token: sharedToken.token,
    tokenPath: sharedToken.tokenPath,
    tokenGenerated: sharedToken.generated,
    loginEnabled: Boolean(credentials),
    credentials: credentials ?? undefined,
    sessionSecret,
    browserAuthMode,
    automationToken: automation?.token,
    automationTokenPath: automation?.tokenPath,
    helperToken: helper?.token,
    helperTokenPath: helper?.tokenPath,
  };
  if (browserAuthMode === "login-only") {
    if (!credentials) throw new Error("login-only browser authentication requires valid password login credentials");
    if (!automation) throw new Error("login-only browser authentication requires WMUX_AUTOMATION_TOKEN or a valid token file");
    if (!helper) throw new Error("login-only browser authentication requires WMUX_HELPER_TOKEN or a valid token file");
  }
  if (browserAuthMode === "login-only" || automation || helper) validateDistinctSecrets(authSecretEntries(auth));
  return auth;
};

const loadBrowserAuthMode = (): BrowserAuthMode => {
  const value = process.env.WMUX_BROWSER_AUTH_MODE?.trim() || "shared-or-login";
  if (value === "shared-or-login" || value === "login-only") return value;
  throw new Error("WMUX_BROWSER_AUTH_MODE must be shared-or-login or login-only");
};

export interface RegistrationAuthConfig {
  token: string;
  /** Absent when the token was supplied directly through the environment. */
  tokenPath?: string;
}

const registrationToken = (value: string, source: string): string => {
  const token = value.trim();
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`${source} must contain printable ASCII without spaces`);
  }
  return token;
};

/**
 * Registration has its own credential so a host may announce itself without
 * gaining read access to sessions or the rest of the wmux API.
 */
export const loadRegistrationAuthConfig = (): RegistrationAuthConfig => {
  const fromEnv = process.env.WMUX_REGISTRATION_TOKEN?.trim();
  if (fromEnv) return { token: registrationToken(fromEnv, "WMUX_REGISTRATION_TOKEN") };

  const tokenPath = process.env.WMUX_REGISTRATION_TOKEN_PATH ?? defaultRegistrationTokenPath();
  const existing = readTrimmedFile(tokenPath);
  if (existing) return { token: registrationToken(existing, tokenPath), tokenPath };

  const generated = crypto.randomBytes(24).toString("base64url");
  persistSecretFile(tokenPath, `${generated}\n`);
  return { token: generated, tokenPath };
};

interface SharedTokenResolution {
  token: string;
  tokenPath?: string;
  generated: boolean;
}

const resolveExistingSharedToken = (): SharedTokenResolution => {
  const fromEnv = process.env.WMUX_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, generated: false };
  const tokenPath = process.env.WMUX_TOKEN_PATH ?? defaultTokenPath();
  const existing = readTrimmedFile(tokenPath);
  return existing
    ? { token: existing, tokenPath, generated: false }
    : { token: "", generated: false };
};

const resolveSharedToken = (): SharedTokenResolution => {
  const fromEnv = process.env.WMUX_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, generated: false };

  const tokenPath = process.env.WMUX_TOKEN_PATH ?? defaultTokenPath();
  const existing = readTrimmedFile(tokenPath);
  if (existing) return { token: existing, tokenPath, generated: false };

  const generated = crypto.randomBytes(24).toString("base64url");
  persistSecretFile(tokenPath, `${generated}\n`);
  return { token: generated, tokenPath, generated: true };
};

const loadCredentials = (): AuthCredentials | null => {
  const authPath = process.env.WMUX_AUTH_PATH ?? defaultAuthPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Partial<AuthCredentials>;
    if (
      typeof parsed.username === "string" && parsed.username &&
      typeof parsed.passwordHash === "string" && parsePasswordHash(parsed.passwordHash)
    ) {
      const credentials = { username: parsed.username, passwordHash: parsed.passwordHash };
      if (credentials.username === "wmux" && verifyPasswordHash("wmux", credentials.passwordHash)) {
        if (process.env.WMUX_ALLOW_INSECURE_DEFAULT_LOGIN === "1") {
          console.warn(`wmux: allowing the legacy default wmux/wmux login in ${authPath} by explicit opt-in.`);
          return credentials;
        }
        console.warn(`wmux: refusing the legacy default wmux/wmux login in ${authPath}; run wmux-set-password to enable browser login.`);
        return null;
      }
      return credentials;
    }
  } catch {
    /* Missing or invalid credentials leave browser password login disabled. */
  }
  return null;
};

const loadOrCreateSessionSecret = (): string => {
  const secretPath = process.env.WMUX_SESSION_SECRET_PATH ?? defaultSessionSecretPath();
  const existing = readTrimmedFile(secretPath);
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString("base64url");
  persistSecretFile(secretPath, `${generated}\n`);
  return generated;
};

const loadRequiredSessionSecret = (): string => {
  const secretPath = process.env.WMUX_SESSION_SECRET_PATH ?? defaultSessionSecretPath();
  return readValidatedSecretFile(secretPath, "browser session secret");
};

interface ScopedTokenResolution {
  token: string;
  tokenPath?: string;
}

const validateScopedSecret = (value: string, source: string): string => {
  const token = value.trim();
  if (!SCOPED_SECRET_PATTERN.test(token)) {
    throw new Error(`${source} must be 32-256 base64url characters`);
  }
  return token;
};

const resolveOptionalScopedToken = (
  valueName: string,
  pathName: string,
  recommendedPath: string,
): ScopedTokenResolution | undefined => {
  const fromEnv = process.env[valueName]?.trim();
  if (fromEnv) return { token: validateScopedSecret(fromEnv, valueName) };
  const configuredPath = process.env[pathName]?.trim();
  const tokenPath = configuredPath || recommendedPath;
  if (!configuredPath && !fs.existsSync(tokenPath)) return undefined;
  return { token: readValidatedSecretFile(tokenPath, valueName), tokenPath };
};

const readValidatedSecretFile = (filePath: string, label: string): string => {
  const resolvedPath = path.resolve(filePath);
  const parentPath = path.dirname(resolvedPath);
  let parent: fs.Stats;
  let file: fs.Stats;
  try {
    parent = fs.lstatSync(parentPath);
    file = fs.lstatSync(resolvedPath);
  } catch {
    throw new Error(`${label} file is missing or unreadable at ${resolvedPath}`);
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(parentPath) !== parentPath) {
    throw new Error(`${label} parent directory must not use symlinks`);
  }
  if (typeof process.getuid === "function" && parent.uid !== process.getuid()) {
    throw new Error(`${label} parent directory must be owned by the wmux user`);
  }
  if ((parent.mode & 0o077) !== 0) throw new Error(`${label} parent directory must be owner-only`);
  if (!file.isFile() || file.isSymbolicLink() || fs.realpathSync(resolvedPath) !== resolvedPath) {
    throw new Error(`${label} file must be a regular non-symlink file`);
  }
  if (typeof process.getuid === "function" && file.uid !== process.getuid()) {
    throw new Error(`${label} file must be owned by the wmux user`);
  }
  if ((file.mode & 0o777) !== 0o600) throw new Error(`${label} file permissions must be 0600`);
  return validateScopedSecret(fs.readFileSync(resolvedPath, "utf8"), label);
};

const readTrimmedFile = (filePath: string): string | null => {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
};

const persistSecretFile = (filePath: string, contents: string): void => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, { mode: 0o600 });
  } catch (error) {
    console.error(`wmux: could not persist ${filePath}: ${error instanceof Error ? error.message : error}`);
  }
};

// ---- Password hashing (scrypt) --------------------------------------------

/** Hash a password as `scrypt$<saltHex>$<hashHex>` for storage in auth.json. */
export const hashPassword = (password: string): string => {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
};

const parsePasswordHash = (stored: string): { salt: Buffer; expected: Buffer } | null => {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return null;
  return { salt, expected };
};

const verifyPasswordHash = (password: string, stored: string): boolean => {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(password, parsed.salt, parsed.expected.length);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(derived, parsed.expected);
};

const verifyPasswordHashAsync = async (password: string, stored: string): Promise<boolean> => {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  let derived: Buffer;
  try {
    derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, parsed.salt, parsed.expected.length, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(derived, parsed.expected);
};

export const verifyCredentials = async (auth: AuthConfig, username: string, password: string): Promise<boolean> => {
  if (!auth.credentials) return false;
  const userMatches = timingSafeStringEqual(auth.credentials.username, username);
  const passwordMatches = await verifyPasswordHashAsync(password, auth.credentials.passwordHash);
  // Evaluate both regardless of the username result to keep timing uniform.
  return userMatches && passwordMatches;
};

// ---- Stateless session tokens ---------------------------------------------

const SESSION_PREFIX = "wsess";

/** Mint a signed `wsess.<payload>.<sig>` token that self-expires after ttlMs. */
export const issueSessionToken = (secret: string, ttlMs: number, nowMs: number): string => {
  const payload = Buffer.from(JSON.stringify({ exp: nowMs + ttlMs })).toString("base64url");
  const body = `${SESSION_PREFIX}.${payload}`;
  return `${body}.${signBody(secret, body)}`;
};

const verifySessionToken = (secret: string, token: string, nowMs: number): number | null => {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_PREFIX) return null;
  const body = `${parts[0]}.${parts[1]}`;
  if (!timingSafeStringEqual(signBody(secret, body), parts[2])) return null;
  try {
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: number };
    return typeof decoded.exp === "number" && decoded.exp > nowMs ? decoded.exp : null;
  } catch {
    return null;
  }
};

const signBody = (secret: string, body: string): string =>
  crypto.createHmac("sha256", secret).update(body).digest("base64url");

// ---- Request authorization -------------------------------------------------

/** Extract a bearer token without accepting URL credentials. */
export const requestBearerToken = (request: http.IncomingMessage): string | null => {
  const header = request.headers.authorization;
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  return null;
};

/** Extract a presented token from the Authorization header or a `token` query param. */
export const requestToken = (request: http.IncomingMessage, url: URL): string | null => {
  const bearer = requestBearerToken(request);
  if (bearer) return bearer;
  const queryToken = url.searchParams.get("token");
  return queryToken ? queryToken.trim() : null;
};

const timingSafeStringEqual = (expected: string, presented: string): boolean => {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/** Back-compat helper: does a presented value equal the shared token? */
export const tokensMatch = (expected: string, presented: string | null): boolean =>
  Boolean(expected) && presented !== null && timingSafeStringEqual(expected, presented);

export const authenticateRequest = (
  auth: AuthConfig,
  request: http.IncomingMessage,
  url: URL,
  nowMs: number = Date.now(),
): AuthPrincipal => {
  if (!auth.enabled) return { kind: "anonymous" };
  const bearer = requestBearerToken(request);
  if (bearer) {
    if (auth.automationToken && tokensMatch(auth.automationToken, bearer)) return { kind: "automation" };
    if (auth.helperToken && tokensMatch(auth.helperToken, bearer)) return { kind: "helper" };
    if ((auth.browserAuthMode ?? "shared-or-login") === "shared-or-login" && tokensMatch(auth.token, bearer)) return { kind: "legacy-shared" };
    const expiresAt = auth.sessionSecret ? verifySessionToken(auth.sessionSecret, bearer, nowMs) : null;
    if (expiresAt !== null) return { kind: "browser-session", expiresAt };
    return { kind: "anonymous" };
  }
  const queryToken = url.searchParams.get("token")?.trim() || null;
  if ((auth.browserAuthMode ?? "shared-or-login") === "shared-or-login" && tokensMatch(auth.token, queryToken)) {
    return { kind: "legacy-shared" };
  }
  const expiresAt = queryToken && auth.sessionSecret
    ? verifySessionToken(auth.sessionSecret, queryToken, nowMs)
    : null;
  return expiresAt === null ? { kind: "anonymous" } : { kind: "browser-session", expiresAt };
};

export const registrationPrincipal = (expected: string | undefined, presented: string | null): AuthPrincipal =>
  expected && tokensMatch(expected, presented) ? { kind: "registration" } : { kind: "anonymous" };

export const registeredHostPrincipal = (
  machineId: string,
  accepted: boolean,
): AuthPrincipal => accepted ? { kind: "registered-host", machineId } : { kind: "anonymous" };

const authSecretEntries = (auth: AuthConfig): Array<[string, string | undefined]> => [
  ["legacy shared token", auth.token],
  ["browser session secret", auth.sessionSecret],
  ["automation token", auth.automationToken],
  ["helper token", auth.helperToken],
];

const validateDistinctSecrets = (entries: Array<[string, string | undefined]>): void => {
  const seen = new Map<string, string>();
  for (const [label, value] of entries) {
    if (!value) continue;
    const previous = seen.get(value);
    if (previous) throw new Error(`${label} must differ from ${previous}`);
    seen.set(value, label);
  }
};

export const validateAuthCredentialSeparation = (
  auth: AuthConfig,
  registrationToken: string,
  agentTokens: ReadonlyArray<{ label: string; token: string | undefined }>,
): void => {
  validateDistinctSecrets([
    ...authSecretEntries(auth),
    ["host registration token", registrationToken],
    ...agentTokens.map(({ label, token }): [string, string | undefined] => [label, token]),
  ]);
};
