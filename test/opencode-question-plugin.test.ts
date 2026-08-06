import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createOpencodeClient as createRootOpencodeClient } from "@opencode-ai/sdk";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const fixtureClientFactoryKey = "__wmuxCreateStructuredOpencodeClient";
const fixtureImportFailureKey = "__wmuxFailStructuredOpencodeImport";
const testCapability = `aic_11111111-1111-4111-8111-111111111111.${"C".repeat(43)}`;
const testSourceId = "source_33333333-3333-4333-8333-333333333333";
const issuedRegistration = (body: any) => ({
  outcome: "issued",
  sourceId: testSourceId,
  relaySecret: `ais_${testSourceId.slice("source_".length)}.${body.relaySecretSeed}`,
  expiresAt: Date.now() + 600_000,
  supported: true,
  credentialGeneration: 1,
  limits: { maxQuestions: 32, maxOptions: 128, maxAnswerBytes: 16_384, maxPollWaitMs: 30_000 },
});
const setFixtureStructuredClient = (factory: (config: unknown) => unknown): void => {
  (globalThis as any)[fixtureClientFactoryKey] = factory;
};
const clearFixtureStructuredClient = (): void => {
  delete (globalThis as any)[fixtureClientFactoryKey];
  delete (globalThis as any)[fixtureImportFailureKey];
};
const withInjectedTransport = <T extends object>(client: T, transport: object = {
  get: async () => { throw new Error("unexpected fixture transport GET"); },
  post: async () => { throw new Error("unexpected fixture transport POST"); },
}): T => {
  Object.defineProperty(client, "_client", { value: transport, enumerable: true, configurable: true });
  return client;
};
const serverChallenge = () => ({
  type: "server_challenge", handshakeSchema: 4,
  contractDigest: "b37166e892fe20db37c2c501ab58c093da1db95a19ef6951393e67f38766f5b8",
  id: crypto.randomUUID(), nonce: crypto.randomBytes(32).toString("base64url"),
  issuedAt: Date.now(), deadline: Date.now() + 15_000,
});
const serveOpenCodeHealth = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  body = '{"healthy":true,"version":"1.18.9"}',
): boolean => {
  if (request.url !== "/global/health") return false;
  response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
  return true;
};

test("generated plugin allowlists top-level questions and uses only typed question.reply delivery", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-plugin-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, ".wmux", "agent-input", "pane.cap");
  const credentialPath = path.join(home, ".wmux", "agent-input", "pane.json");
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
  const captures: Array<{ path: string; method?: string; body: any; authorization?: string }> = [];
  const healthHeaders: http.IncomingHttpHeaders[] = [];
  const startRequests: string[] = [];
  let plugin: any;
  const deliveredQuestions = new Set<string>();
  const pendingDeliveries: Array<{ deliveryId: string; cursor: number; requestId: string; expectedGeneration: number; openCodeRequestId: string; answers: string[][] }> = [];
  let cursor = 0;
  let registrationAttempts = 0;
  let holdNextHealth = false;
  let healthHoldStartedResolve!: () => void;
  const healthHoldStarted = new Promise<void>((resolve) => { healthHoldStartedResolve = resolve; });
  let releaseHeldHealth!: () => void;
  const heldHealth = new Promise<void>((resolve) => { releaseHeldHealth = resolve; });
  let refreshReplyStartedResolve!: () => void;
  const refreshReplyStarted = new Promise<void>((resolve) => { refreshReplyStartedResolve = resolve; });
  let releaseRefreshReply!: () => void;
  const refreshReply = new Promise<void>((resolve) => { releaseRefreshReply = resolve; });
  const server = http.createServer(async (request, response) => {
    if (request.url === "/global/health") {
      healthHeaders.push(request.headers);
      serveOpenCodeHealth(request, response);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    captures.push({ path: request.url ?? "", method: request.method, body, authorization: request.headers.authorization });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    if (request.url?.endsWith("/challenge")) {
      send(201, serverChallenge());
    } else if (request.url === "/api/agent-input/sources/register") {
      registrationAttempts += 1;
      if (registrationAttempts === 1) {
        request.socket.destroy();
        return;
      }
      send(201, issuedRegistration(body));
    } else if (request.url === `/api/agent-input/sources/${testSourceId}/refresh`) {
      send(200, { sourceId: testSourceId, relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2 });
    } else if (request.url === `/api/agent-input/sources/${testSourceId}/requests` && request.method === "POST") {
      const questionId = body.id as string;
      const requestId = questionId === "question-one" ? "input-one" : `input-${questionId}`;
      const duplicate = deliveredQuestions.has(questionId);
      if (!duplicate) {
        deliveredQuestions.add(questionId);
        cursor += 1;
        pendingDeliveries.push({
          deliveryId: `delivery-${questionId}`, cursor, requestId, expectedGeneration: 1,
          openCodeRequestId: questionId,
          answers: questionId === "question-one" ? [["Safe"], ["Tests", "Types"], ["custom note"]]
            : questionId === "question-event-projection" ? [["Safe"], ["Tests"], ["event note"]]
              : [["answer"]],
        });
      }
      send(duplicate ? 200 : 201, { id: requestId, generation: 1, state: "pending", eventRevision: cursor });
    } else if (request.url?.startsWith(`/api/agent-input/sources/${testSourceId}/deliveries?`) && pendingDeliveries.length > 0) {
      send(200, { epoch: "relay-plugin", cursor, deliveries: [pendingDeliveries.shift()] });
    } else if (request.url?.startsWith(`/api/agent-input/sources/${testSourceId}/deliveries?`)) {
      send(200, { epoch: "relay-plugin", cursor, deliveries: [] });
    } else if (request.url?.endsWith("/native-list")) {
      send(200, { outcome: "reconciled", closed: 0 });
    } else if (request.url?.endsWith("/ack")) {
      send(200, { outcome: body.outcome === "applied" ? "delivered" : body.outcome });
    } else if (request.url?.endsWith("/start")) {
      const deliveryId = request.url.split("/").at(-2)!;
      startRequests.push(deliveryId);
      if (deliveryId === "delivery-question-refresh-start") return;
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
  let originalFetch: typeof fetch | undefined;
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    installRealSdkPackage(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const failBrokerPath = path.join(home, "fail-broker-start");
    const brokerWrapperPath = path.join(home, "broker-wrapper");
    fs.writeFileSync(brokerWrapperPath, `#!/bin/sh
if [ -f "${failBrokerPath}" ] && [ "$1" = "serve" ]; then exit 1; fi
exec "${path.join(repoRoot, "scripts", "wmux-agent-input-broker")}" "$@"
`, { mode: 0o700 });
    fs.writeFileSync(pluginPath, fs.readFileSync(pluginPath, "utf8").replace(
      JSON.stringify(path.join(repoRoot, "scripts", "wmux-agent-input-broker")),
      JSON.stringify(brokerWrapperPath),
    ), { mode: 0o600 });
    const module = await import(`${pathToFileURL(pluginPath).href}?question=${Date.now()}`);
    const replies: unknown[] = [];
    const structuredSessionInputs: unknown[] = [];
    const genericCalls = { get: 0, messages: 0 };
    const opencodeRequests: Array<{ method: string; pathname: string; search: string }> = [];
    const pendingQuestions = [
          { id: "question-one", sessionID: "session-one", questions: [
            { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false },
            { header: "Checks", question: "Choose", options: [{ label: "Tests", description: "Tests" }, { label: "Types", description: "Types" }], multiple: true, custom: false },
            { header: "Note", question: "Write", options: [], multiple: false, custom: true },
          ] },
          { id: "child-question", sessionID: "child-session", questions: [{ header: "Child", question: "Ignore", options: [], custom: true }] },
    ];
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { "content-type": "application/json" },
    });
    const inProcessFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      opencodeRequests.push({ method: request.method, pathname: url.pathname, search: url.search });
      if (url.pathname === "/global/health") {
        if (holdNextHealth) {
          holdNextHealth = false;
          healthHoldStartedResolve();
          await heldHealth;
        }
        return json({ healthy: true, version: "1.18.9" });
      }
      if (request.method === "GET" && url.pathname === "/question") return json(pendingQuestions);
      const session = /^\/session\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && session) {
        const sessionID = decodeURIComponent(session[1]);
        structuredSessionInputs.push({ sessionID, directory: url.searchParams.get("directory") });
        genericCalls.get += 1;
        return json({ id: sessionID, title: sessionID === "child-session" ? "Child" : "Top level",
          ...(sessionID === "child-session" ? { parentID: "session-one" } : {}) });
      }
      if (request.method === "GET" && /^\/session\/[^/]+\/message$/.test(url.pathname)) {
        genericCalls.messages += 1;
        return json([]);
      }
      const reply = /^\/question\/([^/]+)\/reply$/.exec(url.pathname);
      if (request.method === "POST" && reply) {
        const requestID = decodeURIComponent(reply[1]);
        const body = await request.json() as { answers: string[][] };
        replies.push({ requestID, answers: body.answers });
        if (requestID === "question-refresh-ack") {
          refreshReplyStartedResolve();
          await refreshReply;
        }
        if (requestID === "question-not-found") return json({ _tag: "QuestionNotFoundError" }, 404);
        if (requestID === "question-invalid") return json({ _tag: "InvalidRequestError" }, 400);
        if (requestID === "question-transport") throw new Error("transport details must not escape");
        return json(true);
      }
      return json({ _tag: "NotFoundError" }, 404);
    };
    const injectedClient = createRootOpencodeClient({ baseUrl: "http://opencode.invalid", directory: repoRoot,
      fetch: inProcessFetch as typeof fetch });
    const transport = Object.getOwnPropertyDescriptor(injectedClient, "_client")?.value;
    assert.ok(transport);
    const transportConfigBefore = transport.getConfig();
    const transportConfigEntries = Reflect.ownKeys(transportConfigBefore)
      .map((key) => [key, transportConfigBefore[key]] as const);
    originalFetch = globalThis.fetch;
    let externalOpenCodeFetches = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : input).hostname === "opencode.invalid") {
        externalOpenCodeFetches += 1;
        throw new Error("external OpenCode fetch forbidden");
      }
      return originalFetch!(input, init);
    }) as typeof fetch;
    plugin = await module.default({ client: injectedClient, directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
    await plugin["chat.message"](
      { sessionID: "session-one" },
      { message: { id: "message-one" }, parts: [{ type: "text", text: "generic lifecycle" }] },
    );
    const questions = [
      { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false },
      { header: "Checks", question: "Choose", options: [{ label: "Tests", description: "Tests" }, { label: "Types", description: "Types" }], multiple: true, custom: false },
      { header: "Note", question: "Write", options: [], multiple: false, custom: true },
    ];
    const normalizedQuestions = [
      { ...questions[0], custom: true },
      questions[1],
      questions[2],
    ];
    await waitFor(() => captures.some((capture) => capture.path === `/api/agent-input/sources/${testSourceId}/requests`), () => JSON.stringify(captures));
    const snapshotCapture = captures.find((capture) => capture.path === `/api/agent-input/sources/${testSourceId}/requests`)!;
    assert.deepEqual(snapshotCapture.body.questions, normalizedQuestions,
      "complete snapshots project absent/false/true custom values in exact question order");
    await waitFor(() => fs.existsSync(`${credentialPath}.status.json`)
      && JSON.parse(fs.readFileSync(`${credentialPath}.status.json`, "utf8")).diagnostic === "runtime_ready");
    const registrationCapture = captures.find((capture) => capture.path === "/api/agent-input/sources/register")!;
    assert.equal(registrationAttempts, 2, "a lost registration response is retried once with the exact request");
    assert.deepEqual(registrationCapture.body.runtimeAttestation.health, {
      source: "plugin.injectedTransport:/global/health", called: true, outcome: "ok", status: 200,
      healthy: true, release: "1.18.9",
    });
    assert.deepEqual(registrationCapture.body.runtimeAttestation.capabilities, {
      globalHealth: true, questionList: true, questionReply: true, sessionGet: true,
    });
    assert.deepEqual(Reflect.ownKeys(transport.getConfig()), transportConfigEntries.map(([key]) => key));
    for (const [key, value] of transportConfigEntries) {
      if (key === "headers") assert.deepEqual([...transport.getConfig()[key].entries()], [...value.entries()]);
      else assert.equal(transport.getConfig()[key], value, `transport config ${String(key)} changed`);
    }
    assert.equal(externalOpenCodeFetches, 0);
    assert.equal(healthHeaders.length, 0, "OpenCode health must not use the wmux TCP listener");
    assert.deepEqual(Object.keys(registrationCapture.body.runtimeAttestation).sort(), [
      "capabilities", "challengeDeadline", "challengeIssuedAt", "compatibilityFingerprint", "contractDigest",
      "diagnostic", "eventEnvelope", "handshakeSchema", "health", "nonce", "observedAt", "release",
      "serverChallenge", "type",
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
    const questionOneCaptures = captures.filter((capture) => capture.path === `/api/agent-input/sources/${testSourceId}/requests`);
    for (const capture of questionOneCaptures) {
      assert.deepEqual(capture.body.questions, normalizedQuestions,
        "snapshot uses the absent/false/true projection");
    }
    assert.deepEqual([...new Set(questionOneCaptures.map((capture) => capture.body.ordinal))], [1],
      "a distinct same-payload ask while pending deduplicates to the current occurrence");
    assert.ok(questionOneCaptures.every((capture) => typeof capture.body.occurrenceId === "string"
      && capture.body["capture" + "OperationId"] === undefined), "the plugin never chooses a server generation identity");
    assert.doesNotMatch(JSON.stringify(captures), /child-question|Ignore/);
    assert.ok(structuredSessionInputs.some((input: any) => input.sessionID === "child-session"
      && input.directory === repoRoot));
    await waitFor(() => captures.some((capture) => capture.path.endsWith("/ack")));
    const ack = captures.find((capture) => capture.path.endsWith("/ack"));
    assert.deepEqual(ack?.body, { id: "input-one", generation: 1, outcome: "applied" });
    assert.equal(replies.filter((reply: any) => reply.requestID === "question-one").length, 1,
      "an exposed request generation invokes the real fixture SDK at most once");

    await plugin.event({ event: { id: "event-question-projection", type: "question.asked", properties: {
      id: "question-event-projection", sessionID: "session-one", questions,
    } } });
    await waitFor(() => captures.some((capture) => capture.body.id === "question-event-projection"));
    const askedCapture = captures.find((capture) => capture.body.id === "question-event-projection")!;
    assert.deepEqual(askedCapture.body.questions, normalizedQuestions,
      "asked events use the same absent/false/true projection in exact question order");
    await waitFor(() => captures.some((capture) => capture.path.endsWith("/ack")
      && capture.body.id === "input-question-event-projection"));
    assert.deepEqual(replies.find((reply: any) => reply.requestID === "question-event-projection"), {
      requestID: "question-event-projection", answers: [["Safe"], ["Tests"], ["event note"]],
    });

    const oneCustomQuestion = [{ header: "Note", question: "Write", options: [], multiple: false, custom: true }];
    for (const id of ["question-not-found", "question-invalid", "question-transport"]) {
      await plugin.event({ event: { id: `event-${id}`, type: "question.asked", properties: { id, sessionID: "session-one", questions: oneCustomQuestion } } });
    }
    await waitFor(() => captures.filter((capture) => capture.path.endsWith("/ack")).length === 5,
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
    assert.equal("permission" in injectedClient, false);
    await plugin.event({ event: { id: "event-question-refresh-start", type: "question.asked", properties: {
      id: "question-refresh-start", sessionID: "session-one", questions: oneCustomQuestion,
    } } });
    await waitFor(() => startRequests.includes("delivery-question-refresh-start"));
    const refreshesBeforeRequest = captures.filter((capture) => capture.path.endsWith("/refresh")).length;
    const refreshResult = await execFileAsync(path.join(repoRoot, "scripts", "wmux-agent-input-broker"), ["refresh"], { env });
    assert.deepEqual(JSON.parse(refreshResult.stdout), {
      refreshed: true, supported: true, diagnostic: "refresh_requested",
    });
    await waitFor(() => captures.filter((capture) => capture.path.endsWith("/refresh")).length > refreshesBeforeRequest,
      () => JSON.stringify(captures.slice(-20)));
    cursor += 1;
    pendingDeliveries.push({
      deliveryId: "delivery-question-refresh-retry",
      cursor,
      requestId: "input-question-refresh-start",
      expectedGeneration: 1,
      openCodeRequestId: "question-refresh-start",
      answers: [["retry-safe"]],
    });
    await waitFor(() => replies.some((reply: any) => reply.requestID === "question-refresh-start"),
      () => JSON.stringify({ startRequests, replies }));
    assert.ok(startRequests.includes("delivery-question-refresh-retry"));

    await plugin.event({ event: { id: "event-question-refresh-ack", type: "question.asked", properties: {
      id: "question-refresh-ack", sessionID: "session-one", questions: oneCustomQuestion,
    } } });
    await refreshReplyStarted;
    const challengesBeforeAckRefresh = captures.filter((capture) => capture.path.endsWith("/challenge")).length;
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-agent-input-broker"), ["refresh"], { env });
    await waitFor(() => captures.filter((capture) => capture.path.endsWith("/challenge")).length > challengesBeforeAckRefresh);
    releaseRefreshReply();
    await waitFor(() => captures.some((capture) => capture.path.endsWith("/ack")
      && capture.body.id === "input-question-refresh-ack" && capture.body.outcome === "applied"),
    () => JSON.stringify(captures.slice(-30)));

    holdNextHealth = true;
    const challengesBeforeAttestationRace = captures.filter((capture) => capture.path.endsWith("/challenge")).length;
    const refreshesBeforeAttestationRace = captures.filter((capture) => capture.path.endsWith("/refresh")).length;
    const snapshotsBeforeAttestationRace = captures.filter((capture) => capture.path.endsWith("/native-list")).length;
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-agent-input-broker"), ["refresh"], { env });
    await healthHoldStarted;
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-agent-input-broker"), ["refresh"], { env });
    await waitFor(() => captures.filter((capture) => capture.path.endsWith("/challenge")).length
      >= challengesBeforeAttestationRace + 2);
    releaseHeldHealth();
    await waitFor(() => captures.filter((capture) => capture.path.endsWith("/refresh")).length
      > refreshesBeforeAttestationRace);
    await waitFor(() => captures.filter((capture) => capture.path.endsWith("/native-list")).length
      > snapshotsBeforeAttestationRace);
    await plugin.event({ event: { id: "event-question-after-stale-attestation", type: "question.asked", properties: {
      id: "question-after-stale-attestation", sessionID: "session-one", questions: oneCustomQuestion,
    } } });
    await waitFor(() => replies.some((reply: any) => reply.requestID === "question-after-stale-attestation"),
      () => JSON.stringify({ captures: captures.slice(-30), replies }));

    fs.writeFileSync(failBrokerPath, "fail\n", { mode: 0o600 });
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-agent-input-broker"), ["refresh"], { env });
    await waitFor(() => brokerChildIds().length === 0);
    await plugin.event({ event: { id: "event-question-during-failed-refresh", type: "question.asked", properties: {
      id: "question-during-failed-refresh", sessionID: "session-one", questions: oneCustomQuestion,
    } } });
    fs.rmSync(failBrokerPath, { force: true });
    const snapshotsBeforeFailedRefreshRecovery = captures.filter((capture) => capture.path.endsWith("/native-list")).length;
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-agent-input-broker"), ["refresh"], { env });
    await waitFor(() => captures.filter((capture) => capture.path.endsWith("/native-list")).length
      > snapshotsBeforeFailedRefreshRecovery);
    assert.equal(captures.some((capture) => capture.path.endsWith("/requests")
      && capture.body.id === "question-during-failed-refresh"), false,
    "a failed replacement must clear accepting state and queued events");

    await plugin.event({ event: { type: "question.rejected", properties: { sessionID: "session-one" } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await plugin.event({ event: { id: "event-after-malformed", type: "question.asked", properties: {
      id: "question-after-malformed", sessionID: "session-one", questions: oneCustomQuestion,
    } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(captures.some((capture) => capture.path.endsWith("/requests")
      && capture.body.id === "question-after-malformed"), false,
      "a malformed allowed event disables later structured handling");

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-one" } } });
    assert.ok(genericCalls.get >= 2, "generic lifecycle session.get stays on the injected root client");
    assert.equal(genericCalls.messages, 1, "generic lifecycle session.messages stays on the injected root client");
    assert.ok(opencodeRequests.some((request) => request.pathname === "/global/health"));

    assert.doesNotMatch(fs.readFileSync(pluginPath, "utf8"), /installedPackageVersion|safePackageManifest|packageSearchRoots/,
      "package manifests are not compatibility authority in the generated plugin");
  } finally {
    if (originalFetch) globalThis.fetch = originalFetch;
    if (plugin) await plugin.event({ event: { type: "question.future", properties: { sessionID: "session-one" } } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearFixtureStructuredClient();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated plugin serializes structured question delivery when resolution validation would finish before an earlier ask", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-sequence-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, "pane.cap");
  const credentialPath = path.join(home, "pane.json");
  const messagesPath = path.join(home, "broker-messages.jsonl");
  const brokerPath = path.join(home, "broker-wrapper.mjs");
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
  fs.writeFileSync(brokerPath, `#!/usr/bin/env node
import fs from "node:fs";
process.stdout.write(JSON.stringify({ type: "runtime_ready", supported: true, eventSequence: 0 }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line) {
      fs.appendFileSync(${JSON.stringify(messagesPath)}, line + "\\n");
      if (JSON.parse(line).type === "unsupported") process.exit(0);
    }
  }
});
`, { mode: 0o700 });
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, WMUX_URL: "http://127.0.0.1:9",
    WMUX_PANE_ID: "pane-sequence", WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath,
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let plugin: any;
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    fs.writeFileSync(pluginPath, fs.readFileSync(pluginPath, "utf8")
      .replace(
        JSON.stringify(path.join(repoRoot, "scripts", "wmux-agent-input-broker")), JSON.stringify(brokerPath),
      )
      .replace("const QUESTION_EVENT_TIMEOUT_MS = 10_000", "const QUESTION_EVENT_TIMEOUT_MS = 500")
      .replace("const MAX_QUESTION_EVENT_TASKS = 256", "const MAX_QUESTION_EVENT_TASKS = 4"), { mode: 0o600 });
    const module = await import(`${pathToFileURL(pluginPath).href}?sequence=${Date.now()}`);
    let releaseAsk!: () => void;
    const askGate = new Promise<void>((resolve) => { releaseAsk = resolve; });
    let askLookupStarted!: () => void;
    const askLookup = new Promise<void>((resolve) => { askLookupStarted = resolve; });
    let sessionCalls = 0;
    let hangLookups = false;
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, response: { status: 200 } }) },
      question: {
        list: async () => ({ data: [], response: { status: 200 } }),
        reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
      },
      session: {
        get: async (input?: { sessionID?: string; path?: { id: string } }, options?: { signal?: AbortSignal }) => {
          sessionCalls += 1;
          if (hangLookups) {
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          if (sessionCalls === 1) {
            askLookupStarted();
            await askGate;
          }
          return { data: { id: input?.sessionID ?? input?.path?.id, title: "Top" }, response: { status: 200 } };
        },
        messages: async () => ({ data: [] }),
      },
    };
    setFixtureStructuredClient(() => client);
    plugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
    await waitFor(() => fs.existsSync(messagesPath));
    const asked = plugin.event({ event: { id: "event-ask", type: "question.asked", properties: {
      id: "reordered", sessionID: "session", questions: [
        { header: "H", question: "Q", options: [], multiple: false, custom: true },
      ],
    } } });
    await askLookup;
    const resolved = plugin.event({ event: { type: "question.replied", properties: {
      requestID: "reordered", sessionID: "session", answers: [["redacted"]],
    } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sessionCalls, 1, "the later resolution cannot overtake the earlier assigned sequence");
    releaseAsk();
    await Promise.all([asked, resolved]);
    await waitFor(() => fs.readFileSync(messagesPath, "utf8").includes('"type":"resolved"'));
    const structured = fs.readFileSync(messagesPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((message) => message.type === "asked" || message.type === "resolved");
    assert.deepEqual(structured.map((message) => [message.type, message.eventSequence]), [["asked", 1], ["resolved", 2]]);
    assert.equal(structured.filter((message) => message.type === "asked").length, 1);
    assert.doesNotMatch(fs.readFileSync(messagesPath, "utf8"), /agent-events|notification|card/);

    hangLookups = true;
    const stalled = plugin.event({ event: { id: "event-stalled", type: "question.asked", properties: {
      id: "stalled", sessionID: "stalled-session", questions: [
        { header: "H", question: "Q", options: [], multiple: false, custom: true },
      ],
    } } });
    await waitFor(() => sessionCalls === 3);
    const queued = Array.from({ length: 4 }, (_, index) => plugin.event({ event: {
      id: `event-overflow-${index}`,
      type: "question.asked",
      properties: {
        id: `overflow-${index}`,
        sessionID: `overflow-session-${index}`,
        questions: [{ header: "H", question: "Q", options: [], multiple: false, custom: true }],
      },
    } }));
    await Promise.race([
      Promise.all([stalled, ...queued]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("structured event queue did not settle")), 2_000)),
    ]);
    await waitFor(() => fs.readFileSync(messagesPath, "utf8").includes('"type":"unsupported"'));
    assert.equal(sessionCalls, 3,
      "a timed-out lookup disables structured handling and queued events settle without more SDK calls");
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    await waitFor(() => brokerChildIds().length === 0, () => JSON.stringify(brokerChildIds())).catch(() => {
      for (const childId of brokerChildIds()) process.kill(childId, "SIGTERM");
    });
    clearFixtureStructuredClient();
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated plugin fails closed on an in-band session lookup error", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-lookup-error-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, "pane.cap");
  const credentialPath = path.join(home, "pane.json");
  const messagesPath = path.join(home, "broker-messages.jsonl");
  const brokerPath = path.join(home, "broker-wrapper.mjs");
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
  fs.writeFileSync(brokerPath, `#!/usr/bin/env node
import fs from "node:fs";
process.stdout.write(JSON.stringify({ type: "runtime_ready", supported: true, eventSequence: 0 }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line) {
      fs.appendFileSync(${JSON.stringify(messagesPath)}, line + "\\n");
      if (JSON.parse(line).type === "unsupported") process.exit(0);
    }
  }
});
`, { mode: 0o700 });
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, WMUX_URL: "http://127.0.0.1:9",
    WMUX_PANE_ID: "pane-lookup-error", WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath,
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let plugin: any;
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    fs.writeFileSync(pluginPath, fs.readFileSync(pluginPath, "utf8").replace(
      JSON.stringify(path.join(repoRoot, "scripts", "wmux-agent-input-broker")), JSON.stringify(brokerPath),
    ), { mode: 0o600 });
    const module = await import(`${pathToFileURL(pluginPath).href}?lookup-error=${Date.now()}`);
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, response: { status: 200 } }) },
      question: {
        list: async () => ({ data: [], response: { status: 200 } }),
        reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
      },
      session: {
        get: async () => ({ data: undefined, error: { name: "NotFound" }, response: { status: 404 } }),
        messages: async () => ({ data: [] }),
      },
    };
    setFixtureStructuredClient(() => client);
    plugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
    await waitFor(() => fs.existsSync(messagesPath));
    await plugin.event({ event: { id: "event-error", type: "question.asked", properties: {
      id: "lookup-error", sessionID: "missing-session", questions: [
        { header: "H", question: "Q", options: [], multiple: false, custom: true },
      ],
    } } });
    await waitFor(() => fs.readFileSync(messagesPath, "utf8").includes('"type":"unsupported"'));
    assert.doesNotMatch(fs.readFileSync(messagesPath, "utf8"), /"type":"asked"/);
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    await waitFor(() => brokerChildIds().length === 0, () => JSON.stringify(brokerChildIds())).catch(() => {
      for (const childId of brokerChildIds()) process.kill(childId, "SIGTERM");
    });
    clearFixtureStructuredClient();
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated plugin disables structured handling instead of dropping an oversized valid ask", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-oversized-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, "pane.cap");
  const credentialPath = path.join(home, "pane.json");
  const messagesPath = path.join(home, "broker-messages.jsonl");
  const brokerPath = path.join(home, "broker-wrapper.mjs");
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
  fs.writeFileSync(brokerPath, `#!/usr/bin/env node
import fs from "node:fs";
process.stdout.write(JSON.stringify({ type: "runtime_ready", supported: true, eventSequence: 0 }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line) {
      fs.appendFileSync(${JSON.stringify(messagesPath)}, line + "\\n");
      if (JSON.parse(line).type === "unsupported") process.exit(0);
    }
  }
});
`, { mode: 0o700 });
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, WMUX_URL: "http://127.0.0.1:9",
    WMUX_PANE_ID: "pane-oversized", WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath,
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let plugin: any;
  try {
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
    installFixturePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    fs.writeFileSync(pluginPath, fs.readFileSync(pluginPath, "utf8").replace(
      JSON.stringify(path.join(repoRoot, "scripts", "wmux-agent-input-broker")), JSON.stringify(brokerPath),
    ), { mode: 0o600 });
    const module = await import(`${pathToFileURL(pluginPath).href}?oversized=${Date.now()}`);
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.9" }, response: { status: 200 } }) },
      question: {
        list: async () => ({ data: [], response: { status: 200 } }),
        reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
      },
      session: {
        get: async (input?: { sessionID?: string }) => ({
          data: { id: input?.sessionID, title: "Top" }, response: { status: 200 },
        }),
        messages: async () => ({ data: [] }),
      },
    };
    setFixtureStructuredClient(() => client);
    plugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
    await waitFor(() => fs.existsSync(messagesPath));
    const questions = Array.from({ length: 32 }, (_, index) => ({
      header: `H${index}`,
      question: "x".repeat(5_000),
      options: [],
      multiple: false,
      custom: true,
    }));
    await plugin.event({ event: { id: "event-oversized", type: "question.asked", properties: {
      id: "oversized", sessionID: "session", questions,
    } } });
    await waitFor(() => fs.readFileSync(messagesPath, "utf8").includes('"type":"unsupported"'));
    const messages = fs.readFileSync(messagesPath, "utf8");
    assert.doesNotMatch(messages, /"type":"asked"/);
    assert.ok(Buffer.byteLength(JSON.stringify({ type: "asked", eventId: "event-oversized", eventSequence: 1,
      id: "oversized", sessionID: "session", questions, nativePending: false })) > 128 * 1024);
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    await waitFor(() => brokerChildIds().length === 0, () => JSON.stringify(brokerChildIds())).catch(() => {
      for (const childId of brokerChildIds()) process.kill(childId, "SIGTERM");
    });
    clearFixtureStructuredClient();
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated plugin bounds snapshot count, aggregate bytes, concurrency, and wall time", { skip: process.platform === "win32" }, async (t) => {
  const minimalQuestion = { header: "H", question: "Q", options: [], multiple: false, custom: true };
  const variants = [
    {
      name: "member count",
      requests: Array.from({ length: 257 }, (_, index) => ({
        id: `count-${index}`, sessionID: "session", questions: [minimalQuestion],
      })),
      expectedSessionCalls: 0,
      shortenDeadline: false,
      hangSession: false,
    },
    {
      name: "aggregate bytes",
      requests: Array.from({ length: 16 }, (_, index) => ({
        id: `bytes-${index}`, sessionID: "session",
        questions: [{ ...minimalQuestion, question: "x".repeat(9_000) }],
      })),
      expectedSessionCalls: 16,
      shortenDeadline: false,
      hangSession: false,
    },
    {
      name: "absolute deadline",
      requests: [{ id: "deadline", sessionID: "session", questions: [minimalQuestion] }],
      expectedSessionCalls: 1,
      shortenDeadline: true,
      hangSession: true,
    },
  ];
  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-snapshot-bound-"));
      const configHome = path.join(home, "config");
      const capabilityPath = path.join(home, "pane.cap");
      const credentialPath = path.join(home, "pane.json");
      const messagesPath = path.join(home, "broker-messages.jsonl");
      const brokerPath = path.join(home, "broker-wrapper.mjs");
      fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
      fs.writeFileSync(brokerPath, `#!/usr/bin/env node
import fs from "node:fs";
process.stdout.write(JSON.stringify({ type: "runtime_ready", supported: true, eventSequence: 0 }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line) {
      fs.appendFileSync(${JSON.stringify(messagesPath)}, line + "\\n");
      if (JSON.parse(line).type === "unsupported") process.exit(0);
    }
  }
});
`, { mode: 0o700 });
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, WMUX_URL: "http://127.0.0.1:9",
        WMUX_PANE_ID: `pane-snapshot-${variant.name}`, WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
        WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath };
      const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
      Object.assign(process.env, env);
      let plugin: any;
      let sessionCalls = 0;
      try {
        await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], { env });
        installFixturePackages(configHome);
        const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
        let source = fs.readFileSync(pluginPath, "utf8").replace(
          JSON.stringify(path.join(repoRoot, "scripts", "wmux-agent-input-broker")), JSON.stringify(brokerPath),
        );
        if (variant.shortenDeadline) source = source.replace("const deadline = Date.now() + 10_000", "const deadline = Date.now() + 100");
        fs.writeFileSync(pluginPath, source, { mode: 0o600 });
        const module = await import(`${pathToFileURL(pluginPath).href}?snapshot-bound=${encodeURIComponent(variant.name)}-${Date.now()}`);
        const client = {
          question: {
            list: async () => ({ data: variant.requests, response: { status: 200 } }),
            reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
          },
          session: {
            get: async () => {
              sessionCalls += 1;
              if (variant.hangSession) return new Promise(() => undefined);
              return { data: { title: "Top" }, response: { status: 200 } };
            },
            messages: async () => ({ data: [] }),
          },
        };
        setFixtureStructuredClient(() => client);
        plugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
        await waitFor(() => fs.existsSync(messagesPath)
          && fs.readFileSync(messagesPath, "utf8").includes('"type":"snapshot"'),
        () => fs.existsSync(messagesPath) ? fs.readFileSync(messagesPath, "utf8") : "missing", 3_000);
        const snapshots = fs.readFileSync(messagesPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
          .filter((message) => message.type === "snapshot");
        assert.ok(snapshots.length >= 1);
        assert.deepEqual((({ complete, members }) => ({ complete, members }))(snapshots.at(-1)), {
          complete: false, members: [],
        });
        assert.equal(sessionCalls, variant.expectedSessionCalls);
      } finally {
        if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
        clearFixtureStructuredClient();
        for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test("new generated plugin fails structured handling closed against an old server while generic lifecycle continues", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-old-server-"));
  const configHome = path.join(home, "config");
  const capabilityPath = path.join(home, ".wmux", "agent-input", "pane.cap");
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
  const captures: Array<{ path: string; body: any }> = [];
  const server = http.createServer(async (request, response) => {
    if (serveOpenCodeHealth(request, response)) return;
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
      question: {
        list: async () => ({ data: [], response: { status: 200 } }),
        reply: async () => { sdkInvocations += 1; return { data: true, error: undefined, response: { status: 200 } }; },
      },
      session: {
        get: async () => ({ data: { title: "Compatible lifecycle" } }),
        messages: async () => ({ data: [] }),
      },
    };
    setFixtureStructuredClient(() => client);
    plugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
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
      && JSON.parse(fs.readFileSync(`${env.WMUX_AGENT_INPUT_CREDENTIAL_PATH}.status.json`, "utf8")).diagnostic === "server_challenge_failed");
    assert.ok(captures.some((capture) => capture.path === "/api/agent-events" && capture.body.status === "running"));
    assert.equal(sdkInvocations, 0, "an old server cannot expose an answer for SDK invocation");
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearFixtureStructuredClient();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated plugin reports sanitized injected-transport, health, and method failures while generic telemetry remains available", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  type Variant = {
    name: string;
    diagnostic: string;
    transport?: "missing" | "invalid";
    omitMethod?: "global.health" | "question.list" | "question.reply" | "session.get";
    clientFailure?: "import" | "construction";
    health?: () => Promise<unknown>;
  };
  const result = (data: unknown, status = 200, error?: unknown) => ({ data, ...(error === undefined ? {} : { error }), response: { status } });
  const variants: Variant[] = [
    { name: "injected transport missing", diagnostic: "injected_transport_missing", transport: "missing" },
    { name: "injected transport invalid", diagnostic: "injected_transport_invalid", transport: "invalid" },
    { name: "v2 import failure", diagnostic: "v2_client_import_error", clientFailure: "import" },
    { name: "v2 construction failure", diagnostic: "v2_client_construction_error", clientFailure: "construction" },
    { name: "global.health missing", diagnostic: "method_global_health_missing", omitMethod: "global.health" },
    { name: "question.list missing", diagnostic: "method_question_list_missing", omitMethod: "question.list" },
    { name: "question.reply missing", diagnostic: "method_question_reply_missing", omitMethod: "question.reply" },
    { name: "session.get missing", diagnostic: "method_session_get_missing", omitMethod: "session.get" },
    { name: "health transport failure", diagnostic: "health_transport_error", health: async () => { throw new Error("private transport detail"); } },
    { name: "health status", diagnostic: "health_status", health: async () => result({}, 503) },
    { name: "health result error", diagnostic: "health_shape_invalid", health: async () => result(
      { healthy: true, version: "1.18.9" }, 200, { private: "error" }) },
    { name: "health extra key", diagnostic: "health_shape_invalid", health: async () => result(
      { healthy: true, version: "1.18.9", extra: true }) },
    { name: "health missing key", diagnostic: "health_shape_invalid", health: async () => result({ healthy: true }) },
    { name: "health unhealthy", diagnostic: "health_shape_invalid", health: async () => result(
      { healthy: false, version: "1.18.9" }) },
    { name: "health release mismatch", diagnostic: "release_mismatch", health: async () => result(
      { healthy: true, version: "1.18.8" }) },
  ];
  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-question-health-"));
      const configHome = path.join(home, "config");
      const inputDirectory = path.join(home, ".wmux", "agent-input");
      const capabilityPath = path.join(inputDirectory, "pane.cap");
      const credentialPath = path.join(inputDirectory, "pane.json");
      fs.mkdirSync(inputDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
      const calls: Array<{ path: string; body: any }> = [];
      const server = http.createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        calls.push({ path: request.url ?? "", body });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify(request.url?.endsWith("/challenge") ? serverChallenge() : {}));
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
        const module = await import(`${pathToFileURL(pluginPath).href}?health=${encodeURIComponent(variant.name)}-${Date.now()}`);
        const structuredClient: any = {
          global: { health: variant.health ?? (async () => result({ healthy: true, version: "1.18.9" })) },
          question: { list: async () => result([]), reply: async () => result(true) },
          session: { get: async () => result({ title: "Structured" }) },
        };
        if (variant.omitMethod === "global.health") delete structuredClient.global.health;
        if (variant.omitMethod === "question.list") delete structuredClient.question.list;
        if (variant.omitMethod === "question.reply") delete structuredClient.question.reply;
        if (variant.omitMethod === "session.get") delete structuredClient.session.get;
        const client: any = { session: {
          get: async () => ({ data: { title: "Telemetry" }, response: { status: 200 } }),
          messages: async () => ({ data: [] }),
        } };
        if (variant.transport === "invalid") Object.defineProperty(client, "_client", { value: { get: async () => undefined } });
        else if (variant.transport !== "missing") withInjectedTransport(client);
        if (variant.clientFailure === "import") (globalThis as any)[fixtureImportFailureKey] = true;
        let constructorCalls = 0;
        setFixtureStructuredClient(() => {
          constructorCalls += 1;
          if (variant.clientFailure === "construction") throw new Error("fixture construction details");
          return structuredClient;
        });
        plugin = await module.default({ client, directory: repoRoot, serverUrl: new URL("http://127.0.0.1:1/unreachable") });
        await plugin["chat.message"]({ sessionID: "session" }, { message: { id: "message" }, parts: [{ type: "text", text: "generic" }] });
        await waitFor(() => fs.existsSync(`${credentialPath}.status.json`)
          && JSON.parse(fs.readFileSync(`${credentialPath}.status.json`, "utf8")).diagnostic === variant.diagnostic,
        () => JSON.stringify(calls), 8_000);
        await waitFor(() => calls.some((call) => call.path === "/api/agent-events"));
        assert.equal(calls.some((call) => call.path === "/api/agent-input/sources/register"), false);
        assert.equal(fs.statSync(`${credentialPath}.status.json`).mode & 0o777, 0o600);
        const status = fs.readFileSync(`${credentialPath}.status.json`, "utf8");
        assert.doesNotMatch(status, /127\.0\.0\.1|global\/health|pane-health|workspace-health|fixture construction|private transport/);
        if (variant.transport === "missing" || variant.transport === "invalid") {
          assert.equal(constructorCalls, 0, "invalid injected transport must not consult a v2 default or fixture fallback");
        }
      } finally {
        if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
        clearFixtureStructuredClient();
        for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
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
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
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
    await module.default({ client: withInjectedTransport({}), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
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
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
  const captures: Array<{ path: string; body: any }> = [];
  const server = http.createServer(async (request, response) => {
    if (serveOpenCodeHealth(request, response)) return;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    captures.push({ path: request.url ?? "", body });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url?.endsWith("/challenge")) {
      send(201, serverChallenge());
    } else if (request.url === "/api/agent-input/sources/register") {
      send(201, issuedRegistration(body));
    } else if (request.url === `/api/agent-input/sources/${testSourceId}/refresh`) {
      send(200, { sourceId: testSourceId, relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2 });
    } else if (request.url === `/api/agent-input/sources/${testSourceId}/requests`) {
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
    let listCalls = 0;
    const listCallTimes: number[] = [];
    let malformedSessionResults = true;
    let unavailableSessionCalls = 0;
    const client = {
      question: {
        list: async () => {
          listCalls += 1;
          listCallTimes.push(Date.now());
          if (listCalls === 1) throw new Error("list unavailable");
          if (listCalls === 2) return { data: {}, response: { status: 200 } };
          if (listCalls === 3) return { data: Array.from({ length: 257 }, () => questionList[0]), response: { status: 200 } };
          if (listCalls === 4) return { data: questionList, error: { name: "conflicting result" }, response: { status: 200 } };
          if (listCalls === 5) return { data: questionList, response: {} };
          if (listCalls === 6) return { data: [{ ...questionList[0], id: "" }], response: { status: 200 } };
          if (listCalls === 7) return { data: [questionList[0], questionList[0]], response: { status: 200 } };
          return { data: questionList, response: { status: 200 } };
        },
        reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
      },
      session: {
        get: async (input: { sessionID?: string; path?: { id: string } }) => {
          const id = input.sessionID ?? input.path?.id ?? "";
          if (malformedSessionResults && id === "top-session") {
            return { data: { id: "wrong-session", title: "Top" }, error: { name: "conflicting result" }, response: { status: 200 } };
          }
          if (malformedSessionResults && id === "child-session") return { data: { id, parentID: 7 }, response: { status: 200 } };
          if (id === "unavailable-session") unavailableSessionCalls += 1;
          if (malformedSessionResults && id === "unavailable-session") {
            return { data: { id, detail: "x".repeat(70 * 1024) }, response: { status: 200 } };
          }
          return { data: id === "child-session" ? { id, parentID: "top-session" } : { id, title: "Top" }, response: { status: 200 } };
        },
        messages: async () => ({ data: [] }),
      },
    };
    setFixtureStructuredClient(() => client);
    plugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
    await waitFor(() => captures.some((capture) => capture.path === "/api/agent-input/sources/register"), () => JSON.stringify(captures));
    await waitFor(() => listCalls >= 8 && unavailableSessionCalls >= 1, () => JSON.stringify(listCallTimes), 14_000);
    const retryIntervals = listCallTimes.slice(1).map((time, index) => time - listCallTimes[index]);
    const expectedIntervals = [100, 200, 400, 800, 1_600, 3_200, 5_000];
    assert.equal(retryIntervals.length, expectedIntervals.length);
    for (const [index, expected] of expectedIntervals.entries()) {
      assert.ok(retryIntervals[index] >= expected - 50 && retryIntervals[index] <= expected + 2_000,
        `snapshot retry ${index + 1} did not use capped exponential backoff: ${JSON.stringify(retryIntervals)}`);
    }
    assert.equal(captures.some((capture) => capture.path.endsWith("/native-list")), false,
      "thrown, malformed, oversized, conflicting, missing-status, invalid-identity, duplicate, and partial results cannot produce a complete barrier");
    const capturedIds = captures
      .filter((capture) => capture.path === `/api/agent-input/sources/${testSourceId}/requests`)
      .map((capture) => capture.body.id);
    assert.deepEqual(capturedIds, [], "a partial list publishes no member or absence mutation");
    assert.equal(captures.some((capture) => capture.path.endsWith("/native-list")), false,
      "malformed required session results make the whole absence snapshot incomplete");

    malformedSessionResults = false;
    await waitFor(() => captures.some((capture) => capture.path.endsWith("/native-list")), () => JSON.stringify(captures), 7_000);
    await waitFor(() => captures.filter((capture) => capture.path === `/api/agent-input/sources/${testSourceId}/requests`).length === 2,
      () => JSON.stringify(captures));
    assert.deepEqual(captures
      .filter((capture) => capture.path === `/api/agent-input/sources/${testSourceId}/requests`)
      .map((capture) => capture.body.id).sort(), ["top-question", "uncertain-question"],
    "an incomplete startup snapshot retries autonomously and preserves top-level filtering");
  } finally {
    if (plugin) await plugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    clearFixtureStructuredClient();
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
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
  const calls: Array<{ path: string; body: any }> = [];
  const bindings = new Map<string, { id: string; generation: number; state: string }>();
  const server = http.createServer(async (request, response) => {
    if (serveOpenCodeHealth(request, response)) return;
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const requestPath = request.url ?? ""; calls.push({ path: requestPath, body });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (requestPath.endsWith("/challenge")) return send(201, serverChallenge());
    if (requestPath === "/api/agent-input/sources/register") return send(201, issuedRegistration(body));
    if (requestPath.endsWith("/refresh")) return send(200, {
      sourceId: testSourceId, relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2,
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
      question: {
        list: async () => new Promise((resolve) => lists.push(resolve)),
        reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
      },
      session: {
        get: async (input: { sessionID?: string; path?: { id: string } }) => {
          sessionCalls += 1;
          await sessionGate;
          return { data: { id: input.sessionID ?? input.path?.id, title: "Top" }, response: { status: 200 } };
        },
        messages: async () => ({ data: [] }),
      },
    };
    setFixtureStructuredClient(() => client);
    plugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
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
    await waitFor(() => sessionCalls >= 2);
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
    clearFixtureStructuredClient();
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
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
  const captures: Array<{ requestId: string; occurrenceId: string; ordinal: number; generation: number }> = [];
  const nativeLists: any[] = [];
  const operationGenerations = new Map<string, number>();
  const challengeAuthorizations: Array<string | undefined> = [];
  const attestations: any[] = [];
  let currentGeneration = 0;
  let pendingGeneration: number | undefined;
  const server = http.createServer(async (request, response) => {
    if (serveOpenCodeHealth(request, response)) return;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url?.endsWith("/challenge")) {
      challengeAuthorizations.push(request.headers.authorization);
      send(201, serverChallenge());
    } else if (request.url === "/api/agent-input/sources/register") {
      attestations.push(body.runtimeAttestation);
      send(201, issuedRegistration(body));
    } else if (request.url === `/api/agent-input/sources/${testSourceId}/refresh`) {
      attestations.push(body.runtimeAttestation);
      send(200, { sourceId: testSourceId, relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2 });
    } else if (request.url === `/api/agent-input/sources/${testSourceId}/requests`) {
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
      question: {
        list: async () => ({ data: listedRequests, response: { status: 200 } }),
        reply: async () => ({ data: true, error: undefined, response: { status: 200 } }),
      },
      session: {
        get: async (input: { sessionID?: string; path?: { id: string } }) => ({
          data: { id: input.sessionID ?? input.path?.id, title: "Top" }, response: { status: 200 },
        }),
        messages: async () => ({ data: [] }),
      },
    };
    setFixtureStructuredClient(() => client);
    firstPlugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
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

    secondPlugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
    await waitFor(() => captures.length === 2, () => JSON.stringify(captures));
    assert.deepEqual(captures.map((capture) => capture.requestId), ["reused-request", "reused-request"]);
    assert.deepEqual(captures.map((capture) => capture.generation), [1, 2]);
    assert.deepEqual(captures.map((capture) => capture.ordinal), [1, 2]);
    assert.notEqual(captures[0].occurrenceId, captures[1].occurrenceId,
      "the durable broker advances a terminal reused native identity");
    assert.equal(attestations.length, 2, "registration and restart refresh each submit current runtime evidence");
    assert.notEqual(attestations[0].nonce, attestations[1].nonce);
    assert.notEqual(attestations[0].serverChallenge.id, attestations[1].serverChallenge.id);
    assert.equal(challengeAuthorizations[0], `Bearer ${testCapability}`);
    assert.match(challengeAuthorizations[1] ?? "",
      new RegExp(`^Bearer ais_${testSourceId.slice("source_".length)}\\.[A-Za-z0-9_-]{43}$`),
      "restart challenge authority comes from the existing source credential, not the consumed constructor capability");
  } finally {
    if (firstPlugin) await firstPlugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    if (secondPlugin) await secondPlugin.event({ event: { type: "question.future", properties: {} } }).catch(() => undefined);
    clearFixtureStructuredClient();
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
  fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
  const pending: any[] = [];
  const starts: Array<{ deliveryId: string; at: number }> = [];
  const sdkCalls: Array<{ requestID: string; at: number }> = [];
  let cursor = 0;
  let registered = false;
  let brokerReady = false;
  const server = http.createServer(async (request, response) => {
    if (serveOpenCodeHealth(request, response)) return;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url?.endsWith("/challenge")) {
      send(201, serverChallenge());
    } else if (request.url === "/api/agent-input/sources/register") {
      registered = true;
      send(201, issuedRegistration(body));
    } else if (request.url === `/api/agent-input/sources/${testSourceId}/requests`) {
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
      question: {
        list: async () => ({ data: [], response: { status: 200 } }),
        reply: async (input: { requestID: string }) => {
          sdkCalls.push({ requestID: input.requestID, at: Date.now() });
          if (input.requestID === "first") await new Promise((resolve) => setTimeout(resolve, 15_050));
          return { data: true, error: undefined, response: { status: 200 } };
        },
      },
      session: { get: async (input: { sessionID?: string; path?: { id: string } }) => ({
        data: { id: input.sessionID ?? input.path?.id, title: "Top" }, response: { status: 200 },
      }), messages: async () => ({ data: [] }) },
    };
    setFixtureStructuredClient(() => client);
    plugin = await module.default({ client: withInjectedTransport(client), directory: repoRoot, serverUrl: new URL(env.WMUX_URL) });
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
    clearFixtureStructuredClient();
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated plugin uses injected transport from a separate import/cache context and never package manifests as authority", { skip: process.platform !== "linux" }, async (t) => {
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
      fs.writeFileSync(capabilityPath, `${testCapability}\n`, { mode: 0o600 });
      let requests = 0;
      const requestPaths: string[] = [];
      const server = http.createServer(async (request, response) => {
        requests += 1;
        requestPaths.push(request.url ?? "");
        if (serveOpenCodeHealth(request, response)) return;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify(request.url?.endsWith("/challenge") ? serverChallenge() : issuedRegistration(body)));
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
          question: {
            list: async () => ({ data: [], response: { status: 200 } }),
            reply: async () => ({ data: true, response: { status: 200 } }),
          },
          session: {
            get: async () => ({ data: { title: "Top" } }),
            messages: async () => ({ data: [] }),
          },
        };
        globalThis.${fixtureClientFactoryKey} = () => client;
        Object.defineProperty(client, "_client", { value: { get: async () => {}, post: async () => {} }, enumerable: true });
        const plugin = await pluginModule.default({ client, directory: ${JSON.stringify(repoRoot)},
          serverUrl: new URL("http://127.0.0.1:1/unreachable-cache-context") });
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
        fs.cpSync(
          path.join(configHome, "opencode", "node_modules", "@opencode-ai", "sdk"),
          path.join(cachedModules, "@opencode-ai", "sdk"),
          { recursive: true },
        );
        const sdkManifest = path.join(configHome, "opencode", "node_modules", "@opencode-ai", "sdk", "package.json");
        variant.mutate(sdkManifest, home);
        child = spawn(process.execPath, ["--experimental-transform-types", runnerPath], { env, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (chunk) => { output += chunk.toString(); });
        child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
        await waitFor(() => output.includes("READY"), () => errors);
        if (variant.launches) {
          await waitFor(() => requestPaths.includes("/api/agent-input/sources/register")
            && brokerChildIds(child!.pid).length > 0, () => JSON.stringify({ requestPaths, errors }));
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
  fs.writeFileSync(path.join(sdkPackage, "v2", "client.js"), `
    if (globalThis.${fixtureImportFailureKey}) throw new Error("fixture import details");
    export class OpencodeClient {
      constructor(config) {
      const factory = globalThis.${fixtureClientFactoryKey};
      if (typeof factory !== "function") throw new Error("fixture client factory missing");
        const value = factory(config);
        if (!("global" in value)) value.global = { health: async () => ({
          data: { healthy: true, version: "1.18.9" }, response: { status: 200 },
        }) };
        return value;
      }
    }
  `);
};

const installRealSdkPackage = (configHome: string): void => {
  const target = path.join(configHome, "opencode", "node_modules", "@opencode-ai", "sdk");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(repoRoot, "node_modules", "@opencode-ai", "sdk"), target, { recursive: true });
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
