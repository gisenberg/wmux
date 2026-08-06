import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentInputCredentialStore } from "../src/server/agent-input-credential-store.js";
import { AgentInputRelay } from "../src/server/agent-input-relay.js";
import { AgentInputRequestStore, capturePayloadDigest, nativeOccurrenceKey } from "../src/server/agent-input-request-store.js";
import {
  createOpenCodeRuntimeAttestation,
} from "../src/server/opencode-question-contract.js";

const boundInput = (input: any) => ({ ...input, occurrenceId: input.occurrenceId ?? "occ-request", occurrenceOrdinal: 1,
  occurrenceKey: nativeOccurrenceKey(input.openCodeSessionId, input.openCodeRequestId), payloadDigest: capturePayloadDigest(input) });
const registrationInput = (
  credentials: AgentInputCredentialStore,
  principal: Parameters<AgentInputCredentialStore["issueRuntimeChallenge"]>[0],
  nonce = "N".repeat(43),
) => {
  const challenge = credentials.issueRuntimeChallenge(principal);
  return { instanceNonce: nonce, kind: "opencode" as const,
    runtimeAttestation: createOpenCodeRuntimeAttestation(nonce, challenge) };
};

test("restart clears a pre-exposure delivery binding and permits the same submission retry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-restart-"));
  const credentialPath = path.join(directory, "credentials.json");
  const requestPath = path.join(directory, "requests.json");
  try {
    let credentials = new AgentInputCredentialStore(credentialPath, { hashKey: "hash-key" });
    let requests = new AgentInputRequestStore(requestPath, { answerDigestKey: "digest-key" });
    const capability = credentials.issueRegistrationCapability({
      workspaceId: "workspace", tabId: "tab", paneId: "pane", machineId: "local", sourceKind: "opencode",
    });
    const registration = credentials.authenticate(capability.capability);
    assert.equal(registration?.kind, "agent-input-registration");
    if (registration?.kind !== "agent-input-registration") return;
    const exchange = credentials.exchange(registration, registrationInput(credentials, registration));
    if (exchange.outcome !== "issued") return;
    let principal = credentials.authenticate(exchange.relaySecret);
    if (principal?.kind !== "agent-input-source") return;
    const captured = requests.capture(boundInput({
      sourceId: exchange.sourceId, workspaceId: "workspace", tabId: "tab", paneId: "pane", machineId: "local",
      openCodeSessionId: "session", openCodeRequestId: "request",
      questions: [{ header: "Note", question: "Custom", options: [], multiple: false, custom: true }],
    }));
    if (captured.outcome !== "created") return;
    const sentinel = ["TRANSIENT", "RESTART", "ANSWER"].join("_");
    assert.equal(requests.reserve(captured.request.id, 1, "stable-submission", [[sentinel]]).outcome, "reserved");
    requests.bindDelivery(captured.request.id, 1, "stable-submission", `delivery_${"b".repeat(16)}`);
    assert.equal(requests.submissionState(captured.request.id)?.deliveryId, `delivery_${"b".repeat(16)}`,
      "the simulated crash cut is after durable binding but before poll exposure");

    credentials = new AgentInputCredentialStore(credentialPath, { hashKey: "hash-key" });
    requests = new AgentInputRequestStore(requestPath, { answerDigestKey: "digest-key" });
    const recoveredSubmission = requests.submissionState(captured.request.id);
    assert.equal(recoveredSubmission?.status, "reserved");
    assert.equal(recoveredSubmission?.sdkStarted, false);
    assert.equal(recoveredSubmission?.deliveryId, undefined,
      "startup recovery atomically removes only the stale pre-exposure binding");
    principal = credentials.authenticate(exchange.relaySecret);
    if (principal?.kind !== "agent-input-source") throw new Error("credential did not survive restart");
    const secondRelay = new AgentInputRelay(requests, credentials, { deliveryTimeoutMs: 1_000, isPaneLive: () => true });
    const secondPollPromise = secondRelay.poll(principal, 0, 1, 1_000);
    const retried = secondRelay.submit(captured.request.id, 1, "stable-submission", [[sentinel]]);
    const secondPoll = await secondPollPromise;
    const delivery = secondPoll.deliveries[0];
    assert.ok(delivery);
    secondRelay.acknowledge(principal, delivery.deliveryId, {
      requestId: captured.request.id, generation: 1, outcome: "applied",
    });
    assert.deepEqual(await retried, { outcome: "delivered" });
    secondRelay.dispose();

    const afterRestart = requests.capture(boundInput({
      occurrenceId: "occ-after-restart",
      sourceId: exchange.sourceId, workspaceId: "workspace", tabId: "tab", paneId: "pane", machineId: "local",
      openCodeSessionId: "session", openCodeRequestId: "request-after-restart",
      questions: [{ header: "Note", question: "Custom", options: [], multiple: false, custom: true }],
    }));
    if (afterRestart.outcome !== "created") throw new Error("post-restart request unavailable");
    const restartedRelay = new AgentInputRelay(requests, credentials, { deliveryTimeoutMs: 1_000, isPaneLive: () => true });
    const resetPollPromise = restartedRelay.poll(principal, 10_000, 1, 1_000, undefined, secondPoll.epoch);
    const restartedAnswer = restartedRelay.submit(afterRestart.request.id, 1, "after-restart", [["safe"]]);
    const resetPoll = await resetPollPromise;
    assert.notEqual(resetPoll.epoch, secondPoll.epoch);
    assert.equal(resetPoll.deliveries.length, 1,
      "a stale high cursor from the prior relay epoch cannot suppress the first post-restart delivery");
    restartedRelay.acknowledge(principal, resetPoll.deliveries[0].deliveryId, {
      requestId: afterRestart.request.id, generation: 1, outcome: "applied",
    });
    assert.deepEqual(await restartedAnswer, { outcome: "delivered" });
    restartedRelay.dispose();

    for (const candidate of [requestPath, `${requestPath}.bak`, credentialPath, `${credentialPath}.bak`]) {
      if (fs.existsSync(candidate)) assert.doesNotMatch(fs.readFileSync(candidate, "utf8"), new RegExp(sentinel));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restart after exposure remains quarantined while list-present and never redelivers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-reconcile-restart-"));
  const credentialPath = path.join(directory, "credentials.json");
  const requestPath = path.join(directory, "requests.json");
  try {
    let credentials = new AgentInputCredentialStore(credentialPath, { hashKey: "hash-key" });
    let requests = new AgentInputRequestStore(requestPath, { answerDigestKey: "digest-key" });
    const capability = credentials.issueRegistrationCapability({
      workspaceId: "workspace", tabId: "tab", paneId: "pane", machineId: "local", sourceKind: "opencode",
    });
    const registration = credentials.authenticate(capability.capability);
    if (registration?.kind !== "agent-input-registration") throw new Error("registration unavailable");
    const exchange = credentials.exchange(registration, registrationInput(credentials, registration));
    if (exchange.outcome !== "issued") throw new Error("source unavailable");
    let principal = credentials.authenticate(exchange.relaySecret);
    if (principal?.kind !== "agent-input-source") throw new Error("principal unavailable");
    const captureInput = boundInput({
      sourceId: exchange.sourceId, workspaceId: "workspace", tabId: "tab", paneId: "pane", machineId: "local",
      openCodeSessionId: "session", openCodeRequestId: "request",
      questions: [{ header: "Mode", question: "Choose", options: [{ label: "Safe", description: "" }], multiple: false, custom: false }],
    });
    const captured = requests.capture(captureInput);
    if (captured.outcome !== "created") throw new Error("request unavailable");
    const firstRelay = new AgentInputRelay(requests, credentials, { deliveryTimeoutMs: 5_000, isPaneLive: () => true });
    const exposedPoll = firstRelay.poll(principal, 0, 1, 1_000);
    const interrupted = firstRelay.submit(captured.request.id, 1, "stable", [["Safe"]]);
    const exposed = (await exposedPoll).deliveries[0];
    assert.ok(exposed);
    firstRelay.startDelivery(principal, exposed.deliveryId, exposed.requestId, exposed.expectedGeneration);
    firstRelay.dispose();
    assert.deepEqual(await interrupted, { outcome: "sdk_error", code: "delivery_ambiguous", retryable: false });

    credentials = new AgentInputCredentialStore(credentialPath, { hashKey: "hash-key" });
    requests = new AgentInputRequestStore(requestPath, { answerDigestKey: "digest-key" });
    principal = credentials.authenticate(exchange.relaySecret);
    if (principal?.kind !== "agent-input-source") throw new Error("principal did not survive");
    const secondRelay = new AgentInputRelay(requests, credentials, { deliveryTimeoutMs: 5_000, isPaneLive: () => true });
    assert.deepEqual(await secondRelay.submit(captured.request.id, 1, "stable", [["Safe"]]), {
      outcome: "sdk_error", code: "delivery_ambiguous", retryable: false,
    });
    assert.deepEqual(secondRelay.reconcileNativePending(principal, captured.request.id, 1, "occ-request"), { outcome: "quarantined" });
    assert.equal((await secondRelay.poll(principal, 0, 1, 0)).deliveries.length, 0);
    assert.deepEqual(secondRelay.reconcileNativeList(principal, [{ occurrenceId: captureInput.occurrenceId,
      occurrenceKey: captureInput.occurrenceKey, ordinal: 1, payloadDigest: captureInput.payloadDigest,
      sessionID: "session", requestID: "request", questions: captureInput.questions }]), { outcome: "reconciled", closed: 0 });
    assert.deepEqual(secondRelay.reconcileNativeList(principal, []), { outcome: "reconciled", closed: 1 });
    assert.deepEqual(await secondRelay.submit(captured.request.id, 1, "stable", [["Safe"]]), { outcome: "already_resolved" });
    secondRelay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("durable delivery identity accepts SDK-success ack after relay restart without raw answers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-ack-restart-"));
  const credentialPath = path.join(directory, "credentials.json");
  const requestPath = path.join(directory, "requests.json");
  try {
    let credentials = new AgentInputCredentialStore(credentialPath, { hashKey: "hash-key" });
    let requests = new AgentInputRequestStore(requestPath, { answerDigestKey: "digest-key" });
    const capability = credentials.issueRegistrationCapability({ workspaceId: "workspace", tabId: "tab", paneId: "pane", sourceKind: "opencode" });
    const registration = credentials.authenticate(capability.capability);
    if (registration?.kind !== "agent-input-registration") throw new Error("registration unavailable");
    const exchange = credentials.exchange(registration, registrationInput(credentials, registration));
    if (exchange.outcome !== "issued") throw new Error("source unavailable");
    let principal = credentials.authenticate(exchange.relaySecret);
    if (principal?.kind !== "agent-input-source") throw new Error("principal unavailable");
    const captured = requests.capture(boundInput({ sourceId: exchange.sourceId, workspaceId: "workspace", tabId: "tab", paneId: "pane",
      openCodeSessionId: "session", openCodeRequestId: "request",
      questions: [{ header: "Note", question: "Write", options: [], multiple: false, custom: true }] }));
    if (captured.outcome !== "created") throw new Error("request unavailable");
    const sentinel = ["NEVER", "PERSIST", "RAW"].join("_");
    const firstRelay = new AgentInputRelay(requests, credentials, { deliveryTimeoutMs: 5_000, isPaneLive: () => true });
    const deliveryPoll = firstRelay.poll(principal, 0, 1, 1_000);
    const interrupted = firstRelay.submit(captured.request.id, 1, "stable", [[sentinel]]);
    const delivery = (await deliveryPoll).deliveries[0];
    firstRelay.startDelivery(principal, delivery.deliveryId, captured.request.id, 1);
    firstRelay.dispose();
    assert.deepEqual(await interrupted, { outcome: "sdk_error", code: "delivery_ambiguous", retryable: false });

    credentials = new AgentInputCredentialStore(credentialPath, { hashKey: "hash-key" });
    requests = new AgentInputRequestStore(requestPath, { answerDigestKey: "digest-key" });
    principal = credentials.authenticate(exchange.relaySecret);
    if (principal?.kind !== "agent-input-source") throw new Error("principal unavailable after restart");
    const secondRelay = new AgentInputRelay(requests, credentials, { isPaneLive: () => true });
    assert.deepEqual(secondRelay.acknowledge(principal, delivery.deliveryId, {
      requestId: captured.request.id, generation: 1, outcome: "applied",
    }), { outcome: "delivered" });
    assert.deepEqual(await secondRelay.submit(captured.request.id, 1, "stable", [[sentinel]]), { outcome: "delivered" });
    for (const candidate of [requestPath, `${requestPath}.bak`, credentialPath, `${credentialPath}.bak`]) {
      if (fs.existsSync(candidate)) assert.doesNotMatch(fs.readFileSync(candidate, "utf8"), new RegExp(sentinel));
    }
    secondRelay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
