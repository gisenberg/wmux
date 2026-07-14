import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createHttpServer } from "../src/server/http.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { BootstrapPayload, MachineConfig } from "../src/server/types.js";

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
