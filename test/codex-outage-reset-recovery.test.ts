import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { AgentSessionService } from "../src/server/agent-sessions.js";
import { AgentTimelineStore } from "../src/server/agent-timeline.js";
import { createHttpServer } from "../src/server/http.js";
import { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";
import { issue, loadBinding } from "../plugins/wmux/scripts/wmux-binding.mjs";
import { runCodexNameObserver } from "../plugins/wmux/scripts/wmux-name-observer.mjs";

const token = "B".repeat(43);
const helperToken = "H".repeat(43);
const browserQualification = process.env.WMUX_BROWSER_QUALIFICATION === "1";

const runBrowserDriver = (base: string, targetWorkspaceId: string, targetTabId: string, otherWorkspaceId: string, otherTabId: string) => new Promise<void>((resolve, reject) => {
  execFile(process.execPath, [path.resolve("test/fixtures/codex-outage-browser-driver.mjs")], {
    timeout: 60_000,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(os.userInfo().homedir, ".cache", "ms-playwright"), WMUX_OUTAGE_URL: base, WMUX_OUTAGE_TOKEN: token, WMUX_OUTAGE_WORKSPACE: targetWorkspaceId, WMUX_OUTAGE_TAB: targetTabId, WMUX_OUTAGE_OTHER_WORKSPACE: otherWorkspaceId, WMUX_OUTAGE_OTHER_TAB: otherTabId },
  }, (error, stdout, stderr) => error ? reject(new Error(`browser outage driver failed: ${stderr || stdout || error.message}`)) : resolve());
});

const until = async <T>(read: () => T | undefined, label: string, timeout = 10_000): Promise<T> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/**
 * Isolated real HTTP/PTTY and private-native-socket coverage. The disposable
 * socket implements the observer's read-only RPC subset; it is not a native
 * Codex UAT run and never touches the user's App Server or production state.
 */
test("M1-05 browser title reset awaits a healthy current native sample on the same receipt", {
  timeout: browserQualification ? 90_000 : 30_000,
  skip: process.platform === "win32" ? "requires a POSIX private Unix socket" : false,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-outage-"));
  const home = path.join(directory, "home");
  const runtime = path.join(home, ".wmux", "codex-plugin");
  const socketDirectory = path.join(directory, "socket");
  const socketPath = path.join(socketDirectory, "native.sock");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  fs.mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const isolatedEnvironmentKeys = ["HOME", "CODEX_HOME", "WMUX_CODEX_PLUGIN_RUNTIME_DIR", "WMUX_CODEX_SOCKET_PATH"];
  const originalEnvironment = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith("WMUX_") || isolatedEnvironmentKeys.includes(key))
      .map((key) => [key, process.env[key]]),
  );
  for (const key of Object.keys(process.env)) if (key.startsWith("WMUX_")) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    CODEX_HOME: home,
    WMUX_CODEX_PLUGIN_RUNTIME_DIR: runtime,
    WMUX_CODEX_SOCKET_PATH: socketPath,
  });

  const sessionId = "outage_root";
  let healthy = true;
  let nativeName = "Initial native metadata";
  let nativeReads = 0;
  let rejectedNativeConnections = 0;
  const nativeServer = http.createServer();
  const native = new WebSocketServer({ server: nativeServer });
  native.on("connection", (socket) => socket.on("message", (raw) => {
    if (!healthy) {
      rejectedNativeConnections += 1;
      socket.close();
      return;
    }
    const request = JSON.parse(raw.toString()) as { id?: number; method?: string };
    if (!Object.hasOwn(request, "id")) return;
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: "0.153.4" };
    else if (request.method === "thread/read") {
      nativeReads += 1;
      result = { thread: { id: sessionId, sessionId: "native_outage_root", parentThreadId: null, name: nativeName, status: { type: "idle" } } };
    } else {
      throw new Error(`unexpected native RPC: ${request.method}`);
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }));
  await new Promise<void>((resolve) => nativeServer.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);

  // `npm test` precedes build. Keep the default fault fixture source-only;
  // the explicit browser lane must use a consistent built server class graph
  // so route errors are recognized by the matching dispatcher.
  let CreateServer: any = createHttpServer, StateStoreClass: any = StateStore,
    SettingsStoreClass: any = SettingsStore, AgentTimelineStoreClass: any = AgentTimelineStore,
    AgentSessionServiceClass: any = AgentSessionService, SessionManagerClass: any = SessionManager;
  if (browserQualification) {
    assert.ok(fs.existsSync(path.resolve("dist/client/index.html")), "browser qualification requires npm run build");
    const loadBuilt = (entry: string) => import(entry);
    const [httpModule, stateModule, settingsModule, timelineModule, agentsModule, sessionsModule] = await Promise.all([
      loadBuilt("../dist/server/http.js"), loadBuilt("../dist/server/state.js"), loadBuilt("../dist/server/settings.js"),
      loadBuilt("../dist/server/agent-timeline.js"), loadBuilt("../dist/server/agent-sessions.js"), loadBuilt("../dist/server/session-manager.js"),
    ]);
    CreateServer = httpModule.createHttpServer; StateStoreClass = stateModule.StateStore;
    SettingsStoreClass = settingsModule.SettingsStore; AgentTimelineStoreClass = timelineModule.AgentTimelineStore;
    AgentSessionServiceClass = agentsModule.AgentSessionService; SessionManagerClass = sessionsModule.SessionManager;
  }

  const machines: MachineConfig[] = [{
    id: "local", name: "Fixture", kind: "local", sessionBackend: "pty", cwd: directory,
    // Keep the browser's terminal protocol from reflecting control queries back
    // into itself; receipt proof is injected through the real fixture PTY API.
    command: [process.execPath, "-e", "process.stdin.resume()"],
  }];
  const state = new StateStoreClass(machines, path.join(directory, "state.json"));
  const settings = new SettingsStoreClass(path.join(directory, "settings.json"));
  const agents = new AgentSessionServiceClass(state, AgentTimelineStoreClass.persistent(path.join(directory, "timeline.json")));
  const sessions = new SessionManagerClass(state, machines, "", () => undefined, () => undefined, undefined, () => ({}), "", "shared-or-login", agents);
  const server = await CreateServer("127.0.0.1", state, machines, sessions, settings, {
    auth: { enabled: true, token, helperToken, loginEnabled: false, sessionSecret: "test", browserAuthMode: "shared-or-login" },
    healthResolvers: { machines: async () => [], streams: async () => [] }, agentSessions: agents,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  fs.mkdirSync(path.join(home, ".wmux"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".wmux", "url"), base, { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".wmux", "helper-token"), helperToken, { mode: 0o600 });
  const post = (url: string, body: object) => fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let observer = new AbortController();

  try {
    const target = state.createWorkspace("local");
    const other = state.createWorkspace("local");
    const targetTab = target.tabs[0];
    const otherTab = other.tabs[0];
    assert.ok(targetTab && otherTab);
    const challenge = await issue(sessionId);
    const receipt = loadBinding(sessionId, challenge.bindingId).receipt;
    sessions.writePane(targetTab.panes[0]!.id, `${challenge.marker}\n`, 80, 24);
    await until(() => {
      try { return sessions.codexTerminalBindings.resolve(sessionId, receipt); }
      catch { return undefined; }
    }, "real PTY receipt proof");

    const running = runCodexNameObserver({ sessionId, bindingId: challenge.bindingId }, { signal: observer.signal });
    await until(() => state.findPaneContext(targetTab.panes[0]!.id)?.workspace.name === nativeName ? true : undefined, "initial native sample");
    assert.ok(nativeReads > 0, "the observer sampled the real native fixture socket");

    assert.equal((await post(`/api/workspaces/${other.id}/title`, { title: "Other workspace pin" })).status, 200);
    assert.equal((await post(`/api/workspaces/${other.id}/tabs/${otherTab.id}/title`, { title: "Other tab pin" })).status, 200);
    assert.equal((await post(`/api/workspaces/${target.id}/title`, { title: "Pinned before outage" })).status, 200);
    assert.equal((await post(`/api/workspaces/${target.id}/tabs/${targetTab.id}/title`, { title: "Pinned tab before outage" })).status, 200);

    // Drop the observed native transport and reject fresh connections while the
    // receipt remains live. This is an isolated metadata outage, not a server
    // or binding outage.
    healthy = false;
    for (const client of native.clients) client.terminate();
    if (browserQualification) {
      await runBrowserDriver(base, target.id, targetTab.id, other.id, otherTab.id);
    } else {
      assert.equal((await post(`/api/workspaces/${target.id}/title`, { clear: true })).status, 200);
      assert.equal((await post(`/api/workspaces/${target.id}/tabs/${targetTab.id}/title`, { clear: true })).status, 200);
    }
    await until(() => rejectedNativeConnections > 0 ? true : undefined, "the continuous observer to attempt the failed native socket");
    const duringOutage = state.findPaneContext(targetTab.panes[0]!.id)!;
    assert.equal(duringOutage.workspace.nameSource, "default", "browser reset awaits metadata instead of replaying a cached title");
    assert.equal(duringOutage.tab.titleSource, "default", "tab reset also remains awaiting metadata");
    assert.equal(state.findPaneContext(otherTab.panes[0]!.id)?.workspace.name, "Other workspace pin");
    assert.equal(state.findPaneContext(otherTab.panes[0]!.id)?.tab.title, "Other tab pin");
    assert.equal((await post("/api/codex-bindings/resolve", { sessionId, receipt })).status, 200, "the original receipt stays live across the socket outage");

    nativeName = "Current native metadata after recovery";
    healthy = true;
    await until(() => state.findPaneContext(targetTab.panes[0]!.id)?.workspace.name === nativeName ? true : undefined, "current metadata on recovered socket");
    const recovered = state.findPaneContext(targetTab.panes[0]!.id)!;
    assert.equal(recovered.workspace.nameSource, "auto");
    assert.equal(recovered.tab.title, nativeName);
    assert.equal(recovered.tab.titleSource, "auto");
    assert.equal(state.findPaneContext(otherTab.panes[0]!.id)?.workspace.name, "Other workspace pin");
    assert.equal(state.findPaneContext(otherTab.panes[0]!.id)?.tab.title, "Other tab pin");

    observer.abort();
    assert.equal((await running).reason, "observer_stopped");
  } finally {
    observer.abort();
    sessions.disposeAll();
    const closed = once(server, "close");
    server.close(); server.closeAllConnections();
    await closed;
    for (const client of native.clients) client.terminate();
    native.close();
    const nativeClosed = once(nativeServer, "close");
    nativeServer.close();
    await nativeClosed;
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("WMUX_") || isolatedEnvironmentKeys.includes(key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
