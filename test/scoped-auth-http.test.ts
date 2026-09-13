import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { privateTempDirectory } from "./private-fixture.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { hashPassword, type AuthConfig } from "../src/server/auth.js";
import { BROWSER_SESSION_COOKIE } from "../src/server/browser-session-cookie.js";
import { createHttpServer } from "../src/server/http.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const connect = async (url: string, headers?: http.OutgoingHttpHeaders): Promise<WebSocket> => {
  const ws = new WebSocket(url, { headers });
  await once(ws, "open");
  return ws;
};
const rejected = async (url: string, headers?: http.OutgoingHttpHeaders): Promise<void> => {
  const ws = new WebSocket(url, { headers });
  const [error] = await once(ws, "error") as [Error];
  assert.match(error.message, /Unexpected server response: (401|404)/);
};

test("login-only enforces scoped REST and WebSocket transports end to end", async () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-scoped-http-"));
  const auth: AuthConfig = {
    enabled: true,
    token: "legacy-test-token",
    loginEnabled: true,
    credentials: { username: "operator", passwordHash: hashPassword("correct horse") },
    sessionSecret: "session-test-secret",
    browserAuthMode: "login-only",
    automationToken: "A".repeat(43),
    automationTokenPath: path.join(directory, "automation-token"),
    helperToken: "H".repeat(43),
    helperTokenPath: path.join(directory, "helper-token"),
  };
  fs.writeFileSync(auth.automationTokenPath, `${auth.automationToken}\n`, { mode: 0o600 });
  fs.writeFileSync(auth.helperTokenPath, `${auth.helperToken}\n`, { mode: 0o600 });
  const machines: MachineConfig[] = [
    { id: "local", name: "Local", kind: "local" },
    { id: "win", name: "Windows", kind: "powershell-ssh", host: "127.0.0.1" },
  ];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const sessions = {
    watchOutput: (_pane: string, ws: WebSocket) => ws.send(JSON.stringify({ type: "ready" })),
    attach: (_pane: string, ws: WebSocket) => ws.send(JSON.stringify({ type: "ready" })),
  } as unknown as SessionManager;
  const server = await createHttpServer("127.0.0.1", state, machines, sessions, settings, {
    auth,
    browserSessionCookieSecure: false,
    healthResolvers: { machines: async () => [], streams: async () => [] },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = base.replace(/^http/, "ws");
  const sockets: WebSocket[] = [];
  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Device One",
      },
      body: JSON.stringify({
        username: "operator",
        password: "correct horse",
      }),
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), {
      authenticated: true,
      expiresInMs: 30 * 24 * 60 * 60 * 1_000,
    });
    const setCookie = login.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, new RegExp(`^${BROWSER_SESSION_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.doesNotMatch(setCookie, /Secure/i);
    const cookie = setCookie.split(";", 1)[0];
    const browser = {
      cookie,
      "content-type": "application/json",
      "user-agent": "Device One",
    };
    const secondLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Device Two",
      },
      body: JSON.stringify({
        username: "operator",
        password: "correct horse",
      }),
    });
    assert.equal(secondLogin.status, 200);
    const secondCookie = secondLogin.headers.get("set-cookie")!.split(";", 1)[0];
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: bearer(auth.automationToken!) })).status, 200);
    assert.equal((await fetch(`${base}/api/bootstrap?token=${encodeURIComponent(auth.automationToken!)}`)).status, 401);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: bearer(auth.helperToken!) })).status, 403);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: bearer(auth.token) })).status, 401);
    assert.equal((await fetch(`${base}/api/notifications`, { method: "POST", headers: bearer(auth.helperToken!), body: "{}" })).status, 201);
    assert.equal((await fetch(`${base}/api/notifications`, { method: "POST", headers: bearer(auth.automationToken!), body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/settings`, { method: "POST", headers: browser, body: "{}" })).status, 200);
    assert.equal((await fetch(`${base}/api/settings`, { method: "POST", headers: bearer(auth.helperToken!), body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/auth/session`, { headers: browser })).status, 200);
    assert.equal((await fetch(`${base}/api/auth/session?token=${encodeURIComponent(cookie)}`)).status, 401);
    assert.equal((await fetch(`${base}/api/auth/session`, { headers: bearer(cookie) })).status, 401);
    const invalidCookie = await fetch(`${base}/api/auth/session`, {
      headers: { cookie: `${BROWSER_SESSION_COOKIE}=${"x".repeat(43)}` },
    });
    assert.equal(invalidCookie.status, 401);
    assert.match(invalidCookie.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await fetch(`${base}/api/auth/session`, { headers: bearer(auth.automationToken!) })).status, 403);
    assert.equal((await fetch(`${base}/api/future-route`, { headers: browser })).status, 401);
    assert.equal((await fetch(`${base}/api/workspaces`, { headers: bearer(auth.automationToken!) })).status, 401);

    const sessionInventory = await fetch(`${base}/api/auth/sessions`, { headers: browser });
    assert.equal(sessionInventory.status, 200);
    const inventory = await sessionInventory.json() as {
      currentSessionId: string;
      sessions: Array<{ id: string; device: string; address: string }>;
    };
    assert.equal(inventory.sessions.length, 2);
    assert.ok(inventory.sessions.every((session) => session.address === "127.0.0.1"));
    const secondSession = inventory.sessions.find((session) => session.device === "Device Two");
    assert.ok(secondSession);
    const secondSocket = await connect(`${wsBase}/ws/events`, {
      cookie: secondCookie,
      "user-agent": "Device Two",
    });
    sockets.push(secondSocket);
    const revokedSocketClosed = once(secondSocket, "close");
    assert.equal((await fetch(
      `${base}/api/auth/sessions/${encodeURIComponent(secondSession.id)}`,
      { method: "DELETE", headers: browser },
    )).status, 200);
    await revokedSocketClosed;
    assert.equal((await fetch(`${base}/api/auth/session`, {
      headers: { cookie: secondCookie, "user-agent": "Device Two" },
    })).status, 401);

    const oldHelperToken = auth.helperToken!;
    const rotateHelper = await fetch(
      `${base}/api/auth/credentials/helper/rotate`,
      { method: "POST", headers: browser },
    );
    assert.equal(rotateHelper.status, 200);
    assert.notEqual(auth.helperToken, oldHelperToken);
    assert.equal((await fetch(`${base}/api/notifications`, {
      method: "POST",
      headers: bearer(oldHelperToken),
      body: "{}",
    })).status, 401);
    assert.equal((await fetch(`${base}/api/notifications`, {
      method: "POST",
      headers: bearer(auth.helperToken!),
      body: "{}",
    })).status, 201);

    const browserBundle = await fetch(`${base}/api/helpers/windows/win`, { headers: browser });
    assert.equal(browserBundle.status, 403);
    assert.doesNotMatch(await browserBundle.text(), new RegExp(auth.helperToken!));
    const browserBootstrap = await fetch(`${base}/api/helpers/windows/win/bootstrap`, { headers: browser });
    assert.equal(browserBootstrap.status, 403);
    assert.doesNotMatch(await browserBootstrap.text(), new RegExp(auth.helperToken!));
    assert.equal((await fetch(`${base}/api/helpers/windows/win`, { headers: bearer(auth.helperToken!) })).status, 200);
    const helperBootstrap = await fetch(`${base}/api/helpers/windows/win/bootstrap`, { headers: bearer(auth.helperToken!) });
    assert.equal(helperBootstrap.status, 200);
    assert.match(await helperBootstrap.text(), new RegExp(auth.helperToken!));
    assert.equal((await fetch(`${base}/api/helpers/windows/win/bootstrap?token=${encodeURIComponent(auth.helperToken!)}`)).status, 401);

    assert.equal((await fetch(`${base}/api/streams/local/request`, { headers: bearer(auth.helperToken!) })).status, 200);
    const streamRequest = await fetch(`${base}/api/streams/local/request`, {
      method: "POST",
      headers: bearer(auth.helperToken!),
      body: JSON.stringify({ requestId: "helper-request", ttlMs: 30_000 }),
    });
    assert.equal(streamRequest.status, 200);
    assert.equal((await fetch(`${base}/api/streams/local/request`, {
      method: "POST", headers: bearer(auth.automationToken!), body: "{}",
    })).status, 403);
    assert.equal((await fetch(`${base}/api/streams/local/request/helper-request`, {
      method: "DELETE", headers: bearer(auth.automationToken!),
    })).status, 403);
    assert.equal((await fetch(`${base}/api/streams/local/request/helper-request`, {
      method: "DELETE", headers: bearer(auth.helperToken!),
    })).status, 200);
    assert.equal((await fetch(`${base}/api/streams/local/request`, {
      method: "POST", headers: browser, body: JSON.stringify({ requestId: "browser-request" }),
    })).status, 200);
    assert.equal((await fetch(`${base}/api/streams/local/request/browser-request`, {
      method: "DELETE", headers: browser,
    })).status, 200);

    sockets.push(await connect(`${wsBase}/ws/panes/pane/output`, bearer(auth.automationToken!)));
    await rejected(`${wsBase}/ws/panes/pane/output?token=${encodeURIComponent(auth.automationToken!)}`);
    await rejected(`${wsBase}/ws/events`, bearer(auth.automationToken!));
    await rejected(`${wsBase}/ws/panes/pane`, bearer(auth.helperToken!));
    sockets.push(await connect(`${wsBase}/ws/events`, { cookie }));
    sockets.push(await connect(`${wsBase}/ws/panes/pane`, { cookie }));
    await rejected(`${wsBase}/ws/events?token=${encodeURIComponent(cookie)}`);
    await rejected(`${wsBase}/ws/future`, { cookie });
  } finally {
    for (const socket of sockets) socket.terminate();
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
