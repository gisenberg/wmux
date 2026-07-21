import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { api } from "../src/client/src/api.ts";
import { clearNonSessionToken, getToken, setToken } from "../src/client/src/token.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("login-only token filtering keeps only password-issued browser sessions", () => {
  setToken("legacy-browser-token");
  clearNonSessionToken();
  assert.equal(getToken(), "");
  setToken("wsess.payload.signature");
  clearNonSessionToken();
  assert.equal(getToken(), "wsess.payload.signature");
  setToken("");
});

test("auth metadata is fetched without sending a stored credential", async () => {
  const originalFetch = globalThis.fetch;
  let headers: HeadersInit | undefined;
  setToken("legacy-browser-token");
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers = init?.headers;
    return new Response(JSON.stringify({ authEnabled: true, loginEnabled: true, browserAuthMode: "login-only" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    assert.equal((await api.authInfo()).browserAuthMode, "login-only");
  } finally {
    globalThis.fetch = originalFetch;
    setToken("");
  }
  assert.deepEqual(headers, { "cache-control": "no-store" });
});

test("the application mounts behind the mode/session gate", () => {
  const main = fs.readFileSync(path.join(repoRoot, "src/client/src/main.tsx"), "utf8");
  const gate = fs.readFileSync(path.join(repoRoot, "src/client/src/BrowserAuthGate.tsx"), "utf8");
  assert.match(main, /render\(<BrowserAuthGate \/>\)/);
  assert.match(gate, /retryTransient\(api\.authSession\)/);
  const authInfoGate = gate.indexOf("retryTransient(api.authInfo)");
  assert.ok(authInfoGate >= 0 && authInfoGate < gate.indexOf("return <App />"));
  assert.match(gate, /clearNonSessionToken\(\)/);
  assert.match(gate, /error instanceof UnauthorizedError/);
  assert.match(gate, /250, 750, 1_500/);
});
