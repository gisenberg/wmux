import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  authenticateRequest,
  hashPassword,
  issueSessionToken,
  loadAuthConfig,
  loadRegistrationAuthConfig,
  requestBearerToken,
  requestToken,
  tokensMatch,
  validateAuthCredentialSeparation,
  verifyCredentials,
  type AuthConfig,
} from "../src/server/auth.js";

const fakeRequest = (headers: Record<string, string> = {}): http.IncomingMessage =>
  ({ headers } as unknown as http.IncomingMessage);

const urlWith = (query = ""): URL => new URL(`http://host/api/x${query}`);

const baseAuth = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  enabled: true,
  token: "s3cret",
  loginEnabled: false,
  sessionSecret: "sign-key",
  ...over,
});

// Run a callback with a hermetic ~/.wmux so loadAuthConfig never touches real home.
const withIsolatedHome = (run: (dir: string) => void): void => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-auth-"));
  process.env.HOME = dir;
  process.env.WMUX_TOKEN_PATH = path.join(dir, "token");
  process.env.WMUX_AUTH_PATH = path.join(dir, "auth.json");
  process.env.WMUX_SESSION_SECRET_PATH = path.join(dir, "session-secret");
  process.env.WMUX_REGISTRATION_TOKEN_PATH = path.join(dir, "registration-token");
  delete process.env.WMUX_DISABLE_AUTH;
  delete process.env.WMUX_ALLOW_INSECURE_DEFAULT_LOGIN;
  delete process.env.WMUX_TOKEN;
  delete process.env.WMUX_REGISTRATION_TOKEN;
  delete process.env.WMUX_BROWSER_AUTH_MODE;
  delete process.env.WMUX_AUTOMATION_TOKEN;
  delete process.env.WMUX_AUTOMATION_TOKEN_PATH;
  delete process.env.WMUX_HELPER_TOKEN;
  delete process.env.WMUX_HELPER_TOKEN_PATH;
  try {
    run(dir);
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("tokensMatch is exact and constant-length-safe", () => {
  assert.equal(tokensMatch("secret", "secret"), true);
  assert.equal(tokensMatch("secret", "secre"), false);
  assert.equal(tokensMatch("secret", null), false);
});

test("requestToken reads Authorization header then query", () => {
  assert.equal(requestToken(fakeRequest({ authorization: "Bearer abc" }), urlWith()), "abc");
  assert.equal(requestToken(fakeRequest(), urlWith("?token=qtok")), "qtok");
  assert.equal(requestToken(fakeRequest(), urlWith()), null);
  assert.equal(requestBearerToken(fakeRequest({ authorization: "Bearer abc" })), "abc");
  assert.equal(requestBearerToken(fakeRequest()), null);
});

test("request authentication accepts the shared token and rejects a bad one", () => {
  const auth = baseAuth();
  assert.equal(authenticateRequest(auth, fakeRequest({ authorization: "Bearer s3cret" }), urlWith()).kind, "legacy-shared");
  assert.equal(authenticateRequest(auth, fakeRequest(), urlWith("?token=s3cret")).kind, "legacy-shared");
  assert.equal(authenticateRequest(auth, fakeRequest({ authorization: "Bearer nope" }), urlWith()).kind, "anonymous");
  assert.equal(authenticateRequest(auth, fakeRequest(), urlWith()).kind, "anonymous");
});

test("authentication-disabled requests remain anonymous for policy-level bypass", () => {
  assert.equal(authenticateRequest(baseAuth({ enabled: false }), fakeRequest(), urlWith()).kind, "anonymous");
});

test("scrypt password hashing verifies the right password only", async () => {
  const auth = baseAuth({ loginEnabled: true, credentials: { username: "wmux", passwordHash: hashPassword("hunter2") } });
  assert.equal(await verifyCredentials(auth, "wmux", "hunter2"), true);
  assert.equal(await verifyCredentials(auth, "wmux", "wrong"), false);
  assert.equal(await verifyCredentials(auth, "other", "hunter2"), false);
});

test("a session token authorizes until it expires", () => {
  const auth = baseAuth();
  const now = 1_000_000;
  const token = issueSessionToken(auth.sessionSecret, 60_000, now);
  assert.equal(authenticateRequest(auth, fakeRequest({ authorization: `Bearer ${token}` }), urlWith(), now + 30_000).kind, "browser-session");
  assert.equal(authenticateRequest(auth, fakeRequest({ authorization: `Bearer ${token}` }), urlWith(), now + 120_000).kind, "anonymous");
});

test("a session token forged with the wrong secret is rejected", () => {
  const token = issueSessionToken("attacker-key", 60_000, 1_000_000);
  assert.equal(authenticateRequest(baseAuth(), fakeRequest({ authorization: `Bearer ${token}` }), urlWith(), 1_000_001).kind, "anonymous");
});

test("loadAuthConfig honors WMUX_DISABLE_AUTH", () => {
  const saved = { ...process.env };
  try {
    process.env.WMUX_DISABLE_AUTH = "1";
    const auth = loadAuthConfig();
    assert.equal(auth.enabled, false);
    assert.equal(auth.token, "");
  } finally {
    process.env = saved;
  }
});

test("registration auth persists a separate token even when main auth is disabled", () => {
  withIsolatedHome((dir) => {
    process.env.WMUX_DISABLE_AUTH = "1";
    const first = loadRegistrationAuthConfig();
    assert.ok(first.token.length >= 16);
    assert.equal(first.tokenPath, path.join(dir, "registration-token"));
    assert.equal(fs.readFileSync(first.tokenPath, "utf8").trim(), first.token);
    assert.equal(loadRegistrationAuthConfig().token, first.token);
  });
});

test("registration auth honors an environment token without writing a file", () => {
  withIsolatedHome((dir) => {
    process.env.WMUX_REGISTRATION_TOKEN = "registration-only";
    const registration = loadRegistrationAuthConfig();
    assert.deepEqual(registration, { token: "registration-only" });
    assert.equal(fs.existsSync(path.join(dir, "registration-token")), false);
  });
});

test("registration auth rejects values that cannot be sent as bearer headers", () => {
  withIsolatedHome(() => {
    process.env.WMUX_REGISTRATION_TOKEN = "first\nsecond";
    assert.throws(() => loadRegistrationAuthConfig(), /printable ASCII without spaces/);
  });
});

test("loadAuthConfig starts token-only without configured credentials", () => {
  withIsolatedHome((dir) => {
    const auth = loadAuthConfig();
    assert.equal(auth.enabled, true);
    assert.equal(auth.loginEnabled, false);
    assert.ok(auth.token.length >= 16);
    assert.equal(auth.tokenPath, path.join(dir, "token"));
    assert.equal(auth.tokenGenerated, true);
    assert.ok(auth.sessionSecret.length >= 16);
    assert.equal(fs.existsSync(path.join(dir, "auth.json")), false);
    assert.ok(fs.existsSync(path.join(dir, "session-secret")));
    assert.equal(fs.existsSync(path.join(dir, "automation-token")), false);
    assert.equal(fs.existsSync(path.join(dir, "helper-token")), false);
    assert.equal(auth.browserAuthMode, "shared-or-login");
  });
});

test("explicit shared-or-login preserves compatibility behavior without scoped files", () => {
  withIsolatedHome((dir) => {
    process.env.WMUX_BROWSER_AUTH_MODE = "shared-or-login";
    const auth = loadAuthConfig();
    assert.equal(auth.browserAuthMode, "shared-or-login");
    assert.ok(auth.token);
    assert.equal(auth.automationToken, undefined);
    assert.equal(auth.helperToken, undefined);
    assert.equal(fs.existsSync(path.join(dir, "automation-token")), false);
    assert.equal(fs.existsSync(path.join(dir, "helper-token")), false);
  });
});

test("invalid browser auth modes and auth disablement in login-only fail closed", () => {
  withIsolatedHome(() => {
    process.env.WMUX_BROWSER_AUTH_MODE = "typo";
    assert.throws(() => loadAuthConfig(), /WMUX_BROWSER_AUTH_MODE/);
    process.env.WMUX_BROWSER_AUTH_MODE = "login-only";
    process.env.WMUX_DISABLE_AUTH = "1";
    assert.throws(() => loadAuthConfig(), /cannot be used/);
  });
});

const writeSecret = (filePath: string, value: string): void => {
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
};

const useScopedPaths = (dir: string): void => {
  process.env.WMUX_AUTOMATION_TOKEN_PATH = path.join(dir, "automation-token");
  process.env.WMUX_HELPER_TOKEN_PATH = path.join(dir, "helper-token");
};

test("login-only loads persistent distinct credentials without creating a legacy token", () => {
  withIsolatedHome((dir) => {
    process.env.WMUX_BROWSER_AUTH_MODE = "login-only";
    useScopedPaths(dir);
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
      username: "operator",
      passwordHash: hashPassword("correct horse battery staple"),
    }));
    writeSecret(path.join(dir, "session-secret"), "S".repeat(43));
    writeSecret(path.join(dir, "automation-token"), "A".repeat(43));
    writeSecret(path.join(dir, "helper-token"), "H".repeat(43));
    const auth = loadAuthConfig();
    assert.equal(auth.browserAuthMode, "login-only");
    assert.equal(auth.token, "");
    assert.equal(auth.loginEnabled, true);
    assert.equal(auth.automationToken, "A".repeat(43));
    assert.equal(auth.helperToken, "H".repeat(43));
    assert.equal(fs.existsSync(path.join(dir, "token")), false);
  });
});

test("login-only rejects every missing mandatory credential", () => {
  for (const missing of ["credentials", "session", "automation", "helper"] as const) {
    withIsolatedHome((dir) => {
      process.env.WMUX_BROWSER_AUTH_MODE = "login-only";
      useScopedPaths(dir);
      if (missing !== "credentials") {
        fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ username: "operator", passwordHash: hashPassword("safe-password") }));
      }
      if (missing !== "session") writeSecret(path.join(dir, "session-secret"), "S".repeat(43));
      if (missing !== "automation") writeSecret(path.join(dir, "automation-token"), "A".repeat(43));
      if (missing !== "helper") writeSecret(path.join(dir, "helper-token"), "H".repeat(43));
      assert.throws(() => loadAuthConfig(), /login-only|missing or unreadable/);
    });
  }
});

test("login-only rejects malformed, unsafe, and duplicate scoped secret files", () => {
  withIsolatedHome((dir) => {
    process.env.WMUX_BROWSER_AUTH_MODE = "login-only";
    useScopedPaths(dir);
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ username: "operator", passwordHash: hashPassword("safe-password") }));
    writeSecret(path.join(dir, "session-secret"), "S".repeat(43));
    writeSecret(path.join(dir, "automation-token"), "too-short");
    writeSecret(path.join(dir, "helper-token"), "H".repeat(43));
    assert.throws(() => loadAuthConfig(), /32-256 base64url/);
  });
  withIsolatedHome((dir) => {
    process.env.WMUX_BROWSER_AUTH_MODE = "login-only";
    useScopedPaths(dir);
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ username: "operator", passwordHash: hashPassword("safe-password") }));
    writeSecret(path.join(dir, "session-secret"), "S".repeat(43));
    writeSecret(path.join(dir, "automation-token"), "A".repeat(43));
    writeSecret(path.join(dir, "helper-token"), "H".repeat(43));
    fs.chmodSync(path.join(dir, "helper-token"), 0o644);
    assert.throws(() => loadAuthConfig(), /permissions must be 0600/);
  });
  withIsolatedHome((dir) => {
    process.env.WMUX_BROWSER_AUTH_MODE = "login-only";
    useScopedPaths(dir);
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ username: "operator", passwordHash: hashPassword("safe-password") }));
    writeSecret(path.join(dir, "session-secret"), "S".repeat(43));
    writeSecret(path.join(dir, "real-token"), "A".repeat(43));
    fs.symlinkSync(path.join(dir, "real-token"), path.join(dir, "automation-token"));
    writeSecret(path.join(dir, "helper-token"), "H".repeat(43));
    assert.throws(() => loadAuthConfig(), /regular non-symlink/);
  });
  withIsolatedHome((dir) => {
    process.env.WMUX_BROWSER_AUTH_MODE = "login-only";
    useScopedPaths(dir);
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ username: "operator", passwordHash: hashPassword("safe-password") }));
    writeSecret(path.join(dir, "session-secret"), "S".repeat(43));
    writeSecret(path.join(dir, "automation-token"), "D".repeat(43));
    writeSecret(path.join(dir, "helper-token"), "D".repeat(43));
    assert.throws(() => loadAuthConfig(), /helper token must differ from automation token/);
  });
});

test("credential separation includes registration and machine agent secrets", () => {
  const auth = baseAuth({
    browserAuthMode: "login-only",
    automationToken: "A".repeat(43),
    helperToken: "H".repeat(43),
  });
  assert.throws(
    () => validateAuthCredentialSeparation(auth, "A".repeat(43), []),
    /host registration token must differ from automation token/,
  );
  assert.throws(
    () => validateAuthCredentialSeparation(auth, "R".repeat(43), [{ label: "machine agent token", token: "H".repeat(43) }]),
    /machine agent token must differ from helper token/,
  );
});

test("request authentication returns typed principals and keeps scoped tokens header-only", () => {
  const now = 1_000_000;
  const auth = baseAuth({
    browserAuthMode: "shared-or-login",
    automationToken: "A".repeat(43),
    helperToken: "H".repeat(43),
  });
  const session = issueSessionToken(auth.sessionSecret, 60_000, now);
  assert.equal(authenticateRequest(auth, fakeRequest(), urlWith()).kind, "anonymous");
  assert.equal(authenticateRequest(auth, fakeRequest({ authorization: "Bearer s3cret" }), urlWith()).kind, "legacy-shared");
  assert.equal(authenticateRequest(auth, fakeRequest({ authorization: `Bearer ${session}` }), urlWith(), now).kind, "browser-session");
  assert.equal(authenticateRequest(auth, fakeRequest({ authorization: `Bearer ${"A".repeat(43)}` }), urlWith()).kind, "automation");
  assert.equal(authenticateRequest(auth, fakeRequest({ authorization: `Bearer ${"H".repeat(43)}` }), urlWith()).kind, "helper");
  assert.equal(authenticateRequest(auth, fakeRequest(), urlWith(`?token=${"A".repeat(43)}`)).kind, "anonymous");
  assert.equal(authenticateRequest(auth, fakeRequest(), urlWith(`?token=${"H".repeat(43)}`)).kind, "anonymous");
  assert.equal(authenticateRequest({ ...auth, browserAuthMode: "login-only" }, fakeRequest({ authorization: "Bearer s3cret" }), urlWith()).kind, "anonymous");
});

test("loadAuthConfig does not mark an existing or environment token as newly generated", () => {
  withIsolatedHome((dir) => {
    const first = loadAuthConfig();
    const existing = loadAuthConfig();
    assert.equal(existing.token, first.token);
    assert.equal(existing.tokenPath, path.join(dir, "token"));
    assert.equal(existing.tokenGenerated, false);

    process.env.WMUX_TOKEN = "from-environment";
    const fromEnvironment = loadAuthConfig();
    assert.equal(fromEnvironment.token, "from-environment");
    assert.equal(fromEnvironment.tokenPath, undefined);
    assert.equal(fromEnvironment.tokenGenerated, false);
  });
});

test("loadAuthConfig refuses legacy default credentials", () => {
  withIsolatedHome((dir) => {
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ username: "wmux", passwordHash: hashPassword("wmux") }),
    );
    const auth = loadAuthConfig();
    assert.equal(auth.loginEnabled, false);
  });
});

test("loadAuthConfig allows legacy default credentials only by explicit opt-in", () => {
  withIsolatedHome((dir) => {
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ username: "wmux", passwordHash: hashPassword("wmux") }),
    );
    process.env.WMUX_ALLOW_INSECURE_DEFAULT_LOGIN = "1";
    const auth = loadAuthConfig();
    assert.equal(auth.loginEnabled, true);
    assert.deepEqual(auth.credentials?.username, "wmux");
  });
});

test("loadAuthConfig enables explicitly configured credentials", () => {
  withIsolatedHome((dir) => {
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ username: "operator", passwordHash: hashPassword("not-the-default") }),
    );
    const auth = loadAuthConfig();
    assert.equal(auth.loginEnabled, true);
    assert.deepEqual(auth.credentials?.username, "operator");
  });
});
