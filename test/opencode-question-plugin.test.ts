import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

test("generated plugin allowlists top-level questions and uses only typed question.reply delivery", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-plugin-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, ".wmux", "agent-input", "pane.cap");
  const credentialPath = path.join(home, ".wmux", "agent-input", "pane.json");
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
  const captures: Array<{ path: string; method?: string; body: any; authorization?: string }> = [];
  let plugin: any;
  const deliveredQuestions = new Set<string>();
  const pendingDeliveries: Array<{ deliveryId: string; cursor: number; requestId: string; expectedGeneration: number; openCodeRequestId: string; answers: string[][] }> = [];
  let cursor = 0;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    captures.push({ path: request.url ?? "", method: request.method, body, authorization: request.headers.authorization });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/agent-input/sources/register") {
      send(201, { sourceId: "source-one", relaySecret: "S".repeat(43), expiresAt: Date.now() + 600_000, supported: true, credentialGeneration: 1 });
    } else if (request.url === "/api/agent-input/sources/source-one/refresh") {
      send(200, { sourceId: "source-one", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2 });
    } else if (request.url === "/api/agent-input/sources/source-one/requests" && request.method === "POST") {
      const questionId = body.id as string;
      const requestId = questionId === "question-one" ? "input-one" : `input-${questionId}`;
      const duplicate = deliveredQuestions.has(questionId);
      if (!duplicate) {
        deliveredQuestions.add(questionId);
        cursor += 1;
        pendingDeliveries.push({
          deliveryId: `delivery-${questionId}`, cursor, requestId, expectedGeneration: 1,
          openCodeRequestId: questionId,
          answers: questionId === "question-one" ? [["Safe"], ["Tests", "Types"], ["custom note"]] : [["answer"]],
        });
      }
      send(duplicate ? 200 : 201, { id: requestId, generation: 1, state: "pending", eventRevision: cursor });
    } else if (request.url?.startsWith("/api/agent-input/sources/source-one/deliveries?") && pendingDeliveries.length > 0) {
      send(200, { epoch: "relay-plugin", cursor, deliveries: [pendingDeliveries.shift()] });
    } else if (request.url?.startsWith("/api/agent-input/sources/source-one/deliveries?")) {
      send(200, { epoch: "relay-plugin", cursor, deliveries: [] });
    } else if (request.url?.endsWith("/start")) {
      send(200, { outcome: "started" });
    } else {
      send(200, { outcome: "resolved" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    WMUX_URL: `http://127.0.0.1:${address.port}`,
    WMUX_PANE_ID: "pane-one",
    WMUX_WORKSPACE_ID: "workspace-one",
    WMUX_TAB_ID: "tab-one",
    WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath,
    WMUX_TOKEN: "broad-shared-token-must-not-cross",
    WMUX_HELPER_TOKEN: "broad-helper-token-must-not-cross",
    WMUX_AUTOMATION_TOKEN: "broad-automation-token-must-not-cross",
    WMUX_REGISTRATION_TOKEN: "broad-registration-token-must-not-cross",
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const sdkPackage = path.join(configHome, "opencode", "node_modules", "@opencode-ai", "sdk");
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const module = await import(`${pathToFileURL(pluginPath).href}?question=${Date.now()}`);
    const replies: unknown[] = [];
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, error: undefined, response: { status: 200 } }) },
      question: {
        list: async () => ({ data: [
          { id: "question-one", sessionID: "session-one", questions: [
            { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
            { header: "Checks", question: "Choose", options: [{ label: "Tests", description: "Tests" }, { label: "Types", description: "Types" }], multiple: true, custom: false },
            { header: "Note", question: "Write", options: [], multiple: false, custom: true },
          ] },
          { id: "child-question", sessionID: "child-session", questions: [{ header: "Child", question: "Ignore", options: [], custom: true }] },
        ], response: { status: 200 } }),
        reply: async (input: unknown) => {
          replies.push(structuredClone(input));
          const requestID = (input as { requestID?: string }).requestID;
          if (requestID === "question-not-found") return { data: undefined, error: { _tag: "QuestionNotFoundError" }, response: { status: 404 } };
          if (requestID === "question-invalid") return { data: undefined, error: { _tag: "InvalidRequestError" }, response: { status: 400 } };
          if (requestID === "question-transport") throw new Error("transport details must not escape");
          return { data: true, error: undefined, response: { status: 200 } };
        },
      },
      session: {
        get: async (input: { path: { id: string } }) => ({ data: {
          title: input.path.id === "child-session" ? "Child" : "Top level",
          ...(input.path.id === "child-session" ? { parentID: "session-one" } : {}),
        } }),
        messages: async () => ({ data: [] }),
      },
    };
    plugin = await module.default({ client, directory: repoRoot });
    const questions = [
      { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
      { header: "Checks", question: "Choose", options: [{ label: "Tests", description: "Tests" }, { label: "Types", description: "Types" }], multiple: true, custom: false },
      { header: "Note", question: "Write", options: [], multiple: false, custom: true },
    ];
    await waitFor(() => captures.some((capture) => capture.path === "/api/agent-input/sources/source-one/requests"), () => JSON.stringify(captures));
    const registrationCapture = captures.find((capture) => capture.path === "/api/agent-input/sources/register")!;
    assert.deepEqual(registrationCapture.body.runtimeAttestation.health, {
      called: true, outcome: "ok", status: 200, healthy: true, release: "1.18.9",
    });
    assert.deepEqual(registrationCapture.body.runtimeAttestation.capabilities, {
      globalHealth: true, questionList: true, questionReply: true, sessionGet: true,
    });
    assert.deepEqual(Object.keys(registrationCapture.body.runtimeAttestation).sort(), [
      "capabilities", "challengeDeadline", "challengeIssuedAt", "compatibilityFingerprint", "contractDigest",
      "diagnostic", "eventEnvelope", "handshakeSchema", "health", "nonce", "observedAt", "release", "type",
    ]);
    assert.doesNotMatch(JSON.stringify(registrationCapture.body.runtimeAttestation),
      /pane-one|workspace-one|tab-one|broad-|wmux-question-plugin-|transport details|RAW|ANSWER/);
    if (process.platform === "linux") {
      await waitFor(() => brokerChildIds().length > 0);
      const brokerEnvironment = fs.readFileSync(`/proc/${brokerChildIds()[0]}/environ`, "utf8").split("\0");
      for (const key of ["WMUX_TOKEN", "WMUX_HELPER_TOKEN", "WMUX_AUTOMATION_TOKEN", "WMUX_REGISTRATION_TOKEN"]) {
        assert.equal(brokerEnvironment.some((entry) => entry.startsWith(`${key}=`)), false, `${key} crossed the broker allowlist`);
      }
      assert.ok(brokerEnvironment.some((entry) => entry === "WMUX_PANE_ID=pane-one"));
      assert.ok(brokerEnvironment.some((entry) => entry.startsWith("WMUX_AGENT_INPUT_CAPABILITY_PATH=")));
    }
    await plugin.event({ event: { id: "event-question-one", type: "question.asked", properties: { id: "question-one", sessionID: "session-one", questions } } });
    await waitFor(() => replies.length === 1, () => JSON.stringify(captures));
    assert.deepEqual(replies, [{ requestID: "question-one", answers: [["Safe"], ["Tests", "Types"], ["custom note"]] }]);
    const questionOneCaptures = captures.filter((capture) => capture.path === "/api/agent-input/sources/source-one/requests");
    assert.deepEqual([...new Set(questionOneCaptures.map((capture) => capture.body.ordinal))], [1],
      "a distinct same-payload ask while pending deduplicates to the current occurrence");
    assert.ok(questionOneCaptures.every((capture) => typeof capture.body.occurrenceId === "string"
      && capture.body["capture" + "OperationId"] === undefined), "the plugin never chooses a server generation identity");
    assert.doesNotMatch(JSON.stringify(captures), /child-question|Ignore/);
    await waitFor(() => captures.some((capture) => capture.path.endsWith("/ack")));
    const ack = captures.find((capture) => capture.path.endsWith("/ack"));
    assert.deepEqual(ack?.body, { id: "input-one", generation: 1, outcome: "applied" });
    assert.equal(replies.filter((reply: any) => reply.requestID === "question-one").length, 1,
      "an exposed request generation invokes the real fixture SDK at most once");

    const oneCustomQuestion = [{ header: "Note", question: "Write", options: [], multiple: false, custom: true }];
    for (const id of ["question-not-found", "question-invalid", "question-transport"]) {
      await plugin.event({ event: { id: `event-${id}`, type: "question.asked", properties: { id, sessionID: "session-one", questions: oneCustomQuestion } } });
    }
    await waitFor(() => captures.filter((capture) => capture.path.endsWith("/ack")).length === 4,
      () => JSON.stringify(captures.filter((capture) => capture.path.endsWith("/ack")).slice(-20)));
    const classified = new Map(captures.filter((capture) => capture.path.endsWith("/ack"))
      .map((capture) => [capture.body.id, capture.body]));
    assert.deepEqual(classified.get("input-question-not-found"), {
      id: "input-question-not-found", generation: 1, outcome: "already_resolved",
    });
    assert.deepEqual(classified.get("input-question-invalid"), {
      id: "input-question-invalid", generation: 1, outcome: "sdk_error", code: "InvalidRequest", retryable: false,
    });
    assert.deepEqual(classified.get("input-question-transport"), {
      id: "input-question-transport", generation: 1, outcome: "sdk_error", code: "transport_error", retryable: true,
    });
    for (const requestID of ["question-one", "question-not-found", "question-invalid", "question-transport"]) {
      assert.ok(replies.filter((reply: any) => reply.requestID === requestID).length <= 1,
        `${requestID} exceeded the one-shot SDK invocation bound`);
    }
    assert.doesNotMatch(JSON.stringify(captures), /transport details must not escape/);

    const sentinel = ["PLUGIN", "RAW", "ANSWER"].join("_");
    await plugin.event({ event: { type: "question.replied", properties: {
      requestID: "question-one", sessionID: "session-one", answers: [[sentinel]],
    } } });
    await waitFor(() => captures.some((capture) => capture.path.endsWith("/resolve")));
    assert.doesNotMatch(JSON.stringify(captures), new RegExp(sentinel));
    assert.doesNotMatch(fs.readFileSync(credentialPath, "utf8"), new RegExp(sentinel));

    const beforeAgentInput = captures.filter((capture) => capture.method !== "GET" && capture.path.includes("/api/agent-input/")).length;
    await plugin.event({ event: { type: "permission.asked", properties: { id: "permission", sessionID: "session-one" } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(captures.filter((capture) => capture.method !== "GET" && capture.path.includes("/api/agent-input/")).length, beforeAgentInput);
    assert.equal("permission" in client, false);
    await plugin.event({ event: { type: "question.future", properties: { sessionID: "session-one" } } });

    assert.doesNotMatch(fs.readFileSync(pluginPath, "utf8"), /installedPackageVersion|safePackageManifest|packageSearchRoots/,
      "package manifests are not compatibility authority in the generated plugin");
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: { sessionID: "session-one" } } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("new generated plugin fails structured handling closed against an old server while generic lifecycle continues", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-old-server-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, ".wmux", "agent-input", "pane.cap");
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
  const captures: Array<{ path: string; body: any }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    captures.push({ path: request.url ?? "", body });
    if (request.url?.startsWith("/api/agent-input/")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
      return;
    }
    response.writeHead(201, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    WMUX_URL: `http://127.0.0.1:${address.port}`,
    WMUX_HELPER_URL: `http://127.0.0.1:${address.port}`,
    WMUX_PANE_ID: "pane-one",
    WMUX_WORKSPACE_ID: "workspace-one",
    WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: path.join(home, ".wmux", "agent-input", "pane.json"),
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let plugin: any;
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const module = await import(`${pathToFileURL(pluginPath).href}?old-server=${Date.now()}`);
    let sdkInvocations = 0;
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, error: undefined, response: { status: 200 } }) },
      question: {
        list: async () => ({ data: [], response: { status: 200 } }),
        reply: async () => { sdkInvocations += 1; return { data: true, error: undefined, response: { status: 200 } }; },
      },
      session: {
        get: async () => ({ data: { title: "Compatible lifecycle" } }),
        messages: async () => ({ data: [] }),
      },
    };
    plugin = await module.default({ client, directory: repoRoot });
    await plugin["chat.message"](
      { sessionID: "session-one" },
      { message: { id: "message-one" }, parts: [{ type: "text", text: "continue" }] },
    );
    await plugin.event({ event: { id: "event-question-one", type: "question.asked", properties: {
      id: "question-one", sessionID: "session-one",
      questions: [{ header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }] }],
    } } });
    await waitFor(() => captures.some((capture) => capture.path === "/api/agent-events")
      && captures.some((capture) => capture.path.startsWith("/api/agent-input/")));
    await waitFor(() => fs.existsSync(`${env.WMUX_AGENT_INPUT_CREDENTIAL_PATH}.status.json`)
      && JSON.parse(fs.readFileSync(`${env.WMUX_AGENT_INPUT_CREDENTIAL_PATH}.status.json`, "utf8")).diagnostic === "registration_failed");
    assert.ok(captures.some((capture) => capture.path === "/api/agent-events" && capture.body.status === "running"));
    assert.equal(sdkInvocations, 0, "an old server cannot expose an answer for SDK invocation");
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated plugin reports sanitized injected-health failures while generic telemetry remains available", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  const variants: Array<[string, string, undefined | (() => Promise<unknown>) ]> = [
    ["missing", "method_global_health_missing", undefined],
    ["timeout", "health_timeout", async () => new Promise(() => {})],
    ["error", "health_error", async () => { throw new Error("RAW_HEALTH_EXCEPTION"); }],
    ["malformed", "health_malformed", async () => ({ data: { healthy: false, version: "1.18.9" }, response: { status: 200 } })],
    ["release mismatch", "release_mismatch", async () => ({ data: { healthy: true, version: "1.18.8" }, error: undefined, response: { status: 200 } })],
  ];
  for (const [name, diagnostic, health] of variants) {
    await t.test(name, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-health-"));
      const configHome = path.join(home, "config");
      const inputDirectory = path.join(home, ".wmux", "agent-input");
      const capabilityPath = path.join(inputDirectory, "pane.cap");
      const credentialPath = path.join(inputDirectory, "pane.json");
      fs.mkdirSync(inputDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
      const calls: Array<{ path: string; body: any }> = [];
      const server = http.createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        calls.push({ path: request.url ?? "", body });
        response.writeHead(201, { "content-type": "application/json" }); response.end("{}");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address(); assert.ok(address && typeof address === "object");
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome,
        WMUX_URL: `http://127.0.0.1:${address.port}`, WMUX_HELPER_URL: `http://127.0.0.1:${address.port}`,
        WMUX_PANE_ID: "pane-health", WMUX_WORKSPACE_ID: "workspace-health",
        WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath, WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath };
      const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
      Object.assign(process.env, env);
      let plugin: any;
      try {
        await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
        installFixturePackages(configHome);
        const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
        const module = await import(`${pathToFileURL(pluginPath).href}?health=${encodeURIComponent(name)}-${Date.now()}`);
        const client: any = {
          ...(health ? { global: { health } } : {}),
          question: { list: async () => ({ data: [], response: { status: 200 } }),
            reply: async () => ({ data: true, error: undefined, response: { status: 200 } }) },
          session: { get: async () => ({ data: { title: "Telemetry" }, response: { status: 200 } }),
            messages: async () => ({ data: [] }) },
        };
        plugin = await module.default({ client, directory: repoRoot });
        await plugin["chat.message"]({ sessionID: "session" }, { message: { id: "message" }, parts: [{ type: "text", text: "generic" }] });
        await waitFor(() => fs.existsSync(`${credentialPath}.status.json`)
          && JSON.parse(fs.readFileSync(`${credentialPath}.status.json`, "utf8")).diagnostic === diagnostic, () => JSON.stringify(calls), 8_000);
        await waitFor(() => calls.some((call) => call.path === "/api/agent-events"));
        assert.equal(calls.some((call) => call.path === "/api/agent-input/sources/register"), false);
        assert.equal(fs.statSync(`${credentialPath}.status.json`).mode & 0o777, 0o600);
        assert.doesNotMatch(fs.readFileSync(`${credentialPath}.status.json`, "utf8"), /RAW_HEALTH_EXCEPTION|pane-health|workspace-health/);
      } finally {
        if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
        for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
        server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test("generated plugin records broker spawn failure without paths, credentials, or exception text", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-spawn-failure-"));
  const configHome = path.join(home, "config");
  const inputDirectory = path.join(home, ".wmux", "agent-input");
  const capabilityPath = path.join(inputDirectory, "pane.cap");
  const credentialPath = path.join(inputDirectory, "pane.json");
  fs.mkdirSync(inputDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, WMUX_URL: "http://127.0.0.1:9",
    WMUX_PANE_ID: "pane-spawn", WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath, WMUX_TOKEN: "BROAD_TOKEN_SENTINEL" };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const source = fs.readFileSync(pluginPath, "utf8").replace(
      JSON.stringify(path.join(repoRoot, "scripts", "wmux-agent-input-broker")),
      JSON.stringify(path.join(home, "missing", "broker")),
    );
    fs.writeFileSync(pluginPath, source, { mode: 0o600 });
    const module = await import(`${pathToFileURL(pluginPath).href}?spawn=${Date.now()}`);
    await module.default({ client: {}, directory: repoRoot });
    await waitFor(() => fs.existsSync(`${credentialPath}.status.json`));
    const status = fs.readFileSync(`${credentialPath}.status.json`, "utf8");
    assert.deepEqual((({ state, diagnostic }) => ({ state, diagnostic }))(JSON.parse(status)), {
      state: "failed", diagnostic: "broker_spawn_error",
    });
    assert.doesNotMatch(status, /missing|pane-spawn|BROAD_TOKEN_SENTINEL|ENOENT/);
  } finally {
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("startup reconciliation never publishes an incomplete native snapshot and keeps top-level filtering", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-partial-reconcile-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, ".wmux", "agent-input", "pane.cap");
  const credentialPath = path.join(home, ".wmux", "agent-input", "pane.json");
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
  const captures: Array<{ path: string; body: any }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    captures.push({ path: request.url ?? "", body });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/agent-input/sources/register") {
      send(201, { sourceId: "source-partial", relaySecret: "S".repeat(43), expiresAt: Date.now() + 600_000, supported: true, credentialGeneration: 1 });
    } else if (request.url === "/api/agent-input/sources/source-partial/requests") {
      send(201, { id: `input-${body.id}`, generation: 1, state: "pending", eventRevision: 1 });
    } else if (request.url?.includes("/deliveries?")) {
      send(200, { epoch: "relay-partial", cursor: 0, deliveries: [] });
    } else {
      send(200, { outcome: "reconciled", closed: 0 });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    WMUX_URL: `http://127.0.0.1:${address.port}`,
    WMUX_PANE_ID: "pane-partial",
    WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath,
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let plugin: any;
  let secondPlugin: any;
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const module = await import(`${pathToFileURL(pluginPath).href}?partial=${Date.now()}`);
    const questionList = [
      { id: "top-question", sessionID: "top-session", questions: [{ header: "Top", question: "Top", options: [], multiple: false, custom: true }] },
      { id: "child-question", sessionID: "child-session", questions: [{ header: "Child", question: "Child", options: [], multiple: false, custom: true }] },
      { id: "uncertain-question", sessionID: "unavailable-session", questions: [{ header: "Unknown", question: "Unknown", options: [], multiple: false, custom: true }] },
    ];
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, error: undefined, response: { status: 200 } }) },
      question: {
        list: async () => ({ data: questionList, response: { status: 200 } }),
        reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
      },
      session: {
        get: async ({ path: { id } }: { path: { id: string } }) => {
          if (id === "unavailable-session") throw new Error("partial session lookup failure");
          return { data: id === "child-session" ? { parentID: "top-session" } : { title: "Top" }, response: { status: 200 } };
        },
        messages: async () => ({ data: [] }),
      },
    };
    plugin = await module.default({ client, directory: repoRoot });
    await waitFor(() => captures.some((capture) => capture.path === "/api/agent-input/sources/register"), () => JSON.stringify(captures));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const capturedIds = captures
      .filter((capture) => capture.path === "/api/agent-input/sources/source-partial/requests")
      .map((capture) => capture.body.id);
    assert.deepEqual(capturedIds, [], "a partial list publishes no member or absence mutation");
    assert.equal(captures.some((capture) => capture.path.endsWith("/native-list")), false,
      "one failed required session.get makes the whole absence snapshot incomplete");

    const listCallsBefore = captures.length;
    const failingListClient = { ...client, question: { ...client.question, list: async () => { throw new Error("list unavailable"); } } };
    secondPlugin = await module.default({ client: failingListClient, directory: repoRoot });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(captures.slice(listCallsBefore).some((capture) => capture.path.endsWith("/native-list")), false,
      "question.list failure cannot produce a complete barrier or close absent requests");
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    if (secondPlugin) await secondPlugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("snapshot cut fencing survives delayed list and session validation for new and reused keys", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-snapshot-cut-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, ".wmux", "agent-input", "pane.cap");
  const credentialPath = path.join(home, ".wmux", "agent-input", "pane.json");
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
  const calls: Array<{ path: string; body: any }> = [];
  const bindings = new Map<string, { id: string; generation: number; state: string }>();
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const requestPath = request.url ?? ""; calls.push({ path: requestPath, body });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (requestPath === "/api/agent-input/sources/register") return send(201, {
      sourceId: "source-cut", relaySecret: "S".repeat(43), expiresAt: Date.now() + 600_000,
      supported: true, credentialGeneration: 1,
    });
    if (requestPath.endsWith("/refresh")) return send(200, {
      sourceId: "source-cut", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2,
    });
    if (requestPath.endsWith("/requests")) {
      const binding = bindings.get(body.occurrenceId) ?? {
        id: `input-${body.id}-${body.ordinal}`, generation: body.ordinal, state: "pending",
      };
      bindings.set(body.occurrenceId, binding); return send(201, binding);
    }
    if (requestPath.endsWith("/pending")) return send(200, { outcome: "pending" });
    if (requestPath.endsWith("/resolve")) return send(200, { outcome: "resolved" });
    if (requestPath.endsWith("/native-list")) return send(200, { outcome: "reconciled", closed: 0 });
    if (requestPath.includes("/deliveries?")) return send(200, { epoch: "relay-cut", cursor: 0, deliveries: [] });
    return send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome,
    WMUX_URL: `http://127.0.0.1:${address.port}`, WMUX_PANE_ID: "pane-cut",
    WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath, WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let plugin: any;
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const module = await import(`${pathToFileURL(pluginPath).href}?cut=${Date.now()}`);
    const oldQuestions = [{ header: "Old", question: "Old payload", options: [], multiple: false, custom: true }];
    const newQuestions = [{ header: "New", question: "New payload", options: [], multiple: false, custom: true }];
    const freshQuestions = [{ header: "Fresh", question: "Fresh key", options: [], multiple: false, custom: true }];
    const lists: Array<(value: unknown) => void> = [];
    let sessionGate = Promise.resolve();
    let releaseSession = () => {};
    let sessionCalls = 0;
    const resetSessionGate = () => {
      sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
      sessionCalls = 0;
    };
    resetSessionGate();
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, error: undefined, response: { status: 200 } }) },
      question: {
        list: async () => new Promise((resolve) => lists.push(resolve)),
        reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
      },
      session: {
        get: async () => { sessionCalls += 1; await sessionGate; return { data: { title: "Top" }, response: { status: 200 } }; },
        messages: async () => ({ data: [] }),
      },
    };
    plugin = await module.default({ client, directory: repoRoot });
    await waitFor(() => lists.length === 1);
    const newEvent = plugin.event({ event: { id: "event-fresh", type: "question.asked", properties: {
      id: "fresh", sessionID: "session", questions: freshQuestions,
    } } });
    const orphanDuringList = plugin.event({ event: { type: "question.replied", properties: {
      requestID: "orphan-during-list", sessionID: "session", answers: [["redacted"]],
    } } });
    lists[0]({ data: [
      { id: "fresh", sessionID: "session", questions: freshQuestions },
      { id: "reused", sessionID: "session", questions: oldQuestions },
    ], response: { status: 200 } });
    await waitFor(() => sessionCalls >= 3);
    releaseSession();
    await Promise.all([newEvent, orphanDuringList]);
    await waitFor(() => calls.some((call) => call.path.endsWith("/native-list"))
      && lists.length === 2, () => JSON.stringify(calls));
    lists[1]({ data: [
      { id: "fresh", sessionID: "session", questions: freshQuestions },
      { id: "reused", sessionID: "session", questions: oldQuestions },
    ], response: { status: 200 } });
    await waitFor(() => calls.filter((call) => call.path.endsWith("/native-list")).length === 2
      && calls.filter((call) => call.path.endsWith("/requests")).length >= 2, () => JSON.stringify(calls));
    assert.deepEqual(calls.filter((call) => call.path.endsWith("/requests") && call.body.id === "fresh")
      .map((call) => call.body.ordinal), [1], "a post-cut new key is not allocated again by the stale snapshot member");

    await plugin.event({ event: { type: "question.replied", properties: {
      requestID: "reused", sessionID: "session", answers: [["redacted"]],
    } } });
    await waitFor(() => calls.some((call) => call.path.includes("input-reused-1/resolve")));
    await plugin.event({ event: { type: "question.replied", properties: {
      requestID: "orphan", sessionID: "session", answers: [["redacted"]],
    } } });
    await waitFor(() => lists.length === 3);
    resetSessionGate();
    const reusedEvent = plugin.event({ event: { id: "event-reused-new", type: "question.asked", properties: {
      id: "reused", sessionID: "session", questions: newQuestions,
    } } });
    lists[2]({ data: [{ id: "reused", sessionID: "session", questions: oldQuestions }], response: { status: 200 } });
    await waitFor(() => sessionCalls >= 2);
    releaseSession();
    await reusedEvent;
    await waitFor(() => calls.filter((call) => call.path.endsWith("/native-list")).length === 3
      && calls.some((call) => call.path.endsWith("/requests") && call.body.id === "reused" && call.body.ordinal === 2),
    () => JSON.stringify(calls));
    const reusedCaptures = calls.filter((call) => call.path.endsWith("/requests") && call.body.id === "reused");
    assert.deepEqual(reusedCaptures.map((call) => [call.body.ordinal, call.body.questions[0].question]), [
      [1, "Old payload"], [2, "New payload"],
    ], "a stale same-key snapshot payload cannot allocate or supersede the post-cut occurrence");
    const lastSnapshot = calls.filter((call) => call.path.endsWith("/native-list")).at(-1)!.body;
    assert.equal(lastSnapshot.cutSequence, 4);
    assert.equal(lastSnapshot.members.some((member: any) => member.requestID === "reused"), false);
    assert.equal(lastSnapshot.occurrenceKeys.includes(reusedCaptures.at(-1)!.body?.occurrenceKey), false,
      "the cut-scoped barrier excludes the post-cut replacement key instead of replaying stale list metadata");
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("plugin-to-broker equal-cut orphan and terminal fences suppress stale members but restart allocates the next occurrence", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-reused-native-id-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, ".wmux", "agent-input", "pane.cap");
  const credentialPath = path.join(home, ".wmux", "agent-input", "pane.json");
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
  const captures: Array<{ requestId: string; occurrenceId: string; ordinal: number; generation: number }> = [];
  const nativeLists: any[] = [];
  const operationGenerations = new Map<string, number>();
  let currentGeneration = 0;
  let pendingGeneration: number | undefined;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/agent-input/sources/register") {
      send(201, { sourceId: "source-reuse", relaySecret: "S".repeat(43), expiresAt: Date.now() + 600_000, supported: true, credentialGeneration: 1 });
    } else if (request.url === "/api/agent-input/sources/source-reuse/refresh") {
      send(200, { sourceId: "source-reuse", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2 });
    } else if (request.url === "/api/agent-input/sources/source-reuse/requests") {
      let generation = operationGenerations.get(body.occurrenceId);
      if (generation === undefined) {
        if (pendingGeneration === undefined) pendingGeneration = ++currentGeneration;
        generation = pendingGeneration;
        operationGenerations.set(body.occurrenceId, generation);
        captures.push({ requestId: body.id, occurrenceId: body.occurrenceId, ordinal: body.ordinal, generation });
      }
      send(201, { id: `public-${generation}`, generation, state: "pending", eventRevision: generation });
    } else if (request.url?.endsWith("/pending")) {
      send(200, { outcome: "pending" });
    } else if (request.url?.endsWith("/resolve")) {
      if (body.generation === pendingGeneration) {
        pendingGeneration = undefined;
        send(200, { outcome: "resolved" });
      } else {
        assert.ok(body.generation <= currentGeneration);
        send(200, { outcome: "already_resolved" });
      }
    } else if (request.url?.endsWith("/native-list")) {
      nativeLists.push(body);
      send(200, { outcome: "reconciled", closed: 0 });
    } else if (request.url?.includes("/deliveries?")) {
      send(200, { epoch: "relay-reuse", cursor: 0, deliveries: [] });
    } else {
      send(404, { error: "not_found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: configHome,
    WMUX_URL: `http://127.0.0.1:${address.port}`, WMUX_PANE_ID: "pane-reuse",
    WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath,
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let firstPlugin: any;
  let secondPlugin: any;
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const module = await import(`${pathToFileURL(pluginPath).href}?reuse=${Date.now()}`);
    const nativeRequest = {
      id: "reused-request", sessionID: "session-reuse",
      questions: [{ header: "H", question: "Q", options: [], multiple: false, custom: true }],
    };
    const orphanRequest = {
      id: "orphan-request", sessionID: "session-reuse",
      questions: [{ header: "H", question: "stale orphan", options: [], multiple: false, custom: true }],
    };
    let listedRequests = [nativeRequest];
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, error: undefined, response: { status: 200 } }) },
      question: {
        list: async () => ({ data: listedRequests, response: { status: 200 } }),
        reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
      },
      session: {
        get: async () => ({ data: { title: "Top" }, response: { status: 200 } }),
        messages: async () => ({ data: [] }),
      },
    };
    firstPlugin = await module.default({ client, directory: repoRoot });
    await waitFor(() => captures.length === 1, () => JSON.stringify(captures));
    await firstPlugin.event({ event: {
      type: "question.replied", properties: { requestID: "reused-request", sessionID: "session-reuse", answers: [["redacted"]] },
    } });
    await waitFor(() => pendingGeneration === undefined);
    await waitFor(() => nativeLists.length >= 1);
    const priorNativeLists = nativeLists.length;
    listedRequests = [nativeRequest, orphanRequest];
    await firstPlugin.event({ event: {
      type: "question.rejected", properties: { requestID: "orphan-request", sessionID: "session-reuse" },
    } });
    await waitFor(() => nativeLists.length > priorNativeLists, () => JSON.stringify(nativeLists));
    const equalCut = nativeLists.at(-1);
    assert.equal(equalCut.cutSequence, 2);
    assert.deepEqual(equalCut.members, [],
      "terminal seq 1 and orphan seq 2 both fence stale members in the rerun collected at cut 2");
    assert.deepEqual(captures.map((capture) => capture.requestId), ["reused-request"],
      "the equal-cut orphan member performs no capture");
    listedRequests = [nativeRequest];
    if (process.platform === "linux") {
      for (const childId of brokerChildIds()) process.kill(childId, "SIGTERM");
      await waitFor(() => brokerChildIds().length === 0);
    }

    secondPlugin = await module.default({ client, directory: repoRoot });
    await waitFor(() => captures.length === 2, () => JSON.stringify(captures));
    assert.deepEqual(captures.map((capture) => capture.requestId), ["reused-request", "reused-request"]);
    assert.deepEqual(captures.map((capture) => capture.generation), [1, 2]);
    assert.deepEqual(captures.map((capture) => capture.ordinal), [1, 2]);
    assert.notEqual(captures[0].occurrenceId, captures[1].occurrenceId,
      "the durable broker advances a terminal reused native identity");
  } finally {
    if (firstPlugin) await firstPlugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    if (secondPlugin) await secondPlugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("serial SDK delivery starts only at invocation and a timed-out queued delivery never calls late", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-serial-start-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, ".wmux", "agent-input", "pane.cap");
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
  const pending: any[] = [];
  const starts: Array<{ deliveryId: string; at: number }> = [];
  const sdkCalls: Array<{ requestID: string; at: number }> = [];
  let cursor = 0;
  let registered = false;
  let brokerReady = false;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/agent-input/sources/register") {
      registered = true;
      send(201, { sourceId: "source-serial", relaySecret: "S".repeat(43), expiresAt: Date.now() + 600_000, supported: true, credentialGeneration: 1 });
    } else if (request.url === "/api/agent-input/sources/source-serial/requests") {
      cursor += 1;
      pending.push({ deliveryId: `delivery-${body.id}`, cursor, requestId: `input-${body.id}`, expectedGeneration: 1, openCodeRequestId: body.id, answers: [[body.id]] });
      send(201, { id: `input-${body.id}`, generation: 1, state: "pending", eventRevision: cursor });
    } else if (request.url?.includes("/deliveries?") && pending.length) {
      brokerReady = true;
      send(200, { epoch: "relay-serial", cursor, deliveries: pending.splice(0) });
    } else if (request.url?.includes("/deliveries?")) {
      brokerReady = true;
      send(200, { epoch: "relay-serial", cursor, deliveries: [] });
    } else if (request.url?.endsWith("/start")) {
      const deliveryId = request.url.split("/").at(-2)!;
      starts.push({ deliveryId, at: Date.now() });
      send(deliveryId === "delivery-first" ? 200 : 409, deliveryId === "delivery-first" ? { outcome: "started" } : { error: "delivery_conflict" });
    } else {
      send(200, { outcome: "delivered" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: configHome,
    WMUX_URL: `http://127.0.0.1:${address.port}`, WMUX_PANE_ID: "pane-serial",
    WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: path.join(home, ".wmux", "agent-input", "pane.json"),
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let plugin: any;
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const module = await import(`${pathToFileURL(pluginPath).href}?serial=${Date.now()}`);
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, error: undefined, response: { status: 200 } }) },
      question: {
        list: async () => ({ data: [], response: { status: 200 } }),
        reply: async (input: { requestID: string }) => {
          sdkCalls.push({ requestID: input.requestID, at: Date.now() });
          if (input.requestID === "first") await new Promise((resolve) => setTimeout(resolve, 15_050));
          return { data: true, error: undefined, response: { status: 200 } };
        },
      },
      session: { get: async () => ({ data: { title: "Top" }, response: { status: 200 } }), messages: async () => ({ data: [] }) },
    };
    plugin = await module.default({ client, directory: repoRoot });
    await waitFor(() => registered && brokerReady);
    const question = (id: string) => ({ id: `event-${id}`, type: "question.asked", properties: {
      id, sessionID: "session", questions: [{ header: "H", question: "Q", options: [], multiple: false, custom: true }],
    } });
    await plugin.event({ event: question("first") });
    await plugin.event({ event: question("second") });
    await waitFor(() => starts.length === 2, () => JSON.stringify({ starts, sdkCalls }), 25_000);
    assert.deepEqual(sdkCalls.map((call) => call.requestID), ["first"], "the rejected queued delivery never invokes question.reply late");
    assert.ok(starts[1].at - starts[0].at >= 14_900, "the second start signal remains behind the first 15-second serial SDK call");
    assert.ok(Math.abs(sdkCalls[0].at - starts[0].at) < 500, "the accepted start is adjacent to actual SDK invocation");
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated plugin uses injected runtime attestation and never package manifests as compatibility authority", { skip: process.platform !== "linux" }, async (t) => {
  const variants: Array<{
    name: string;
    customXdg?: boolean;
    launches: boolean;
    mutate: (manifest: string, home: string) => void;
  }> = [
    { name: "default HOME layout", launches: true, mutate: () => undefined },
    { name: "custom XDG base", customXdg: true, launches: true, mutate: () => undefined },
    { name: "version mismatch", launches: true, mutate: (manifest) => fs.writeFileSync(manifest, '{"name":"@opencode-ai/sdk","version":"1.18.8"}') },
    { name: "name mismatch", launches: true, mutate: (manifest) => fs.writeFileSync(manifest, '{"name":"@opencode-ai/not-sdk","version":"1.18.9"}') },
    { name: "non-string version", launches: true, mutate: (manifest) => fs.writeFileSync(manifest, '{"name":"@opencode-ai/sdk","version":1.18}') },
    { name: "missing", launches: true, mutate: (manifest) => fs.rmSync(manifest) },
    { name: "malformed", launches: true, mutate: (manifest) => fs.writeFileSync(manifest, '{') },
    { name: "world writable", launches: true, mutate: (manifest) => fs.chmodSync(manifest, 0o666) },
    { name: "symlink", launches: true, mutate: (manifest, home) => {
      const target = path.join(home, "sdk-package.json");
      fs.writeFileSync(target, '{"name":"@opencode-ai/sdk","version":"1.18.9"}', { mode: 0o600 });
      fs.rmSync(manifest);
      fs.symlinkSync(target, manifest);
    } },
  ];
  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-package-"));
      const configHome = variant.customXdg ? path.join(home, "custom-config") : path.join(home, ".config");
      const capabilityPath = path.join(home, "pane.cap");
      fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
      let requests = 0;
      const server = http.createServer((_request, response) => {
        requests += 1;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          sourceId: "unexpected", relaySecret: "S".repeat(43), expiresAt: Date.now() + 60_000,
          supported: true, credentialGeneration: 1,
        }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const cacheRoot = path.join(home, "loader-cache", "opencode");
      const cachedPluginPath = path.join(cacheRoot, "plugins", "wmux.ts");
      const runnerPath = path.join(cacheRoot, "run-plugin.mjs");
      fs.mkdirSync(path.dirname(cachedPluginPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(runnerPath, `
        const pluginModule = await import(${JSON.stringify(pathToFileURL(cachedPluginPath).href)});
        const client = {
          global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, error: undefined, response: { status: 200 } }) },
          question: {
            list: async () => ({ data: [], response: { status: 200 } }),
            reply: async () => ({ data: true, response: { status: 200 } }),
          },
          session: {
            get: async () => ({ data: { title: "Top" } }),
            messages: async () => ({ data: [] }),
          },
        };
        const plugin = await pluginModule.default({ client, directory: ${JSON.stringify(repoRoot)} });
        process.stdout.write("READY\\n");
        await new Promise((resolve) => setTimeout(resolve, 750));
        await plugin.event({ event: { type: "question.future", properties: {} } });
        await new Promise((resolve) => setTimeout(resolve, 100));
      `, { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        WMUX_URL: `http://127.0.0.1:${address.port}`,
        WMUX_PANE_ID: `pane-${variant.name}`,
        WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
        WMUX_AGENT_INPUT_CREDENTIAL_PATH: path.join(home, "pane.json"),
        WMUX_TOKEN: "broad-shared-token-must-not-cross",
        WMUX_HELPER_TOKEN: "broad-helper-token-must-not-cross",
        WMUX_AUTOMATION_TOKEN: "broad-automation-token-must-not-cross",
        WMUX_REGISTRATION_TOKEN: "broad-registration-token-must-not-cross",
      };
      if (variant.customXdg) env.XDG_CONFIG_HOME = configHome;
      else delete env.XDG_CONFIG_HOME;
      let child: ReturnType<typeof spawn> | undefined;
      let output = "";
      let errors = "";
      try {
        await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
        installFixturePackages(configHome, true);
        fs.copyFileSync(path.join(configHome, "opencode", "plugins", "wmux.ts"), cachedPluginPath);
        const cachedModules = path.join(cacheRoot, "node_modules");
        fs.mkdirSync(path.join(cachedModules, "@opencode-ai"), { recursive: true, mode: 0o700 });
        fs.symlinkSync(
          path.join(configHome, "opencode", "node_modules", "@opencode-ai", "plugin"),
          path.join(cachedModules, "@opencode-ai", "plugin"),
          "dir",
        );
        fs.symlinkSync(
          path.join(configHome, "opencode", "node_modules", "effect"),
          path.join(cachedModules, "effect"),
          "dir",
        );
        const sdkManifest = path.join(configHome, "opencode", "node_modules", "@opencode-ai", "sdk", "package.json");
        variant.mutate(sdkManifest, home);
        child = spawn(process.execPath, ["--experimental-transform-types", runnerPath], { env, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (chunk) => { output += chunk.toString(); });
        child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
        await waitFor(() => output.includes("READY"), () => errors);
        if (variant.launches) {
          await waitFor(() => requests > 0 && brokerChildIds(child!.pid).length > 0, () => JSON.stringify({ requests, errors }));
          const environment = fs.readFileSync(`/proc/${brokerChildIds(child.pid)[0]}/environ`, "utf8").split("\0");
          for (const key of ["WMUX_TOKEN", "WMUX_HELPER_TOKEN", "WMUX_AUTOMATION_TOKEN", "WMUX_REGISTRATION_TOKEN"]) {
            assert.equal(environment.some((entry) => entry.startsWith(`${key}=`)), false, `${key} crossed the broker allowlist`);
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, 200));
          assert.deepEqual(brokerChildIds(child.pid), [], `${variant.name} launched a broker`);
          assert.equal(requests, 0, `${variant.name} reached broker bootstrap`);
        }
        const exitCode = child.exitCode ?? await new Promise<number | null>((resolve) => child!.once("exit", resolve));
        assert.equal(exitCode, 0, errors);
      } finally {
        if (child?.exitCode === null) child.kill("SIGTERM");
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

const installFixturePackages = (configHome: string, importOnly = false): void => {
  const nodeModules = path.join(configHome, "opencode", "node_modules");
  const pluginPackage = path.join(nodeModules, "@opencode-ai", "plugin");
  const effectPackage = path.join(nodeModules, "effect");
  const sdkPackage = path.join(nodeModules, "@opencode-ai", "sdk");
  fs.mkdirSync(pluginPackage, { recursive: true });
  fs.mkdirSync(effectPackage, { recursive: true });
  fs.mkdirSync(path.join(sdkPackage, "v2"), { recursive: true });
  fs.writeFileSync(path.join(pluginPackage, "package.json"), importOnly
    ? '{"name":"@opencode-ai/plugin","version":"1.18.9","type":"module","exports":{".":{"import":"./index.js"}}}'
    : '{"name":"@opencode-ai/plugin","version":"1.18.9","type":"module","exports":"./index.js"}');
  fs.writeFileSync(path.join(pluginPackage, "index.js"), 'export const tool=Object.assign((v)=>v,{schema:{string:()=>({optional:()=>({})}),number:()=>({optional:()=>({})}),boolean:()=>({optional:()=>({})})}});\n');
  fs.writeFileSync(path.join(effectPackage, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(effectPackage, "index.js"), 'export const Effect={runPromise:(v)=>v()};\n');
  fs.writeFileSync(path.join(sdkPackage, "package.json"), importOnly
    ? '{"name":"@opencode-ai/sdk","version":"1.18.9","type":"module","exports":{"./v2/client":{"import":"./v2/client.js"}}}'
    : '{"name":"@opencode-ai/sdk","version":"1.18.9","type":"module","exports":{"./v2/client":"./v2/client.js"}}');
  fs.writeFileSync(path.join(sdkPackage, "v2", "client.js"), 'export {};\n');
};

const waitFor = async (predicate: () => boolean, detail: () => string = () => "", timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out ${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const brokerChildIds = (parentId = process.pid): number[] => {
  const childrenPath = `/proc/${parentId}/task/${parentId}/children`;
  let ids: number[] = [];
  try {
    ids = fs.readFileSync(childrenPath, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
  return ids.filter((id) => {
    try { return fs.readFileSync(`/proc/${id}/cmdline`, "utf8").includes("wmux-agent-input-broker"); }
    catch { return false; }
  }).sort((left, right) => left - right);
};
