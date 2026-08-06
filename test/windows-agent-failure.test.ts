import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import {
  buildWindowsAgentUpdateSshInvocation,
  listSessionAgentSessions,
  parseWindowsAgentUpdateAcknowledgement,
  probeWindowsAgent,
  WindowsAgentSession,
} from "../src/server/windows-agent.js";
import {
  expectedWindowsAgentProtocolVersion,
  expectedWindowsAgentReleaseVersion,
  windowsHelperBundleVersion,
} from "../src/server/windows-helpers.js";
import { TerminalCheckpoint } from "../src/server/terminal-checkpoint.js";
import type { MachineConfig, PaneState } from "../src/server/types.js";

const waitUntil = async (predicate: () => boolean, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const listen = (server: http.Server, port: number) => new Promise<void>((resolve, reject) => {
  const onError = (error: Error) => {
    server.off("listening", onListening);
    reject(error);
  };
  const onListening = () => {
    server.off("error", onError);
    resolve();
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, "127.0.0.1");
});

const closeServer = async (server: http.Server) => {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
};

const listenOnAdjacentPorts = async (currentServer: http.Server, sideServer: http.Server) => {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    await listen(currentServer, 0);
    const address = currentServer.address();
    assert.ok(address && typeof address === "object");
    const currentPort = address.port;
    try {
      await listen(sideServer, currentPort + 1);
      return { currentPort, sidePort: currentPort + 1 };
    } catch {
      await closeServer(currentServer);
    }
  }
  throw new Error("could not reserve adjacent loopback ports after 32 attempts");
};

test("Windows agent updates use a bounded encoded SSH command with an explicit acknowledgement", () => {
  const invocation = buildWindowsAgentUpdateSshInvocation({
    id: "windows",
    name: "Windows",
    kind: "powershell-ssh",
    host: "192.168.1.20",
    user: "runner",
    sessionBackend: "agent",
  }, 3482);
  const encodedIndex = invocation.args.indexOf("-EncodedCommand");
  assert.ok(encodedIndex > 0);
  assert.equal(invocation.args.includes("-Command"), false);
  const script = Buffer.from(invocation.args[encodedIndex + 1], "base64").toString("utf16le");
  assert.match(script, /wmux-windows-agent-service\.ps1/);
  assert.match(script, /rollout-update --port 3482/);
  assert.match(script, /--expected-release 'v[^']+-win'/);
  assert.match(script, /--expected-protocol \d+/);
  assert.match(script, /--expected-helpers '[a-f0-9]+'/);
  assert.match(script, /wmuxUpdateActivation = \$true/);
  assert.equal(invocation.acknowledgementAction, "rollout-update");

  assert.equal(
    parseWindowsAgentUpdateAcknowledgement(
      '{"port":3482}\n{"wmuxUpdateActivation":true,"action":"rollout-update","port":3482}',
      "rollout-update",
      3482,
    ),
    3482,
  );
  assert.throws(
    () => parseWindowsAgentUpdateAcknowledgement("Update staged", "activate-update"),
    /missing activate-update acknowledgement/,
  );
});

test("Windows agent control failures are contained", async () => {
  const pane: PaneState = {
    id: "pane_failure_test",
    machineId: "windows",
    title: "PowerShell",
    status: "idle",
    createdAt: new Date(0).toISOString(),
  };
  const machine: MachineConfig = {
    id: "windows",
    name: "Windows",
    kind: "powershell-ssh",
    host: "127.0.0.1",
    sessionBackend: "agent",
    agentUrl: "http://127.0.0.1:1",
  };
  const session = new WindowsAgentSession(pane, machine, 80, 24);

  session.write("echo test\r");
  session.resize(100, 40);
  session.kill();

  // Connection-refused rejections arrive asynchronously. node:test treats an
  // unhandled rejection as a test failure, which protects the service-level
  // contract this regression test covers.
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test("Windows agent health probes fail within their timeout budget", async () => {
  const server = http.createServer((_request, response) => {
    setTimeout(() => response.end(JSON.stringify({ ok: true })), 250);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const startedAt = Date.now();
  const result = await probeWindowsAgent(
    {
      id: "windows-timeout",
      name: "Windows timeout",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    30,
  );
  assert.equal(result.reachable, false);
  assert.match(result.reason ?? "", /timed out/);
  assert.ok(Date.now() - startedAt < 1000);
  server.close();
  await once(server, "close");
});

test("session agent audit lists bounded valid pane identities only", async () => {
  let authorization = "";
  const server = http.createServer((request, response) => {
    authorization = String(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      sessions: [
        { id: "pane_valid", status: "running", pid: 42 },
        { id: "../invalid", status: "running", pid: 43 },
        { id: "x".repeat(121), status: "running", pid: 44 },
      ],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await listSessionAgentSessions({
    id: "agent",
    name: "Agent",
    kind: "ssh",
    host: "127.0.0.1",
    sessionBackend: "agent",
    agentUrl: `http://127.0.0.1:${address.port}`,
    agentToken: "server-secret",
  });
  assert.deepEqual(result, {
    reachable: true,
    sessions: [{
      paneId: "pane_valid",
      detail: "running, pid 42",
    }],
  });
  assert.equal(authorization, "Bearer server-secret");
  server.close();
  await once(server, "close");
});

test("Windows agent detach preserves the remote session while kill deletes it", async () => {
  const deleted: string[] = [];
  const created: string[] = [];
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    if (request.method === "POST" && /^\/sessions\/pane_/.test(path)) {
      created.push(path);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: path.split("/")[2], pid: 123, base: 0, cursor: 0 }));
      return;
    }
    if (request.method === "GET" && path.includes("/output")) {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ base: 0, cursor: 0, dataBase64: "", exited: false }));
      }, 10);
      return;
    }
    if (request.method === "DELETE") {
      deleted.push(path);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ removed: true }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const machine: MachineConfig = {
    id: "windows",
    name: "Windows",
    kind: "powershell-ssh",
    host: "127.0.0.1",
    sessionBackend: "agent",
    agentUrl: `http://127.0.0.1:${address.port}`,
  };
  const pane = (id: string): PaneState => ({
    id,
    machineId: "windows",
    title: "PowerShell",
    status: "idle",
    createdAt: new Date(0).toISOString(),
  });

  const detached = new WindowsAgentSession(pane("pane_detach"), machine, 80, 24);
  await waitUntil(() => created.includes("/sessions/pane_detach"));
  detached.detach();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(deleted, []);

  const killed = new WindowsAgentSession(pane("pane_kill"), machine, 80, 24);
  await waitUntil(() => created.includes("/sessions/pane_kill"));
  killed.kill();
  await waitUntil(() => deleted.includes("/sessions/pane_kill"));

  server.close();
  await once(server, "close");
});

test("Windows agent session creation forwards profile preferences", async () => {
  let createBody: Record<string, unknown> | undefined;
  const server = http.createServer(async (request, response) => {
    const path = request.url ?? "";
    if (request.method === "POST" && path === "/sessions/pane_profile") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      createBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "pane_profile", pid: 123, base: 0, cursor: 0 }));
      return;
    }
    if (request.method === "GET" && path.includes("/output")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ base: 0, cursor: 0, dataBase64: "", exited: false }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const session = new WindowsAgentSession(
    {
      id: "pane_profile",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
      loadPowerShellProfile: true,
      source: "registered",
    },
    80,
    24,
  );
  const phases: string[] = [];
  session.on("phase", (phase) => phases.push(phase));

  await waitUntil(() => createBody !== undefined);
  assert.deepEqual(phases.slice(0, 2), ["checking-agent", "creating-session"]);
  assert.equal(createBody?.loadPowerShellProfile, true);
  assert.equal(createBody?.agentProfileOptionalAuth, true);
  await session.attachReady;
  assert.equal(session.isExited, false);
  session.detach();
  server.close();
  await once(server, "close");
});

test("a new Windows pane stages and safely activates an outdated agent", async () => {
  const expectedRelease = expectedWindowsAgentReleaseVersion();
  const expectedProtocol = expectedWindowsAgentProtocolVersion();
  let release = expectedRelease;
  let protocol = Math.max(1, expectedProtocol - 1);
  let helperBundleVersion = "stale";
  let staged = false;
  let drained = false;
  let created = false;
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/health") {
      response.end(JSON.stringify({
        ok: true,
        version: release,
        releaseVersion: release,
        protocolVersion: protocol,
        helperBundleVersion,
        activeSessions: 0,
        draining: drained,
      }));
      return;
    }
    if (request.method === "GET" && path === "/sessions") {
      response.end(JSON.stringify({ sessions: [] }));
      return;
    }
    if (request.method === "POST" && path.startsWith("/sessions/__wmux_update_")) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          helperBundle?: { bundleVersion?: string };
        };
        helperBundleVersion = body.helperBundle?.bundleVersion ?? helperBundleVersion;
        staged = true;
        response.end(JSON.stringify({ id: path.split("/")[2], status: "running" }));
      });
      return;
    }
    if (request.method === "DELETE" && path.startsWith("/sessions/__wmux_update_")) {
      response.end(JSON.stringify({ removed: true }));
      return;
    }
    if (request.method === "POST" && path === "/drain") {
      drained = true;
      setTimeout(() => {
        release = expectedRelease;
        protocol = expectedProtocol;
        drained = false;
      }, 20);
      response.end(JSON.stringify({ activeSessions: 0, draining: true, restartWhenIdle: true }));
      return;
    }
    if (request.method === "POST" && path === "/sessions/pane_update") {
      created = true;
      response.end(JSON.stringify({ id: "pane_update", pid: 123, base: 0, cursor: 0 }));
      return;
    }
    if (request.method === "GET" && path.startsWith("/sessions/pane_update/output")) {
      response.end(JSON.stringify({ base: 0, cursor: 0, dataBase64: "", exited: false }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const session = new WindowsAgentSession(
    {
      id: "pane_update",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    24,
    {},
    async (_machine, rolloutPort) => {
      assert.equal(rolloutPort, undefined, "an idle base agent updates in place");
      const response = await fetch(`http://127.0.0.1:${address.port}/drain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restartWhenIdle: true }),
      });
      assert.equal(response.ok, true);
    },
  );
  await session.attachReady;
  assert.equal(staged, true);
  assert.equal(drained, false);
  assert.equal(created, true);
  assert.match(session.replayOutput, new RegExp(`Updating Windows agent ${expectedRelease}/protocol ${expectedProtocol - 1} → ${expectedRelease}/protocol ${expectedProtocol}`));
  assert.match(session.replayOutput, new RegExp(`updated to ${expectedRelease}/protocol ${expectedProtocol}`));
  assert.doesNotMatch(session.replayOutput, /new generation/);
  session.detach();
  server.close();
  await once(server, "close");
});

test("an idle pinned Windows generation refreshes itself instead of the base agent", async () => {
  const expectedRelease = expectedWindowsAgentReleaseVersion();
  const expectedProtocol = expectedWindowsAgentProtocolVersion();
  let helperBundleVersion = "stale";
  let refreshedPort: number | undefined;
  let created = false;
  const server = http.createServer(async (request, response) => {
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/health") {
      response.end(JSON.stringify({
        ok: true,
        releaseVersion: expectedRelease,
        protocolVersion: expectedProtocol,
        helperBundleVersion,
        activeSessions: 0,
        draining: false,
      }));
      return;
    }
    if (request.method === "GET" && path === "/sessions") {
      response.end(JSON.stringify({ sessions: [] }));
      return;
    }
    if (request.method === "POST" && path.startsWith("/sessions/__wmux_update_")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        helperBundle?: { bundleVersion?: string };
      };
      helperBundleVersion = body.helperBundle?.bundleVersion ?? helperBundleVersion;
      response.end(JSON.stringify({ id: path.split("/")[2], status: "running" }));
      return;
    }
    if (request.method === "DELETE" && path.startsWith("/sessions/__wmux_update_")) {
      response.end(JSON.stringify({ removed: true }));
      return;
    }
    if (request.method === "POST" && path === "/sessions/pane_pinned_generation") {
      created = true;
      response.end(JSON.stringify({
        id: "pane_pinned_generation",
        pid: 321,
        base: 0,
        cursor: 0,
      }));
      return;
    }
    if (request.method === "GET" && path.startsWith("/sessions/pane_pinned_generation/output")) {
      response.end(JSON.stringify({ base: 0, cursor: 0, dataBase64: "", exited: false }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const generationPort = address.port;
  const session = new WindowsAgentSession(
    {
      id: "pane_pinned_generation",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${generationPort}`,
    },
    80,
    24,
    {},
    async (_machine, rolloutPort) => {
      refreshedPort = rolloutPort;
      return rolloutPort;
    },
    1_000,
    undefined,
    generationPort - 1,
  );
  try {
    await session.attachReady;
    assert.equal(refreshedPort, generationPort);
    assert.equal(created, true);
    assert.equal(session.isExited, false);
  } finally {
    session.detach();
    server.close();
    await once(server, "close");
  }
});

test("a concurrent create makes same-port refresh defer to a side-by-side generation", async () => {
  const expectedRelease = expectedWindowsAgentReleaseVersion();
  const expectedProtocol = expectedWindowsAgentProtocolVersion();
  let concurrentSessions = 0;
  let samePortRefreshes = 0;
  let sidePortRefreshes = 0;
  let currentDeletes = 0;
  let sideCreates = 0;
  let sideGenerationActive = false;
  let sideAuthorization = "";
  let sideEnvironment: Record<string, string> | undefined;
  const currentServer = http.createServer((request, response) => {
    const requestPath = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && requestPath === "/health") {
      response.end(JSON.stringify({
        ok: true,
        releaseVersion: expectedRelease,
        protocolVersion: expectedProtocol,
        helperBundleVersion: "stale",
        activeSessions: concurrentSessions,
        draining: false,
      }));
      return;
    }
    if (request.method === "GET" && requestPath === "/sessions") {
      response.end(JSON.stringify({
        sessions: concurrentSessions > 0
          ? [{ id: "pane_concurrent", status: "running", pid: 44 }]
          : [],
      }));
      return;
    }
    if (request.method === "POST" && requestPath.startsWith("/sessions/__wmux_update_")) {
      response.end(JSON.stringify({ id: requestPath.split("/")[2], status: "running" }));
      return;
    }
    if (request.method === "DELETE" && requestPath.startsWith("/sessions/")) {
      currentDeletes += 1;
      response.end(JSON.stringify({ removed: true }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  const sideServer = http.createServer(async (request, response) => {
    const requestPath = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && requestPath === "/health") {
      if (!sideGenerationActive) {
        response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
        return;
      }
      response.end(JSON.stringify({
        ok: true,
        releaseVersion: expectedRelease,
        protocolVersion: expectedProtocol,
        helperBundleVersion: windowsHelperBundleVersion(),
        activeSessions: sideCreates,
      }));
      return;
    }
    if (request.method === "POST" && requestPath === "/sessions/pane_refresh_race") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      sideAuthorization = String(request.headers.authorization ?? "");
      sideEnvironment = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        env?: Record<string, string>;
      }).env;
      sideCreates += 1;
      response.end(JSON.stringify({ id: "pane_refresh_race", pid: 45, base: 0, cursor: 0 }));
      return;
    }
    if (request.method === "GET" && requestPath.startsWith("/sessions/pane_refresh_race/output")) {
      response.end(JSON.stringify({ base: 0, cursor: 0, dataBase64: "", exited: false }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  const { currentPort, sidePort } = await listenOnAdjacentPorts(currentServer, sideServer);
  const selected: Array<{ port: number; origin: string }> = [];
  const session = new WindowsAgentSession(
    {
      id: "pane_refresh_race",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "changed-dns.internal",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${currentPort}`,
      agentPort: currentPort,
      agentToken: "pinned-token",
    },
    80,
    24,
    {},
    async (_machine, rolloutPort) => {
      if (rolloutPort === currentPort) {
        samePortRefreshes += 1;
        concurrentSessions = 1;
        throw new Error("generation_refresh_busy");
      }
      assert.equal(rolloutPort, sidePort);
      sidePortRefreshes += 1;
      sideGenerationActive = true;
      return sidePort;
    },
    1_000,
    undefined,
    currentPort - 1,
  );
  session.on("agentPort", (port, origin) => selected.push({ port, origin }));
  try {
    await session.attachReady;
    assert.equal(session.isExited, false, session.replayOutput);
    assert.equal(samePortRefreshes, 1);
    assert.equal(sidePortRefreshes, 1);
    assert.equal(concurrentSessions, 1, "the session that won the refresh race remains active");
    assert.equal(currentDeletes, 1, "only the temporary helper staging session is deleted");
    assert.equal(sideCreates, 1);
    assert.equal(sideAuthorization, "Bearer pinned-token");
    assert.equal(sideEnvironment?.WMUX_MACHINE_ID, "windows");
    assert.deepEqual(selected, [{ port: sidePort, origin: `http://127.0.0.1:${sidePort}` }]);
  } finally {
    session.detach();
    await Promise.all([closeServer(currentServer), closeServer(sideServer)]);
  }
});

test("concurrent first use of a rollout slot starts one generation and reuses it", async () => {
  const expectedRelease = expectedWindowsAgentReleaseVersion();
  const expectedProtocol = expectedWindowsAgentProtocolVersion();
  const expectedHelpers = windowsHelperBundleVersion();
  let generationActive = false;
  let activationCalls = 0;
  let generationStarts = 0;
  let generationReuses = 0;
  const created = new Set<string>();
  const baseServer = http.createServer((request, response) => {
    const requestPath = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && requestPath === "/health") {
      response.end(JSON.stringify({
        ok: true,
        releaseVersion: expectedRelease,
        protocolVersion: expectedProtocol,
        helperBundleVersion: "stale",
        activeSessions: 1,
        draining: false,
      }));
      return;
    }
    if (request.method === "GET" && requestPath === "/sessions") {
      response.end(JSON.stringify({ sessions: [{ id: "existing", status: "running", pid: 41 }] }));
      return;
    }
    if (request.method === "POST" && requestPath.startsWith("/sessions/__wmux_update_")) {
      response.end(JSON.stringify({ id: requestPath.split("/")[2], status: "running" }));
      return;
    }
    if (request.method === "DELETE" && requestPath.startsWith("/sessions/__wmux_update_")) {
      response.end(JSON.stringify({ removed: true }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  const generationServer = http.createServer((request, response) => {
    const requestPath = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && requestPath === "/health") {
      if (!generationActive) {
        response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
        return;
      }
      response.end(JSON.stringify({
        ok: true,
        releaseVersion: expectedRelease,
        protocolVersion: expectedProtocol,
        helperBundleVersion: expectedHelpers,
        activeSessions: created.size,
      }));
      return;
    }
    const sessionMatch = /^\/sessions\/(pane_first_[ab])$/.exec(requestPath);
    if (request.method === "POST" && sessionMatch) {
      created.add(sessionMatch[1]);
      response.end(JSON.stringify({ id: sessionMatch[1], pid: 50 + created.size, base: 0, cursor: 0 }));
      return;
    }
    const outputMatch = /^\/sessions\/(pane_first_[ab])\/output/.exec(requestPath);
    if (request.method === "GET" && outputMatch) {
      response.end(JSON.stringify({ base: 0, cursor: 0, dataBase64: "", exited: false }));
      return;
    }
    const resizeMatch = /^\/sessions\/(pane_first_[ab])\/resize$/.exec(requestPath);
    if (request.method === "POST" && resizeMatch) {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  const { currentPort, sidePort } = await listenOnAdjacentPorts(baseServer, generationServer);
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  let lock = Promise.resolve();
  const activate = async (_machine: MachineConfig, rolloutPort?: number) => {
    assert.equal(rolloutPort, sidePort);
    activationCalls += 1;
    if (activationCalls === 2) releaseBarrier();
    await barrier;
    const previous = lock;
    let release!: () => void;
    lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (generationActive) generationReuses += 1;
      else {
        generationStarts += 1;
        generationActive = true;
      }
      return sidePort;
    } finally {
      release();
    }
  };
  const machine: MachineConfig = {
    id: "windows",
    name: "Windows",
    kind: "powershell-ssh",
    host: "changed-dns.internal",
    sessionBackend: "agent",
    agentUrl: `http://127.0.0.1:${currentPort}`,
    agentPort: currentPort,
    agentToken: "pinned-token",
  };
  const createSession = (id: string) => new WindowsAgentSession(
    {
      id,
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    machine,
    80,
    24,
    {},
    activate,
    1_000,
    undefined,
    currentPort,
  );
  const first = createSession("pane_first_a");
  const second = createSession("pane_first_b");
  try {
    await Promise.all([first.attachReady, second.attachReady]);
    assert.equal(first.isExited, false, first.replayOutput);
    assert.equal(second.isExited, false, second.replayOutput);
    assert.equal(activationCalls, 2);
    assert.equal(generationStarts, 1);
    assert.equal(generationReuses, 1);
    assert.deepEqual([...created].sort(), ["pane_first_a", "pane_first_b"]);
  } finally {
    first.detach();
    second.detach();
    await Promise.all([closeServer(baseServer), closeServer(generationServer)]);
  }
});

test("an acknowledged Windows agent update cannot leave pane startup waiting forever", async () => {
  let helperBundleVersion = "stale";
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/health") {
      response.end(JSON.stringify({
        ok: true,
        releaseVersion: expectedWindowsAgentReleaseVersion(),
        protocolVersion: Math.max(1, expectedWindowsAgentProtocolVersion() - 1),
        helperBundleVersion,
        activeSessions: 0,
        draining: false,
      }));
      return;
    }
    if (request.method === "GET" && path === "/sessions") {
      response.end(JSON.stringify({ sessions: [] }));
      return;
    }
    if (request.method === "POST" && path.startsWith("/sessions/__wmux_update_")) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          helperBundle?: { bundleVersion?: string };
        };
        helperBundleVersion = body.helperBundle?.bundleVersion ?? helperBundleVersion;
        response.end(JSON.stringify({ id: path.split("/")[2], status: "running" }));
      });
      return;
    }
    if (request.method === "DELETE" && path.startsWith("/sessions/__wmux_update_")) {
      response.end(JSON.stringify({ removed: true }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const session = new WindowsAgentSession(
    {
      id: "pane_update_timeout",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    24,
    {},
    async () => undefined,
    40,
  );
  await session.attachReady;
  assert.equal(session.isExited, true);
  assert.match(session.replayOutput, /did not become current within 1 seconds/);
  server.close();
  await once(server, "close");
});

test("a new pane cancels a legacy global drain and rolls onto a side-by-side generation", async () => {
  let helperBundleVersion = "stale";
  let draining = true;
  let drainCancelled = false;
  let staged = false;
  let created = false;
  let currentCreated = false;
  let updateScheduled = false;
  let baseAppearsCurrent = false;
  const generationServer = http.createServer((request, response) => {
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/health") {
      response.end(JSON.stringify({
        ok: true,
        releaseVersion: expectedWindowsAgentReleaseVersion(),
        protocolVersion: expectedWindowsAgentProtocolVersion(),
        helperBundleVersion,
        activeSessions: created ? 1 : 0,
      }));
      return;
    }
    if (request.method === "POST" && (path === "/sessions/pane_deferred" || path === "/sessions/pane_current")) {
      if (path.endsWith("pane_deferred")) created = true;
      else currentCreated = true;
      response.end(JSON.stringify({ id: path.split("/")[2], pid: 456, base: 0, cursor: 0 }));
      return;
    }
    if (request.method === "GET" && /^\/sessions\/pane_(deferred|current)\/output/.test(path)) {
      response.end(JSON.stringify({ base: 0, cursor: 0, dataBase64: "", exited: false }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/health") {
      response.end(JSON.stringify({
        ok: true,
        version: baseAppearsCurrent ? expectedWindowsAgentReleaseVersion() : "0.7",
        releaseVersion: baseAppearsCurrent ? expectedWindowsAgentReleaseVersion() : "0.7",
        protocolVersion: baseAppearsCurrent ? expectedWindowsAgentProtocolVersion() : undefined,
        helperBundleVersion,
        activeSessions: 1,
        draining,
        restartWhenIdle: true,
      }));
      return;
    }
    if (request.method === "GET" && path === "/sessions") {
      response.end(JSON.stringify({ sessions: [{ id: "pane_existing", status: "running" }] }));
      return;
    }
    if (request.method === "DELETE" && path === "/drain") {
      draining = false;
      drainCancelled = true;
      response.end(JSON.stringify({ activeSessions: 1, draining: false, restartWhenIdle: false }));
      return;
    }
    if (request.method === "POST" && path.startsWith("/sessions/__wmux_update_")) {
      assert.equal(draining, false, "legacy drain is cancelled before helper staging");
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          helperBundle?: { bundleVersion?: string };
        };
        helperBundleVersion = body.helperBundle?.bundleVersion ?? helperBundleVersion;
        staged = true;
        response.end(JSON.stringify({ id: path.split("/")[2], status: "running" }));
      });
      return;
    }
    if (request.method === "DELETE" && path.startsWith("/sessions/__wmux_update_")) {
      response.end(JSON.stringify({ removed: true }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let session: WindowsAgentSession | undefined;
  let currentSession: WindowsAgentSession | undefined;
  try {
    session = new WindowsAgentSession(
      {
        id: "pane_deferred",
        machineId: "windows",
        title: "PowerShell",
        status: "idle",
        createdAt: new Date(0).toISOString(),
      },
      {
        id: "windows",
        name: "Windows",
        kind: "powershell-ssh",
        host: "127.0.0.1",
        sessionBackend: "agent",
        agentUrl: `http://127.0.0.1:${address.port}`,
      },
      80,
      24,
      {},
      async (_machine, rolloutPort) => {
        assert.equal(created, false, "the new generation starts before it owns the pane");
        assert.ok(rolloutPort, "the updater selects an adjacent rollout port");
        updateScheduled = true;
        generationServer.listen(rolloutPort, "127.0.0.1");
        await once(generationServer, "listening");
        return rolloutPort;
      },
    );
    await session.attachReady;
    assert.equal(updateScheduled, true, session.replayOutput);
    assert.equal(drainCancelled, true);
    assert.equal(staged, true);
    assert.equal(created, true);
    assert.match(session.replayOutput, /existing pane\(s\) will remain on their current generation/);
    assert.match(session.replayOutput, /Updated Windows agent generation is ready/);

    // Models the legacy behavior where staging shared files made the still-old
    // base process report the new release/protocol/bundle identity.
    baseAppearsCurrent = true;
    currentSession = new WindowsAgentSession(
      {
        id: "pane_current",
        machineId: "windows",
        title: "PowerShell",
        status: "idle",
        createdAt: new Date(0).toISOString(),
      },
      {
        id: "windows",
        name: "Windows",
        kind: "powershell-ssh",
        host: "127.0.0.1",
        sessionBackend: "agent",
        agentUrl: `http://127.0.0.1:${address.port}`,
      },
      80,
      24,
      {},
      async () => {
        throw new Error("a current rollout generation must be reused");
      },
    );
    await currentSession.attachReady;
    assert.equal(currentCreated, true, currentSession.replayOutput);
    assert.match(currentSession.replayOutput, /Current Windows agent generation is ready/);
  } finally {
    session?.detach();
    currentSession?.detach();
    server.closeAllConnections();
    if (generationServer.listening) generationServer.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (generationServer.listening) {
      await new Promise<void>((resolve) => generationServer.close(() => resolve()));
    }
  }
});

test("an unreachable side-by-side generation reports the required firewall range", async () => {
  let helperBundleVersion = "stale";
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/health") {
      response.end(JSON.stringify({
        ok: true,
        releaseVersion: expectedWindowsAgentReleaseVersion(),
        protocolVersion: Math.max(1, expectedWindowsAgentProtocolVersion() - 1),
        helperBundleVersion,
        activeSessions: 1,
      }));
      return;
    }
    if (request.method === "GET" && path === "/sessions") {
      response.end(JSON.stringify({ sessions: [{ id: "pane_existing", status: "running" }] }));
      return;
    }
    if (request.method === "POST" && path.startsWith("/sessions/__wmux_update_")) {
      helperBundleVersion = windowsHelperBundleVersion();
      response.end(JSON.stringify({ id: path.split("/")[2], status: "running" }));
      return;
    }
    if (request.method === "DELETE" && path.startsWith("/sessions/__wmux_update_")) {
      response.end(JSON.stringify({ removed: true }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const session = new WindowsAgentSession(
    {
      id: "pane_firewall",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    24,
    {},
    async () => 1,
  );
  const selectedPorts: number[] = [];
  session.on("agentPort", (port) => selectedPorts.push(port));
  await session.attachReady;
  assert.equal(session.isExited, true);
  assert.deepEqual(selectedPorts, [], "an unreachable generation is not persisted for the next retry");
  assert.match(session.replayOutput, /is not reachable from wmux/);
  assert.match(session.replayOutput, new RegExp(`allow inbound TCP ${address.port}-${address.port + 8}`));
  assert.match(session.replayOutput, /configure-agent-firewall/);
  server.close();
  await once(server, "close");
});

test("OSC 7 cwd wins over a stale cwd returned by an older Windows agent", async () => {
  let outputRequests = 0;
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "POST" && path === "/sessions/pane_cwd") {
      response.end(JSON.stringify({ id: "pane_cwd", pid: 123, base: 0, cwd: "C:\\Users\\operator" }));
      return;
    }
    if (request.method === "GET" && path.includes("/output")) {
      outputRequests += 1;
      const data = outputRequests === 1 ? "\x1b]7;file://WIN/C%3A/Windows\x07" : "";
      response.end(JSON.stringify({
        cursor: data.length,
        dataBase64: Buffer.from(data).toString("base64"),
        cwd: "C:\\Users\\operator",
        exited: false,
      }));
      return;
    }
    response.end(JSON.stringify({ removed: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const session = new WindowsAgentSession(
    {
      id: "pane_cwd",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    24,
  );
  const cwds: string[] = [];
  session.on("cwd", (cwd) => cwds.push(cwd));
  await waitUntil(() => outputRequests >= 2);
  assert.equal(cwds.at(-1), "C:/Windows");
  session.detach();
  server.close();
  await once(server, "close");
});

test("Windows agent queues initial resize and input until session creation completes", async () => {
  let created = false;
  let earlyRequests = 0;
  const operations: string[] = [];
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    if (request.method === "POST" && path === "/sessions/pane_startup") {
      setTimeout(() => {
        created = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "pane_startup", pid: 123, base: 0 }));
      }, 50);
      return;
    }
    if (request.method === "POST" && path.endsWith("/resize")) {
      if (!created) earlyRequests += 1;
      operations.push("resize");
      response.writeHead(created ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(created ? { ok: true } : { error: "unknown_session" }));
      return;
    }
    if (request.method === "POST" && path.endsWith("/input")) {
      if (!created) earlyRequests += 1;
      operations.push("input");
      response.writeHead(created ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(created ? { ok: true } : { error: "unknown_session" }));
      return;
    }
    if (request.method === "GET" && path.includes("/output")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cursor: 0, exited: false }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const session = new WindowsAgentSession(
    {
      id: "pane_startup",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    24,
  );
  session.resize(120, 40);
  session.write("echo ready\r");
  await waitUntil(() => operations.length === 2);
  assert.equal(earlyRequests, 0);
  assert.deepEqual(operations, ["resize", "input"]);
  session.detach();
  server.close();
  await once(server, "close");
});

test("Windows agent recreates a live pane when the remote agent loses its session", async () => {
  let createCount = 0;
  let reportMissingSession = false;
  let remoteCols = 80;
  let remoteRows = 24;
  const createBodies: Array<Record<string, unknown>> = [];
  let replacementCapabilities = 0;
  const server = http.createServer(async (request, response) => {
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && path === "/sessions/pane_reboot") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      createBodies.push(body);
      remoteCols = Number(body.cols);
      remoteRows = Number(body.rows);
      createCount += 1;
      response.end(JSON.stringify({
        id: "pane_reboot",
        pid: 100 + createCount,
        base: 0,
        cursor: 0,
        cwd: "C:\\work",
        cols: remoteCols,
        rows: remoteRows,
      }));
      return;
    }
    if (request.method === "POST" && path === "/sessions/pane_reboot/resize") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { cols: number; rows: number };
      remoteCols = body.cols;
      remoteRows = body.rows;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "GET" && path.startsWith("/sessions/pane_reboot/output")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (reportMissingSession) {
        reportMissingSession = false;
        response.writeHead(404);
        response.end(JSON.stringify({ error: "unknown_session" }));
        return;
      }
      const cursor = Number(new URL(path, "http://agent.invalid").searchParams.get("cursor") ?? 0);
      const output = Buffer.from(createCount === 1 ? "first-shell\r\n" : "second-shell\r\n");
      const data = output.subarray(Math.min(cursor, output.length));
      response.end(JSON.stringify({
        base: 0,
        startCursor: cursor,
        cursor: output.length,
        dataBase64: data.toString("base64"),
        exited: false,
        cols: remoteCols,
        rows: remoteRows,
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const session = new WindowsAgentSession(
    {
      id: "pane_reboot",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      cwd: "C:\\work",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    24,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    () => {
      replacementCapabilities += 1;
      return [{ purpose: "agent-input-capability", data: Buffer.from("replacement-capability\n") }];
    },
  );
  const output: string[] = [];
  session.on("output", (data) => output.push(data));
  await session.attachReady;
  await waitUntil(() => output.join("").includes("first-shell"));
  assert.equal(session.pid, 101);
  session.resize(120, 35);
  await waitUntil(() => remoteCols === 120 && remoteRows === 35);

  reportMissingSession = true;
  await waitUntil(() => createCount === 2);
  await waitUntil(() => output.join("").includes("second-shell"));
  assert.equal(session.pid, 102);
  assert.equal(createBodies.length, 2);
  assert.equal(createBodies[1]?.cwd, "C:\\work");
  assert.equal(createBodies[1]?.cols, 120);
  assert.equal(createBodies[1]?.rows, 35);
  assert.equal(replacementCapabilities, 1);
  const replacementRuntimeFiles = createBodies[1]?.runtimeFiles as Array<{ purpose: string; dataBase64: string }>;
  assert.equal(replacementRuntimeFiles.length, 1);
  assert.equal(replacementRuntimeFiles[0].purpose, "agent-input-capability");
  assert.equal(Buffer.from(replacementRuntimeFiles[0].dataBase64, "base64").toString("utf8"), "replacement-capability\n");
  assert.match(output.join(""), /Session agent restarted; opened a new shell for this pane/);
  assert.doesNotMatch(output.join(""), /unknown_session/);

  session.detach();
  server.close();
  await once(server, "close");
});

test("Windows agent preserves input request order", async () => {
  const inputBodies: Array<{ dataBase64?: string }> = [];
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    if (request.method === "POST" && path === "/sessions/pane_input_order") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "pane_input_order", pid: 123, base: 0 }));
      return;
    }
    if (request.method === "POST" && path.endsWith("/input")) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        inputBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const finish = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        };
        if (inputBodies.length === 1) setTimeout(finish, 80);
        else finish();
      });
      return;
    }
    if (request.method === "GET" && path.includes("/output")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cursor: 0, exited: false }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const session = new WindowsAgentSession(
    {
      id: "pane_input_order",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    24,
  );
  await waitUntil(() => session.pid === 123);
  session.write("payload");
  session.write("\r");
  await waitUntil(() => inputBodies.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(inputBodies.length, 1);
  await waitUntil(() => inputBodies.length === 2);
  assert.deepEqual(inputBodies.map((body) => Buffer.from(body.dataBase64 ?? "", "base64").toString()), ["payload", "\r"]);
  session.detach();
  server.close();
  await once(server, "close");
});

test("Windows agent coalesces resize bursts and repaints a settled alternate screen once", async () => {
  const resizes: Array<{ cols: number; rows: number }> = [];
  const historical = "\x1b[?1049h\x1b[2J\x1b[HREADY";
  const historyBytes = Buffer.byteLength(historical);
  let activeResizes = 0;
  let maxActiveResizes = 0;
  let remoteCols = 80;
  let remoteRows = 24;
  const server = http.createServer(async (request, response) => {
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && path === "/sessions/pane_resize_burst") {
      response.end(JSON.stringify({
        id: "pane_resize_burst",
        pid: 123,
        base: 0,
        cursor: historyBytes,
        cols: remoteCols,
        rows: remoteRows,
      }));
      return;
    }
    if (request.method === "POST" && path.endsWith("/resize")) {
      activeResizes += 1;
      maxActiveResizes = Math.max(maxActiveResizes, activeResizes);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { cols: number; rows: number };
      resizes.push(body);
      if (resizes.length === 1) await new Promise((resolve) => setTimeout(resolve, 80));
      remoteCols = body.cols;
      remoteRows = body.rows;
      activeResizes -= 1;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "GET" && path.includes("/output")) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const cursor = Number(new URL(path, "http://agent.invalid").searchParams.get("cursor") ?? 0);
      response.end(JSON.stringify({
        base: 0,
        startCursor: cursor,
        cursor: historyBytes,
        cols: remoteCols,
        rows: remoteRows,
        resizes: [],
        dataBase64: cursor === 0 ? Buffer.from(historical).toString("base64") : "",
        exited: false,
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const session = new WindowsAgentSession(
    {
      id: "pane_resize_burst",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    24,
  );
  const output: string[] = [];
  session.on("output", (data) => output.push(data));
  try {
    await session.attachReady;
    session.resize(85, 25);
    session.resize(87, 26);
    session.resize(90, 28);
    await waitUntil(() => resizes.length === 1);
    session.resize(100, 31);
    session.resize(110, 35);

    await waitUntil(() => remoteCols === 110 && remoteRows === 35);
    await waitUntil(() => output.length === 1, 2000);
    assert.deepEqual(resizes, [
      { cols: 90, rows: 28 },
      { cols: 110, rows: 35 },
    ]);
    assert.equal(maxActiveResizes, 1);
    assert.equal(output.length, 1);
    assert.match(output[0] ?? "", /^\x1bc\x1b\[\?1049h/);
    const checkpoint = (session as unknown as { checkpoint: TerminalCheckpoint }).checkpoint;
    assert.deepEqual(checkpoint.dimensions, { cols: 110, rows: 35 });
  } finally {
    session.detach();
    server.close();
    await once(server, "close");
  }
});

test("Windows agent hydrates a 24-row replay before attaching it to a taller split", async () => {
  const historical = "\x1b[2J\x1b[Hhistory\x1b[24;1HPS> ";
  const historyBytes = Buffer.byteLength(historical);
  const resizes: Array<{ cols: number; rows: number }> = [];
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    response.writeHead(200, { "content-type": "application/json" });
    if (
      request.method === "POST"
      && path.startsWith("/sessions/pane_replay_")
      && !path.endsWith("/resize")
      && !path.endsWith("/input")
    ) {
      const legacy = path.includes("pane_replay_legacy");
      response.end(JSON.stringify({
        id: legacy ? "pane_replay_legacy" : "pane_replay_geometry",
        pid: 123,
        base: 0,
        cursor: historyBytes,
        ...(legacy ? {} : { cols: 80, rows: 24 }),
      }));
      return;
    }
    if (request.method === "POST" && path.endsWith("/resize")) {
      let body = "";
      request.on("data", (chunk) => { body += chunk.toString(); });
      request.on("end", () => {
        resizes.push(JSON.parse(body));
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (request.method === "GET" && path.includes("/output")) {
      const cursor = Number(new URL(path, "http://agent").searchParams.get("cursor") ?? 0);
      const legacy = path.includes("pane_replay_legacy");
      response.end(JSON.stringify(cursor === 0 ? {
        base: 0,
        startCursor: 0,
        cursor: historyBytes,
        ...(legacy ? {} : { cols: 80, rows: 24 }),
        resizes: [],
        dataBase64: Buffer.from(historical).toString("base64"),
        exited: false,
      } : {
        base: 0,
        startCursor: historyBytes,
        cursor: historyBytes,
        ...(legacy ? {} : { cols: 80, rows: 33 }),
        resizes: [],
        dataBase64: "",
        exited: false,
      }));
      return;
    }
    response.end(JSON.stringify({ removed: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const persisted = new TerminalCheckpoint(80, 33);
  persisted.write("PERSISTED_FALLBACK");
  const session = new WindowsAgentSession(
    {
      id: "pane_replay_geometry",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    33,
    {},
    undefined,
    undefined,
    {
      data: persisted.snapshot(),
      kind: "checkpoint",
    },
  );
  session.resize(80, 33);
  await session.attachReady;

  const attach = session.attachReplay;
  const restored = new TerminalCheckpoint(80, 33);
  const legacyPersisted = new TerminalCheckpoint(80, 33);
  legacyPersisted.write("LEGACY_PERSISTED_SCREEN");
  const legacySession = new WindowsAgentSession(
    {
      id: "pane_replay_legacy",
      machineId: "windows",
      title: "PowerShell",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "127.0.0.1",
      sessionBackend: "agent",
      agentUrl: `http://127.0.0.1:${address.port}`,
    },
    80,
    33,
    {},
    undefined,
    undefined,
    {
      data: legacyPersisted.snapshot(),
      kind: "checkpoint",
    },
  );
  try {
    restored.write(attach.data);
    assert.equal(attach.kind, "checkpoint");
    assert.deepEqual(restored.cursor(), { x: 4, y: 23, visible: true });
    assert.match(restored.screenLines()[23], /^PS> /);
    assert.equal(
      restored.screenLines().some((line) =>
        line.includes("PERSISTED_FALLBACK")),
      false,
    );
    assert.equal(restored.screenLines()[32].trim(), "");
    assert.deepEqual(resizes, [{ cols: 80, rows: 33 }]);
    await legacySession.attachReady;
    const legacyAttach = new TerminalCheckpoint(80, 33);
    try {
      legacyAttach.write(legacySession.attachReplay.data);
      assert.equal(
        legacyAttach.screenLines().some((line) =>
          line.includes("LEGACY_PERSISTED_SCREEN")),
        true,
      );
    } finally {
      legacyAttach.dispose();
    }
  } finally {
    persisted.dispose();
    legacyPersisted.dispose();
    restored.dispose();
    session.detach();
    legacySession.detach();
    server.close();
    await once(server, "close");
  }
});
