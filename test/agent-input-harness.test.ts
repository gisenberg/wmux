import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAgentInputAnswers } from "../src/client/src/agent-input-reference.js";
import { AgentInputCredentialStore } from "../src/server/agent-input-credential-store.js";
import { AgentInputRelay } from "../src/server/agent-input-relay.js";
import { AgentInputRequestStore } from "../src/server/agent-input-request-store.js";
import type { AuthConfig } from "../src/server/auth.js";
import { createHttpServer } from "../src/server/http.js";
import {
  OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
  SUPPORTED_OPENCODE_SDK_VERSION,
} from "../src/server/opencode-question-contract.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { AgentInputQuestion, BootstrapPayload, MachineConfig } from "../src/shared/protocol.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtime = {
  type: "runtime", openCodeVersion: SUPPORTED_OPENCODE_SDK_VERSION,
  sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION, eventEnvelope: "legacy-properties",
  compatibilityFingerprint: OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
};
const question: AgentInputQuestion = {
  header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: true,
};

test("isolated reference-to-occurrence-broker-to-SDK harness preserves HTTP answers and writes zero pane bytes", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-occurrence-harness-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const credentials = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "server-key" });
  const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "answer-key" });
  const relay = new AgentInputRelay(requests, credentials, { deliveryTimeoutMs: 5_000, isPaneLive: () => true });
  const auth: AuthConfig = {
    enabled: true, token: "browser-user-token", loginEnabled: false, sessionSecret: "session-secret",
    browserAuthMode: "shared-or-login", helperToken: "H".repeat(43), automationToken: "A".repeat(43),
  };
  let paneInputCalls = 0;
  let paneInputBytes = 0;
  const sessions = { writePane: (_paneId: string, data: string) => {
    paneInputCalls += 1; paneInputBytes += Buffer.byteLength(data); return true;
  } } as unknown as SessionManager;
  const server = await createHttpServer("127.0.0.1", state, machines, sessions, settings, {
    auth, agentInputCredentials: credentials, agentInputRequests: requests, agentInputRelay: relay,
    healthResolvers: { machines: async () => [], streams: async () => [] },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const base = `http://127.0.0.1:${address.port}`;
  const context = state.findPaneContext(state.snapshot().workspaces[0].tabs[0].panes[0].id)!;
  const capability = credentials.issueRegistrationCapability({ workspaceId: context.workspace.id, tabId: context.tab.id,
    paneId: context.pane.id, machineId: context.pane.machineId, sourceKind: "opencode" });
  const agentInputDirectory = path.join(directory, "agent-input");
  fs.mkdirSync(agentInputDirectory, { mode: 0o700 });
  const capabilityPath = path.join(agentInputDirectory, `${context.pane.id}.cap`);
  const credentialPath = path.join(agentInputDirectory, `${context.pane.id}.json`);
  fs.writeFileSync(capabilityPath, `${capability.capability}\n`, { mode: 0o600 });
  const broker = launchBroker(directory, base, context.pane.id, credentialPath, capabilityPath);
  const questions: AgentInputQuestion[] = [question,
    { header: "Checks", question: "Choose checks", options: [{ label: "Tests", description: "Tests" }, { label: "Types", description: "Types" }], multiple: true, custom: false },
    { header: "Note", question: "Custom", options: [], multiple: false, custom: true }];
  const sentinel = ["A6", "RAW", "ANSWER", "SENTINEL"].join("_");
  try {
    broker.send(runtime);
    broker.send({ type: "asked", eventId: "native-event-a6", eventSequence: 1,
      id: "question-a6", sessionID: "session-a6", questions, nativePending: false });
    broker.send({ type: "snapshot", complete: true, cutSequence: 1,
      members: [{ id: "question-a6", sessionID: "session-a6", questions }] });
    await waitFor(() => broker.messages.some((message) => message.type === "ready" && message.supported === true));
    await waitFor(() => requests.snapshot().some((request) => request.openCodeRequestId === "question-a6"));
    const request = requests.snapshot().find((candidate) => candidate.openCodeRequestId === "question-a6")!;
    const answers = buildAgentInputAnswers(questions, [["Safe"], ["Tests", "Types"], []], ["", "", sentinel]);
    const answerPromise = fetch(`${base}/api/agent-input/requests/${request.id}/answer`, {
      method: "POST", headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedGeneration: request.generation, idempotencyKey: "a6-submission", answers }),
    });
    await waitFor(() => broker.messages.some((message) => message.type === "delivery"));
    const delivery = broker.messages.find((message) => message.type === "delivery");
    const sdkCalls = [{ requestID: delivery.openCodeRequestId, answers: structuredClone(delivery.answers) }];
    assert.deepEqual(sdkCalls, [{ requestID: "question-a6", answers }]);
    broker.send({ type: "ack", deliveryId: delivery.deliveryId, id: delivery.requestId,
      generation: delivery.expectedGeneration, outcome: "applied" });
    for (const answer of delivery.answers as string[][]) answer.fill("");
    delivery.answers.length = 0;
    for (const answer of sdkCalls[0].answers) answer.fill("");
    sdkCalls[0].answers.length = 0;
    const answerResponse = await answerPromise;
    assert.equal(answerResponse.status, 200);
    assert.deepEqual(await answerResponse.json(), { outcome: "delivered" });
    const projection = await (await fetch(`${base}/api/bootstrap`, { headers: { authorization: `Bearer ${auth.token}` } })).json() as BootstrapPayload;
    assert.equal(projection.agentInputRequests.find((candidate) => candidate.id === request.id)?.state, "answered");
    assert.equal(paneInputCalls, 0);
    assert.equal(paneInputBytes, 0);
    broker.send({ type: "unsupported" });
    await broker.exit();
    execFileSync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], {
      stdio: "pipe", env: { HOME: directory, PATH: process.env.PATH ?? "/usr/bin:/bin", XDG_CONFIG_HOME: path.join(directory, "generated-config") },
    });
    state.flush();
    for (const value of [requests.snapshot(), credentials.snapshot(), state.snapshot(), projection, broker.sanitized, broker.stderr]) {
      assert.doesNotMatch(JSON.stringify(value), new RegExp(sentinel));
    }
    for (const filePath of recursiveFiles(directory)) assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), new RegExp(sentinel));
    assert.equal(sdkCalls.length, 1, "the native SDK invocation occurs at most once");
  } finally {
    await broker.stop();
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("broker occurrence stream converges duplicate events, orders reused IDs, survives restart, and consumes permanent failures once", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-occurrence-stream-"));
  const credentialPath = path.join(directory, "pane.json");
  const calls: Array<{ path: string; body: any }> = [];
  const bindings = new Map<string, { id: string; generation: number; state: string }>();
  const resolutionAttempts = new Map<string, number>();
  let dropFirstCapture = true;
  let dropFirstResolve = true;
  let generationTwoCaptured = false;
  const fixture = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const requestPath = request.url ?? "";
    calls.push({ path: requestPath, body });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (requestPath.endsWith("/refresh")) return send(200, { sourceId: "source-one", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2 });
    if (requestPath.endsWith("/requests")) {
      let binding = bindings.get(body.occurrenceId);
      if (!binding) {
        binding = { id: `public-${body.ordinal}`, generation: body.ordinal, state: "pending" };
        bindings.set(body.occurrenceId, binding);
      }
      if (body.ordinal === 1 && dropFirstCapture) { dropFirstCapture = false; response.destroy(); return; }
      if (body.ordinal === 2) generationTwoCaptured = true;
      if (body.ordinal === 3) return send(409, { error: "permanent_binding" });
      return send(bindings.get(body.occurrenceId) === binding ? 201 : 200, binding);
    }
    if (requestPath.endsWith("/pending")) return send(200, { outcome: "pending" });
    if (requestPath.endsWith("/resolve")) {
      const attempts = (resolutionAttempts.get(requestPath) ?? 0) + 1;
      resolutionAttempts.set(requestPath, attempts);
      if (requestPath.includes("public-1") && dropFirstResolve) { dropFirstResolve = false; response.destroy(); return; }
      return send(200, { outcome: "resolved" });
    }
    if (requestPath.endsWith("/native-list")) return send(200, { outcome: "reconciled", closed: 0 });
    if (requestPath.includes("/deliveries?")) return send(200, { epoch: "relay-one", cursor: 0, deliveries: [] });
    return send(404, { error: "not_found" });
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("fixture unavailable");
  writeCredential(credentialPath);
  let broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath);
  try {
    broker.send(runtime);
    broker.send({ type: "asked", eventId: "ask-one", eventSequence: 1,
      id: "reused", sessionID: "session", questions: [question], nativePending: false });
    broker.send({ type: "asked", eventId: "ask-one", eventSequence: 2,
      id: "reused", sessionID: "session", questions: [question], nativePending: false });
    broker.send({ type: "asked", eventId: "ask-two", eventSequence: 3,
      id: "reused", sessionID: "session", questions: [question], nativePending: false });
    broker.send({ type: "resolved", eventSequence: 4, requestID: "reused", sessionID: "session", result: "replied" });
    await waitFor(() => calls.some((call) => call.path.includes("public-1/resolve")));
    await broker.stop();
    broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath);
    broker.send(runtime);
    broker.send({ type: "asked", eventId: "ask-three", eventSequence: 5,
      id: "reused", sessionID: "session", questions: [question], nativePending: false });
    await waitFor(() => generationTwoCaptured, () => JSON.stringify(calls));
    broker.send({ type: "resolved", eventSequence: 3, requestID: "reused", sessionID: "session", result: "replied" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls.some((call) => call.path.includes("public-2/resolve")), false,
      "a delayed terminal event older than occurrence two cannot resolve it");
    broker.send({ type: "resolved", eventSequence: 6, requestID: "reused", sessionID: "session", result: "rejected" });
    await waitFor(() => calls.some((call) => call.path.includes("public-2/resolve")), () => JSON.stringify(calls));
    const uniqueCaptures = new Map(calls.filter((call) => call.path.endsWith("/requests"))
      .map((call) => [call.body.occurrenceId, call.body.ordinal]));
    assert.deepEqual([...uniqueCaptures.values()], [1, 2],
      "distinct asks deduplicate while pending and advance only after a terminal event");
    assert.ok((resolutionAttempts.get("/api/agent-input/sources/source-one/requests/public-1/resolve") ?? 0) >= 2);
    assert.equal(calls.some((call) => call.path.includes("public-2/resolve") && call.body.generation === 1), false);
    assert.equal(calls.some((call) => call.path.includes("public-1/resolve") && call.body.generation === 2), false);
    broker.send({ type: "asked", eventId: "ask-four", eventSequence: 7,
      id: "reused", sessionID: "session", questions: [question], nativePending: false });
    await waitFor(() => JSON.parse(fs.readFileSync(credentialPath, "utf8")).quarantines.some((item: any) => item.status === 409));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ordinalThreeCalls = calls.filter((call) => call.path.endsWith("/requests") && call.body.ordinal === 3);
    assert.equal(ordinalThreeCalls.length, 1, "permanent binding 409 is consumed exactly once");
    const persisted = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    assert.equal(persisted.schemaVersion, 8);
    assert.equal(persisted.streams[Object.keys(persisted.streams)[0]].nextOrdinal, 3);
    assert.equal(persisted.receipts.filter((receipt: any) => receipt.occurrenceId === [...bindings.keys()][0]).length, 2,
      "multiple asked-event receipts converge durably on occurrence one");
  } finally {
    await broker.stop();
    fixture.close(); fixture.closeAllConnections(); await once(fixture, "close");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("identity-only orphan resolution fences an equal-cut stale member until broker restart", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-snapshot-trigger-"));
  const credentialPath = path.join(directory, "pane.json");
  const calls: Array<{ path: string; body: any }> = [];
  const fixture = await startSimpleFixture(calls);
  writeCredential(credentialPath);
  let broker = launchBroker(directory, fixture.base, "pane-one", credentialPath);
  try {
    broker.send(runtime);
    broker.send({ type: "resolved", eventSequence: 1, requestID: "missing", sessionID: "session", result: "replied" });
    await waitFor(() => broker.messages.some((message) => message.type === "snapshot_request"));
    assert.equal(calls.some((call) => call.path.endsWith("/resolve")), false);
    broker.send({ type: "snapshot", complete: false, cutSequence: 1, members: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls.some((call) => call.path.endsWith("/native-list")), false, "partial snapshots perform no closure");
    broker.send({ type: "snapshot", complete: true, cutSequence: 1,
      members: [{ id: "missing", sessionID: "session", questions: [question] }] });
    await waitFor(() => calls.some((call) => call.path.endsWith("/native-list")));
    assert.equal(calls.some((call) => call.path.endsWith("/requests")), false,
      "the orphan terminal event at the snapshot cut fences its stale listed member");
    await broker.stop();
    broker = launchBroker(directory, fixture.base, "pane-one", credentialPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "ready" && message.supported === true));
    broker.send({ type: "snapshot", complete: true, cutSequence: 1,
      members: [{ id: "missing", sessionID: "session", questions: [question] }] });
    await waitFor(() => calls.some((call) => call.path.endsWith("/requests") && call.body.ordinal === 1));
    broker.send({ type: "resolved", eventSequence: 2, requestID: "missing", sessionID: "session", result: "rejected" });
    await waitFor(() => calls.some((call) => call.path.endsWith("/resolve")));
    assert.deepEqual([...new Set(calls.filter((call) => call.path.endsWith("/requests")).map((call) => call.body.ordinal))], [1]);
  } finally {
    await broker.stop(); await fixture.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("broker resets a stale high delivery cursor when the transient relay epoch changes", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-relay-epoch-"));
  const credentialPath = path.join(directory, "pane.json");
  const polls: string[] = [];
  let delivered = false;
  const sentinel = ["RELAY", "EPOCH", "RAW"].join("_");
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    const requestPath = request.url ?? "";
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (requestPath.endsWith("/refresh")) return send(200, {
      sourceId: "source-one", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2,
    });
    if (requestPath.includes("/deliveries?")) {
      polls.push(requestPath);
      if (!delivered) {
        delivered = true;
        return send(200, { epoch: "relay-new", cursor: 1, deliveries: [{
          deliveryId: "delivery-first-new-epoch", cursor: 1, requestId: "input-one", expectedGeneration: 1,
          openCodeRequestId: "question-one", answers: [[sentinel]],
        }] });
      }
      return send(200, { epoch: "relay-new", cursor: 1, deliveries: [] });
    }
    return send(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  writeCredential(credentialPath);
  const stale = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
  stale.relayEpoch = "relay-old";
  stale.cursor = 9_999;
  fs.writeFileSync(credentialPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  const broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath);
  try {
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "delivery"));
    assert.match(polls[0], /epoch=relay-old&after=9999/);
    const persisted = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    assert.deepEqual({ epoch: persisted.relayEpoch, cursor: persisted.cursor }, { epoch: "relay-new", cursor: 1 });
    assert.doesNotMatch(fs.readFileSync(credentialPath, "utf8"), new RegExp(sentinel));
  } finally {
    await broker.stop(); server.close(); server.closeAllConnections(); await once(server, "close");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("broker migrations discard unbound metadata, require fresh registration, and preserve future schemas byte-for-byte", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-broker-migration-"));
  const credentialPath = path.join(directory, "pane.json");
  const calls: Array<{ path: string; body: any }> = [];
  const fixture = await startSimpleFixture(calls);
  try {
    fs.writeFileSync(credentialPath, `${JSON.stringify({ schemaVersion: 6, sourceId: "source-one", relaySecret: "S".repeat(43),
      expiresAt: Date.now() + 60_000, supported: true, credentialGeneration: 1, cursor: 0,
      legacyBindings: { stale: { id: "wrong-generation", generation: 9 } },
      outbox: [{ type: "resolve", id: "wrong-generation", generation: 9 }] })}\n`, { mode: 0o600 });
    let broker = launchBroker(directory, fixture.base, "pane-one", credentialPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "ready" && message.supported === false));
    await broker.stop();
    const migrated = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    assert.equal(migrated.schemaVersion, 8);
    assert.equal(migrated.supported, false);
    assert.deepEqual(migrated.outbox, []);
    assert.equal(calls.length, 0, "legacy unbound metadata performs no capture or resolution call");

    const future = `${JSON.stringify({ schemaVersion: 9, sourceId: "source-one", relaySecret: "S".repeat(43), expiresAt: 9e15, cursor: 0 })}\n`;
    fs.writeFileSync(credentialPath, future, { mode: 0o600 });
    broker = launchBroker(directory, fixture.base, "pane-one", credentialPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "ready" && message.supported === false));
    await broker.stop();
    assert.equal(fs.readFileSync(credentialPath, "utf8"), future);
    assert.equal(calls.length, 0);
  } finally {
    await fixture.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("broker stale credentials and receipt capacity fail closed without metadata mutation calls", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-broker-fail-closed-"));
  const credentialPath = path.join(directory, "pane.json");
  const calls: Array<{ path: string; body: any }> = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    calls.push({ path: request.url ?? "", body: {} });
    response.writeHead(401, { "content-type": "application/json" }); response.end('{"error":"stale"}');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  try {
    writeCredential(credentialPath);
    let broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "ready" && message.supported === false));
    await broker.stop();
    assert.equal(JSON.parse(fs.readFileSync(credentialPath, "utf8")).disabledReason, "stale-credential");
    assert.equal(calls.filter((call) => call.path.endsWith("/requests")).length, 0);

    const key = "a".repeat(64);
    const digest = "b".repeat(64);
    fs.writeFileSync(credentialPath, `${JSON.stringify({ schemaVersion: 8, sourceId: "source-one", relaySecret: "S".repeat(43),
      expiresAt: Date.now() + 600_000, supported: true, credentialGeneration: 1, cursor: 0,
      occurrenceEpoch: "epoch", relayEpoch: null, lastEventSequence: 512,
      streams: {}, receipts: Array.from({ length: 512 }, (_, index) => ({ eventId: `event-${index}`, occurrenceKey: key,
        eventSequence: index + 1, occurrenceId: `occ-${index}`, payloadDigest: digest })), outbox: [], quarantines: [] })}\n`, { mode: 0o600 });
    calls.length = 0;
    const fixture = await startSimpleFixture(calls);
    broker = launchBroker(directory, fixture.base, "pane-one", credentialPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "ready" && message.supported === true));
    broker.send({ type: "asked", eventId: "overflow", eventSequence: 513,
      id: "request", sessionID: "session", questions: [question], nativePending: false });
    await waitFor(() => JSON.parse(fs.readFileSync(credentialPath, "utf8")).supported === false);
    await broker.stop();
    assert.equal(calls.some((call) => call.path.endsWith("/requests")), false);
    await fixture.close();

    writeCredential(credentialPath);
    calls.length = 0;
    const conflictFixture = await startSimpleFixture(calls);
    broker = launchBroker(directory, conflictFixture.base, "pane-one", credentialPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "ready" && message.supported === true));
    broker.send({ type: "asked", eventId: "first", eventSequence: 1,
      id: "request", sessionID: "session", questions: [question], nativePending: false });
    await waitFor(() => calls.some((call) => call.path.endsWith("/requests")));
    broker.send({ type: "asked", eventId: "conflict", eventSequence: 2,
      id: "request", sessionID: "session",
      questions: [{ ...question, question: "secret conflicting payload" }], nativePending: false });
    await waitFor(() => JSON.parse(fs.readFileSync(credentialPath, "utf8")).supported === false);
    await broker.stop();
    const conflictState = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    assert.equal(conflictState.disabledReason, "asked-payload-conflict");
    assert.equal(calls.filter((call) => call.path.endsWith("/requests")).length, 1,
      "a conflicting pending ask cannot allocate generation two");
    assert.doesNotMatch(JSON.stringify(conflictState.quarantines), /secret conflicting payload/);
    await conflictFixture.close();
  } finally {
    server.close(); server.closeAllConnections(); await once(server, "close");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("complete absence advances broker ordinals and queued orphan reconciliation reruns without accepting a stale member", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-broker-absence-"));
  const credentialPath = path.join(directory, "pane.json");
  const calls: Array<{ path: string; body: any }> = [];
  const fixture = await startSimpleFixture(calls);
  const broker = (writeCredential(credentialPath), launchBroker(directory, fixture.base, "pane-one", credentialPath));
  try {
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "ready" && message.supported === true));
    broker.send({ type: "asked", eventId: "target-one", eventSequence: 1,
      id: "target", sessionID: "session", questions: [question], nativePending: false });
    await waitFor(() => calls.some((call) => call.path.endsWith("/requests") && call.body.id === "target" && call.body.ordinal === 1));
    broker.send({ type: "snapshot", complete: true, cutSequence: 1, members: [] });
    await waitFor(() => calls.some((call) => call.path.endsWith("/native-list")
      && call.body.occurrenceKeys?.length === 1 && call.body.members.length === 0));
    broker.send({ type: "asked", eventId: "target-two", eventSequence: 2,
      id: "target", sessionID: "session", questions: [question], nativePending: false });
    await waitFor(() => calls.some((call) => call.path.endsWith("/requests") && call.body.id === "target" && call.body.ordinal === 2));

    broker.send({ type: "resolved", eventSequence: 3, requestID: "orphan-a", sessionID: "session", result: "replied" });
    await waitFor(() => broker.messages.filter((message) => message.type === "snapshot_request").length === 1);
    broker.send({ type: "resolved", eventSequence: 4, requestID: "orphan-b", sessionID: "session", result: "rejected" });
    broker.send({ type: "snapshot", complete: true, cutSequence: 3, members: [] });
    await waitFor(() => broker.messages.filter((message) => message.type === "snapshot_request").length === 2);
    broker.send({ type: "snapshot", complete: true, cutSequence: 3,
      members: [{ id: "orphan-b", sessionID: "session", questions: [question] }] });
    await waitFor(() => calls.filter((call) => call.path.endsWith("/native-list")).length >= 3);
    assert.equal(calls.some((call) => call.path.endsWith("/requests") && call.body.id === "orphan-b"), false,
      "the post-cut orphan fence suppresses a delayed stale list member even without an occurrence");
    const state = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    const targetKey = Object.keys(state.streams).find((key) => state.streams[key].requestID === "target")!;
    assert.equal(state.streams[targetKey].nextOrdinal, 2);
    assert.equal(state.streams[targetKey].current.state, "terminal",
      "the later complete absence updates durable broker state as well as server reconciliation");
  } finally {
    await broker.stop(); await fixture.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("same-key metadata stays FIFO through resolve backoff while an unrelated real-store capture proceeds", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-real-store-fifo-"));
  const credentialPath = path.join(directory, "pane.json");
  const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "key" });
  let resolveAttempts = 0;
  let unrelatedCapturedBeforeRetry = false;
  let sameKeyOvertook = false;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const requestPath = request.url ?? "";
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (requestPath.endsWith("/refresh")) return send(200, { sourceId: "source-one", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2 });
    if (requestPath.endsWith("/requests")) {
      if (body.id === "unrelated" && resolveAttempts === 1) unrelatedCapturedBeforeRetry = true;
      if (body.id === "same" && body.ordinal === 2 && requests.snapshot().some((item) => item.openCodeRequestId === "same" && item.state === "pending")) sameKeyOvertook = true;
      const result = requests.capture({ occurrenceId: body.occurrenceId, occurrenceKey: body.occurrenceKey,
        occurrenceOrdinal: body.ordinal, payloadDigest: body.payloadDigest, sourceId: "source-one",
        workspaceId: "workspace", tabId: "tab", paneId: "pane", openCodeSessionId: body.sessionID,
        openCodeRequestId: body.id, questions: body.questions });
      if (result.outcome === "conflict") return send(409, { error: result.code });
      if (result.outcome === "retired") return send(200, result);
      return send(result.outcome === "created" ? 201 : 200, { id: result.request.id,
        generation: result.request.generation, state: result.request.state });
    }
    if (requestPath.endsWith("/resolve")) {
      resolveAttempts += 1;
      if (resolveAttempts === 1) return send(503, { error: "temporary" });
      const id = decodeURIComponent(requestPath.split("/").at(-2)!);
      return send(200, requests.resolveNative(id, body.generation, body.occurrenceId, body.result));
    }
    if (requestPath.includes("/deliveries?")) return send(200, { epoch: "relay-fifo", cursor: 0, deliveries: [] });
    return send(200, { outcome: "reconciled", closed: 0 });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  writeCredential(credentialPath);
  const broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath);
  try {
    broker.send(runtime);
    broker.send({ type: "asked", eventId: "same-one", eventSequence: 1,
      id: "same", sessionID: "session", questions: [question], nativePending: false });
    await waitFor(() => requests.snapshot().some((item) => item.openCodeRequestId === "same"));
    broker.send({ type: "resolved", eventSequence: 2, requestID: "same", sessionID: "session", result: "replied" });
    await waitFor(() => resolveAttempts === 1);
    broker.send({ type: "asked", eventId: "same-two", eventSequence: 3,
      id: "same", sessionID: "session", questions: [question], nativePending: false });
    broker.send({ type: "asked", eventId: "other-one", eventSequence: 4,
      id: "unrelated", sessionID: "session", questions: [question], nativePending: false });
    await waitFor(() => requests.snapshot().some((item) => item.openCodeRequestId === "same" && item.generation === 2)
      && requests.snapshot().some((item) => item.openCodeRequestId === "unrelated"));
    assert.equal(sameKeyOvertook, false, "capture N+1 never reaches generation allocation before resolve N succeeds");
    assert.equal(unrelatedCapturedBeforeRetry, true, "an unrelated key continues during same-key backoff");
    assert.ok(resolveAttempts >= 2);
  } finally {
    await broker.stop(); server.close(); server.closeAllConnections(); await once(server, "close");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("capture metadata survives more than eight transient failures and recovers without consuming the occurrence", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-capture-outage-"));
  const credentialPath = path.join(directory, "pane.json");
  let attempts = 0;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const requestPath = request.url ?? "";
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (requestPath.endsWith("/refresh")) return send(200, { sourceId: "source-one", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2 });
    if (requestPath.endsWith("/requests")) {
      attempts += 1;
      if (attempts <= 9) return send(503, { error: "outage" });
      return send(201, { id: "public-recovered", generation: 1, state: "pending", occurrenceId: body.occurrenceId });
    }
    if (requestPath.includes("/deliveries?")) return send(200, { epoch: "relay-outage", cursor: 0, deliveries: [] });
    return send(200, { outcome: "pending" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  writeCredential(credentialPath);
  const broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath);
  try {
    broker.send(runtime);
    broker.send({ type: "asked", eventId: "outage-one", eventSequence: 1,
      id: "outage", sessionID: "session", questions: [question], nativePending: false });
    await waitFor(() => attempts >= 9, () => String(attempts), 25_000);
    const duringOutage = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    assert.equal(duringOutage.outbox.some((operation: any) => operation.type === "capture"), true);
    assert.equal(duringOutage.quarantines.some((item: any) => item.reason === "retry-exhausted"), false);
    await waitFor(() => attempts >= 10 && JSON.parse(fs.readFileSync(credentialPath, "utf8")).outbox.length === 0,
      () => String(attempts), 25_000);
    const recovered = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    assert.equal(Object.values(recovered.streams).some((stream: any) => stream.current?.serverId === "public-recovered"), true);
  } finally {
    await broker.stop(); server.close(); server.closeAllConnections(); await once(server, "close");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeCredential(filePath: string): void {
  fs.writeFileSync(filePath, `${JSON.stringify({ schemaVersion: 8, sourceId: "source-one", relaySecret: "S".repeat(43),
    expiresAt: Date.now() + 60_000, supported: true, credentialGeneration: 1, cursor: 0,
    occurrenceEpoch: "epoch-one", relayEpoch: null, lastEventSequence: 0,
    streams: {}, receipts: [], outbox: [], quarantines: [] })}\n`, { mode: 0o600 });
}

function launchBroker(home: string, base: string, paneId: string, credentialPath: string, capabilityPath?: string) {
  const child = spawn(path.join(repoRoot, "scripts", "wmux-agent-input-broker"), ["serve"], {
    stdio: ["pipe", "pipe", "pipe"], env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", WMUX_URL: base,
      WMUX_PANE_ID: paneId, WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath,
      WMUX_OPENCODE_QUESTION_CONTRACT_PATH: path.join(repoRoot, "scripts", "opencode-question-contract.json"),
      ...(capabilityPath ? { WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath } : {}) },
  });
  const messages: any[] = [];
  const sanitized: string[] = [];
  const stderr: string[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line); messages.push(message);
      sanitized.push(message.type === "delivery" ? JSON.stringify({ type: "delivery", deliveryId: message.deliveryId }) : line);
    }
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const exit = async () => { if (child.exitCode === null) await once(child, "exit"); };
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.stdin.end(); child.kill("SIGTERM"); await once(child, "exit").catch(() => undefined);
  };
  return { child, messages, sanitized, stderr, send, exit, stop };
}

async function startSimpleFixture(calls: Array<{ path: string; body: any }>) {
  const bindings = new Map<string, any>();
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const requestPath = request.url ?? ""; calls.push({ path: requestPath, body });
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (requestPath.endsWith("/refresh")) return send(200, { sourceId: "source-one", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2 });
    if (requestPath.endsWith("/requests")) {
      const binding = bindings.get(body.occurrenceId) ?? { id: `public-${body.ordinal}`, generation: body.ordinal, state: "pending" };
      bindings.set(body.occurrenceId, binding); return send(201, binding);
    }
    if (requestPath.endsWith("/pending")) return send(200, { outcome: "pending" });
    if (requestPath.endsWith("/resolve")) return send(200, { outcome: "resolved" });
    if (requestPath.endsWith("/native-list")) return send(200, { outcome: "reconciled", closed: 0 });
    if (requestPath.includes("/deliveries?")) return send(200, { epoch: "relay-one", cursor: 0, deliveries: [] });
    return send(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  return { base: `http://127.0.0.1:${address.port}`, close: async () => {
    server.close(); server.closeAllConnections(); await once(server, "close");
  } };
}

const waitFor = async (predicate: () => boolean, detail: () => string = () => "", timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for occurrence state ${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const recursiveFiles = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const candidate = path.join(directory, entry.name);
  return entry.isDirectory() ? recursiveFiles(candidate) : entry.isFile() ? [candidate] : [];
});
