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
  createOpenCodeRuntimeAttestation,
} from "../src/server/opencode-question-contract.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const registrationBody = (nonce: string, challenge: Parameters<typeof createOpenCodeRuntimeAttestation>[1]) => ({
  instanceNonce: nonce,
  kind: "opencode" as const,
  runtimeAttestation: createOpenCodeRuntimeAttestation(nonce, challenge),
});
const challengeFrom = (value: any): Parameters<typeof createOpenCodeRuntimeAttestation>[1] => ({
  id: value.id,
  nonce: value.nonce,
  issuedAt: value.issuedAt,
  deadline: value.deadline,
});
const captureBodyFor = (occurrenceId: string, sessionID: string, id: string, questions: any[], ordinal = 1) => ({
  occurrenceId, occurrenceKey: nativeOccurrenceKey(sessionID, id), ordinal,
  payloadDigest: capturePayloadDigest({ openCodeSessionId: sessionID, openCodeRequestId: id, questions }),
  sessionID, id, questions,
});
const liveBinding = {
  backendId: "durable-multiplexer" as const,
  sessionIncarnation: "1".repeat(64),
  endpointFingerprint: "2".repeat(64),
};
const liveSessions = (live = () => true) => ({
  hasLivePaneSession: (_paneId: string, binding: typeof liveBinding) =>
    live() && JSON.stringify(binding) === JSON.stringify(liveBinding),
  agentInputSessionBinding: () => liveBinding,
  setAgentInputCapabilityIssuer: () => undefined,
  setAgentInputSourceRetirer: () => undefined,
}) as unknown as SessionManager;

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
  state.updatePane(created.tabs[0].panes[0].id, { status: "running" });
  const relay = new AgentInputRelay(requests, credentials, {
    deliveryTimeoutMs: 2_000,
    isPaneLive: (source) => source.context.paneId === "pane-one",
  });
  const auth: AuthConfig = {
    enabled: true, token: "browser-user-token", loginEnabled: false,
    sessionSecret: "session-secret", browserAuthMode: "shared-or-login",
    helperToken: "H".repeat(43), automationToken: "A".repeat(43),
  };
  const sessions = liveSessions();
  const server = await createHttpServer("127.0.0.1", state, machines, sessions, settings, {
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
      liveBinding,
    );
    assert.throws(() => issueAgentInputRegistrationCapabilityForPane(credentials, state, "other-pane"), /pane_unavailable/);
    assert.equal((await fetch(`${base}/api/agent-input/sources/challenge`, {
      method: "POST", headers: bearer(auth.token), body: JSON.stringify({ kind: "opencode" }),
    })).status, 403, "broad browser authority cannot mint a runtime challenge");
    assert.equal((await fetch(`${base}/api/agent-input/sources/challenge`, {
      method: "POST", headers: bearer(capability.capability), body: "x".repeat(1_025),
    })).status, 413, "challenge requests have an independent small body bound");
    const lostChallengeResponse = await fetch(`${base}/api/agent-input/sources/challenge`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify({ kind: "opencode" }),
    });
    assert.equal(lostChallengeResponse.status, 201);
    const lostChallenge = challengeFrom(await lostChallengeResponse.json());
    const challenged = await fetch(`${base}/api/agent-input/sources/challenge`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify({ kind: "opencode" }),
    });
    assert.equal(challenged.status, 201);
    assert.equal(challenged.headers.get("cache-control"), "no-store");
    const serverChallenge = challengeFrom(await challenged.json());
    assert.notEqual(serverChallenge.id, lostChallenge.id, "a response-loss retry renews rather than reuses plaintext");
    const staleChallenge = await fetch(`${base}/api/agent-input/sources/register`, {
      method: "POST", headers: bearer(capability.capability),
      body: JSON.stringify(registrationBody("O".repeat(43), lostChallenge)),
    });
    assert.equal(staleChallenge.status, 409, "renewal makes the unobserved predecessor unusable");
    assert.equal((await staleChallenge.json() as { error: string }).error, "runtime_attestation_invalid");
    const invalidNonce = "I".repeat(43);
    const invalidAttestation = await fetch(`${base}/api/agent-input/sources/register`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify({
        ...registrationBody(invalidNonce, serverChallenge),
        runtimeAttestation: { ...createOpenCodeRuntimeAttestation(invalidNonce, serverChallenge), release: "1.18.8" },
      }),
    });
    assert.equal(invalidAttestation.status, 409, "the server independently rejects a non-exact runtime attestation");
    assert.equal(credentials.authenticate(capability.capability)?.kind, "agent-input-registration",
      "invalid attestation does not consume the one-shot capability");
    const relaySecretSeed = "Q".repeat(43);
    const registrationRequest = { ...registrationBody("N".repeat(43), serverChallenge), relaySecretSeed };
    const register = await fetch(`${base}/api/agent-input/sources/register`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify(registrationRequest),
    });
    assert.equal(register.status, 201);
    assert.equal(register.headers.get("cache-control"), "no-store");
    const source = await register.json() as { sourceId: string; relaySecret: string };
    assert.ok(source.sourceId && source.relaySecret);
    assert.equal(source.relaySecret.endsWith(`.${relaySecretSeed}`), true);
    const lostRegistrationReplay = await fetch(`${base}/api/agent-input/sources/register`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify(registrationRequest),
    });
    assert.equal(lostRegistrationReplay.status, 200, "an exact response-loss retry converges without replaying plaintext");
    const replayResult = await lostRegistrationReplay.json() as Record<string, unknown>;
    assert.equal(replayResult.outcome, "already_exchanged");
    assert.equal(replayResult.sourceId, source.sourceId);
    assert.equal(typeof replayResult.expiresAt, "number");
    assert.equal(replayResult.supported, true);
    assert.equal(replayResult.credentialGeneration, 1);
    assert.equal("relaySecret" in replayResult, false);
    const sourceChallengeResponse = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/challenge`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify({ kind: "opencode" }),
    });
    assert.equal(sourceChallengeResponse.status, 201);
    const sourceChallenge = challengeFrom(await sourceChallengeResponse.json());
    const priorRelaySecret = source.relaySecret;
    const refreshedResponse = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/refresh`, {
      method: "POST", headers: bearer(priorRelaySecret),
      body: JSON.stringify(registrationBody("R".repeat(43), sourceChallenge)),
    });
    assert.equal(refreshedResponse.status, 200);
    source.relaySecret = (await refreshedResponse.json() as { relaySecret: string }).relaySecret;
    assert.equal(credentials.authenticate(priorRelaySecret), undefined);
    const storedAttestation = credentials.source(source.sourceId)?.runtimeAttestation as Record<string, unknown>;
    assert.equal("nonce" in storedAttestation, false);
    assert.equal("serverChallenge" in storedAttestation, false);
    assert.doesNotMatch(fs.readFileSync(credentials.filePath, "utf8"), new RegExp(sourceChallenge.nonce));
    const incompleteNativeSnapshot = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/native-list`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify({ pendingRequestIds: [] }),
    });
    assert.equal(incompleteNativeSnapshot.status, 400, "absence reconciliation requires an explicit complete snapshot");
    const rotatedRegistrationReplay = await fetch(`${base}/api/agent-input/sources/register`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify(registrationRequest),
    });
    assert.equal(rotatedRegistrationReplay.status, 401,
      "a capability cannot reconstruct a source credential after relay rotation");
    const conflictingRegistrationReplay = await fetch(`${base}/api/agent-input/sources/register`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify(registrationBody("D".repeat(43), serverChallenge)),
    });
    assert.equal(conflictingRegistrationReplay.status, 401, "a used capability cannot bind a different source nonce");
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

    const pollPromise = fetch(`${base}/api/agent-input/sources/${source.sourceId}/deliveries?epoch=unbound&after=0&limit=1&waitMs=1000`, {
      headers: bearer(source.relaySecret),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answerPromise = fetch(`${base}/api/agent-input/requests/${request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: JSON.stringify({
        expectedGeneration: request.generation, idempotencyKey: "submission-one",
        answers: [["Safe"], ["Tests"]],
      }),
    });
    const polled = await pollPromise;
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

    const maximumOptions = Array.from({ length: 128 }, (_, index) => ({
      label: `option-${index}`, description: "",
    }));
    const maximumValues = [...maximumOptions.map((option) => option.label), "custom"];
    const maximumCapture = await fetch(`${base}/api/agent-input/sources/${source.sourceId}/requests`, {
      method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify(captureBodyFor(
        "occ-request-maximum", "session-one", "request-maximum",
        [{ header: "Maximum", question: "Choose", options: maximumOptions, multiple: true, custom: true }],
      )),
    });
    assert.equal(maximumCapture.status, 201);
    const maximumRequest = await maximumCapture.json() as { id: string; generation: number };
    assert.equal((await fetch(`${base}/api/agent-input/requests/${maximumRequest.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: JSON.stringify({
        expectedGeneration: maximumRequest.generation,
        idempotencyKey: "submission-oversized-utf8",
        answers: [["🙂".repeat(1_025)]],
      }),
    })).status, 422, "route validation applies the per-value UTF-8 byte bound");
    const maximumPollPromise = fetch(
      `${base}/api/agent-input/sources/${source.sourceId}/deliveries?epoch=unbound&after=0&limit=1&waitMs=1000`,
      { headers: bearer(source.relaySecret) },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const maximumAnswerPromise = fetch(`${base}/api/agent-input/requests/${maximumRequest.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: JSON.stringify({
        expectedGeneration: maximumRequest.generation,
        idempotencyKey: "submission-maximum",
        answers: [maximumValues],
      }),
    });
    const maximumDeliveryResponse = await maximumPollPromise;
    assert.equal(maximumDeliveryResponse.status, 200);
    const maximumDelivery = await maximumDeliveryResponse.json() as {
      deliveries: Array<{ deliveryId: string; requestId: string; expectedGeneration: number; answers: string[][] }>;
    };
    assert.deepEqual(maximumDelivery.deliveries[0].answers, [maximumValues]);
    assert.equal((await fetch(
      `${base}/api/agent-input/sources/${source.sourceId}/deliveries/${maximumDelivery.deliveries[0].deliveryId}/ack`,
      {
        method: "POST", headers: bearer(source.relaySecret), body: JSON.stringify({
          id: maximumRequest.id, generation: maximumRequest.generation, outcome: "applied",
        }),
      },
    )).status, 200);
    assert.equal((await maximumAnswerPromise).status, 200,
      "128 selected options plus one custom answer remain a valid bounded submission");

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

    const secondWorkspace = state.createWorkspace("local", undefined, "user", undefined, {
      workspaceId: "workspace-two", tabId: "tab-two", paneId: "pane-two",
    });
    state.updatePane(secondWorkspace.tabs[0].panes[0].id, { status: "running" });
    const secondCapability = credentials.issueRegistrationCapability({
      workspaceId: secondWorkspace.id, tabId: secondWorkspace.tabs[0].id,
      paneId: secondWorkspace.tabs[0].panes[0].id,
      machineId: "local", sourceKind: "opencode",
      ...liveBinding,
    });
    const secondPrincipal = credentials.authenticate(secondCapability.capability);
    assert.equal(secondPrincipal?.kind, "agent-input-registration");
    if (secondPrincipal?.kind === "agent-input-registration") {
      const secondChallenge = credentials.issueRuntimeChallenge(secondPrincipal);
      const second = credentials.exchange(secondPrincipal, registrationBody("S".repeat(43), secondChallenge));
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

test("source and registration authority retire on abnormal exit, backend replacement, host retarget, and incarnation change", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-live-authority-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local", sessionBackend: "tmux" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const credentials = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "server-key" });
  const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "answer-key" });
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  const context = state.findPaneContext(pane.id)!;
  state.updatePane(pane.id, { status: "running" });
  let currentBinding = liveBinding;
  let live = true;
  let retire: ((paneId: string, binding: typeof liveBinding) => void) | undefined;
  const sessions = {
    hasLivePaneSession: (_paneId: string, binding: typeof liveBinding) =>
      live && JSON.stringify(binding) === JSON.stringify(currentBinding),
    agentInputSessionBinding: () => currentBinding,
    setAgentInputCapabilityIssuer: () => undefined,
    setAgentInputSourceRetirer: (value: typeof retire) => { retire = value; },
  } as unknown as SessionManager;
  const auth: AuthConfig = {
    enabled: true, token: "browser-user-token", loginEnabled: false,
    sessionSecret: "session-secret", browserAuthMode: "shared-or-login",
  };
  const server = await createHttpServer("127.0.0.1", state, machines, sessions, settings, {
    auth, agentInputCredentials: credentials, agentInputRequests: requests,
    healthResolvers: { machines: async () => [], streams: async () => [] },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server unavailable");
  const base = `http://127.0.0.1:${address.port}`;
  const issueSource = (binding: typeof liveBinding, nonce: string) => {
    const capability = credentials.issueRegistrationCapability({
      workspaceId: context.workspace.id, tabId: context.tab.id, paneId: pane.id,
      machineId: pane.machineId, sourceKind: "opencode", ...binding,
    });
    const registration = credentials.authenticate(capability.capability);
    if (registration?.kind !== "agent-input-registration") throw new Error("registration unavailable");
    const challenge = credentials.issueRuntimeChallenge(registration);
    const exchange = credentials.exchange(registration, registrationBody(nonce, challenge));
    if (exchange.outcome !== "issued") throw new Error("source unavailable");
    return exchange;
  };
  const questions = [{ header: "Mode", question: "Choose", options: [], multiple: false, custom: true }];
  const capture = (sourceId: string, id: string) => requests.capture({
    sourceId, workspaceId: context.workspace.id, tabId: context.tab.id, paneId: pane.id,
    machineId: pane.machineId, openCodeSessionId: "session", openCodeRequestId: id,
    occurrenceId: `occ-${id}`, occurrenceKey: nativeOccurrenceKey("session", id), occurrenceOrdinal: 1,
    payloadDigest: capturePayloadDigest({ openCodeSessionId: "session", openCodeRequestId: id, questions }),
    questions,
  });
  const staleCaptureStatus = async (source: { sourceId: string; relaySecret: string }, id: string) =>
    (await fetch(`${base}/api/agent-input/sources/${source.sourceId}/requests`, {
      method: "POST", headers: bearer(source.relaySecret),
      body: JSON.stringify(captureBodyFor(`occ-${id}`, "session", id, questions)),
    })).status;
  try {
    const delayedCapability = credentials.issueRegistrationCapability({
      workspaceId: context.workspace.id, tabId: context.tab.id, paneId: pane.id,
      machineId: pane.machineId, sourceKind: "opencode", ...liveBinding,
    });
    const delayedPrincipal = credentials.authenticate(delayedCapability.capability);
    if (delayedPrincipal?.kind !== "agent-input-registration") throw new Error("registration unavailable");
    const delayedChallenge = credentials.issueRuntimeChallenge(delayedPrincipal);
    const delayedBody = JSON.stringify(registrationBody("T".repeat(43), delayedChallenge));
    const delayedStatus = await new Promise<number>((resolve, reject) => {
      const target = new URL("/api/agent-input/sources/register", base);
      const request = http.request(target, {
        method: "POST",
        headers: {
          ...bearer(delayedCapability.capability),
          "content-length": Buffer.byteLength(delayedBody),
        },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      const midpoint = Math.floor(delayedBody.length / 2);
      request.write(delayedBody.slice(0, midpoint));
      setTimeout(() => {
        live = false;
        request.end(delayedBody.slice(midpoint));
      }, 25);
    });
    assert.equal(delayedStatus, 409, "registration rechecks live authority after reading its body");
    live = true;

    const abnormal = issueSource(liveBinding, "A".repeat(43));
    const abnormalRequest = capture(abnormal.sourceId, "abnormal");
    if (abnormalRequest.outcome !== "created") throw new Error("request unavailable");
    live = false;
    retire?.(pane.id, liveBinding);
    assert.equal(credentials.authenticate(abnormal.relaySecret), undefined);
    assert.equal(requests.find(abnormalRequest.request.id)?.state, "cancelled");
    assert.equal(requests.find(abnormalRequest.request.id)?.resolution, "source-revoked");
    assert.equal((await fetch(`${base}/api/agent-input/sources/${abnormal.sourceId}/deliveries?epoch=x&after=0&limit=1&waitMs=0`, {
      headers: bearer(abnormal.relaySecret),
    })).status, 401);

    live = true;
    currentBinding = liveBinding;
    const backendSource = issueSource(liveBinding, "B".repeat(43));
    const staleCapability = credentials.issueRegistrationCapability({
      workspaceId: context.workspace.id, tabId: context.tab.id, paneId: pane.id,
      machineId: pane.machineId, sourceKind: "opencode", ...liveBinding,
    });
    currentBinding = { ...liveBinding, backendId: "raw-pty", sessionIncarnation: "3".repeat(64) };
    assert.equal(await staleCaptureStatus(backendSource, "backend-replaced"), 401);
    assert.equal((await fetch(`${base}/api/agent-input/sources/challenge`, {
      method: "POST", headers: bearer(staleCapability.capability), body: JSON.stringify({ kind: "opencode" }),
    })).status, 409, "a pre-replacement constructor capability cannot register against the new backend");
    state.updatePane(pane.id, { title: "backend replacement" });
    assert.equal(credentials.authenticate(backendSource.relaySecret), undefined);

    currentBinding = liveBinding;
    const retargeted = issueSource(liveBinding, "C".repeat(43));
    currentBinding = { ...liveBinding, endpointFingerprint: "4".repeat(64), sessionIncarnation: "5".repeat(64) };
    assert.equal(await staleCaptureStatus(retargeted, "host-retarget"), 401);
    state.updatePane(pane.id, { title: "host retarget" });
    assert.equal(credentials.authenticate(retargeted.relaySecret), undefined);

    currentBinding = liveBinding;
    const reincarnated = issueSource(liveBinding, "D".repeat(43));
    currentBinding = { ...liveBinding, sessionIncarnation: "6".repeat(64) };
    assert.equal(await staleCaptureStatus(reincarnated, "new-incarnation"), 401);
    assert.equal((await fetch(`${base}/api/agent-input/sources/${reincarnated.sourceId}/deliveries?epoch=x&after=0&limit=1&waitMs=0`, {
      headers: bearer(reincarnated.relaySecret),
    })).status, 401, "raw-answer polling is denied across session incarnations");
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
  state.updatePane(context.pane.id, { status: "running" });
  const capability = credentials.issueRegistrationCapability({
    workspaceId: context.workspace.id, tabId: context.tab.id, paneId: context.pane.id,
    machineId: context.pane.machineId, sourceKind: "opencode",
    ...liveBinding,
  });
  const registration = credentials.authenticate(capability.capability);
  if (registration?.kind !== "agent-input-registration") throw new Error("registration unavailable");
  const registrationChallenge = credentials.issueRuntimeChallenge(registration);
  const exchange = credentials.exchange(registration, registrationBody("L".repeat(43), registrationChallenge));
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
    hasLivePaneSession: (_paneId: string, binding: typeof liveBinding) =>
      JSON.stringify(binding) === JSON.stringify(liveBinding),
    agentInputSessionBinding: () => liveBinding,
    setAgentInputCapabilityIssuer: () => undefined,
    setAgentInputSourceRetirer: () => undefined,
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

    const expandedSnapshotEnvelope = await fetch(`${base}${sourcePath}/native-list`, {
      method: "POST", headers: bearer(exchange.relaySecret),
      body: JSON.stringify({ complete: true, cutSequence: 0, members: [], padding: "x".repeat(180 * 1024) }),
    });
    assert.equal(expandedSnapshotEnvelope.status, 400,
      "native-list reads the bounded broker metadata expansion above the 128-KiB control-message cap");
    const oversizedSnapshotEnvelope = await fetch(`${base}${sourcePath}/native-list`, {
      method: "POST", headers: bearer(exchange.relaySecret), body: "x".repeat(256 * 1024 + 1),
    });
    assert.equal(oversizedSnapshotEnvelope.status, 413);

    const unsupportedCapability = credentials.issueRegistrationCapability({
      workspaceId: context.workspace.id, tabId: context.tab.id, paneId: context.pane.id,
      machineId: context.pane.machineId, sourceKind: "opencode",
      ...liveBinding,
    });
    const unsupportedRegistration = credentials.authenticate(unsupportedCapability.capability);
    if (unsupportedRegistration?.kind !== "agent-input-registration") throw new Error("unsupported registration unavailable");
    const futureNonce = "F".repeat(43);
    const futureChallenge = credentials.issueRuntimeChallenge(unsupportedRegistration);
    assert.throws(() => credentials.exchange(unsupportedRegistration, {
      ...registrationBody(futureNonce, futureChallenge),
      runtimeAttestation: { ...createOpenCodeRuntimeAttestation(futureNonce, futureChallenge), release: "future" },
    }), /runtime_attestation_invalid/);

    const concurrent = capture("concurrent");
    if (concurrent.outcome !== "created") throw new Error("concurrent request unavailable");
    const concurrentBody = JSON.stringify({ expectedGeneration: 1, idempotencyKey: "same-key", answers: [["Safe"]] });
    const concurrentPoll = relay.poll(principal, 0, 1, 1_000);
    const concurrentAnswers = [1, 2].map(() => fetch(`${base}/api/agent-input/requests/${concurrent.request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: concurrentBody,
    }));
    await waitUntil(() => fs.readFileSync(requests.filePath, "utf8").includes("same-key"));
    const delivery = (await concurrentPoll).deliveries[0];
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

    const badRequest = capture("bad-request");
    if (badRequest.outcome !== "created") throw new Error("bad request fixture unavailable");
    const badPoll = relay.poll(principal, retriedDelivery.cursor, 1, 1_000);
    const badBody = JSON.stringify({ expectedGeneration: 1, idempotencyKey: "bad-key", answers: [["Safe"]] });
    const badAnswer = fetch(`${base}/api/agent-input/requests/${badRequest.request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: badBody,
    });
    const badDelivery = (await badPoll).deliveries[0];
    relay.startDelivery(principal, badDelivery.deliveryId, badDelivery.requestId, badDelivery.expectedGeneration);
    relay.acknowledge(principal, badDelivery.deliveryId, {
      requestId: badDelivery.requestId, generation: badDelivery.expectedGeneration,
      outcome: "sdk_error", code: "BadRequest", retryable: false,
    });
    const badResponse = await badAnswer;
    assert.equal(badResponse.status, 502);
    assert.deepEqual(await badResponse.json(), { outcome: "sdk_error", code: "BadRequest", retryable: false });
    assert.equal(requests.find(badRequest.request.id)?.state, "failed");
    const sameKey = await fetch(`${base}/api/agent-input/requests/${badRequest.request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: badBody,
    });
    assert.equal(sameKey.status, 502, "a reloaded or second client converges on the durable SDK failure");
    const secondClient = await fetch(`${base}/api/agent-input/requests/${badRequest.request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: JSON.stringify({
        expectedGeneration: 1, idempotencyKey: "different-client", answers: [["Safe"]],
      }),
    });
    assert.equal(secondClient.status, 409);
    assert.equal(relay.resolveNative(principal, badRequest.request.id, 1, "occ-bad-request", "replied").outcome, "resolved");
    assert.equal(requests.find(badRequest.request.id)?.state, "answered");
    const reconciled = await fetch(`${base}/api/agent-input/requests/${badRequest.request.id}/answer`, {
      method: "POST", headers: bearer(auth.token), body: badBody,
    });
    assert.equal(reconciled.status, 200);
    assert.deepEqual(await reconciled.json(), { outcome: "already_resolved" });

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
        const refreshChallenge = credentials.issueRuntimeChallenge(principal);
        credentials.refresh(principal, registrationBody("R".repeat(43), refreshChallenge));
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

test("feature disable rejects challenge creation without leaving pending challenge authority", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-route-disabled-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const credentials = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "server-key" });
  const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "answer-key" });
  const auth: AuthConfig = {
    enabled: true, token: "browser-user-token", loginEnabled: false,
    sessionSecret: "session-secret", browserAuthMode: "shared-or-login",
  };
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  const context = state.findPaneContext(pane.id)!;
  const questions = [{ header: "Mode", question: "Choose", options: [], multiple: false, custom: true }];
  const orphan = requests.capture({
    sourceId: "source-missing", workspaceId: context.workspace.id, tabId: context.tab.id,
    paneId: pane.id, machineId: pane.machineId, openCodeSessionId: "session-disabled",
    openCodeRequestId: "request-disabled", occurrenceId: "occ-disabled",
    occurrenceKey: nativeOccurrenceKey("session-disabled", "request-disabled"), occurrenceOrdinal: 1,
    payloadDigest: capturePayloadDigest({
      openCodeSessionId: "session-disabled", openCodeRequestId: "request-disabled", questions,
    }),
    questions,
  });
  if (orphan.outcome !== "created") throw new Error("orphan request unavailable");
  const server = await createHttpServer("127.0.0.1", state, machines, {} as SessionManager, settings, {
    auth, agentInputEnabled: false, agentInputCredentials: credentials, agentInputRequests: requests,
    healthResolvers: { machines: async () => [], streams: async () => [] },
  });
  assert.equal(requests.find(orphan.request.id)?.state, "cancelled");
  assert.equal(requests.find(orphan.request.id)?.resolution, "source-revoked");
  const capability = credentials.issueRegistrationCapability({
    workspaceId: context.workspace.id, tabId: context.tab.id, paneId: pane.id,
    machineId: pane.machineId, sourceKind: "opencode",
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("server unavailable");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent-input/sources/challenge`, {
      method: "POST", headers: bearer(capability.capability), body: JSON.stringify({ kind: "opencode" }),
    });
    assert.equal(response.status, 503);
    assert.equal(credentials.snapshot().challenges.length, 0);
  } finally {
    server.close(); await once(server, "close"); state.flush();
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
