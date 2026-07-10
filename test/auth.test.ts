import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  hashPassword,
  isAuthorized,
  issueSessionToken,
  loadAuthConfig,
  requestToken,
  tokensMatch,
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
  process.env.WMUX_TOKEN_PATH = path.join(dir, "token");
  process.env.WMUX_AUTH_PATH = path.join(dir, "auth.json");
  process.env.WMUX_SESSION_SECRET_PATH = path.join(dir, "session-secret");
  delete process.env.WMUX_DISABLE_AUTH;
  delete process.env.WMUX_ALLOW_INSECURE_DEFAULT_LOGIN;
  delete process.env.WMUX_TOKEN;
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
});

test("isAuthorized accepts the shared token, rejects a bad one", () => {
  const auth = baseAuth();
  assert.equal(isAuthorized(auth, fakeRequest({ authorization: "Bearer s3cret" }), urlWith()), true);
  assert.equal(isAuthorized(auth, fakeRequest(), urlWith("?token=s3cret")), true);
  assert.equal(isAuthorized(auth, fakeRequest({ authorization: "Bearer nope" }), urlWith()), false);
  assert.equal(isAuthorized(auth, fakeRequest(), urlWith()), false);
});

test("isAuthorized is open when auth disabled", () => {
  assert.equal(isAuthorized(baseAuth({ enabled: false }), fakeRequest(), urlWith()), true);
});

test("scrypt password hashing verifies the right password only", () => {
  const auth = baseAuth({ loginEnabled: true, credentials: { username: "wmux", passwordHash: hashPassword("hunter2") } });
  assert.equal(verifyCredentials(auth, "wmux", "hunter2"), true);
  assert.equal(verifyCredentials(auth, "wmux", "wrong"), false);
  assert.equal(verifyCredentials(auth, "other", "hunter2"), false);
});

test("a session token authorizes until it expires", () => {
  const auth = baseAuth();
  const now = 1_000_000;
  const token = issueSessionToken(auth.sessionSecret, 60_000, now);
  assert.equal(isAuthorized(auth, fakeRequest({ authorization: `Bearer ${token}` }), urlWith(), now + 30_000), true);
  assert.equal(isAuthorized(auth, fakeRequest({ authorization: `Bearer ${token}` }), urlWith(), now + 120_000), false);
});

test("a session token forged with the wrong secret is rejected", () => {
  const token = issueSessionToken("attacker-key", 60_000, 1_000_000);
  assert.equal(isAuthorized(baseAuth(), fakeRequest({ authorization: `Bearer ${token}` }), urlWith(), 1_000_001), false);
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

test("loadAuthConfig starts token-only without configured credentials", () => {
  withIsolatedHome((dir) => {
    const auth = loadAuthConfig();
    assert.equal(auth.enabled, true);
    assert.equal(auth.loginEnabled, false);
    assert.ok(auth.token.length >= 16);
    assert.ok(auth.sessionSecret.length >= 16);
    assert.equal(fs.existsSync(path.join(dir, "auth.json")), false);
    assert.ok(fs.existsSync(path.join(dir, "session-secret")));
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
    assert.equal(verifyCredentials(auth, "wmux", "wmux"), false);
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
    assert.equal(verifyCredentials(auth, "wmux", "wmux"), true);
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
    assert.equal(verifyCredentials(auth, "operator", "not-the-default"), true);
  });
});
