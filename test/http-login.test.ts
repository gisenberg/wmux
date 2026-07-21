import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashPassword, type AuthConfig } from "../src/server/auth.js";
import { createHttpServer } from "../src/server/http.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";

test("login verifies asynchronously and throttles attempts per client address", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-http-login-"));
  const auth: AuthConfig = {
    enabled: true,
    token: "shared-test-token",
    loginEnabled: true,
    credentials: { username: "operator", passwordHash: hashPassword("correct horse") },
    sessionSecret: "session-test-secret",
  };
  const state = new StateStore([], path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const server = await createHttpServer(
    "127.0.0.1",
    state,
    [],
    {} as SessionManager,
    settings,
    { auth },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const login = (password: string) => fetch(`http://127.0.0.1:${address.port}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator", password }),
  });

  try {
    const authInfo = await fetch(`http://127.0.0.1:${address.port}/api/auth-info`);
    assert.equal(authInfo.headers.get("cache-control"), "no-store");
    assert.equal(((await authInfo.json()) as { browserAuthMode: string }).browserAuthMode, "shared-or-login");
    const success = await login("correct horse");
    assert.equal(success.status, 200);
    assert.equal(success.headers.get("cache-control"), "no-store");
    assert.match(((await success.json()) as { token: string }).token, /^wsess\./);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login("wrong password")).status, 401);
    }
    const limited = await login("wrong password");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.equal(((await limited.json()) as { error: string }).error, "login_rate_limited");
  } finally {
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
