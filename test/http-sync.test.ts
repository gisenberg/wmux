import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import {
  HEALTH_EPOCH_PROCESS_STRIDE,
  PROCESS_HEALTH_EPOCH_BASE,
  createHttpServer,
  healthEpochForProcessStart,
  nextHealthEpoch,
} from "../src/server/http.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { BootstrapPayload, MachineConfig, MachineStatus, StreamStatus } from "../src/server/types.js";

const listen = async (server: http.Server): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
};

const close = async (server: http.Server): Promise<void> => {
  server.close();
  await once(server, "close");
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const nextSocketMessage = <T>(ws: WebSocket, predicate: (message: unknown) => boolean): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for WebSocket message"));
    }, 2_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message: unknown = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      cleanup();
      resolve(message as T);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });

test("health epochs use safe restart-sortable process bases", () => {
  const firstProcess = healthEpochForProcessStart(1_000);
  const laterProcess = healthEpochForProcessStart(1_001);
  let firstProcessEpoch = firstProcess;
  for (let index = 0; index < 10; index += 1) firstProcessEpoch = nextHealthEpoch(firstProcessEpoch);
  assert.equal(laterProcess - firstProcess, HEALTH_EPOCH_PROCESS_STRIDE);
  assert.ok(laterProcess > firstProcessEpoch);
  assert.ok(Number.isSafeInteger(PROCESS_HEALTH_EPOCH_BASE));
  assert.throws(() => nextHealthEpoch(Number.MAX_SAFE_INTEGER), /health epoch exhausted/);
});

test("workspace reorder API moves existing workspaces and validates targets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-http-reorder-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(dir, "state.json"));
  const first = state.snapshot().workspaces[0];
  const second = state.createWorkspace("local");
  const third = state.createWorkspace("local");
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  const server = await createHttpServer("127.0.0.1", state, machines, {} as SessionManager, settings, {
    auth: { enabled: false, token: "", loginEnabled: false, sessionSecret: "test" },
  });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: third.id, targetWorkspaceId: first.id, position: "after" }),
    });
    const payload = await response.json() as { state: BootstrapPayload };
    assert.equal(response.status, 200);
    assert.deepEqual(payload.state.workspaces.map((workspace) => workspace.id), [second.id, first.id, third.id]);

    const invalid = await fetch(`http://127.0.0.1:${port}/api/workspaces/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: third.id, targetWorkspaceId: first.id, position: "middle" }),
    });
    assert.equal(invalid.status, 400);

    const missing = await fetch(`http://127.0.0.1:${port}/api/workspaces/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "missing", targetWorkspaceId: first.id, position: "before" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    state.flush();
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delegation status API returns persisted lifecycle results by run id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-http-delegation-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(dir, "state.json"));
  const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
  state.recordAgentEvent({
    paneId,
    runId: "run-http-1",
    agent: "codex",
    status: "completed",
    title: "Review",
    summary: "Codex delegation completed",
    message: "Review result",
  });
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  const server = await createHttpServer("127.0.0.1", state, machines, {} as SessionManager, settings, {
    auth: { enabled: true, token: "delegation-test-token", loginEnabled: false, sessionSecret: "test" },
  });
  const port = await listen(server);

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/delegations/run-http-1`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`http://127.0.0.1:${port}/api/delegations/run-http-1`, {
      headers: { authorization: "Bearer delegation-test-token" },
    });
    const payload = await response.json() as { delegation: { state: string; result: string } };
    assert.equal(response.status, 200);
    assert.equal(payload.delegation.state, "completed");
    assert.equal(payload.delegation.result, "Review result");

    const missing = await fetch(`http://127.0.0.1:${port}/api/delegations/missing`, {
      headers: { authorization: "Bearer delegation-test-token" },
    });
    assert.equal(missing.status, 404);
  } finally {
    state.flush();
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mutations use cached health and publish revisioned WebSocket snapshots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-http-sync-"));
  const healthDelayMs = 600;
  const healthServer = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, upstream: { ok: true }, target: { ok: true } }));
    }, healthDelayMs);
  });
  const healthPort = await listen(healthServer);
  const machines: MachineConfig[] = [
    {
      id: "local",
      name: "Local",
      kind: "local",
      stream: { provider: "moonlight-gateway", gatewayUrl: `http://127.0.0.1:${healthPort}` },
    },
  ];
  const state = new StateStore(machines, path.join(dir, "state.json"));
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  const sessions = {} as SessionManager;
  const server = await createHttpServer("127.0.0.1", state, machines, sessions, settings, {
    auth: { enabled: false, token: "", loginEnabled: false, sessionSecret: "test" },
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  let ws: WebSocket | undefined;
  let secondWs: WebSocket | undefined;

  try {
    const bootstrapStart = performance.now();
    const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
    const bootstrap = (await bootstrapResponse.json()) as BootstrapPayload;
    const bootstrapMs = performance.now() - bootstrapStart;
    assert.equal(bootstrapResponse.status, 200);
    assert.equal(bootstrap.healthEpoch, PROCESS_HEALTH_EPOCH_BASE);
    assert.ok(Number.isSafeInteger(bootstrap.healthEpoch));
    assert.ok(bootstrapMs >= healthDelayMs * 0.75, `expected slow health bootstrap, got ${bootstrapMs.toFixed(1)}ms`);
    assert.ok(bootstrap.streams[0].checkedAt);

    ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    secondWs = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    await Promise.all([once(ws, "open"), once(secondWs, "open")]);
    const snapshotPromise = nextSocketMessage<{
      type: "snapshot";
      reason: string;
      revision: number;
      state: BootstrapPayload;
    }>(ws, (message) => Boolean(message && typeof message === "object" && "type" in message && message.type === "snapshot"));
    const secondSnapshotPromise = nextSocketMessage<{
      type: "snapshot";
      reason: string;
      revision: number;
      state: BootstrapPayload;
    }>(secondWs, (message) => Boolean(message && typeof message === "object" && "type" in message && message.type === "snapshot"));

    const originalSnapshot = state.snapshot.bind(state);
    let snapshotCalls = 0;
    state.snapshot = () => {
      snapshotCalls += 1;
      return originalSnapshot();
    };

    const workspaceId = bootstrap.workspaces[0].id;
    const mutationStart = performance.now();
    const mutationResponse = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fast rename" }),
    });
    const mutation = (await mutationResponse.json()) as { state: BootstrapPayload };
    const mutationMs = performance.now() - mutationStart;
    assert.equal(mutationResponse.status, 200);
    assert.ok(mutationMs < bootstrapMs / 2, `mutation ${mutationMs.toFixed(1)}ms should not wait for health`);
    assert.ok(mutation.state.revision > bootstrap.revision);

    const socketSnapshot = await snapshotPromise;
    const secondSocketSnapshot = await secondSnapshotPromise;
    assert.equal(socketSnapshot.reason, "state");
    assert.equal(socketSnapshot.revision, mutation.state.revision);
    assert.equal(socketSnapshot.state.workspaces[0].name, "Fast rename");
    assert.equal(socketSnapshot.state.streams[0].checkedAt, bootstrap.streams[0].checkedAt);
    assert.equal(secondSocketSnapshot.revision, socketSnapshot.revision);
    assert.equal(snapshotCalls, 2, "one shared event snapshot plus one HTTP response snapshot");
  } finally {
    ws?.terminate();
    secondWs?.terminate();
    state.flush();
    await close(server);
    await close(healthServer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("health polls publish only meaningful typed deltas to every browser", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-health-delta-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  let changed = false;
  let machineChecks = 0;
  let streamChecks = 0;
  const machineResolver = async (): Promise<MachineStatus[]> => [{
    id: "local", name: "Local", kind: "local", platform: "linux", reachable: changed, checkedAt: `machine-${++machineChecks}`, releaseVersion: "vtest-linux",
  }];
  const streamResolver = async (): Promise<StreamStatus[]> => [{
    machineId: "local", provider: "mediamtx", path: "local", live: changed, requested: false, requestCount: 0, viewerCount: 0,
    webRtcUrl: "http://stream", openUrl: "http://stream", checkedAt: `stream-${++streamChecks}`,
  }];
  const state = new StateStore(machines, path.join(dir, "state.json"));
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  const server = await createHttpServer("127.0.0.1", state, machines, {} as SessionManager, settings, {
    auth: { enabled: false, token: "", loginEnabled: false, sessionSecret: "test" },
    healthRefreshIntervals: { machines: 20, streams: 20 },
    healthResolvers: { machines: machineResolver, streams: streamResolver },
  });
  const port = await listen(server);
  const messages: unknown[][] = [[], []];
  const sockets = [new WebSocket(`ws://127.0.0.1:${port}/ws/events`), new WebSocket(`ws://127.0.0.1:${port}/ws/events`)];
  try {
    const opened = Promise.all(sockets.map((socket, index) => {
      socket.on("message", (raw) => messages[index].push(JSON.parse(raw.toString())));
      return once(socket, "open");
    }));
    await opened;
    await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
    messages.forEach((items) => { items.length = 0; });
    await sleep(90);
    assert.equal(messages.flat().some((message) => (message as { type?: string }).type === "health"), false, "checkedAt-only polls stay quiet");
    changed = true;
    const receivedChangedHealth = (items: unknown[]): boolean => {
      const health = items.filter((message): message is { type: "health"; machines?: MachineStatus[]; streams?: StreamStatus[] } =>
        (message as { type?: string }).type === "health");
      return health.some((message) => message.machines?.[0]?.reachable === true)
        && health.some((message) => message.streams?.[0]?.live === true);
    };
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && messages.some((items) => !receivedChangedHealth(items))) await sleep(10);
    for (const received of messages) {
      const health = received.filter((message): message is { type: "health"; healthEpoch: number; machines?: MachineStatus[]; streams?: StreamStatus[] } => (message as { type?: string }).type === "health");
      assert.ok(health.some((message) => message.machines?.[0]?.reachable === true && message.machines[0].checkedAt.startsWith("machine-")));
      assert.ok(health.some((message) => message.streams?.[0]?.live === true && message.streams[0].checkedAt.startsWith("stream-")));
      assert.equal(received.some((message) => (message as { type?: string }).type === "snapshot"), false, "health never serializes a snapshot");
      assert.ok(health.every((message) => message.healthEpoch > 0));
    }
  } finally {
    sockets.forEach((socket) => socket.terminate());
    state.flush();
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/settings persists terminal scroll mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-http-settings-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const settingsPath = path.join(dir, "settings.json");
  const state = new StateStore(machines, path.join(dir, "state.json"));
  const settings = new SettingsStore(settingsPath);
  const server = await createHttpServer("127.0.0.1", state, machines, {} as SessionManager, settings, {
    auth: { enabled: false, token: "", loginEnabled: false, sessionSecret: "test" },
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalScrollMode: "immediate" }),
    });
    const payload = (await response.json()) as { settings: BootstrapPayload["settings"] };
    assert.equal(response.status, 200);
    assert.equal(payload.settings.terminalScrollMode, "immediate");
    assert.equal(settings.snapshot().terminalScrollMode, "immediate");
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).terminalScrollMode, "immediate");
  } finally {
    state.flush();
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
