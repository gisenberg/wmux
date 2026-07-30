import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentInputCredentialStore,
  issueAgentInputRegistrationCapabilityForPane,
} from "../src/server/agent-input-credential-store.js";
import { AgentInputRelay } from "../src/server/agent-input-relay.js";
import { AgentInputRequestStore, capturePayloadDigest, nativeOccurrenceKey } from "../src/server/agent-input-request-store.js";
import type { AuthConfig } from "../src/server/auth.js";
import { createHttpServer } from "../src/server/http.js";
import {
  OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
  SUPPORTED_OPENCODE_SDK_VERSION,
} from "../src/server/opencode-question-contract.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const captureBodyFor = (occurrenceId: string, sessionID: string, id: string, questions: any[], ordinal = 1) => ({
  occurrenceId, occurrenceKey: nativeOccurrenceKey(sessionID, id), ordinal,
  payloadDigest: capturePayloadDigest({ openCodeSessionId: sessionID, openCodeRequestId: id, questions }),
  sessionID, id, questions,
});

test("real server routes enforce source/pane authority and deliver ephemeral answers with typed outcomes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-routes-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const credentials = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "server-key" });
  const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "answer-key" });
  const created = state.createWorkspace("local", undefined, "user", undefined, {
    workspaceId: "workspace-one", tabId: "tab-one", paneId: "pane-one",
  });
  state.flush();
  const relay = new AgentInputRelay(requests, credentials, {
    deliveryTimeoutMs: 2_000,
    isPaneLive: (source) => source.context.paneId === "pane-one",
  });
  const auth: AuthConfig = {
    enabled: true, token: "browser-user-token", loginEnabled: false,
    sessionSecret: "session-secret", browserAuthMode: "shared-or-login",
    helperToken: "H".repeat(43), automationToken: "A".repeat(43),
  };
  const server = await createHttpServer("127.0.0.1", state, machines, {} as SessionManager, settings, {
    auth, agentInputCredentials: credentials, agentInputRequests: requests, agentInputRelay: relay,
    healthResolvers: { machines: async () => [], streams: async () => [] },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const legacyPluginEvent = await fetch(`${base}/api/agent-events`, {
      method: "POST",
      headers: bearer(auth.helperToken!),
      body: JSON.stringify({
        workspaceId: created.id,
        tabId: created.tabs[0].id,
        paneId: created.tabs[0].panes[0].id,
        agent: "opencode",
        status: "running",
        title: "Legacy plugin lifecycle",
        summary: "Compatibility event without structured-question fields",
      }),
    });
    assert.equal(legacyPluginEvent.status, 201, "an old plugin remains compatible with the new server");

    const capability = issueAgentInputRegistrationCapabilityForPane(
      credentials,
      state,
      created.tabs[0].panes[0].id,
    );
    assert.throws(() => issueAgentInputRegistrationCapabilityForPane(credentials, state, "other-pane"), /pane_unavailable/);
    const register = await fetch(`${base}/api/agent-input/sources/register`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify({
        instanceNonce: "instance-one", kind: "opencode",
        pluginVersion: SUPPORTED_OPENCODE_SDK_VERSION, sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION,
        compatibilityFingerprint: OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
      }),
    });
    assert.equal(register.status, 201);
    assert.equal(register.headers.get("cache-control"), "no-store");
    const source = await register.json() as { sourceId: string; relaySecret: string };
    assert.ok(source.sourceId && source.relaySecret);
    const incompleteNativeSnapshot = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/native-list`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify({ pendingRequestIds: [] }),
    });
    assert.equal(incompleteNativeSnapshot.status, 400, "absence reconciliation requires an explicit complete snapshot");
    const lostRegistrationReplay = await fetch(`${base}/api/agent-input/sources/register`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify({
        instanceNonce: "instance-one", kind: "opencode",
        pluginVersion: SUPPORTED_OPENCODE_SDK_VERSION, sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION,
        compatibilityFingerprint: OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
      }),
    });
    assert.equal(lostRegistrationReplay.status, 401, "a used capability never reconstructs a lost plaintext response");
    assert.equal((await fetch(`${base}/api/agent-input/sources/register?token=${encodeURIComponent(capability.capability)}`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    })).status, 401);

    const captureQuestions = [
        { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: true },
        { header: "Checks", question: "Checks", options: [{ label: "Tests", description: "Tests" }], multiple: true, custom: false },
      ];
    const captureBody = captureBodyFor("occ-request-one", "session-one", "request-one", captureQuestions);
    const captured = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/requests`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify(captureBody),
    });
    assert.equal(captured.status, 201);
    const request = await captured.json() as { id: string; generation: number };
    const pendingDuplicate = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/requests`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify(captureBody),
    });
    assert.equal(pendingDuplicate.status, 200);
    assert.deepEqual((({ id, generation, state }) => ({ id, generation, state }))(await pendingDuplicate.json()), {
      id: request.id, generation: 1, state: "pending",
    });
    const captureConflict = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/requests`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify({
        ...captureBody,
        questions: [{ ...captureBody.questions[0], question: "Conflicting operation payload" }],
      }),
    });
    assert.equal(captureConflict.status, 409);
    assert.equal((await fetch(`${base}/api/agent-input/sources/${source.sourceId}/deliveries?token=${encodeURIComponent(source.relaySecret)}`)).status, 401);
    assert.equal((await fetch(`${base}/api/agent-input/sources/${source.sourceId}/deliveries`, { headers: bearer(auth.token) })).status, 403);
    assert.equal((await fetch(`${base}/api/agent-input/requests/${request.id}/answer`, {
      method: "POST", headers: bearer(source.relaySecret), body: "{}",
    })).status, 401);
    assert.equal((await fetch(`${base}/api/agent-input/requests/${request.id}/answer`, {
      method: "POST", headers: bearer(auth.helperToken!), body: "{}",
    })).status, 403);
    assert.equal((await fetch(`${base}/api/agent-input/requests/${request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: JSON.stringify({
        expectedGeneration: request.generation, idempotencyKey: "invalid", answers: [],
      }),
    })).status, 422);

    const answerPromise = fetch(`${base}/api/agent-input/requests/${request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: JSON.stringify({
        expectedGeneration: request.generation, idempotencyKey: "submission-one",
        answers: [["Safe"], ["Tests"]],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const polled = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/deliveries?epoch=unbound&after=0&limit=1&waitMs=100`, {
      headers: bearer(source.relaySecret),
    });
    assert.equal(polled.status, 200);
    assert.equal(polled.headers.get("cache-control"), "no-store");
    const deliveryPayload = await polled.json() as { epoch: string; deliveries: Array<{ deliveryId: string; requestId: string; expectedGeneration: number; answers: string[][] }> };
    assert.ok(deliveryPayload.epoch);
    assert.equal(deliveryPayload.deliveries.length, 1);
    assert.deepEqual(deliveryPayload.deliveries[0].answers, [["Safe"], ["Tests"]]);
    const ack = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/deliveries/${deliveryPayload.deliveries[0].deliveryId}/ack`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify({
        id: request.id, generation: request.generation, outcome: "applied",
      }),
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { outcome: "delivered" });
    const answer = await answerPromise;
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("cache-control"), "no-store");
    assert.deepEqual(await answer.json(), { outcome: "delivered" });
    const terminalCaptureRetry = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/requests`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify(captureBody),
    });
    assert.equal(terminalCaptureRetry.status, 200);
    assert.deepEqual((({ id, generation, state }) => ({ id, generation, state }))(await terminalCaptureRetry.json()), {
      id: request.id, generation: 1, state: "answered",
    });
    const reusedCapture = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/requests`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify({
        ...captureBodyFor("occ-request-one-reused", "session-one", "request-one", captureQuestions, 2),
      }),
    });
    assert.equal(reusedCapture.status, 201);
    assert.deepEqual((({ generation, state }) => ({ generation, state }))(await reusedCapture.json()), {
      generation: 2, state: "pending",
    });
    const duplicate = await fetch(`${base}/api/agent-input/requests/${request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: JSON.stringify({
        expectedGeneration: request.generation, idempotencyKey: "submission-one",
        answers: [["Safe"], ["Tests"]],
      }),
    });
    assert.equal(duplicate.status, 200);
    const conflicting = await fetch(`${base}/api/agent-input/requests/${request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: JSON.stringify({
        expectedGeneration: request.generation, idempotencyKey: "submission-one",
        answers: [["different"], ["Tests"]],
      }),
    });
    assert.equal(conflicting.status, 409);

    const secondCapability = credentials.issueRegistrationCapability({
      workspaceId: created.id, tabId: created.tabs[0].id, paneId: created.tabs[0].panes[0].id,
      machineId: "local", sourceKind: "opencode",
    });
    const secondPrincipal = credentials.authenticate(secondCapability.capability);
    assert.equal(secondPrincipal?.kind, "agent-input-registration");
    if (secondPrincipal?.kind === "agent-input-registration") {
      const second = credentials.exchange(secondPrincipal, { instanceNonce: "second", kind: "opencode",
        pluginVersion: SUPPORTED_OPENCODE_SDK_VERSION, sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION,
        compatibilityFingerprint: OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT });
      if (second.outcome === "issued") {
        assert.equal((await fetch(`${base}/api/agent-input/sources/${source.sourceId}/deliveries`, { headers: bearer(second.relaySecret) })).status, 401);
      }
    }
    const closeCapture = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/requests`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify({
        ...captureBodyFor("occ-request-close", "session-one", "request-close", captureQuestions),
      }),
    });
    assert.equal(closeCapture.status, 201);
    const closeRequest = await closeCapture.json() as { id: string };
    state.removeWorkspace(created.id);
    assert.equal(requests.find(closeRequest.id)?.state, "closed");
    assert.equal(requests.find(closeRequest.id)?.resolution, "pane-closed");
    assert.equal((await fetch(`${base}/api/agent-input/sources/${source.sourceId}/deliveries`, {
      headers: bearer(source.relaySecret),
    })).status, 401);
  } finally {
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("agent-input routes enforce body, poll, concurrency, cancellation, status, and cache boundaries", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-route-limits-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const credentials = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "server-key" });
  const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "answer-key" });
  const context = state.findPaneContext(state.snapshot().workspaces[0].tabs[0].panes[0].id)!;
  const capability = credentials.issueRegistrationCapability({
    workspaceId: context.workspace.id, tabId: context.tab.id, paneId: context.pane.id,
    machineId: context.pane.machineId, sourceKind: "opencode",
  });
  const registration = credentials.authenticate(capability.capability);
  if (registration?.kind !== "agent-input-registration") throw new Error("registration unavailable");
  const exchange = credentials.exchange(registration, {
    instanceNonce: "limits", kind: "opencode", pluginVersion: SUPPORTED_OPENCODE_SDK_VERSION,
    sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION, compatibilityFingerprint: OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
  });
  if (exchange.outcome !== "issued") throw new Error("source unavailable");
  const principal = credentials.authenticate(exchange.relaySecret);
  if (principal?.kind !== "agent-input-source") throw new Error("source principal unavailable");
  const relay = new AgentInputRelay(requests, credentials, { deliveryTimeoutMs: 2_000, isPaneLive: () => true });
  const auth: AuthConfig = {
    enabled: true, token: "browser-user-token", loginEnabled: false,
    sessionSecret: "session-secret", browserAuthMode: "shared-or-login",
    helperToken: "H".repeat(43), automationToken: "A".repeat(43),
  };
  let paneInputCalls = 0;
  let paneInputBytes = 0;
  const sessions = {
    writePane: (_paneId: string, data: string) => {
      paneInputCalls += 1;
      paneInputBytes += Buffer.byteLength(data);
      return true;
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
  const sourcePath = `/api/agent-input/sources/${exchange.sourceId}`;
  const capture = (openCodeRequestId: string) => {
    const questions = [{ header: "Mode", question: "Choose", options: [{ label: "Safe", description: "" }], multiple: false, custom: false }];
    const wire = captureBodyFor(`occ-${openCodeRequestId}`, "session", openCodeRequestId, questions);
    return requests.capture({
    occurrenceId: wire.occurrenceId, occurrenceKey: wire.occurrenceKey, occurrenceOrdinal: wire.ordinal, payloadDigest: wire.payloadDigest,
    sourceId: exchange.sourceId, workspaceId: context.workspace.id, tabId: context.tab.id, paneId: context.pane.id,
    machineId: context.pane.machineId, openCodeSessionId: "session", openCodeRequestId,
    questions,
  }); };
  const noStore = (response: Response) => assert.equal(response.headers.get("cache-control"), "no-store");
  try {
    const unauthorized = await fetch(`${base}${sourcePath}/deliveries`);
    assert.equal(unauthorized.status, 401);
    noStore(unauthorized);

    const oldBrokerPoll = await fetch(`${base}${sourcePath}/deliveries?after=0&limit=1&waitMs=0`, {
      headers: bearer(exchange.relaySecret),
    });
    assert.equal(oldBrokerPoll.status, 400, "polling without an explicit relay epoch fails safely");
    noStore(oldBrokerPoll);

    const invalidPoll = await fetch(`${base}${sourcePath}/deliveries?limit=17`, { headers: bearer(exchange.relaySecret) });
    assert.equal(invalidPoll.status, 400);
    noStore(invalidPoll);

    const malformed = await fetch(`${base}${sourcePath}/requests`, {
      method: "POST", headers: bearer(exchange.relaySecret), body: "{",
    });
    assert.equal(malformed.status, 400);
    noStore(malformed);

    const oversized = await fetch(`${base}${sourcePath}/requests`, {
      method: "POST", headers: bearer(exchange.relaySecret), body: "x".repeat(128 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    noStore(oversized);

    const unsupportedCapability = credentials.issueRegistrationCapability({
      workspaceId: context.workspace.id, tabId: context.tab.id, paneId: context.pane.id,
      machineId: context.pane.machineId, sourceKind: "opencode",
    });
    const unsupportedRegistration = credentials.authenticate(unsupportedCapability.capability);
    if (unsupportedRegistration?.kind !== "agent-input-registration") throw new Error("unsupported registration unavailable");
    const unsupported = credentials.exchange(unsupportedRegistration, {
      instanceNonce: "future", kind: "opencode", pluginVersion: "future", sdkVersion: "future",
      compatibilityFingerprint: "future",
    });
    if (unsupported.outcome !== "issued") throw new Error("unsupported source unavailable");
    const unsupportedCapture = await fetch(`${base}/api/agent-input/sources/${unsupported.sourceId}/requests`, {
      method: "POST", headers: bearer(unsupported.relaySecret), body: JSON.stringify(captureBodyFor(
        "occ-future", "session", "future", [{
          header: "H", question: "Q", options: [], multiple: false, custom: true,
        }],
      )),
    });
    assert.equal(unsupportedCapture.status, 409);
    noStore(unsupportedCapture);

    const concurrent = capture("concurrent");
    if (concurrent.outcome !== "created") throw new Error("concurrent request unavailable");
    const concurrentBody = JSON.stringify({ expectedGeneration: 1, idempotencyKey: "same-key", answers: [["Safe"]] });
    const concurrentAnswers = [1, 2].map(() => fetch(`${base}/api/agent-input/requests/${concurrent.request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: concurrentBody,
    }));
    await waitUntil(() => fs.readFileSync(requests.filePath, "utf8").includes("same-key"));
    const delivery = (await relay.poll(principal, 0, 1, 0)).deliveries[0];
    assert.ok(delivery);
    relay.startDelivery(principal, delivery.deliveryId, delivery.requestId, delivery.expectedGeneration);
    relay.acknowledge(principal, delivery.deliveryId, {
      requestId: delivery.requestId, generation: delivery.expectedGeneration, outcome: "applied",
    });
    const concurrentResponses = await Promise.all(concurrentAnswers);
    assert.deepEqual(concurrentResponses.map((response) => response.status), [200, 200]);
    concurrentResponses.forEach(noStore);

    const cancelled = capture("cancelled-before-poll");
    if (cancelled.outcome !== "created") throw new Error("cancel request unavailable");
    const cancellation = new AbortController();
    const cancelledFetch = fetch(`${base}/api/agent-input/requests/${cancelled.request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), signal: cancellation.signal,
      body: JSON.stringify({ expectedGeneration: 1, idempotencyKey: "cancel-key", answers: [["Safe"]] }),
    }).catch((error) => error);
    await waitUntil(() => fs.readFileSync(requests.filePath, "utf8").includes("cancel-key"));
    cancellation.abort();
    await cancelledFetch;
    await waitUntil(() => !JSON.parse(fs.readFileSync(requests.filePath, "utf8")).submissions
      .some((submission: any) => submission.requestId === cancelled.request.id && submission.deliveryId));
    const retry = fetch(`${base}/api/agent-input/requests/${cancelled.request.id}/answer`, {
      method: "POST", headers: bearer(auth.token),
      body: JSON.stringify({ expectedGeneration: 1, idempotencyKey: "cancel-key", answers: [["Safe"]] }),
    });
    await waitUntil(() => JSON.parse(fs.readFileSync(requests.filePath, "utf8")).submissions
      .some((submission: any) => submission.requestId === cancelled.request.id && submission.deliveryId));
    const retriedDelivery = (await relay.poll(principal, delivery.cursor, 1, 0)).deliveries[0];
    relay.acknowledge(principal, retriedDelivery.deliveryId, {
      requestId: retriedDelivery.requestId, generation: retriedDelivery.expectedGeneration,
      outcome: "sdk_error", code: "transport_error", retryable: true,
    });
    const retryResponse = await retry;
    assert.equal(retryResponse.status, 502);
    noStore(retryResponse);

    const rotationBody = Buffer.from(JSON.stringify(captureBodyFor(
      "occ-rotated-during-body", "session", "rotated-during-body", [{
        header: "H", question: "Q", options: [], multiple: false, custom: true,
      }],
    )));
    const rotatedResponse = new Promise<number>((resolve, reject) => {
      const request = http.request(`${base}${sourcePath}/requests`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${exchange.relaySecret}`,
          "content-type": "application/json",
          "content-length": String(rotationBody.length),
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      const split = Math.floor(rotationBody.length / 2);
      request.write(rotationBody.subarray(0, split));
      setImmediate(() => {
        credentials.refresh(principal);
        request.end(rotationBody.subarray(split));
      });
    });
    assert.equal(await rotatedResponse, 401);
    assert.equal(requests.snapshot().some((candidate) => candidate.openCodeRequestId === "rotated-during-body"), false);

    assert.equal(paneInputCalls, 0, "answer routes must never invoke pane input");
    assert.equal(paneInputBytes, 0, "answer routes must transport zero terminal bytes");
  } finally {
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for route state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
