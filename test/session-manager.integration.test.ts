import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createHttpServer } from "../src/server/http.js";
import { durableSessionName } from "../src/server/machines.js";
import {
  isAgentInterruptInput,
  isTerminalProtocolResponseInput,
  paneAuthEnvironmentForMachine,
  parseClientMessage,
  resolveDisposalMachine,
  sessionAccessTokenForMachine,
  SessionManager,
} from "../src/server/session-manager.js";
import { StateStore } from "../src/server/state.js";
import { SettingsStore } from "../src/server/settings.js";
import type { MachineConfig } from "../src/server/types.js";

const execFileAsync = promisify(execFile);

test("registered sessions never receive the broad wmux API token", () => {
  const registered: MachineConfig = {
    id: "dynamic",
    name: "Dynamic",
    kind: "ssh",
    host: "100.70.0.8",
    source: "registered",
  };
  assert.equal(sessionAccessTokenForMachine(registered, "broad-token"), "");
  assert.equal(sessionAccessTokenForMachine({ ...registered, source: "config" }, "broad-token"), "broad-token");
});

test("pane auth staging prefers helper scope, preserves default fallback, and keeps registered panes empty", () => {
  const configured: MachineConfig = { id: "static", name: "Static", kind: "ssh", source: "config" };
  const registered: MachineConfig = { ...configured, id: "dynamic", source: "registered" };
  assert.deepEqual(paneAuthEnvironmentForMachine(configured, "legacy", "helper", "login-only"), {
    WMUX_HELPER_TOKEN: "helper",
    WMUX_TOKEN: "",
    WMUX_BROWSER_AUTH_MODE: "login-only",
  });
  assert.deepEqual(paneAuthEnvironmentForMachine(configured, "legacy", "", "shared-or-login"), {
    WMUX_TOKEN: "legacy",
    WMUX_BROWSER_AUTH_MODE: "shared-or-login",
  });
  assert.deepEqual(paneAuthEnvironmentForMachine(registered, "legacy", "helper", "login-only"), {
    WMUX_TOKEN: "",
    WMUX_BROWSER_AUTH_MODE: "login-only",
  });
});

test("pane disposal prefers the live session's pre-heartbeat machine snapshot", () => {
  const oldMachine: MachineConfig = {
    id: "roamer",
    name: "Roamer",
    kind: "ssh",
    host: "100.70.0.8",
    source: "registered",
  };
  const movedMachine = { ...oldMachine, host: "100.70.0.9" };
  assert.equal(resolveDisposalMachine(oldMachine, [movedMachine], oldMachine.id)?.host, "100.70.0.8");
  assert.equal(resolveDisposalMachine(undefined, [movedMachine], oldMachine.id)?.host, "100.70.0.9");
});

test("idle durable-client recycle keeps the old endpoint snapshot through later address churn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-recycle-"));
  let machine: MachineConfig = {
    id: "recycled-roamer",
    name: "Recycled roamer",
    kind: "ssh",
    host: "100.70.0.8",
    sessionBackend: "pty",
    source: "registered",
    online: true,
  };
  const state = new StateStore([machine], path.join(dir, "state.json"));
  const workspace = state.createWorkspace(machine.id);
  const pane = workspace.tabs[0].panes[0];
  const manager = new SessionManager(state, () => [machine]);
  const internals = manager as unknown as {
    sessions: Map<string, { pane: typeof pane; isExited: boolean; kill: () => void }>;
    sessionMachines: Map<string, MachineConfig>;
    shouldUseDurableClientRefresh: (pane: typeof pane) => boolean;
    hasPaneConnections: (paneId: string) => boolean;
    recycleIdleDurableClient: (pane: typeof pane) => boolean;
  };
  let killed = false;
  internals.sessions.set(pane.id, { pane, isExited: false, kill: () => { killed = true; } });
  internals.sessionMachines.set(pane.id, structuredClone(machine));
  internals.shouldUseDurableClientRefresh = () => true;
  internals.hasPaneConnections = () => false;
  try {
    assert.equal(internals.recycleIdleDurableClient(pane), true);
    assert.equal(killed, true);
    assert.equal(internals.sessionMachines.get(pane.id)?.host, "100.70.0.8");

    killed = false;
    internals.sessions.set(pane.id, { pane, isExited: false, kill: () => { killed = true; } });
    internals.hasPaneConnections = () => true;
    assert.equal(internals.recycleIdleDurableClient(pane), false);
    assert.equal(killed, false);

    machine = { ...machine, host: "100.70.0.9" };
    assert.equal(
      resolveDisposalMachine(internals.sessionMachines.get(pane.id), [machine], machine.id)?.host,
      "100.70.0.8",
    );
    assert.equal(manager.closePane(pane.id), true);
    assert.equal(internals.sessionMachines.has(pane.id), false);
  } finally {
    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ready holds every empty durable-refresh replay, including a late attach to a live client", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-refresh-ready-"));
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  const state = new StateStore([machine], path.join(dir, "state.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  const manager = new SessionManager(state, [machine]);
  const client = socket();
  const session = {
    pane,
    pid: 42,
    isExited: false,
    resize: () => undefined,
  };
  const internals = manager as unknown as {
    recycleIdleDurableClient: (candidate: typeof pane) => boolean;
    shouldUseDurableClientRefresh: (candidate: typeof pane) => boolean;
    ensureSession: (candidate: typeof pane, cols: number, rows: number) => typeof session;
    replayOutputFor: () => { data: string; kind: "raw" | "checkpoint" };
    scheduleDurableClientRefresh: () => void;
  };
  internals.recycleIdleDurableClient = () => true;
  internals.shouldUseDurableClientRefresh = () => true;
  internals.ensureSession = () => session;
  internals.replayOutputFor = () => ({ data: "", kind: "raw" });
  internals.scheduleDurableClientRefresh = () => undefined;
  try {
    manager.attach(pane.id, client, 80, 24);
    const ready = await waitForMessage(client, (message) => message.type === "ready");
    assert.equal(ready.waitForRefresh, true);

    fake(client).close();
    const lateClient = socket();
    internals.recycleIdleDurableClient = () => false;
    manager.attach(pane.id, lateClient, 80, 24);
    const lateReady = await waitForMessage(lateClient, (message) => message.type === "ready");
    assert.equal(lateReady.waitForRefresh, true);

    fake(lateClient).close();
    const checkpointClient = socket();
    internals.replayOutputFor = () => ({ data: "checkpoint", kind: "checkpoint" });
    manager.attach(pane.id, checkpointClient, 80, 24);
    const checkpointReady = await waitForMessage(checkpointClient, (message) => message.type === "ready");
    assert.equal(checkpointReady.waitForRefresh, undefined);

    fake(checkpointClient).close();
    const replayClient = socket();
    internals.replayOutputFor = () => ({ data: "prompt", kind: "raw" });
    manager.attach(pane.id, replayClient, 80, 24);
    const replayReady = await waitForMessage(replayClient, (message) => message.type === "ready");
    assert.equal(replayReady.waitForRefresh, undefined);

    fake(replayClient).close();
    const ordinaryClient = socket();
    internals.shouldUseDurableClientRefresh = () => false;
    internals.replayOutputFor = () => ({ data: "", kind: "raw" });
    manager.attach(pane.id, ordinaryClient, 80, 24);
    const ordinaryReady = await waitForMessage(ordinaryClient, (message) => message.type === "ready");
    assert.equal(ordinaryReady.waitForRefresh, undefined);
  } finally {
    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("output watchers receive raw replay instead of a rendered checkpoint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-output-replay-"));
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  const state = new StateStore([machine], path.join(dir, "state.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  const manager = new SessionManager(state, [machine]);
  const client = socket();
  const session = {
    pane,
    pid: 42,
    isExited: false,
    replayOutput: "WMUX_AGENT_READY\n",
    attachReplay: { data: "rendered checkpoint", kind: "checkpoint" as const },
  };
  const internals = manager as unknown as {
    ensureSession: (candidate: typeof pane, cols: number, rows: number) => typeof session;
  };
  internals.ensureSession = () => session;
  try {
    manager.watchOutput(pane.id, client, 80, 24);
    const ready = await waitForMessage(client, (message) => message.type === "ready");
    assert.equal(ready.replayKind, "raw");
    assert.equal(ready.replay, "WMUX_AGENT_READY\n");
  } finally {
    fake(client).close();
    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("offline registered machines reject new session creation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-offline-"));
  const machine: MachineConfig = {
    id: "offline-host",
    name: "Offline host",
    kind: "ssh",
    host: "100.70.0.8",
    source: "registered",
    online: false,
  };
  const state = new StateStore([machine], path.join(dir, "state.json"));
  const workspace = state.createWorkspace(machine.id);
  const pane = workspace.tabs[0].panes[0];
  const manager = new SessionManager(state, [machine]);
  try {
    assert.throws(() => manager.writePane(pane.id, "whoami\n"), /machine offline-host is offline/);
  } finally {
    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
    this.emit("sent");
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  message(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

const socket = (): WebSocket => new FakeSocket() as unknown as WebSocket;
const fake = (ws: WebSocket): FakeSocket => ws as unknown as FakeSocket;

const waitForMessage = async (ws: WebSocket, predicate: (message: any) => boolean, timeoutMs = 3_000): Promise<any> => {
  const target = fake(ws);
  const existing = target.sent.find(predicate);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for session message: ${JSON.stringify(target.sent.slice(-3))}`));
    }, timeoutMs);
    const onSent = () => {
      const match = target.sent.find(predicate);
      if (!match) return;
      cleanup();
      resolve(match);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      target.off("sent", onSent);
    };
    target.on("sent", onSent);
  });
};

const waitForCondition = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const waitForWebSocketMessage = async (
  ws: WebSocket,
  predicate: (message: any) => boolean,
  timeoutMs = 5_000,
): Promise<any> => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    cleanup();
    reject(new Error("timed out waiting for websocket message"));
  }, timeoutMs);
  const onMessage = (raw: WebSocket.RawData) => {
    const message = JSON.parse(raw.toString());
    if (!predicate(message)) return;
    cleanup();
    resolve(message);
  };
  const cleanup = () => {
    clearTimeout(timeout);
    ws.off("message", onMessage);
  };
  ws.on("message", onMessage);
});

const withState = async (machine: MachineConfig, run: (state: StateStore, dir: string) => Promise<void>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-manager-"));
  try {
    await run(new StateStore([machine], path.join(dir, "state.json")), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("failed agent exit retains its old endpoint snapshot for close after a heartbeat move", async () => {
  let oldDeletes = 0;
  let newRequests = 0;
  const oldAgent = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      response.end(JSON.stringify({ pid: 1, base: 0 }));
      return;
    }
    if (request.method === "GET") {
      response.end(JSON.stringify({ cursor: 0, exited: true, exitCode: 1 }));
      return;
    }
    if (request.method === "DELETE") {
      oldDeletes += 1;
      response.end(JSON.stringify({ deleted: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const newAgent = http.createServer((_request, response) => {
    newRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ deleted: true }));
  });
  oldAgent.listen(0, "127.0.0.1");
  newAgent.listen(0, "127.0.0.1");
  await Promise.all([once(oldAgent, "listening"), once(newAgent, "listening")]);
  const oldAddress = oldAgent.address();
  const newAddress = newAgent.address();
  assert.ok(oldAddress && typeof oldAddress === "object");
  assert.ok(newAddress && typeof newAddress === "object");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-agent-move-"));
  let machine: MachineConfig = {
    id: "moving-agent",
    name: "Moving agent",
    kind: "powershell-ssh",
    host: "127.0.0.1",
    sessionBackend: "agent",
    agentPort: oldAddress.port,
    agentToken: "test-agent-token",
    source: "registered",
    online: true,
  };
  const state = new StateStore([machine], path.join(dir, "state.json"));
  const workspace = state.createWorkspace(machine.id);
  const pane = workspace.tabs[0].panes[0];
  const manager = new SessionManager(state, () => [machine]);
  const client = socket();
  try {
    manager.attach(pane.id, client, 80, 24);
    await waitForMessage(client, (message) => message.type === "exit");
    assert.equal(state.findPane(pane.id)?.status, "exited");

    machine = { ...machine, agentPort: newAddress.port };
    assert.equal(manager.closePane(pane.id), true);
    for (let attempt = 0; attempt < 50 && oldDeletes === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(oldDeletes, 1);
    assert.equal(newRequests, 0);
  } finally {
    manager.disposeAll();
    oldAgent.close();
    newAgent.close();
    oldAgent.closeAllConnections();
    newAgent.closeAllConnections();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent interrupt input excludes terminal escape sequences", () => {
  assert.equal(isAgentInterruptInput("\x03"), true);
  assert.equal(isAgentInterruptInput("\x1b"), true);
  assert.equal(isAgentInterruptInput("\x1b\x1b"), true);
  assert.equal(isAgentInterruptInput("\x1b[A"), false);
  assert.equal(isAgentInterruptInput("\x1bf"), false);
  assert.equal(isAgentInterruptInput("text"), false);
});

test("terminal-generated response metadata survives client message parsing", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "input", data: "\x1b[?62;22c", terminalResponse: true })), {
    type: "input",
    data: "\x1b[?62;22c",
    terminalResponse: true,
  });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "input", data: "text", terminalResponse: false })), {
    type: "input",
    data: "text",
  });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "input", data: "x", sequence: 42 })), {
    type: "input",
    data: "x",
    sequence: 42,
  });
  assert.equal(parseClientMessage(JSON.stringify({ type: "input", data: "x", sequence: 0 })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: "input", data: "x", sequence: 1.5 })), null);
});

test("pane output acknowledges each browser's latest input sequence without tagging output watchers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-input-ack-"));
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  const state = new StateStore([machine], path.join(dir, "state.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  const manager = new SessionManager(state, [machine]);
  const client = socket();
  const watcher = socket();
  const internals = manager as unknown as {
    sockets: Map<string, Set<WebSocket>>;
    outputWatchers: Map<string, Set<WebSocket>>;
    socketState: Map<WebSocket, { paneId: string; cols: number; rows: number; foreground: boolean; inputSequence?: number }>;
    broadcastOutput: (paneId: string, data: string) => void;
  };
  try {
    internals.sockets.set(pane.id, new Set([client]));
    internals.outputWatchers.set(pane.id, new Set([watcher]));
    internals.socketState.set(client, { paneId: pane.id, cols: 80, rows: 24, foreground: true, inputSequence: 7 });
    internals.broadcastOutput(pane.id, "echo");
    assert.deepEqual(fake(client).sent.at(-1), { type: "output", paneId: pane.id, data: "echo", inputSequence: 7 });
    assert.deepEqual(fake(watcher).sent.at(-1), { type: "output", paneId: pane.id, data: "echo" });
  } finally {
    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server recognizes terminal replies from stale browser clients", () => {
  assert.equal(isTerminalProtocolResponseInput("\x1b[?62;22c"), true);
  assert.equal(isTerminalProtocolResponseInput("\x1b[?62;22c\x1b[?62;22c"), true);
  assert.equal(isTerminalProtocolResponseInput("\x1b[12;40R"), true);
  assert.equal(isTerminalProtocolResponseInput("\x1bP>|libghostty 0.1.0-dev\x1b\\"), true);
  assert.equal(isTerminalProtocolResponseInput("\x1b[>1;0;0c\x1bP>|libghostty 0.1.0-dev\x1b\\"), true);
  assert.equal(isTerminalProtocolResponseInput("\x1b]10;rgb:c0c0/caca/f5f5\x1b\\"), true);
  assert.equal(isTerminalProtocolResponseInput("\x1b]4;1;rgb:f7f7/7676/8e8e\x07"), true);
  assert.equal(isTerminalProtocolResponseInput("\x1bP>|other-terminal 1.0\x1b\\"), false);
  assert.equal(isTerminalProtocolResponseInput("\x1b[A"), false);
});

test("new sessions receive the current terminal theme environment", { skip: process.platform === "win32" }, async () => {
  const machine: MachineConfig = {
    id: "local",
    name: "Local",
    kind: "local",
    command: ["/bin/sh", "-c", "printf '%s|%s' \"$WMUX_COLOR_SCHEME\" \"$WMUX_COLOR_MODE\"; sleep 0.1"],
  };
  await withState(machine, async (state) => {
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(
      state,
      [machine],
      "",
      undefined,
      undefined,
      undefined,
      () => ({ WMUX_COLOR_SCHEME: "tokyo-night", WMUX_COLOR_MODE: "dark" }),
    );
    const client = socket();
    try {
      manager.attach(pane.id, client, 80, 24);
      const output = await waitForMessage(client, (message) => message.type === "output" && message.data.includes("tokyo-night|dark"));
      assert.match(output.data, /tokyo-night\|dark/);
    } finally {
      manager.disposeAll();
    }
  });
});

test("multi-client PTY attach broadcasts output, replays, and removes cleanly", { skip: process.platform === "win32" }, async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  await withState(machine, async (state) => {
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    const first = socket();
    const second = socket();
    manager.attach(pane.id, first, 80, 24);
    manager.attach(pane.id, second, 100, 30);
    await Promise.all([
      waitForMessage(first, (message) => message.type === "ready"),
      waitForMessage(second, (message) => message.type === "ready"),
    ]);
    fake(second).message({ type: "input", data: "printf 'wmux-multi-marker\\n'\r" });
    await Promise.all([
      waitForMessage(first, (message) => message.type === "output" && message.data.includes("wmux-multi-marker")),
      waitForMessage(second, (message) => message.type === "output" && message.data.includes("wmux-multi-marker")),
    ]);

    fake(second).close();
    const reconnected = socket();
    manager.attach(pane.id, reconnected, 92, 28);
    const ready = await waitForMessage(reconnected, (message) => message.type === "ready");
    assert.match(ready.replay, /wmux-multi-marker/);
    assert.equal(ready.replayKind, "raw");

    const workspaceId = state.snapshot().workspaces[0].id;
    assert.equal(manager.closeWorkspace(workspaceId), true);
    await waitForMessage(reconnected, (message) => message.type === "removed");
    assert.equal(state.findPane(pane.id), null);
    manager.disposeAll();
  });
});

test("active resize ownership keeps every viewer on one authoritative grid", { skip: process.platform === "win32" }, async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  await withState(machine, async (state) => {
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    const first = socket();
    const second = socket();
    manager.attach(pane.id, first, 80, 24);
    const firstReady = await waitForMessage(first, (message) => message.type === "ready");
    assert.deepEqual(
      { cols: firstReady.cols, rows: firstReady.rows, resizeOwner: firstReady.resizeOwner },
      { cols: 80, rows: 24, resizeOwner: true },
    );
    fake(first).message({ type: "activate", cols: 80, rows: 24, foreground: true });

    const internals = manager as unknown as {
      sessions: Map<string, { resize: (cols: number, rows: number) => void }>;
    };
    const session = internals.sessions.get(pane.id);
    assert.ok(session);
    const originalResize = session.resize.bind(session);
    const resizes: Array<[number, number]> = [];
    session.resize = (cols, rows) => {
      resizes.push([cols, rows]);
      originalResize(cols, rows);
    };

    manager.attach(pane.id, second, 100, 30);
    const secondReady = await waitForMessage(second, (message) => message.type === "ready");
    assert.deepEqual(
      { cols: secondReady.cols, rows: secondReady.rows, resizeOwner: secondReady.resizeOwner },
      { cols: 80, rows: 24, resizeOwner: false },
    );
    fake(second).message({ type: "activate", cols: 100, rows: 30, foreground: true });
    assert.deepEqual(resizes, []);

    fake(second).message({ type: "input", data: "" });
    assert.deepEqual(resizes, [[100, 30]]);
    assert.deepEqual(
      await waitForMessage(first, (message) => message.type === "size" && message.cols === 100),
      { type: "size", paneId: pane.id, cols: 100, rows: 30, resizeOwner: false },
    );
    assert.deepEqual(
      await waitForMessage(second, (message) => message.type === "size" && message.cols === 100),
      { type: "size", paneId: pane.id, cols: 100, rows: 30, resizeOwner: true },
    );
    fake(first).message({ type: "activate", cols: 80, rows: 24, foreground: true });
    assert.deepEqual(resizes, [[100, 30]]);

    fake(first).message({ type: "input", data: "" });
    assert.deepEqual(resizes, [[100, 30], [80, 24]]);
    manager.disposeAll();
  });
});

test("an inactive owner keeps the canonical size until another foreground viewer activates", { skip: process.platform === "win32" }, async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  await withState(machine, async (state) => {
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    const first = socket();
    const second = socket();
    manager.attach(pane.id, first, 80, 24);
    await waitForMessage(first, (message) => message.type === "ready");
    fake(first).message({ type: "activate", cols: 80, rows: 24, foreground: true });

    const internals = manager as unknown as {
      sessions: Map<string, { resize: (cols: number, rows: number) => void }>;
    };
    const session = internals.sessions.get(pane.id);
    assert.ok(session);
    const originalResize = session.resize.bind(session);
    const resizes: Array<[number, number]> = [];
    session.resize = (cols, rows) => {
      resizes.push([cols, rows]);
      originalResize(cols, rows);
    };

    manager.attach(pane.id, second, 100, 30);
    await waitForMessage(second, (message) => message.type === "ready");
    fake(first).message({ type: "resize", cols: 90, rows: 27, foreground: false });
    assert.deepEqual(resizes, []);

    fake(second).message({ type: "activate", cols: 100, rows: 30, foreground: true });
    assert.deepEqual(resizes, [[100, 30]]);
    assert.deepEqual(
      await waitForMessage(first, (message) => message.type === "size" && message.cols === 100),
      { type: "size", paneId: pane.id, cols: 100, rows: 30, resizeOwner: false },
    );

    fake(first).message({ type: "resize", cols: 110, rows: 34, foreground: false });
    assert.deepEqual(resizes, [[100, 30]]);
    fake(second).message({ type: "resize", cols: 100, rows: 30, foreground: false });
    fake(second).close();
    assert.deepEqual(resizes, [[100, 30]]);
    assert.deepEqual(
      await waitForMessage(first, (message) => message.type === "size" && message.resizeOwner),
      { type: "size", paneId: pane.id, cols: 100, rows: 30, resizeOwner: true },
    );

    fake(first).message({ type: "activate", cols: 110, rows: 34, foreground: true });
    assert.deepEqual(resizes, [[100, 30], [110, 34]]);
    manager.disposeAll();
  });
});

test("late attach receives an authoritative checkpoint for a full-screen PTY", { skip: process.platform === "win32" }, async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  await withState(machine, async (state) => {
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    const first = socket();
    manager.attach(pane.id, first, 80, 24);
    await waitForMessage(first, (message) => message.type === "ready");

    fake(first).message({
      type: "input",
      data: "printf '\\033[?1049h\\033[2J\\033[Hcheckpoint-marker\\033[3;4Hcursor'\r",
    });
    await waitForMessage(
      first,
      (message) => message.type === "output"
        && message.data.includes("\x1b[?1049h")
        && message.data.includes("checkpoint-marker"),
    );
    fake(first).close();

    const reconnected = socket();
    manager.attach(pane.id, reconnected, 80, 24);
    const ready = await waitForMessage(reconnected, (message) => message.type === "ready");
    assert.equal(ready.replayKind, "checkpoint");
    assert.match(ready.replay, /checkpoint-marker/);
    assert.match(ready.replay, /cursor/);

    manager.disposeAll();
  });
});

test(
  "new and reattached tmux panes synchronize cwd after the durable session is ready",
  { skip: process.platform === "win32" || spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-cwd-"));
    const initialCwd = path.join(dir, "initial");
    const movedCwd = path.join(dir, "moved");
    fs.mkdirSync(initialCwd);
    fs.mkdirSync(movedCwd);
    const machine: MachineConfig = {
      id: "local",
      name: "Local",
      kind: "local",
      shell: "/bin/sh",
      sessionBackend: "tmux",
      cwd: initialCwd,
    };
    const state = new StateStore([machine], path.join(dir, "state.json"));
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const sessionName = durableSessionName(pane.id);
    const firstManager = new SessionManager(state, [machine]);
    let secondManager: SessionManager | undefined;
    const first = socket();
    try {
      firstManager.attach(pane.id, first, 80, 24);
      await waitForMessage(first, (message) => message.type === "ready");
      await waitForCondition(() => state.findPane(pane.id)?.cwd === initialCwd, 5_000);

      fake(first).message({ type: "input", data: `cd '${movedCwd}' && printf 'cwd-moved\\n'\r` });
      await waitForMessage(first, (message) => message.type === "output" && message.data.includes("cwd-moved"));
      await waitForCondition(() => {
        const result = spawnSync("tmux", ["display-message", "-p", "-t", sessionName, "#{pane_current_path}"], {
          encoding: "utf8",
        });
        return result.status === 0 && result.stdout.trim() === movedCwd;
      });

      firstManager.disposeAll();
      state.updatePane(pane.id, { cwd: undefined });
      secondManager = new SessionManager(state, [machine]);
      const second = socket();
      secondManager.attach(pane.id, second, 88, 26);
      await waitForMessage(second, (message) => message.type === "ready");
      await waitForCondition(() => state.findPane(pane.id)?.cwd === movedCwd, 5_000);
    } finally {
      firstManager.disposeAll();
      secondManager?.disposeAll();
      spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "output watchers receive replay from durable tmux panes",
  { skip: process.platform === "win32" || spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const machine: MachineConfig = {
      id: "local",
      name: "Local",
      kind: "local",
      shell: "/bin/sh",
      sessionBackend: "tmux",
    };
    await withState(machine, async (state) => {
      const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
      const sessionName = durableSessionName(pane.id);
      const manager = new SessionManager(state, [machine]);
      const first = socket();
      try {
        manager.watchOutput(pane.id, first, 80, 24);
        await waitForMessage(first, (message) => message.type === "ready");
        fake(first).close();

        assert.equal(manager.writePane(pane.id, "printf 'durable-output-marker\\n'\r", 80, 24), true);
        const internals = manager as unknown as {
          sessions: Map<string, { replayOutput: string }>;
        };
        await waitForCondition(() => internals.sessions.get(pane.id)?.replayOutput.includes("durable-output-marker") === true);

        const second = socket();
        manager.watchOutput(pane.id, second, 80, 24);
        const ready = await waitForMessage(second, (message) => message.type === "ready");
        assert.equal(ready.outputOnly, true);
        assert.match(ready.replay, /durable-output-marker/);
        fake(second).close();
      } finally {
        manager.disposeAll();
        spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
      }
    });
  },
);

test(
  "tmux pane survives manager disposal and explicit close kills its durable session",
  { skip: process.platform === "win32" || spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const machine: MachineConfig = { id: "local", name: "Local", kind: "local", shell: "/bin/sh", sessionBackend: "tmux" };
    await withState(machine, async (state) => {
      const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
      const sessionName = durableSessionName(pane.id);
      const firstManager = new SessionManager(state, [machine]);
      let secondManager: SessionManager | undefined;
      const first = socket();
      try {
        firstManager.attach(pane.id, first, 80, 24);
        await waitForMessage(first, (message) => message.type === "ready");
        fake(first).message({
          type: "input",
          data: "export WMUX_RESTORE_MARKER=survived; printf '\\n\\155\\141\\162\\153\\145\\162\\055\\163\\145\\164\\n'\r",
        });
        await waitForMessage(
          first,
          (message) => message.type === "output" && message.data.includes("marker-set"),
        );
        firstManager.disposeAll();
        assert.equal(spawnSync("tmux", ["has-session", "-t", sessionName]).status, 0);

        secondManager = new SessionManager(state, [machine]);
        const second = socket();
        secondManager.attach(pane.id, second, 88, 26);
        await waitForMessage(second, (message) => message.type === "ready");
        fake(second).message({ type: "input", data: "printf 'restore:%s\\n' \"$WMUX_RESTORE_MARKER\"\r" });
        await waitForMessage(second, (message) => message.type === "output" && message.data.includes("restore:survived"), 5_000);

        assert.equal(secondManager.closeWorkspace(state.snapshot().workspaces[0].id), true);
        await waitForCondition(() => spawnSync("tmux", ["has-session", "-t", sessionName]).status !== 0);
        assert.notEqual(spawnSync("tmux", ["has-session", "-t", sessionName]).status, 0);
      } finally {
        firstManager.disposeAll();
        secondManager?.disposeAll();
        spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
      }
    });
  },
);

test(
  "output-only HTTP websocket refreshes a controller-created tmux pane and streams later input",
  { skip: process.platform === "win32" || spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-controller-tmux-"));
    const machine: MachineConfig = {
      id: "local",
      name: "Local",
      kind: "local",
      shell: "/bin/sh",
      sessionBackend: "tmux",
    };
    const state = new StateStore([machine], path.join(dir, "state.json"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    const manager = new SessionManager(state, [machine]);
    const workspace = state.snapshot().workspaces[0];
    const pane = workspace.tabs[0].panes[0];
    const sessionName = durableSessionName(pane.id);
    const server = await createHttpServer("127.0.0.1", state, [machine], manager, settings, {
      auth: { enabled: false, token: "", loginEnabled: false, sessionSecret: "test" },
      healthResolvers: { machines: async () => [], streams: async () => [] },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const output = new WebSocket(`${base.replace(/^http/, "ws")}/ws/panes/${pane.id}/output?cols=96&rows=32`);
    const readyPromise = waitForWebSocketMessage(output, (message) => message.type === "ready");
    try {
      await once(output, "open");
      const ready = await readyPromise;
      assert.equal(ready.outputOnly, true);
      assert.equal(ready.replay, "");
      assert.equal(ready.waitForRefresh, true);
      const refreshed = await waitForWebSocketMessage(
        output,
        (message) => message.type === "output" && message.data.length > 0,
      );
      assert.notEqual(refreshed.data, "", "controller should receive the refreshed tmux display");

      const marker = `wmux-controller-live-${process.pid}`;
      const liveOutput = waitForWebSocketMessage(
        output,
        (message) => message.type === "output" && message.data.includes(marker),
      );
      const input = await fetch(`${base}/api/panes/${pane.id}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: `printf '${marker}\\n'\r`, cols: 96, rows: 32 }),
      });
      assert.equal(input.status, 200);
      assert.match((await liveOutput).data, new RegExp(marker));

      const controllerOutput = await execFileAsync(
        "python3",
        ["skills/wmux/scripts/wmuxctl.py", "--url", base, "output", pane.id],
        {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH, HOME: dir, WMUX_TOKEN: "" },
        },
      );
      assert.match(controllerOutput.stdout, new RegExp(marker));
      assert.match(controllerOutput.stdout, /^.*[$#]\s*$/m);

      const closed = await fetch(`${base}/api/workspaces/${workspace.id}`, { method: "DELETE" });
      assert.equal(closed.status, 200);
      await waitForCondition(() => spawnSync("tmux", ["has-session", "-t", sessionName]).status !== 0);
    } finally {
      output.terminate();
      manager.disposeAll();
      server.close();
      await once(server, "close");
      state.flush();
      spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
