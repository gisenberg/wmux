import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const sessionId = "root_thread", turnId = "root_turn";

async function until<T>(read: () => T | undefined, label: string, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (value !== undefined) return value; await delay(25); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function hook(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path.join(scripts, "wmux-context.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; child.stdout.on("data", (data: Buffer) => { stdout += data; }); child.stderr.resume();
  child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, turn_id: turnId, prompt: "observer fixture task" }));
  const [code] = await once(child, "exit"); assert.equal(code, 0);
  const value = JSON.parse(stdout);
  assert.match(value.systemMessage, /^\[\[WMUX:[A-Za-z0-9_-]{22}\]\]$/);
  return value.systemMessage as string;
}

test("production hook automatically observes a bound root through the private Unix App Server socket", { timeout: 20_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-observer-integration-"));
  const home = path.join(directory, "home"), socketDirectory = path.join(home, "app-server-control"), socketPath = path.join(socketDirectory, "app-server-control.sock");
  fs.mkdirSync(path.join(home, ".wmux"), { recursive: true, mode: 0o700 }); fs.mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const nativeServer = http.createServer(), native = new WebSocketServer({ server: nativeServer });
  const nativeMethods: string[] = []; let phase: "active" | "attention" | "completed" = "active";
  native.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(raw.toString()); nativeMethods.push(request.method);
    if (!Object.hasOwn(request, "id")) return;
    const status = phase === "completed" ? { type: "idle" } : { type: "active", activeFlags: phase === "attention" ? ["waitingOnApproval"] : [] };
    let result: any = {};
    if (request.method === "initialize") result = { protocolVersion: "0.153.4" };
    else if (request.method === "thread/read") result = { thread: { id: sessionId, sessionId, parentThreadId: null, status } };
    else if (request.method === "thread/turns/list") {
      const turnStatus = phase === "completed" ? "completed" : "inProgress";
      result = { data: [{ id: turnId, status: turnStatus, startedAt: 1, completedAt: phase === "completed" ? 2 : null, durationMs: phase === "completed" ? 1 : null }], nextCursor: null, backwardsCursor: null };
    } else { throw new Error(`unexpected native method ${request.method}`); }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }));
  await new Promise<void>(resolve => nativeServer.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);

  const machines: MachineConfig[] = [{ id: "local", name: "Fixture", kind: "local", sessionBackend: "pty", cwd: directory, command: [process.execPath, "-e", "process.stdin.setRawMode(true);process.stdin.on('data',data=>process.stdout.write(data))"] }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const agents = new AgentSessionService(state, AgentTimelineStore.persistent(path.join(directory, "timeline.json")));
  const sessions = new SessionManager(state, machines, "", () => undefined, () => undefined, undefined, () => ({}), "", "shared-or-login", agents);
  const helperToken = "H".repeat(43);
  const server = await createHttpServer("127.0.0.1", state, machines, sessions, settings, { auth: { enabled: true, token: "B".repeat(43), helperToken, loginEnabled: false, sessionSecret: "test-only", browserAuthMode: "shared-or-login" }, healthResolvers: { machines: async () => [], streams: async () => [] }, agentSessions: agents });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  fs.writeFileSync(path.join(home, ".wmux", "url"), `http://127.0.0.1:${address.port}`, { mode: 0o600 }); fs.writeFileSync(path.join(home, ".wmux", "helper-token"), helperToken, { mode: 0o600 });
  const env = { ...process.env, HOME: home, CODEX_HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith("WMUX_")) delete env[key as keyof typeof env];
  const first = state.createWorkspace("local"), second = state.createWorkspace("local");
  const paneId = first.tabs[0].panes[0].id, otherPane = second.tabs[0].panes[0].id;
  try {
    const marker = await hook(env);
    // This is terminal output, not hook stdout: the production marker parser
    // establishes the exact live raw-PTY binding before the observer resolves.
    sessions.writePane(paneId, `${marker}\n`, 80, 24);
    const runtime = path.join(home, ".wmux", "codex-plugin");
    const recordName = fs.readdirSync(runtime).find(name => /^[a-f0-9]{64}\.json$/.test(name)); assert.ok(recordName);
    const receipt = JSON.parse(fs.readFileSync(path.join(runtime, recordName), "utf8")).receipt;
    const tuple = await until(() => { try { return sessions.codexTerminalBindings.resolve(sessionId, receipt); } catch { return undefined; } }, "terminal marker binding");
    assert.equal(tuple.turnId, turnId);
    const running = await until(() => state.snapshot().delegations.find(item => item.paneId === paneId && item.state === "running"), "running lifecycle");
    assert.equal(running.attentionReason, undefined);
    phase = "attention";
    const waiting = await until(() => state.snapshot().delegations.find(item => item.paneId === paneId && item.state === "waiting"), "approval lifecycle");
    assert.equal(waiting.attentionReason, "approval");
    phase = "completed";
    const completed = await until(() => state.snapshot().delegations.find(item => item.paneId === paneId && item.state === "completed"), "completed lifecycle");
    assert.equal(completed.state, "completed");
    await until(() => native.clients.size === 0 ? true : undefined, "observer self-exit");
    assert.equal(state.snapshot().delegations.some(item => item.paneId === otherPane), false);
    assert.equal(state.snapshot().delegations.filter(item => item.paneId === paneId && item.state === "completed").length, 1);
    assert.ok(nativeMethods.includes("thread/read") && nativeMethods.includes("thread/turns/list"));
    assert.equal(nativeMethods.includes("thread/name/set"), false);
    assert.equal(nativeMethods.includes("thread/start"), false);
    assert.equal(nativeMethods.includes("turn/start"), false);
  } finally {
    sessions.disposeAll();
    const closed = once(server, "close"); server.close(); await closed;
    native.close(); const nativeClosed = once(nativeServer, "close"); nativeServer.close(); await nativeClosed;
    state.flush(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
