import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { AuthConfig } from "../src/server/auth.js";
import { HostRegistry } from "../src/server/host-registry.js";
import { createHttpServer } from "../src/server/http.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import { resolveStreamStatuses } from "../src/server/streams.js";
import type { BootstrapPayload, MachineConfig, MachineStatus, StreamStatus } from "../src/server/types.js";

const sharedAuth: AuthConfig = {
  enabled: true,
  token: "wmux-token",
  loginEnabled: false,
  sessionSecret: "test-session-secret",
};

const listen = async (server: http.Server): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
};

interface TestServer {
  baseUrl: string;
  registry: HostRegistry;
  state: StateStore;
  close: () => Promise<void>;
}

const startServer = async (
  auth: AuthConfig = sharedAuth,
  healthRefreshIntervals?: { machines?: number; streams?: number },
  healthResolvers?: NonNullable<Parameters<typeof createHttpServer>[5]>["healthResolvers"],
): Promise<TestServer> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-registry-http-"));
  const staticMachines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const registry = new HostRegistry(staticMachines, path.join(dir, "registry.json"), undefined, undefined, 0);
  const currentMachines = (): MachineConfig[] => registry.machines();
  const state = new StateStore(currentMachines(), path.join(dir, "state.json"));
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  const sessions = {} as SessionManager;
  const server = await createHttpServer("127.0.0.1", state, currentMachines, sessions, settings, {
    auth,
    hostRegistry: registry,
    registrationToken: "registration-token",
    trustedProxies: new Set(["127.0.0.1"]),
    healthRefreshIntervals,
    healthResolvers,
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    registry,
    state,
    close: async () => {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
      registry.dispose();
      state.flush();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

const bearer = (token: string): HeadersInit => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

const registrationBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    machine: { id: "roamer", name: "Roamer", kind: "ssh", port: 1, ...overrides },
    ttlMs: 60_000,
  });

test("registration POST always requires its dedicated token and DELETE uses wmux auth", async () => {
  const app = await startServer();
  try {
    const noToken = await fetch(`${app.baseUrl}/api/registry/hosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: registrationBody(),
    });
    assert.equal(noToken.status, 401);

    const queryToken = await fetch(`${app.baseUrl}/api/registry/hosts?token=registration-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: registrationBody(),
    });
    assert.equal(queryToken.status, 401);

    const sharedToken = await fetch(`${app.baseUrl}/api/registry/hosts`, {
      method: "POST",
      headers: bearer("wmux-token"),
      body: registrationBody(),
    });
    assert.equal(sharedToken.status, 401);

    const registered = await fetch(`${app.baseUrl}/api/registry/hosts`, {
      method: "POST",
      headers: { ...bearer("registration-token"), "x-forwarded-for": "127.0.0.2" },
      body: registrationBody({ host: "ignored.example" }),
    });
    assert.equal(registered.status, 200);
    const registrationAck = await registered.json() as { host: Record<string, unknown> };
    assert.deepEqual(Object.keys(registrationAck.host).sort(), ["expiresAt", "id", "lastSeenAt"]);
    assert.equal(registrationAck.host.id, "roamer");

    const registrationRead = await fetch(`${app.baseUrl}/api/registry/hosts`, {
      headers: bearer("registration-token"),
    });
    assert.equal(registrationRead.status, 401);

    const deleteWithRegistration = await fetch(`${app.baseUrl}/api/registry/hosts/roamer`, {
      method: "DELETE",
      headers: bearer("registration-token"),
    });
    assert.equal(deleteWithRegistration.status, 401);

    const removed = await fetch(`${app.baseUrl}/api/registry/hosts/roamer`, {
      method: "DELETE",
      headers: bearer("wmux-token"),
    });
    assert.equal(removed.status, 200);
  } finally {
    await app.close();
  }
});

test("registration remains token-gated when main wmux auth is disabled", async () => {
  const app = await startServer({ enabled: false, token: "", loginEnabled: false, sessionSecret: "" });
  try {
    const rejected = await fetch(`${app.baseUrl}/api/registry/hosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: registrationBody(),
    });
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${app.baseUrl}/api/registry/hosts`, {
      method: "POST",
      headers: { ...bearer("registration-token"), "x-forwarded-for": "127.0.0.2" },
      body: registrationBody(),
    });
    assert.equal(accepted.status, 200);

    const removed = await fetch(`${app.baseUrl}/api/registry/hosts/roamer`, { method: "DELETE" });
    assert.equal(removed.status, 200);
  } finally {
    await app.close();
  }
});

test("registry responses and browser bootstrap redact observed-host agent credentials", async () => {
  const app = await startServer();
  try {
    const body = registrationBody({
      id: "dynamic-win",
      name: "Dynamic Windows",
      kind: "powershell-ssh",
      host: "ignored.example",
      user: "operator",
      sessionBackend: "agent",
      agentPort: 1,
      agentToken: "private-agent-token",
    });
    const registered = await fetch(`${app.baseUrl}/api/registry/hosts`, {
      method: "POST",
      headers: { ...bearer("registration-token"), "x-forwarded-for": "127.0.0.2" },
      body,
    });
    assert.equal(registered.status, 200);
    assert.doesNotMatch(await registered.text(), /private-agent-token|ignored\.example/);

    const registryResponse = await fetch(`${app.baseUrl}/api/registry/hosts`, { headers: bearer("wmux-token") });
    assert.equal(registryResponse.status, 200);
    assert.doesNotMatch(await registryResponse.text(), /private-agent-token|ignored\.example/);

    const bootstrapResponse = await fetch(`${app.baseUrl}/api/bootstrap`, { headers: bearer("wmux-token") });
    assert.equal(bootstrapResponse.status, 200);
    const bootstrapText = await bootstrapResponse.text();
    assert.doesNotMatch(bootstrapText, /private-agent-token|ignored\.example/);
    const bootstrap = JSON.parse(bootstrapText) as BootstrapPayload;
    assert.equal(bootstrap.machines.find((machine) => machine.id === "dynamic-win")?.host, "127.0.0.2");

    const registrationBundle = await fetch(`${app.baseUrl}/api/helpers/windows/dynamic-win`, {
      headers: bearer("registration-token"),
    });
    assert.equal(registrationBundle.status, 401);

    const enrollmentBootstrap = await fetch(
      `${app.baseUrl}/api/helpers/windows/dynamic-win/bootstrap?token=registration-token`,
    );
    assert.equal(enrollmentBootstrap.status, 401);

    const bootstrapToken = app.registry.bootstrapToken("dynamic-win");
    assert.ok(bootstrapToken);
    const registeredBootstrap = await fetch(
      `${app.baseUrl}/api/helpers/windows/dynamic-win/bootstrap?token=${encodeURIComponent(bootstrapToken)}`,
    );
    assert.equal(registeredBootstrap.status, 200);
    const registeredBootstrapText = await registeredBootstrap.text();
    assert.match(registeredBootstrapText, /FromBase64String/);
    assert.doesNotMatch(registeredBootstrapText, /private-agent-token|wmux-token|registration-token/);

    const broadBundle = await fetch(`${app.baseUrl}/api/helpers/windows/dynamic-win`, { headers: bearer("wmux-token") });
    assert.equal(broadBundle.status, 200);
    assert.doesNotMatch(await broadBundle.text(), /private-agent-token/);
  } finally {
    await app.close();
  }
});

test("bootstrap cache follows same-cardinality heartbeat address changes", async () => {
  const app = await startServer();
  try {
    for (const address of ["127.0.0.2", "127.0.0.3"]) {
      const response = await fetch(`${app.baseUrl}/api/registry/hosts`, {
        method: "POST",
        headers: { ...bearer("registration-token"), "x-forwarded-for": address },
        body: registrationBody(),
      });
      assert.equal(response.status, 200);

      const bootstrapResponse = await fetch(`${app.baseUrl}/api/bootstrap`, { headers: bearer("wmux-token") });
      const bootstrap = (await bootstrapResponse.json()) as BootstrapPayload;
      assert.equal(bootstrap.machines.find((machine) => machine.id === "roamer")?.host, address);
    }
  } finally {
    await app.close();
  }
});

test("periodic health and stream lease mutations force cached status refreshes", async () => {
  const app = await startServer(sharedAuth, { machines: 30, streams: 30 });
  try {
    const firstResponse = await fetch(`${app.baseUrl}/api/bootstrap`, { headers: bearer("wmux-token") });
    const first = (await firstResponse.json()) as BootstrapPayload;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const secondResponse = await fetch(`${app.baseUrl}/api/bootstrap`, { headers: bearer("wmux-token") });
    const second = (await secondResponse.json()) as BootstrapPayload;
    assert.notEqual(second.machines[0].checkedAt, first.machines[0].checkedAt);
    assert.notEqual(second.streams[0].checkedAt, first.streams[0].checkedAt);

    const requestedResponse = await fetch(`${app.baseUrl}/api/streams/local/request`, {
      method: "POST",
      headers: bearer("wmux-token"),
      body: JSON.stringify({ requestId: "registry-test", ttlMs: 30_000 }),
    });
    const requested = (await requestedResponse.json()) as { streams: BootstrapPayload["streams"] };
    assert.equal(requested.streams[0].requested, true);

    const releasedResponse = await fetch(`${app.baseUrl}/api/streams/local/request/registry-test`, {
      method: "DELETE",
      headers: bearer("wmux-token"),
    });
    const released = (await releasedResponse.json()) as { streams: BootstrapPayload["streams"] };
    assert.equal(released.streams[0].requested, false);
  } finally {
    await app.close();
  }
});

test("a cached bootstrap waits for an in-flight forced health refresh", async () => {
  let streamCalls = 0;
  let markSecondStarted!: () => void;
  let releaseSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  const secondRelease = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const app = await startServer(sharedAuth, undefined, {
    streams: async (...args) => {
      streamCalls += 1;
      if (streamCalls === 2) {
        markSecondStarted();
        await secondRelease;
      }
      return resolveStreamStatuses(...args);
    },
  });
  try {
    const initial = await fetch(`${app.baseUrl}/api/bootstrap`, { headers: bearer("wmux-token") });
    assert.equal(initial.status, 200);

    const forced = fetch(`${app.baseUrl}/api/streams`, { headers: bearer("wmux-token") });
    await secondStarted;
    let concurrentSettled = false;
    const concurrent = fetch(`${app.baseUrl}/api/bootstrap`, { headers: bearer("wmux-token") }).then((response) => {
      concurrentSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(concurrentSettled, false);

    releaseSecond();
    assert.equal((await forced).status, 200);
    assert.equal((await concurrent).status, 200);
  } finally {
    releaseSecond?.();
    await app.close();
  }
});

const withTimeout = <T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

test("timestamp-only heartbeats neither restart probes nor hide current presence metadata", async () => {
  let machineCalls = 0;
  let markSecondStarted!: () => void;
  let releaseSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  const secondRelease = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const app = await startServer(sharedAuth, { machines: 100_000, streams: 100_000 }, {
    machines: async (machines) => {
      machineCalls += 1;
      if (machineCalls === 2) {
        markSecondStarted();
        await secondRelease;
      }
      return machines.map((machine): MachineStatus => ({
        id: machine.id,
        name: machine.name,
        kind: machine.kind,
        host: machine.host,
        port: machine.port,
        source: machine.source,
        registeredAt: machine.registeredAt,
        lastSeenAt: machine.lastSeenAt,
        expiresAt: machine.expiresAt,
        online: machine.online,
        reachable: true,
        checkedAt: `probe-${machineCalls}`,
      }));
    },
    streams: async (machines) => machines.map((machine): StreamStatus => ({
      machineId: machine.id,
      checkedAt: "stream-probe",
      provider: "mediamtx",
      path: `wmux-${machine.id}`,
      live: false,
      requested: false,
      requestCount: 0,
      viewerCount: 0,
      webRtcUrl: "http://127.0.0.1/stream",
      openUrl: "http://127.0.0.1/stream",
    })),
  });
  const startedAt = Date.now();
  const input = JSON.parse(registrationBody()) as unknown;
  let events: WebSocket | undefined;
  try {
    app.registry.register(input, "127.0.0.2", startedAt);
    const initial = await fetch(`${app.baseUrl}/api/bootstrap`, { headers: bearer("wmux-token") });
    assert.equal(initial.status, 200);
    assert.equal(machineCalls, 1);

    app.registry.register(input, "127.0.0.3", startedAt + 5_000);
    await withTimeout(secondStarted, "second machine probe");
    const middleSeenAt = startedAt + 10_000;
    app.registry.register(input, "127.0.0.3", middleSeenAt);
    releaseSecond();
    const middle = (await (await fetch(`${app.baseUrl}/api/bootstrap`, {
      headers: bearer("wmux-token"),
    })).json()) as BootstrapPayload;
    assert.equal(machineCalls, 2);
    assert.equal(
      middle.machines.find((machine) => machine.id === "roamer")?.lastSeenAt,
      new Date(middleSeenAt).toISOString(),
    );

    events = new WebSocket(app.baseUrl.replace(/^http/, "ws") + "/ws/events?token=wmux-token");
    const ready = new Promise<void>((resolve) => {
      events?.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string };
        if (message.type === "ready") resolve();
      });
    });
    await withTimeout(once(events, "open").then(() => undefined), "event socket open");
    await withTimeout(ready, "event socket ready");

    const latestSeenAt = startedAt + 15_000;
    const presenceSnapshot = new Promise<{ reason?: string; state?: BootstrapPayload }>((resolve) => {
      events?.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string; reason?: string; state?: BootstrapPayload };
        if (message.type === "snapshot" && message.reason === "machines") resolve(message);
      });
    });
    app.registry.register(input, "127.0.0.3", latestSeenAt);
    const published = await withTimeout(presenceSnapshot, "machine presence snapshot");
    assert.equal(machineCalls, 2);
    assert.equal(
      published.state?.machines.find((machine) => machine.id === "roamer")?.lastSeenAt,
      new Date(latestSeenAt).toISOString(),
    );
  } finally {
    releaseSecond?.();
    if (events && events.readyState < WebSocket.CLOSING) {
      const closed = once(events, "close");
      events.close();
      await closed;
    }
    await app.close();
  }
});
