import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
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
  createOpenCodeRuntimeAttestation,
} from "../src/server/opencode-question-contract.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { AgentInputQuestion, BootstrapPayload, MachineConfig } from "../src/shared/protocol.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtime = { type: "legacy_runtime_ignored" };
const serverChallenge = () => ({
  type: "server_challenge",
  handshakeSchema: 4,
  contractDigest: "b37166e892fe20db37c2c501ab58c093da1db95a19ef6951393e67f38766f5b8",
  id: crypto.randomUUID(),
  nonce: crypto.randomBytes(32).toString("base64url"),
  issuedAt: Date.now(),
  deadline: Date.now() + 15_000,
});
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
  const binding = {
    backendId: "durable-multiplexer" as const,
    sessionIncarnation: "1".repeat(64),
    endpointFingerprint: "2".repeat(64),
  };
  const sessions = {
    hasLivePaneSession: (_paneId: string, candidate: typeof binding) =>
      JSON.stringify(candidate) === JSON.stringify(binding),
    agentInputSessionBinding: () => binding,
    setAgentInputCapabilityIssuer: () => undefined,
    setAgentInputSourceRetirer: () => undefined,
    writePane: (_paneId: string, data: string) => {
    paneInputCalls += 1; paneInputBytes += Buffer.byteLength(data); return true;
    },
  } as unknown as SessionManager;
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
  state.updatePane(context.pane.id, { status: "running" });
  const capability = credentials.issueRegistrationCapability({ workspaceId: context.workspace.id, tabId: context.tab.id,
    paneId: context.pane.id, machineId: context.pane.machineId, sourceKind: "opencode", ...binding });
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
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === true));
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
    if (requestPath.endsWith("/challenge")) return send(201, serverChallenge());
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
    assert.equal(persisted.schemaVersion, 10);
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
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === true));
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

test("broker rejects an earlier ask that arrives after a higher-sequence orphan resolution", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-reordered-orphan-"));
  const credentialPath = path.join(directory, "pane.json");
  const calls: Array<{ path: string; body: any }> = [];
  const fixture = await startSimpleFixture(calls);
  writeCredential(credentialPath);
  const broker = launchBroker(directory, fixture.base, "pane-one", credentialPath);
  try {
    broker.send(runtime);
    broker.send({ type: "resolved", eventSequence: 2, requestID: "reordered", sessionID: "session", result: "replied" });
    broker.send({ type: "asked", eventId: "ask-reordered", eventSequence: 1,
      id: "reordered", sessionID: "session", questions: [question], nativePending: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls.some((call) => call.path.endsWith("/requests") && call.body.id === "reordered"), false,
      "a stale ask cannot delete the orphan fence and allocate a resurrected occurrence");
  } finally {
    await broker.stop();
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
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
    if (requestPath.endsWith("/challenge")) return send(201, serverChallenge());
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

test("broker quarantines acknowledgement conflicts and requests native reconciliation", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-ack-conflict-"));
  const credentialPath = path.join(directory, "pane.json");
  let acknowledgementCalls = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    const requestPath = request.url ?? "";
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (requestPath.endsWith("/challenge")) return send(201, serverChallenge());
    if (requestPath.endsWith("/refresh")) return send(200, {
      sourceId: "source-one", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000, credentialGeneration: 2,
    });
    if (requestPath.endsWith("/ack")) {
      acknowledgementCalls += 1;
      return send(409, { error: "ack_conflict" });
    }
    if (requestPath.includes("/deliveries?")) return send(200, { epoch: "relay-ack", cursor: 0, deliveries: [] });
    return send(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  writeCredential(credentialPath);
  const broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath);
  try {
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === true));
    broker.send({
      type: "ack", deliveryId: "delivery-conflict", id: "input-conflict", generation: 1,
      outcome: "applied",
    });
    await waitFor(() => broker.messages.some((message) => message.type === "snapshot_request"));
    await waitFor(() => JSON.parse(fs.readFileSync(credentialPath, "utf8")).quarantines
      .some((item: any) => item.opId === "ack:delivery-conflict" && item.status === 409));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(acknowledgementCalls, 1, "a typed acknowledgement conflict is not silently consumed or retried");
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
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === false));
    await broker.stop();
    const migrated = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    assert.equal(migrated.schemaVersion, 10);
    assert.equal(migrated.supported, false);
    assert.deepEqual(migrated.outbox, []);
    assert.equal(calls.length, 0, "legacy unbound metadata performs no capture or resolution call");

    const future = `${JSON.stringify({ schemaVersion: 11, sourceId: "source-one", relaySecret: "S".repeat(43), expiresAt: 9e15, cursor: 0 })}\n`;
    fs.writeFileSync(credentialPath, future, { mode: 0o600 });
    broker = launchBroker(directory, fixture.base, "pane-one", credentialPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === false));
    await broker.stop();
    assert.equal(fs.readFileSync(credentialPath, "utf8"), future);
    assert.equal(calls.length, 0);
  } finally {
    await fixture.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("broker stale credentials require fresh pane capability authority and receipt capacity fails closed", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-broker-fail-closed-"));
  const credentialPath = path.join(directory, "pane.json");
  const capabilityPath = `${credentialPath}.cap`;
  const calls: Array<{ path: string; body: any }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestPath = request.url ?? "";
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    calls.push({ path: requestPath, body });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (requestPath === "/api/agent-input/sources/source-one/challenge") return send(401, { error: "stale" });
    if (requestPath === "/api/agent-input/sources/challenge") return send(201, serverChallenge());
    if (requestPath === "/api/agent-input/sources/register") return send(201, {
      sourceId: "source-restarted", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000,
      supported: true, credentialGeneration: 1,
    });
    if (requestPath.includes("/deliveries?")) return send(200, { epoch: "relay-restarted", cursor: 0, deliveries: [] });
    return send(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  try {
    writeCredential(credentialPath);
    let broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === false));
    await broker.stop();
    assert.equal(JSON.parse(fs.readFileSync(credentialPath, "utf8")).disabledReason, "stale-credential");
    assert.equal(calls.filter((call) => call.path.endsWith("/requests")).length, 0);

    calls.length = 0;
    writeCredential(credentialPath);
    fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
    broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath, capabilityPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === true));
    await broker.stop();
    assert.deepEqual(calls.slice(0, 3).map((call) => call.path), [
      "/api/agent-input/sources/source-one/challenge",
      "/api/agent-input/sources/challenge",
      "/api/agent-input/sources/register",
    ]);
    assert.equal(JSON.parse(fs.readFileSync(credentialPath, "utf8")).sourceId, "source-restarted");
    assert.equal(fs.existsSync(capabilityPath), false, "successful replacement consumes the new pane capability");

    const key = "a".repeat(64);
    const digest = "b".repeat(64);
    fs.writeFileSync(credentialPath, `${JSON.stringify({ schemaVersion: 10, sourceId: "source-one", relaySecret: "S".repeat(43),
      expiresAt: Date.now() + 600_000, supported: true, credentialGeneration: 1, cursor: 0,
      occurrenceEpoch: "epoch", relayEpoch: null, lastEventSequence: 512,
      streams: {}, receipts: Array.from({ length: 512 }, (_, index) => ({ eventId: `event-${index}`, occurrenceKey: key,
        eventSequence: index + 1, occurrenceId: `occ-${index}`, payloadDigest: digest })), outbox: [], quarantines: [] })}\n`, { mode: 0o600 });
    calls.length = 0;
    const fixture = await startSimpleFixture(calls);
    broker = launchBroker(directory, fixture.base, "pane-one", credentialPath);
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === true));
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
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === true));
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

test("running broker backs off until durable reattachment stages replacement authority", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-broker-live-recovery-"));
  const credentialPath = path.join(directory, "pane.json");
  const capabilityPath = `${credentialPath}.cap`;
  const calls: string[] = [];
  let sourceChallengeCalls = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const requestPath = request.url ?? "";
    calls.push(requestPath);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (requestPath === "/api/agent-input/sources/source-one/challenge") {
      sourceChallengeCalls += 1;
      return sourceChallengeCalls === 1
        ? send(201, serverChallenge())
        : send(409, { error: "pane_unavailable" });
    }
    if (requestPath === "/api/agent-input/sources/source-one/refresh") return send(200, {
      sourceId: "source-one", relaySecret: "T".repeat(43), expiresAt: Date.now() + 600_000,
      credentialGeneration: 2,
    });
    if (requestPath.startsWith("/api/agent-input/sources/source-one/deliveries?")) {
      return send(401, { error: "unauthorized" });
    }
    if (requestPath === "/api/agent-input/sources/challenge") return send(201, serverChallenge());
    if (requestPath === "/api/agent-input/sources/register") return send(201, {
      sourceId: "source-restarted", relaySecret: "R".repeat(43), expiresAt: Date.now() + 600_000,
      supported: true, credentialGeneration: 1,
    });
    if (requestPath.startsWith("/api/agent-input/sources/source-restarted/deliveries?")) {
      return send(200, { epoch: "relay-restarted", cursor: 0, deliveries: [] });
    }
    return send(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  writeCredential(credentialPath);
  const broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane-one", credentialPath, capabilityPath);
  try {
    broker.send(runtime);
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === true));
    await waitFor(() => JSON.parse(fs.readFileSync(credentialPath, "utf8")).requiresFreshRegistration === true);
    const callsBeforeWait = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(calls.length, callsBeforeWait, "missing replacement capability causes no HTTP retry storm");

    fs.writeFileSync(capabilityPath, `${"C".repeat(43)}\n`, { mode: 0o600 });
    await waitFor(() => broker.messages.filter((message) => message.type === "runtime_ready" && message.supported === true).length === 2);
    await waitFor(() => calls.some((requestPath) => requestPath.startsWith("/api/agent-input/sources/source-restarted/deliveries?")));
    assert.equal(JSON.parse(fs.readFileSync(credentialPath, "utf8")).sourceId, "source-restarted");
    assert.ok(calls.includes("/api/agent-input/sources/challenge"));
    assert.ok(calls.includes("/api/agent-input/sources/register"));
    assert.equal(fs.existsSync(capabilityPath), false);
  } finally {
    await broker.stop(); server.close(); server.closeAllConnections(); await once(server, "close");
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
    await waitFor(() => broker.messages.some((message) => message.type === "runtime_ready" && message.supported === true));
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
    if (requestPath.endsWith("/challenge")) return send(201, serverChallenge());
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
    if (requestPath.endsWith("/challenge")) return send(201, serverChallenge());
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

test("broker runtime attestation rejects every predicate with stable sanitized diagnostics and drops pre-ready events", { skip: process.platform === "win32" }, async (t) => {
  const baseAttestation = (challenge: any) => ({
    ...createOpenCodeRuntimeAttestation(challenge.nonce, challenge.serverChallenge),
    challengeIssuedAt: challenge.issuedAt,
    challengeDeadline: challenge.deadline,
    observedAt: Date.now(),
    contractDigest: challenge.contractDigest,
  });
  const variants: Array<[string, string, (value: any, challenge: any) => any]> = [
    ["handshake schema", "handshake_schema_mismatch", (value) => ({ ...value, handshakeSchema: 1 })],
    ["nonce", "attestation_nonce_mismatch", (value) => ({ ...value, nonce: "W".repeat(43) })],
    ["freshness", "attestation_late", (value, challenge) => ({ ...value, observedAt: challenge.deadline + 1 })],
    ["digest", "contract_digest_mismatch", (value) => ({ ...value, contractDigest: "0".repeat(64) })],
    ["fingerprint", "fingerprint_mismatch", (value) => ({ ...value, compatibilityFingerprint: "wrong" })],
    ["event envelope", "event_envelope_mismatch", (value) => ({ ...value, eventEnvelope: "future" })],
    ["health source", "health_source_mismatch", (value) => ({ ...value,
      health: { ...value.health, source: "package-or-path-discovery" } })],
    ["global health method", "method_global_health_missing", (value) => ({ ...value,
      capabilities: { ...value.capabilities, globalHealth: false } })],
    ["question list method", "method_question_list_missing", (value) => ({ ...value,
      capabilities: { ...value.capabilities, questionList: false } })],
    ["question reply method", "method_question_reply_missing", (value) => ({ ...value,
      capabilities: { ...value.capabilities, questionReply: false } })],
    ["session get method", "method_session_get_missing", (value) => ({ ...value,
      capabilities: { ...value.capabilities, sessionGet: false } })],
    ["injected transport missing", "injected_transport_missing", (value) => ({ ...value, diagnostic: "injected_transport_missing",
      health: { ...value.health, called: false, outcome: "unavailable", status: 0, healthy: false, release: "" } })],
    ["injected transport invalid", "injected_transport_invalid", (value) => ({ ...value, diagnostic: "injected_transport_invalid",
      health: { ...value.health, called: false, outcome: "unavailable", status: 0, healthy: false, release: "" } })],
    ["health timeout", "health_timeout", (value) => ({ ...value, diagnostic: "health_timeout",
      health: { ...value.health, called: true, outcome: "timeout", status: 0, healthy: false, release: "" } })],
    ["health transport", "health_transport_error", (value) => ({ ...value, diagnostic: "health_transport_error",
      health: { ...value.health, called: true, outcome: "transport_error", status: 0, healthy: false, release: "" } })],
    ["health status", "health_status", (value) => ({ ...value, diagnostic: "health_status",
      health: { ...value.health, called: true, outcome: "status", status: 503, healthy: false, release: "" } })],
    ["health shape", "health_shape_invalid", (value) => ({ ...value, diagnostic: "health_shape_invalid",
      health: { ...value.health, called: true, outcome: "shape_invalid", status: 200, healthy: false, release: "" } })],
    ["release", "release_mismatch", (value) => ({ ...value, release: "", diagnostic: "health_release_mismatch",
      health: { ...value.health, called: true, outcome: "release_mismatch", status: 200, healthy: true, release: "1.18.8" } })],
  ];
  for (const [name, diagnostic, mutate] of variants) {
    await t.test(name, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attestation-predicate-"));
      const credentialPath = path.join(directory, "pane.json");
      writeCredential(credentialPath);
      const fixture = await startChallengeOnlyFixture();
      const broker = launchBroker(directory, fixture.base, "pane", credentialPath, undefined,
        (challenge) => mutate(baseAttestation(challenge), challenge));
      const sentinel = ["PRE", "READY", "QUESTION"].join("_");
      broker.sendRaw({ type: "asked", eventId: "pre-ready", eventSequence: 1, id: "request", sessionID: "session",
        questions: [{ ...question, question: sentinel }], nativePending: false });
      try {
        await broker.exit();
        const status = JSON.parse(fs.readFileSync(`${credentialPath}.status.json`, "utf8"));
        assert.deepEqual({ state: status.state, diagnostic: status.diagnostic }, { state: "failed", diagnostic });
        assert.doesNotMatch(fs.readFileSync(credentialPath, "utf8"), new RegExp(sentinel));
      } finally {
        await broker.stop(); await fixture.close(); fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("broker runtime challenge is one-shot and distinguishes replay, duplicate, and conflict", { skip: process.platform === "win32" }, async (t) => {
  const attestation = (challenge: any) => ({
    ...createOpenCodeRuntimeAttestation(challenge.nonce, challenge.serverChallenge),
    challengeIssuedAt: challenge.issuedAt,
    challengeDeadline: challenge.deadline,
    observedAt: Date.now(),
    contractDigest: challenge.contractDigest,
  });
  for (const [name, diagnostic, conflict] of [
    ["duplicate", "attestation_duplicate", false],
    ["conflict", "attestation_conflict", true],
  ] as const) {
    await t.test(name, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attestation-once-"));
      const credentialPath = path.join(directory, "pane.json");
      writeCredential(credentialPath);
      const server = http.createServer(async (request, response) => {
        for await (const _chunk of request) { /* drain */ }
        if (request.url?.endsWith("/challenge")) {
          response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify(serverChallenge()));
        }
      });
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
      let first: any;
      const broker = launchBroker(directory, `http://127.0.0.1:${address.port}`, "pane", credentialPath, undefined, (challenge) => {
        first = attestation(challenge);
        return first;
      });
      try {
        await waitFor(() => first !== undefined);
        const second = structuredClone(first);
        if (conflict) second.diagnostic = "health_error";
        broker.sendRaw(second);
        await broker.exit();
        const status = JSON.parse(fs.readFileSync(`${credentialPath}.status.json`, "utf8"));
        assert.equal(status.diagnostic, diagnostic);
      } finally {
        await broker.stop(); server.closeAllConnections(); server.close(); await once(server, "close");
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  await t.test("replay", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attestation-replay-"));
    const credentialPath = path.join(directory, "pane.json");
    writeCredential(credentialPath);
    const oldNonce = "R".repeat(43);
    const fixture = await startChallengeOnlyFixture();
    const broker = launchBroker(directory, fixture.base, "pane", credentialPath, undefined, (challenge) => ({
      ...attestation(challenge), nonce: oldNonce,
    }));
    try {
      await broker.exit();
      const status = JSON.parse(fs.readFileSync(`${credentialPath}.status.json`, "utf8"));
      assert.equal(status.diagnostic, "attestation_nonce_mismatch");
    } finally {
      await broker.stop(); await fixture.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function writeCredential(filePath: string): void {
  fs.writeFileSync(filePath, `${JSON.stringify({ schemaVersion: 10, sourceId: "source-one", relaySecret: "S".repeat(43),
    expiresAt: Date.now() + 60_000, supported: true, credentialGeneration: 1, cursor: 0,
    occurrenceEpoch: "epoch-one", relayEpoch: null, lastEventSequence: 0,
    streams: {}, receipts: [], outbox: [], quarantines: [] })}\n`, { mode: 0o600 });
}

function launchBroker(
  home: string,
  base: string,
  paneId: string,
  credentialPath: string,
  capabilityPath?: string,
  attest: (challenge: any) => any = (message) => ({
    ...createOpenCodeRuntimeAttestation(message.nonce, message.serverChallenge),
    challengeIssuedAt: message.issuedAt,
    challengeDeadline: message.deadline,
    observedAt: Date.now(),
    contractDigest: message.contractDigest,
  }),
) {
  const child = spawn(path.join(repoRoot, "scripts", "wmux-agent-input-broker"), ["serve"], {
    stdio: ["pipe", "pipe", "pipe"], env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", WMUX_URL: base,
      WMUX_PANE_ID: paneId, WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath,
      WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath ?? `${credentialPath}.cap`,
      WMUX_OPENCODE_QUESTION_CONTRACT_PATH: path.join(repoRoot, "scripts", "opencode-question-contract.json"),
    },
  });
  const messages: any[] = [];
  const sanitized: string[] = [];
  const stderr: string[] = [];
  let buffer = "";
  let ready = false;
  const pending: unknown[] = [];
  const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
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
      if (message.type === "runtime_challenge") {
        const response = attest(message);
        if (response) write(response);
      } else if (message.type === "runtime_ready" && message.supported === true) {
        ready = true;
        for (const queued of pending.splice(0)) write(queued);
      }
    }
  });
  const send = (message: any) => {
    if (message?.type === "legacy_runtime_ignored") return;
    if (ready) write(message);
    else pending.push(message);
  };
  const sendRaw = write;
  const exit = async () => { if (child.exitCode === null) await once(child, "exit"); };
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.stdin.end(); child.kill("SIGTERM"); await once(child, "exit").catch(() => undefined);
  };
  return { child, messages, sanitized, stderr, send, sendRaw, exit, stop };
}

async function startChallengeOnlyFixture() {
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    if (request.url?.endsWith("/challenge")) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify(serverChallenge()));
      return;
    }
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "runtime_attestation_invalid" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  return { base: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); server.close(); await once(server, "close");
  } };
}

async function startSimpleFixture(calls: Array<{ path: string; body: any }>) {
  const bindings = new Map<string, any>();
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const requestPath = request.url ?? ""; calls.push({ path: requestPath, body });
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (requestPath.endsWith("/challenge")) return send(201, serverChallenge());
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
