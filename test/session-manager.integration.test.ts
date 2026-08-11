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
import { DurableEndpointStore } from "../src/server/durable-endpoint-store.js";
import { durableSessionName } from "../src/server/machines.js";
import {
  isAgentInterruptInput,
  isTerminalProtocolResponseInput,
  paneAuthEnvironmentForMachine,
  parseClientMessage,
  resolveDisposalMachine,
  resolvePersistedPaneMachine,
  sessionAccessTokenForMachine,
  createAgentInputSessionBinding,
  SessionManager,
} from "../src/server/session-manager.js";
import { StateStore } from "../src/server/state.js";
import { SettingsStore } from "../src/server/settings.js";
import type { MachineConfig } from "../src/server/types.js";
import {
  expectedWindowsAgentProtocolVersion,
  expectedWindowsAgentReleaseVersion,
  windowsHelperBundleVersion,
} from "../src/server/windows-helpers.js";

const execFileAsync = promisify(execFile);
const canonicalTempRoot = fs.realpathSync(os.tmpdir());

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

test("persisted panes recover base and generation origins without using changed SSH DNS", () => {
  const configured: MachineConfig = {
    id: "windows",
    name: "Windows",
    kind: "powershell-ssh",
    host: "changed.internal",
    sessionBackend: "agent",
    agentUrl: "http://100.64.0.30:3481",
    agentPort: 3481,
    agentToken: "replacement-token",
  };
  const pane = {
    id: "pane-generation",
    machineId: configured.id,
    agentPort: 3482,
    title: "PowerShell",
    status: "idle" as const,
    createdAt: "2026-08-05T00:00:00.000Z",
  };
  const recovered = {
    ...configured,
    host: "100.64.0.20",
    agentUrl: undefined,
    agentPort: 3482,
    agentToken: "recovered-token",
  };
  const resolvedLegacy = resolvePersistedPaneMachine(pane, configured, recovered);
  assert.equal(resolvedLegacy.agentUrl, "http://100.64.0.20:3482");
  assert.equal(resolvedLegacy.host, "100.64.0.20");
  assert.equal(resolvedLegacy.agentToken, "recovered-token");

  const recoveredBase = { ...recovered, agentUrl: "http://100.64.0.25:3490", agentPort: 3490 };
  const resolvedBase = resolvePersistedPaneMachine({ ...pane, agentPort: undefined }, configured, recoveredBase);
  assert.equal(resolvedBase.agentUrl, "http://100.64.0.25:3490");
  assert.equal(resolvedBase.agentPort, 3490);
  assert.equal(resolvedBase.agentToken, "recovered-token");
});

test("every backend attachment receives a fresh agent-input authority epoch", () => {
  const machine: MachineConfig = {
    id: "durable", name: "Durable", kind: "ssh", host: "100.70.0.8", sessionBackend: "tmux",
  };
  const backend = { id: "durable-multiplexer" as const };
  const first = createAgentInputSessionBinding("pane-one", backend, machine);
  const recycled = createAgentInputSessionBinding("pane-one", backend, machine);
  assert.notEqual(recycled.sessionIncarnation, first.sessionIncarnation);
  assert.equal(recycled.endpointFingerprint, first.endpointFingerprint);

  const retargeted = createAgentInputSessionBinding(
    "pane-one", backend, { ...machine, host: "100.70.0.9" },
  );
  assert.notEqual(retargeted.sessionIncarnation, first.sessionIncarnation);
  assert.notEqual(retargeted.endpointFingerprint, first.endpointFingerprint);
  const restarted = createAgentInputSessionBinding("pane-one", backend, machine);
  assert.notEqual(restarted.sessionIncarnation, first.sessionIncarnation,
    "a manager restart has no retained binding and creates a fresh authority epoch");
});

test("idle durable-client recycle detaches only the transient client and keeps the old endpoint snapshot", () => {
  const dir = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-session-recycle-"));
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
    backends: Map<string, { detach: (session: unknown) => void }>;
    sessionMachines: Map<string, MachineConfig>;
    agentInputSessionBindings: Map<string, ReturnType<typeof createAgentInputSessionBinding>>;
    shouldUseDurableClientRefresh: (pane: typeof pane) => boolean;
    hasPaneConnections: (paneId: string) => boolean;
    recycleIdleDurableClient: (pane: typeof pane) => boolean;
  };
  let killed = false;
  let detached = false;
  const binding = createAgentInputSessionBinding(pane.id, { id: "durable-multiplexer" }, machine);
  const retired: unknown[] = [];
  const session = { pane, isExited: false, kill: () => { killed = true; } };
  internals.sessions.set(pane.id, session);
  internals.backends.set(pane.id, {
    detach: (candidate) => {
      assert.equal(candidate, session);
      detached = true;
    },
  });
  internals.sessionMachines.set(pane.id, structuredClone(machine));
  internals.agentInputSessionBindings.set(pane.id, binding);
  manager.setAgentInputSourceRetirer((_paneId, retiredBinding) => retired.push(retiredBinding));
  internals.shouldUseDurableClientRefresh = () => true;
  internals.hasPaneConnections = () => false;
  try {
    assert.equal(internals.recycleIdleDurableClient(pane), true);
    assert.equal(detached, true);
    assert.equal(killed, false);
    assert.equal(internals.sessionMachines.get(pane.id)?.host, "100.70.0.8");
    assert.deepEqual(retired, [binding]);
    assert.equal(internals.agentInputSessionBindings.has(pane.id), false);

    killed = false;
    detached = false;
    internals.sessions.set(pane.id, { pane, isExited: false, kill: () => { killed = true; } });
    internals.hasPaneConnections = () => true;
    assert.equal(internals.recycleIdleDurableClient(pane), false);
    assert.equal(detached, false);
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
  const dir = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-session-refresh-ready-"));
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
  const dir = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-session-output-replay-"));
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
  const dir = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-session-offline-"));
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

test("agent-input authority epochs are exact and graceful shutdown retires only the current binding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-agent-input-epoch-"));
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  const state = new StateStore([machine], path.join(dir, "state.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  const manager = new SessionManager(state, [machine]);
  const oldBinding = {
    backendId: "raw-pty" as const,
    sessionIncarnation: "1".repeat(64),
    endpointFingerprint: "2".repeat(64),
  };
  const currentBinding = { ...oldBinding, sessionIncarnation: "3".repeat(64) };
  const session = { pane, isExited: false };
  const retired: Array<{ paneId: string; binding: typeof oldBinding }> = [];
  let detached = false;
  const internals = manager as unknown as {
    sessions: Map<string, typeof session>;
    backends: Map<string, { detach: (candidate: typeof session) => void }>;
    sessionMachines: Map<string, MachineConfig>;
    agentInputSessionBindings: Map<string, typeof oldBinding>;
  };
  try {
    state.updatePane(pane.id, { status: "running" });
    internals.sessions.set(pane.id, session);
    internals.backends.set(pane.id, { detach: (candidate) => {
      assert.equal(candidate, session);
      detached = true;
    } });
    internals.sessionMachines.set(pane.id, machine);
    internals.agentInputSessionBindings.set(pane.id, oldBinding);
    manager.setAgentInputSourceRetirer((paneId, binding) => retired.push({ paneId, binding }));
    assert.equal(manager.hasLivePaneSession(pane.id, oldBinding), true);

    internals.agentInputSessionBindings.set(pane.id, currentBinding);
    assert.equal(manager.hasLivePaneSession(pane.id, oldBinding), false,
      "a prior source authority epoch cannot authenticate after same-pane replacement");
    assert.equal(manager.hasLivePaneSession(pane.id, currentBinding), true);

    manager.disposeAll();
    assert.equal(detached, true);
    assert.deepEqual(retired, [{ paneId: pane.id, binding: currentBinding }]);
    assert.equal(manager.hasLivePaneSession(pane.id, currentBinding), false);
  } finally {
    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("abnormal live backend exit retires its exact agent-input authority", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-agent-input-exit-"));
  const machine: MachineConfig = {
    id: "local",
    name: "Local",
    kind: "local",
    command: ["/bin/sh", "-c", "exit 9"],
    sessionBackend: "pty",
  };
  const state = new StateStore([machine], path.join(dir, "state.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  const manager = new SessionManager(state, [machine]);
  const client = socket();
  const retired: Array<{ paneId: string; binding: unknown }> = [];
  manager.setAgentInputSourceRetirer((paneId, binding) => retired.push({ paneId, binding }));
  try {
    manager.attach(pane.id, client, 80, 24);
    await waitForMessage(client, (message) => message.type === "exit");
    assert.equal(retired.length, 1);
    assert.equal(retired[0].paneId, pane.id);
    assert.match(JSON.stringify(retired[0].binding), /raw-pty/);
    assert.equal(manager.hasLivePaneSession(pane.id), false);
    assert.equal(state.findPane(pane.id)?.status, "exited");
  } finally {
    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  const dir = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-session-manager-"));
  try {
    await run(new StateStore([machine], path.join(dir, "state.json")), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("shutdown cancels pending workspace close timers", async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local" };
  await withState(machine, async (state) => {
    const workspace = state.createWorkspace(machine.id);
    const manager = new SessionManager(state, [machine]);
    const internals = manager as unknown as {
      pendingWorkspaceCloses: Map<string, unknown>;
    };
    assert.ok(manager.scheduleWorkspaceClose(workspace.id, 10));
    manager.disposeAll();
    assert.equal(internals.pendingWorkspaceCloses.size, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(state.snapshot().workspaces.some((candidate) => candidate.id === workspace.id));
  });
});

test("reattaching a pinned Windows generation retains the configured base agent port", async () => {
  const machine: MachineConfig = {
    id: "windows-agent",
    name: "Windows agent",
    kind: "powershell-ssh",
    host: "127.0.0.1",
    sessionBackend: "agent",
    agentPort: 3481,
    agentToken: "test-agent-token",
  };
  await withState(machine, async (state) => {
    const workspace = state.createWorkspace(machine.id);
    const pane = workspace.tabs[0].panes[0];
    state.updatePane(pane.id, { agentPort: 3482 });
    const manager = new SessionManager(state, [machine]);
    const internals = manager as unknown as {
      sessions: Map<string, { configuredBaseAgentPort?: number }>;
    };
    try {
      manager.writePane(pane.id, "");
      assert.equal(internals.sessions.get(pane.id)?.configuredBaseAgentPort, 3481);
    } finally {
      manager.disposeAll();
    }
  });
});

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

  const dir = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-session-agent-move-"));
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

test("restart reattaches a referenced rollout generation on its pinned private origin", async () => {
  let generationRequests = 0;
  let generationDeletes = 0;
  let baseRequests = 0;
  let createAuthorization = "";
  let createEnvironment: Record<string, string> | undefined;
  let expectedPaneId = "";
  const generationAgent = http.createServer(async (request, response) => {
    generationRequests += 1;
    const requestPath = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && requestPath === "/health") {
      response.end(JSON.stringify({
        ok: true,
        releaseVersion: expectedWindowsAgentReleaseVersion(),
        protocolVersion: expectedWindowsAgentProtocolVersion(),
        helperBundleVersion: windowsHelperBundleVersion(),
        activeSessions: 0,
        draining: false,
      }));
      return;
    }
    if (request.method === "GET" && requestPath === "/sessions") {
      response.end(JSON.stringify({ sessions: [] }));
      return;
    }
    if (request.method === "POST" && requestPath === `/sessions/${expectedPaneId}`) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      createAuthorization = String(request.headers.authorization ?? "");
      createEnvironment = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        env?: Record<string, string>;
      }).env;
      response.end(JSON.stringify({
        id: expectedPaneId,
        pid: 61,
        base: 0,
        cursor: 0,
      }));
      return;
    }
    if (request.method === "GET" && requestPath.startsWith(`/sessions/${expectedPaneId}/output`)) {
      response.end(JSON.stringify({ base: 0, cursor: 0, dataBase64: "", exited: false }));
      return;
    }
    if (request.method === "POST" && requestPath === `/sessions/${expectedPaneId}/resize`) {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "DELETE") {
      generationDeletes += 1;
      response.end(JSON.stringify({ removed: true }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  const baseAgent = http.createServer((_request, response) => {
    baseRequests += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "wrong_origin" }));
  });
  generationAgent.listen(0, "127.0.0.1");
  baseAgent.listen(0, "127.0.0.1");
  await Promise.all([once(generationAgent, "listening"), once(baseAgent, "listening")]);
  const generationAddress = generationAgent.address();
  const baseAddress = baseAgent.address();
  assert.ok(generationAddress && typeof generationAddress === "object");
  assert.ok(baseAddress && typeof baseAddress === "object");
  const directory = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-session-generation-restart-"));
  const statePath = path.join(directory, "state.json");
  const endpointPath = path.join(directory, "session-endpoints.json");
  const configuredMachine: MachineConfig = {
    id: "windows-generation",
    name: "Windows generation",
    kind: "powershell-ssh",
    host: "changed-ssh-name.internal",
    sessionBackend: "agent",
    agentUrl: `http://127.0.0.1:${baseAddress.port}`,
    agentPort: baseAddress.port,
    agentToken: "generation-secret",
    source: "config",
  };
  let manager: SessionManager | undefined;
  try {
    const initialState = new StateStore([configuredMachine], statePath);
    const initialPane = initialState.snapshot().workspaces[0].tabs[0].panes[0];
    expectedPaneId = initialPane.id;
    initialState.updatePane(initialPane.id, { agentPort: generationAddress.port });
    const pane = initialState.snapshot().workspaces[0].tabs[0].panes[0];
    initialState.flush();
    const generationMachine = {
      ...configuredMachine,
      agentUrl: `http://127.0.0.1:${generationAddress.port}`,
      agentPort: generationAddress.port,
      agentToken: "recovered-generation-secret",
    };
    const endpoints = new DurableEndpointStore(endpointPath);
    const record = endpoints.bind(pane.id, generationMachine, "windows-agent");
    assert.ok(record);

    const restartedState = new StateStore([configuredMachine], statePath);
    manager = new SessionManager(
      restartedState,
      [configuredMachine],
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      "helper-scope",
      "login-only",
      undefined,
      undefined,
      new DurableEndpointStore(endpointPath),
    );
    const restoredRecord = new DurableEndpointStore(endpointPath).find(record.id);
    assert.equal(restoredRecord?.status, "active");
    assert.equal(restoredRecord?.machine.agentUrl, `http://127.0.0.1:${generationAddress.port}`);

    const client = socket();
    manager.attach(pane.id, client, 80, 24);
    await waitForMessage(client, (message) => message.type === "ready");
    assert.ok(generationRequests >= 3);
    assert.equal(baseRequests, 0);
    assert.equal(generationDeletes, 0, "restart reconciliation never cleanup-deletes the referenced generation");
    assert.equal(createAuthorization, "Bearer recovered-generation-secret");
    assert.equal(createEnvironment?.WMUX_PANE_ID, pane.id);
    assert.equal(restartedState.findPane(pane.id)?.agentPort, generationAddress.port);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      workspaces: Array<{ tabs: Array<{ panes: Array<Record<string, unknown>> }> }>;
    };
    assert.equal("agentUrl" in persisted.workspaces[0].tabs[0].panes[0], false);
  } finally {
    manager?.disposeAll();
    generationAgent.closeAllConnections();
    baseAgent.closeAllConnections();
    generationAgent.close();
    baseAgent.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("agent interrupt input scopes bare escape fallback to Codex", () => {
  assert.equal(isAgentInterruptInput("\x03"), true);
  assert.equal(isAgentInterruptInput("\x03", "prime-agent"), true);
  assert.equal(isAgentInterruptInput("\x1b", "codex"), true);
  assert.equal(isAgentInterruptInput("\x1b\x1b", "codex"), true);
  assert.equal(isAgentInterruptInput("\x1b", "prime-agent"), false);
  assert.equal(isAgentInterruptInput("\x1b"), false);
  assert.equal(isAgentInterruptInput("\x1b[A", "codex"), false);
  assert.equal(isAgentInterruptInput("\x1bf", "codex"), false);
  assert.equal(isAgentInterruptInput("text", "codex"), false);
});

test("Prime Agent escape UI actions do not interrupt active pane lifecycle", async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  await withState(machine, async (state) => {
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    const client = socket();
    manager.attach(pane.id, client, 80, 24);
    await waitForMessage(client, (message) => message.type === "ready");
    manager.agentSessions.recordAgentEvent({
      paneId: pane.id,
      agent: "prime-agent",
      status: "running",
      summary: "Main turn and subagents active",
    });

    fake(client).message({ type: "input", data: "\x1b" });
    assert.equal(state.snapshot().agentEvents[0]?.status, "running");

    fake(client).message({ type: "input", data: "\x03" });
    assert.equal(state.snapshot().agentEvents[0]?.status, "interrupted");
    manager.disposeAll();
  });
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
  const dir = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-session-input-ack-"));
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  const state = new StateStore([machine], path.join(dir, "state.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  const manager = new SessionManager(state, [machine]);
  const client = socket();
  const watcher = socket();
  const internals = manager as unknown as {
    sockets: Map<string, Set<WebSocket>>;
    outputWatchers: Map<string, Set<WebSocket>>;
    socketState: Map<WebSocket, { paneId: string; cols: number; rows: number; inputSequence?: number }>;
    broadcastOutput: (paneId: string, data: string) => void;
  };
  try {
    internals.sockets.set(pane.id, new Set([client]));
    internals.outputWatchers.set(pane.id, new Set([watcher]));
    internals.socketState.set(client, { paneId: pane.id, cols: 80, rows: 24, inputSequence: 7 });
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

test("only the authoritative viewer forwards non-color terminal query responses", { skip: process.platform === "win32" }, async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  await withState(machine, async (state) => {
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    const first = socket();
    const second = socket();
    manager.attach(pane.id, first, 80, 24);
    await waitForMessage(first, (message) => message.type === "ready");
    manager.attach(pane.id, second, 100, 30);
    await waitForMessage(second, (message) => message.type === "ready");

    const internals = manager as unknown as {
      backends: Map<string, {
        write: (session: unknown, data: string, terminalResponse?: boolean) => void;
      }>;
      resizeOwners: Map<string, WebSocket>;
    };
    const backend = internals.backends.get(pane.id);
    assert.ok(backend);
    const writes: Array<{ data: string; terminalResponse: boolean }> = [];
    backend.write = (_session, data, terminalResponse = false) => {
      writes.push({ data, terminalResponse });
    };
    const response = "\x1b[>1;0;0c\x1bP>|libghostty\x1b\\";
    const staleColorResponse = "\x1b]10;rgb:c0c0/caca/f5f5\x1b\\";

    fake(first).message({ type: "input", data: staleColorResponse, terminalResponse: true });
    assert.deepEqual(writes, []);

    fake(second).message({ type: "input", data: response, terminalResponse: true });
    assert.deepEqual(writes, []);
    assert.equal(internals.resizeOwners.get(pane.id), first);

    fake(first).message({ type: "input", data: response });
    assert.deepEqual(writes, [{ data: response, terminalResponse: true }]);

    fake(second).message({ type: "input", data: "x", sequence: 1 });
    assert.deepEqual(writes.at(-1), { data: "x", terminalResponse: false });
    assert.equal(internals.resizeOwners.get(pane.id), second);

    fake(first).message({ type: "input", data: response, terminalResponse: true });
    assert.deepEqual(writes, [
      { data: response, terminalResponse: true },
      { data: "x", terminalResponse: false },
    ]);
    fake(second).message({ type: "input", data: response, terminalResponse: true });
    assert.deepEqual(writes.at(-1), { data: response, terminalResponse: true });
    manager.disposeAll();
  });
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

test("server answers startup color queries without a browser viewer", { skip: process.platform === "win32" }, async () => {
  const expected = [
    "\x1b]10;rgb:c0c0/caca/f5f5\x1b\\",
    "\x1b]11;rgb:1a1a/1b1b/2626\x1b\\",
    "\x1b]4;1;rgb:f7f7/7676/8e8e\x1b\\",
  ].join("");
  const queryPrefix = "\x1b]10";
  const querySuffix = ";?\x07\x1b]11;?\x1b\\\x1b]4;1;?\x07";
  const program = `
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let received = "";
    const expected = ${JSON.stringify(expected)};
    const timeout = setTimeout(() => {
      process.stdout.write("WMUX_COLOR_RESPONSE_TIMEOUT");
      process.exit(2);
    }, 2000);
    process.stdin.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (!received.includes(expected)) return;
      clearTimeout(timeout);
      process.stdout.write("WMUX_COLOR_RESPONSE_OK");
      process.exit(0);
    });
    process.stdout.write(${JSON.stringify(queryPrefix)});
    setTimeout(() => process.stdout.write(${JSON.stringify(querySuffix)}), 10);
  `;
  const machine: MachineConfig = {
    id: "local",
    name: "Local",
    kind: "local",
    command: [process.execPath, "-e", program],
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
      () => ({
        WMUX_COLOR_SCHEME: "tokyo-night",
        WMUX_COLOR_MODE: "dark",
      }),
    );
    const watcher = socket();
    try {
      manager.watchOutput(pane.id, watcher, 80, 24);
      const output = await waitForMessage(
        watcher,
        (message) => message.type === "output" && message.data.includes("WMUX_COLOR_RESPONSE_OK"),
      );
      assert.match(output.data, /WMUX_COLOR_RESPONSE_OK/);
      assert.equal(
        fake(watcher).sent.some((message: any) => message.type === "output" && message.data.includes("WMUX_COLOR_RESPONSE_TIMEOUT")),
        false,
      );
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
    assert.equal(ready.replayKind, "checkpoint");

    const workspaceId = state.snapshot().workspaces[0].id;
    assert.equal(manager.closeWorkspace(workspaceId), true);
    await waitForMessage(reconnected, (message) => message.type === "removed");
    assert.equal(state.findPane(pane.id), null);
    manager.disposeAll();
  });
});

test("session manager reaps expired agent workspaces while preserving retained workspaces", async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  await withState(machine, async (state) => {
    const retained = state.snapshot().workspaces[0];
    const expired = state.createWorkspace(
      "local",
      undefined,
      "agent",
      undefined,
      undefined,
      { policy: "on-success", cleanupAt: "2000-01-01T00:00:00.000Z" },
    );
    const manager = new SessionManager(state, [machine]);
    try {
      assert.equal(
        state.snapshot().workspaces.some((workspace) => workspace.id === expired.id),
        false,
      );
      assert.equal(
        state.snapshot().workspaces.some((workspace) => workspace.id === retained.id),
        true,
      );
      assert.deepEqual(manager.sweepExpiredAgentWorkspaces(), []);
    } finally {
      manager.disposeAll();
    }
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
    assert.deepEqual(resizes, [[100, 30]]);
    assert.deepEqual(
      await waitForMessage(second, (message) => message.type === "size" && message.cols === 100),
      { type: "size", paneId: pane.id, cols: 100, rows: 30, resizeOwner: true },
    );

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
    assert.deepEqual(resizes, [[100, 30], [80, 24]]);

    fake(first).message({ type: "input", data: "" });
    assert.deepEqual(resizes, [[100, 30], [80, 24]]);
    manager.disposeAll();
  });
});

test("an unfocused sole resize owner still applies browser-window geometry", { skip: process.platform === "win32" }, async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  await withState(machine, async (state) => {
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    const viewer = socket();
    manager.attach(pane.id, viewer, 80, 24);
    await waitForMessage(viewer, (message) => message.type === "ready");

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

    fake(viewer).message({ type: "resize", cols: 120, rows: 36, foreground: false });
    assert.deepEqual(resizes, [[120, 36]]);
    assert.deepEqual(
      await waitForMessage(viewer, (message) => message.type === "size" && message.cols === 120),
      { type: "size", paneId: pane.id, cols: 120, rows: 36, resizeOwner: true },
    );
    manager.disposeAll();
  });
});

test("foreground activation transfers resize ownership before terminal input", { skip: process.platform === "win32" }, async () => {
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
    fake(second).message({ type: "activate", cols: 100, rows: 30, foreground: true });
    assert.deepEqual(resizes, [[100, 30]]);

    fake(first).message({ type: "resize", cols: 90, rows: 27, foreground: false });
    assert.deepEqual(resizes, [[100, 30]]);

    fake(first).message({ type: "resize", cols: 110, rows: 34, foreground: false });
    assert.deepEqual(resizes, [[100, 30]]);
    fake(second).message({ type: "resize", cols: 100, rows: 30, foreground: false });
    fake(second).close();
    assert.deepEqual(resizes, [[100, 30]]);

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

test("late attach after a terminal resize receives an authoritative checkpoint", async () => {
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local", command: ["/bin/sh"] };
  await withState(machine, async (state) => {
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    try {
      const first = socket();
      manager.attach(pane.id, first, 80, 24);
      await waitForMessage(first, (message) => message.type === "ready");

      fake(first).message({
        type: "input",
        data: "printf '\\033[2J\\033[24;1Hcross-size-marker\\033[24;20H\\033[?25l'\r",
      });
      await waitForMessage(
        first,
        (message) =>
          message.type === "output"
          && message.data.includes("\x1b[2J")
          && message.data.includes("cross-size-marker"),
      );
      fake(first).close();

      const reconnected = socket();
      manager.attach(pane.id, reconnected, 40, 12);
      const ready = await waitForMessage(reconnected, (message) => message.type === "ready");
      assert.equal(ready.replayKind, "checkpoint");
      assert.match(ready.replay, /cross-size-marker/);
      assert.match(ready.replay, /\x1b\[\?25l/);
    } finally {
      manager.disposeAll();
    }
  });
});

test(
  "raw PTY restores its persisted screen checkpoint after manager restart",
  { skip: process.platform === "win32" },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(canonicalTempRoot, "wmux-raw-checkpoint-"),
    );
    const machine: MachineConfig = {
      id: "local",
      name: "Local",
      kind: "local",
      shell: "/bin/sh",
      sessionBackend: "pty",
    };
    const state = new StateStore(
      [machine],
      path.join(directory, "state.json"),
    );
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const firstManager = new SessionManager(state, [machine]);
    let secondManager: SessionManager | undefined;
    const first = socket();
    try {
      firstManager.attach(pane.id, first, 80, 24);
      await waitForMessage(first, (message) => message.type === "ready");
      fake(first).message({
        type: "input",
        data: "printf '\\033[?1049h\\033[2J\\033[HWMUX_PERSISTED_SCREEN'\r",
      });
      await waitForMessage(
        first,
        (message) =>
          message.type === "output"
          && message.data.includes("WMUX_PERSISTED_SCREEN"),
      );

      firstManager.disposeAll();
      secondManager = new SessionManager(state, [machine]);
      const second = socket();
      secondManager.attach(pane.id, second, 92, 28);
      const ready = await waitForMessage(
        second,
        (message) => message.type === "ready",
      );
      assert.equal(ready.replayKind, "checkpoint");
      assert.match(ready.replay, /WMUX_PERSISTED_SCREEN/);
      assert.equal(
        secondManager.closeWorkspace(
          state.snapshot().workspaces[0].id,
        ),
        true,
      );
      assert.equal(
        fs.readdirSync(
          path.join(directory, "pane-checkpoints"),
        ).some((entry) => entry.endsWith(".json")),
        false,
      );
    } finally {
      firstManager.disposeAll();
      secondManager?.disposeAll();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "new and reattached tmux panes synchronize cwd after the durable session is ready",
  { skip: process.platform === "win32" || spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const dir = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-session-cwd-"));
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
      await waitForCondition(() => state.findPane(pane.id)?.cwd === movedCwd, 5_000);

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

        fake(first).close();
        const reattached = socket();
        firstManager.attach(pane.id, reattached, 84, 25);
        await waitForMessage(reattached, (message) => message.type === "ready");
        fake(reattached).message({
          type: "input",
          data: "printf 'same-manager:%s\\n' \"$WMUX_RESTORE_MARKER\"\r",
        });
        await waitForMessage(
          reattached,
          (message) => message.type === "output" && message.data.includes("same-manager:survived"),
          5_000,
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
    const dir = fs.mkdtempSync(path.join(canonicalTempRoot, "wmux-controller-tmux-"));
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
