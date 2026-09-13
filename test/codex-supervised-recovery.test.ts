import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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

const scripts = path.resolve("plugins/wmux/scripts");
const sessionId = "recovery_root", turnId = "recovery_turn";

async function until<T>(read: () => T | undefined, label: string, timeout = 12_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, "exit");
    child.kill("SIGKILL");
    await killed;
  }
}

/** This is a synthetic native App Server socket. It exercises production
 * observer transport and HTTP/PTTY receipt handling, but it is not a native
 * Codex UAT run. */
test("supervised observer replacement resumes an idle bound receipt without changing independent pins", {
  timeout: 50_000,
  skip: process.platform !== "linux" ? "requires a Linux private Unix socket fixture" : false,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-supervised-recovery-"));
  const home = path.join(directory, "home");
  const runtime = path.join(home, ".wmux", "codex-plugin");
  const socketDirectory = path.join(home, "app-server-control");
  const socketPath = path.join(socketDirectory, "app-server-control.sock");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  fs.mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });

  let phase: "active" | "completed" = "active";
  let nativeName = "Native before worker replacement";
  const nativeMethods: string[] = [];
  const nativeServer = http.createServer();
  const native = new WebSocketServer({ server: nativeServer });
  native.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(raw.toString());
    nativeMethods.push(request.method);
    if (!Object.hasOwn(request, "id")) return;
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: "0.153.4" };
    else if (request.method === "thread/read") result = {
      thread: { id: sessionId, sessionId, parentThreadId: null, name: nativeName,
        status: phase === "completed" ? { type: "idle" } : { type: "active", activeFlags: [] } },
    };
    else if (request.method === "thread/turns/list") result = {
      data: [{ id: turnId, status: phase === "completed" ? "completed" : "inProgress", startedAt: 1,
        completedAt: phase === "completed" ? 2 : null, durationMs: phase === "completed" ? 1 : null }],
      nextCursor: null, backwardsCursor: null,
    };
    else throw new Error(`unexpected native RPC method: ${request.method}`);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }));
  await new Promise<void>(resolve => nativeServer.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);

  const machines: MachineConfig[] = [{
    id: "local", name: "Fixture", kind: "local", sessionBackend: "pty", cwd: directory,
    command: [process.execPath, "-e", "process.stdin.setRawMode(true);process.stdin.on('data',data=>process.stdout.write(data))"],
  }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const agents = new AgentSessionService(state, AgentTimelineStore.persistent(path.join(directory, "timeline.json")));
  const sessions = new SessionManager(state, machines, "", () => undefined, () => undefined, undefined, () => ({}), "", "shared-or-login", agents);
  const helperToken = "H".repeat(43);
  let server = await createHttpServer("127.0.0.1", state, machines, sessions, settings, {
    auth: { enabled: true, token: "B".repeat(43), helperToken, loginEnabled: false, sessionSecret: "test-only", browserAuthMode: "shared-or-login" },
    healthResolvers: { machines: async () => [], streams: async () => [] }, agentSessions: agents,
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  fs.writeFileSync(path.join(home, ".wmux", "url"), base, { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".wmux", "helper-token"), helperToken, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: home, WMUX_CODEX_PLUGIN_RUNTIME_DIR: runtime, WMUX_CODEX_SOCKET_PATH: socketPath };
  for (const key of Object.keys(env)) if (key.startsWith("WMUX_") && !["WMUX_CODEX_PLUGIN_RUNTIME_DIR", "WMUX_CODEX_SOCKET_PATH"].includes(key)) delete env[key as keyof typeof env];

  const workspace = state.createWorkspace("local");
  const paneId = workspace.tabs[0].panes[0].id;
  let worker: ChildProcess | undefined;
  let replacement: ChildProcess | undefined;
  let restartedServer: http.Server | undefined;
  try {
    const issue = await fetch(`${base}/api/codex-bindings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${helperToken}` }, body: JSON.stringify({ sessionId, turnId }) });
    assert.equal(issue.status, 201);
    const binding = await issue.json() as { receipt: string; marker: string; expiresAt: string };
    const bindingId = binding.marker.slice(7, -2);
    sessions.writePane(paneId, `${binding.marker}\n`, 80, 24);
    await until(() => { try { return sessions.codexTerminalBindings.resolve(sessionId, binding.receipt); } catch { return undefined; } }, "real PTY marker receipt");
    const record = { schemaVersion: 3, sessionId, bindingId, receipt: binding.receipt, expiresAt: binding.expiresAt,
      createdAt: Date.now(), promptTurnId: turnId, socketPath };
    // The production binding writer is intentionally represented by this same
    // bounded record shape; the receipt itself was issued and witnessed by the
    // real authenticated HTTP + PTY path above.
    const crypto = await import("node:crypto");
    fs.writeFileSync(path.join(runtime, `${crypto.createHash("sha256").update(`${sessionId}\0${bindingId}`).digest("hex")}.json`), JSON.stringify(record), { mode: 0o600 });

    worker = spawn(process.execPath, [path.join(scripts, "wmux-observer.mjs"), "--service"], { env, stdio: "ignore" });
    await until(() => {
      if (worker?.exitCode !== null) throw new Error(`service worker exited before its first sample (${worker?.exitCode ?? "signal"})`);
      return state.findPaneContext(paneId)?.workspace.name === nativeName ? true : undefined;
    }, "initial automatic native title").catch(error => { throw new Error(`${error.message}; native methods: ${JSON.stringify(nativeMethods)}`); });
    const pin = await fetch(`${base}/api/workspaces/${workspace.id}/title`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${"B".repeat(43)}` }, body: JSON.stringify({ title: "Pinned workspace" }) });
    assert.equal(pin.status, 200);
    const recordFile = fs.readdirSync(runtime).find(name => name.endsWith(".json") && name !== "observation-supervisor.lock");
    assert.ok(recordFile);
    const sequence = () => Number(JSON.parse(fs.readFileSync(path.join(runtime, recordFile), "utf8")).lifecycleSequence || 0);
    const activeSequence = sequence();
    phase = "completed";
    await until(() => state.snapshot().delegations.find(item => item.paneId === paneId && item.state === "completed"), "terminal lifecycle");
    assert.ok(sequence() > activeSequence, "terminal lifecycle advances the persisted sequence");
    const terminalNotifications = state.snapshot().notifications.filter(item => item.paneId === paneId).map(item => item.id);
    await delay(2_300);
    assert.deepEqual(state.snapshot().notifications.filter(item => item.paneId === paneId).map(item => item.id), terminalNotifications, "repeated terminal samples notify once");

    nativeName = "Native current before worker replacement";
    await until(() => state.findPaneContext(paneId)?.tab.title === nativeName ? true : undefined, "current native title before replacement");
    const preKillSequence = sequence();
    // Kill only the service worker. No prompt, marker, or native rename occurs
    // between workers; the replacement must use this current trusted receipt.
    const killed = once(worker, "exit"); worker.kill("SIGKILL"); await killed;
    const clearTab = await fetch(`${base}/api/workspaces/${workspace.id}/tabs/${workspace.tabs[0].id}/title`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${"B".repeat(43)}` }, body: JSON.stringify({ clear: true }) });
    assert.equal(clearTab.status, 200);
    replacement = spawn(process.execPath, [path.join(scripts, "wmux-observer.mjs"), "--service"], { env, stdio: "ignore" });
    await until(() => state.findPaneContext(paneId)?.tab.title === nativeName ? true : undefined, "replacement worker native title");
    await until(() => sequence() > preKillSequence ? sequence() : undefined, "replacement lifecycle sequence");
    assert.equal(state.findPaneContext(paneId)?.workspace.name, "Pinned workspace", "workspace pin survives replacement");
    assert.deepEqual(state.snapshot().notifications.filter(item => item.paneId === paneId).map(item => item.id), terminalNotifications, "replacement does not repeat the terminal notification");
    const clearWorkspace = await fetch(`${base}/api/workspaces/${workspace.id}/title`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${"B".repeat(43)}` }, body: JSON.stringify({ clear: true }) });
    assert.equal(clearWorkspace.status, 200);
    await until(() => state.findPaneContext(paneId)?.workspace.name === nativeName ? true : undefined, "unpin applies current title without a new rename");
    assert.ok(nativeMethods.includes("thread/read") && nativeMethods.includes("thread/turns/list"));
    assert.equal(nativeMethods.some(method => ["thread/name/set", "thread/start", "turn/start"].includes(method)), false, "observer native RPC remains read-only");

    // Restarting the server creates a fresh in-memory receipt registry. The
    // persisted plugin record must not regain authority after that restart.
    await stop(replacement); replacement = undefined;
    const freshSessions = new SessionManager(state, machines);
    restartedServer = await createHttpServer("127.0.0.1", state, machines, freshSessions, settings, {
      auth: { enabled: true, token: "B".repeat(43), helperToken, loginEnabled: false, sessionSecret: "test-only", browserAuthMode: "shared-or-login" },
      healthResolvers: { machines: async () => [], streams: async () => [] },
    });
    restartedServer.listen(0, "127.0.0.1"); await once(restartedServer, "listening");
    const restartedAddress = restartedServer.address(); assert.ok(restartedAddress && typeof restartedAddress !== "string");
    const rejected = await fetch(`http://127.0.0.1:${restartedAddress.port}/api/codex-bindings/resolve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${helperToken}` }, body: JSON.stringify({ sessionId, receipt: binding.receipt }) });
    assert.equal(rejected.status, 404, "a restarted server rejects the old receipt");
    freshSessions.disposeAll();
  } finally {
    await stop(replacement); await stop(worker);
    sessions.closePane(paneId);
    sessions.disposeAll();
    if (restartedServer) { const restartedClosed = once(restartedServer, "close"); restartedServer.close(); restartedServer.closeAllConnections(); await Promise.race([restartedClosed, delay(2_000)]); }
    const closed = once(server, "close"); server.close(); server.closeAllConnections(); await Promise.race([closed, delay(2_000)]);
    for (const client of native.clients) client.terminate();
    const nativeClosed = once(nativeServer, "close"); native.close(); nativeServer.close(); await Promise.race([nativeClosed, delay(2_000)]);
    state.flush(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
