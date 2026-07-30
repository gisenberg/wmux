import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentInputCredentialStore, type AgentInputSourcePrincipal } from "../src/server/agent-input-credential-store.js";
import {
  AgentInputRelay,
  MAX_AGENT_INPUT_DELIVERIES,
  MAX_AGENT_INPUT_DELIVERIES_PER_SOURCE,
  MAX_AGENT_INPUT_POLLS,
  MAX_AGENT_INPUT_TRANSIENT_BYTES,
} from "../src/server/agent-input-relay.js";
import { AgentInputRequestStore, capturePayloadDigest, nativeOccurrenceKey } from "../src/server/agent-input-request-store.js";
import {
  createOpenCodeRuntimeAttestation,
} from "../src/server/opencode-question-contract.js";

const registrationInput = (nonce: string) => ({
  instanceNonce: nonce, kind: "opencode" as const, runtimeAttestation: createOpenCodeRuntimeAttestation(nonce),
});

const setup = (directory: string, timeout = 500) => {
  const credentials = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "hash-key" });
  const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "digest-key" });
  const capability = credentials.issueRegistrationCapability({
    workspaceId: "workspace", tabId: "tab", paneId: "pane", machineId: "local", sourceKind: "opencode",
  });
  const registrationPrincipal = credentials.authenticate(capability.capability);
  assert.equal(registrationPrincipal?.kind, "agent-input-registration");
  if (registrationPrincipal?.kind !== "agent-input-registration") throw new Error("missing principal");
  const exchange = credentials.exchange(registrationPrincipal, registrationInput("N".repeat(43)));
  if (exchange.outcome !== "issued") throw new Error("missing source");
  const principal = credentials.authenticate(exchange.relaySecret);
  if (principal?.kind !== "agent-input-source") throw new Error("missing source principal");
  const relay = new AgentInputRelay(requests, credentials, { deliveryTimeoutMs: timeout, isPaneLive: () => true });
  const ask = (openCodeRequestId: string) => requests.capture(occurrenceInput({
    occurrenceId: `occ-${openCodeRequestId}`,
    sourceId: exchange.sourceId, workspaceId: "workspace", tabId: "tab", paneId: "pane", machineId: "local",
    openCodeSessionId: "session", openCodeRequestId,
    questions: [{ header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: true }],
  }));
  return { credentials, requests, relay, principal, relaySecret: exchange.relaySecret, ask };
};

const occurrenceInput = (input: any) => ({
  ...input,
  occurrenceOrdinal: input.occurrenceOrdinal ?? 1,
  occurrenceKey: nativeOccurrenceKey(input.openCodeSessionId, input.openCodeRequestId),
  payloadDigest: capturePayloadDigest(input),
});

test("two clients race, duplicate polls/acks converge, and only one SDK delivery wins", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-race-"));
  try {
    const { relay, principal, ask } = setup(directory, 3_000);
    const captured = ask("request-race");
    assert.equal(captured.outcome, "created");
    if (captured.outcome !== "created") return;
    const first = relay.submit(captured.request.id, 1, "client-one", [["Safe"]]);
    const second = await relay.submit(captured.request.id, 1, "client-two", [["Safe"]]);
    assert.deepEqual(second, { outcome: "conflict", code: "idempotency_conflict" });
    const pollOne = await relay.poll(principal, 0, 1, 0);
    const pollTwo = await relay.poll(principal, pollOne.cursor, 1, 0);
    assert.equal(pollOne.deliveries.length, 1);
    assert.equal(pollTwo.deliveries.length, 0, "cursor advancement suppresses rapid redelivery");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const redelivery = await relay.poll(principal, pollOne.cursor, 1, 0);
    assert.equal(redelivery.deliveries.length, 0, "an exposed delivery is never redelivered");
    const delivery = pollOne.deliveries[0];
    assert.deepEqual(relay.acknowledge(principal, delivery.deliveryId, {
      requestId: captured.request.id, generation: 1, outcome: "applied",
    }), { outcome: "delivered" });
    assert.deepEqual(relay.acknowledge(principal, delivery.deliveryId, {
      requestId: captured.request.id, generation: 1, outcome: "applied",
    }), { outcome: "delivered" });
    assert.deepEqual(await first, { outcome: "delivered" });
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native resolution and a later equivalent SDK acknowledgement commute", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-commutative-"));
  try {
    const { relay, principal, ask } = setup(directory, 3_000);
    const captured = ask("commutative");
    if (captured.outcome !== "created") throw new Error("request unavailable");
    const pending = relay.submit(captured.request.id, 1, "stable", [["Safe"]]);
    const delivery = (await relay.poll(principal, 0, 1, 0)).deliveries[0];
    relay.startDelivery(principal, delivery.deliveryId, delivery.requestId, delivery.expectedGeneration);
    assert.deepEqual(relay.resolveNative(principal, captured.request.id, 1, "occ-commutative", "replied"), { outcome: "resolved" });
    assert.deepEqual(await pending, { outcome: "already_resolved" });
    assert.deepEqual(relay.acknowledge(principal, delivery.deliveryId, {
      requestId: delivery.requestId, generation: delivery.expectedGeneration, outcome: "applied",
    }), { outcome: "already_resolved" });
    assert.deepEqual(relay.acknowledge(principal, delivery.deliveryId, {
      requestId: delivery.requestId, generation: delivery.expectedGeneration, outcome: "applied",
    }), { outcome: "already_resolved" });
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("closing one duplicate same-key waiter cannot cancel the shared submission", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-shared-waiter-"));
  try {
    const { relay, principal, ask } = setup(directory, 3_000);
    const captured = ask("shared-waiter");
    if (captured.outcome !== "created") throw new Error("request unavailable");
    const abandoned = new AbortController();
    const first = relay.submit(captured.request.id, 1, "stable", [["Safe"]], abandoned.signal);
    const second = relay.submit(captured.request.id, 1, "stable", [["Safe"]]);
    abandoned.abort();
    assert.deepEqual(await first, { outcome: "source_unavailable" });
    const delivery = (await relay.poll(principal, 0, 1, 0)).deliveries[0];
    assert.ok(delivery);
    relay.acknowledge(principal, delivery.deliveryId, {
      requestId: delivery.requestId, generation: delivery.expectedGeneration, outcome: "applied",
    });
    assert.deepEqual(await second, { outcome: "delivered" });
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("poll leases clean up exactly, replace per source, and enforce the global cap", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-poll-leases-"));
  try {
    const credentials = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "key" });
    const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "key" });
    const relay = new AgentInputRelay(requests, credentials, { isPaneLive: () => true });
    const principals: AgentInputSourcePrincipal[] = [];
    for (let index = 0; index <= MAX_AGENT_INPUT_POLLS; index += 1) {
      const capability = credentials.issueRegistrationCapability({
        workspaceId: `w${index}`, tabId: `t${index}`, paneId: `p${index}`, sourceKind: "opencode",
      });
      const registration = credentials.authenticate(capability.capability);
      if (registration?.kind !== "agent-input-registration") throw new Error("registration unavailable");
      const exchange = credentials.exchange(registration, registrationInput(String(index).padStart(43, "0")));
      if (exchange.outcome !== "issued") throw new Error("source unavailable");
      const principal = credentials.authenticate(exchange.relaySecret);
      if (principal?.kind !== "agent-input-source") throw new Error("principal unavailable");
      principals.push(principal);
    }
    const controllers = principals.slice(0, MAX_AGENT_INPUT_POLLS).map(() => new AbortController());
    const polls = principals.slice(0, MAX_AGENT_INPUT_POLLS).map((principal, index) =>
      relay.poll(principal, 0, 1, 30_000, controllers[index].signal));
    await assert.rejects(relay.poll(principals[MAX_AGENT_INPUT_POLLS], 0, 1, 30_000), /poll_limit/);
    const replacementController = new AbortController();
    const replacement = relay.poll(principals[0], 0, 1, 30_000, replacementController.signal);
    controllers.forEach((controller) => controller.abort());
    replacementController.abort();
    await Promise.all([...polls, replacement]);
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal reply/reject races and delivery timeout return observable typed outcomes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-terminal-race-"));
  try {
    const { relay, principal, ask } = setup(directory, 30);
    const replied = ask("terminal-first");
    assert.equal(replied.outcome, "created");
    if (replied.outcome !== "created") return;
    const pending = relay.submit(replied.request.id, 1, "terminal-client", [["Safe"]]);
    const delivery = (await relay.poll(principal, 0, 1, 0)).deliveries[0];
    assert.ok(delivery);
    assert.deepEqual(relay.resolveNative(principal, replied.request.id, 1, "occ-terminal-first", "replied"), { outcome: "resolved" });
    assert.deepEqual(await pending, { outcome: "already_resolved" });

    const rejected = ask("terminal-reject");
    assert.equal(rejected.outcome, "created");
    if (rejected.outcome === "created") {
      assert.deepEqual(relay.resolveNative(principal, rejected.request.id, 1, "occ-terminal-reject", "rejected"), { outcome: "resolved" });
      assert.deepEqual(await relay.submit(rejected.request.id, 1, "late-client", [["Safe"]]), {
        outcome: "conflict", code: "not_pending",
      });
    }

    const timeout = ask("timeout");
    assert.equal(timeout.outcome, "created");
    if (timeout.outcome === "created") {
      assert.deepEqual(await relay.submit(timeout.request.id, 1, "timeout-client", [["Safe"]]), {
        outcome: "delivery_timeout",
      });
    }
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("delivery timeout quarantines every exposed handoff and never redelivers it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-start-timeout-"));
  try {
    const { relay, principal, requests, ask } = setup(directory, 40);
    const queued = ask("queued-timeout");
    if (queued.outcome !== "created") throw new Error("queued request unavailable");
    const queuedSubmit = relay.submit(queued.request.id, 1, "queued", [["Safe"]]);
    const queuedDelivery = (await relay.poll(principal, 0, 1, 0)).deliveries[0];
    assert.ok(queuedDelivery);
    assert.deepEqual(await queuedSubmit, { outcome: "sdk_error", code: "delivery_ambiguous", retryable: false });
    assert.equal(requests.submissionState(queued.request.id)?.status, "ambiguous");
    assert.throws(() => relay.startDelivery(
      principal,
      queuedDelivery.deliveryId,
      queuedDelivery.requestId,
      queuedDelivery.expectedGeneration,
    ), /delivery_conflict/);

    assert.deepEqual(await relay.submit(queued.request.id, 1, "queued", [["Safe"]]), {
      outcome: "sdk_error", code: "delivery_ambiguous", retryable: false,
    });
    assert.equal((await relay.poll(principal, queuedDelivery.cursor, 1, 0)).deliveries.length, 0);

    const started = ask("started-timeout");
    if (started.outcome !== "created") throw new Error("started request unavailable");
    const startedSubmit = relay.submit(started.request.id, 1, "started", [["Safe"]]);
    const startedDelivery = (await relay.poll(principal, queuedDelivery.cursor, 1, 0)).deliveries[0];
    relay.startDelivery(principal, startedDelivery.deliveryId, startedDelivery.requestId, startedDelivery.expectedGeneration);
    assert.deepEqual(await startedSubmit, { outcome: "sdk_error", code: "delivery_ambiguous", retryable: false });
    assert.equal(requests.submissionState(started.request.id)?.status, "ambiguous");
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("credential rotation cancels handoff, invalidates old principal, and confines source generations", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-rotation-"));
  try {
    const { relay, credentials, principal, relaySecret, ask } = setup(directory);
    const captured = ask("rotation");
    assert.equal(captured.outcome, "created");
    if (captured.outcome !== "created") return;
    const pending = relay.submit(captured.request.id, 1, "rotation-client", [["Safe"]]);
    const refreshed = credentials.refresh(principal);
    assert.equal(credentials.authenticate(relaySecret), undefined);
    assert.deepEqual(await pending, { outcome: "source_unavailable" });
    const next = credentials.authenticate(refreshed.relaySecret);
    assert.equal(next?.kind, "agent-input-source");
    assert.rejects(relay.poll(principal, 0, 1, 0), /unauthorized_source/);
    if (next?.kind === "agent-input-source") {
      assert.equal((next as AgentInputSourcePrincipal).credentialGeneration, principal.credentialGeneration + 1);
    }
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("disconnect after poll marks delivery in doubt until native reconciliation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-in-doubt-"));
  try {
    const { relay, principal, ask } = setup(directory);
    const captured = ask("in-doubt");
    assert.equal(captured.outcome, "created");
    if (captured.outcome !== "created") return;
    const pending = relay.submit(captured.request.id, 1, "stable-key", [["Safe"]]);
    const delivery = (await relay.poll(principal, 0, 1, 0)).deliveries[0];
    assert.ok(delivery);
    assert.deepEqual(relay.startDelivery(principal, delivery.deliveryId, captured.request.id, 1), { outcome: "started" });
    relay.disconnectSource(principal.sourceId);
    assert.deepEqual(await pending, { outcome: "sdk_error", code: "delivery_ambiguous", retryable: false });
    assert.deepEqual(await relay.submit(captured.request.id, 1, "stable-key", [["Safe"]]), {
      outcome: "sdk_error", code: "delivery_ambiguous", retryable: false,
    });
    assert.deepEqual(relay.resolveNative(principal, captured.request.id, 1, "occ-in-doubt", "replied"), { outcome: "resolved" });
    assert.deepEqual(await relay.submit(captured.request.id, 1, "stable-key", [["Safe"]]), {
      outcome: "already_resolved",
    });
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("feature disable revokes sources, clears requests, and rejects new handoffs", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-disabled-"));
  try {
    const { relay, credentials, relaySecret, requests, ask } = setup(directory);
    const captured = ask("disabled");
    assert.equal(captured.outcome, "created");
    if (captured.outcome !== "created") return;
    relay.setEnabled(false);
    assert.equal(credentials.authenticate(relaySecret), undefined);
    assert.equal(requests.find(captured.request.id)?.state, "cancelled");
    assert.deepEqual(await relay.submit(captured.request.id, 1, "disabled-key", [["Safe"]]), {
      outcome: "source_unavailable",
    });
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("post-exposure SDK ambiguity is quarantined while deterministic SDK failures remain converged", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-sdk-retry-"));
  try {
    const { relay, principal, ask } = setup(directory, 3_000);
    const captured = ask("sdk-retry");
    if (captured.outcome !== "created") throw new Error("request unavailable");
    const first = relay.submit(captured.request.id, 1, "stable", [["Safe"]]);
    const delivery = (await relay.poll(principal, 0, 1, 0)).deliveries[0];
    relay.startDelivery(principal, delivery.deliveryId, captured.request.id, 1);
    assert.deepEqual(relay.acknowledge(principal, delivery.deliveryId, {
      requestId: captured.request.id, generation: 1, outcome: "sdk_error", code: "transport_error", retryable: true,
    }), { outcome: "sdk_error", code: "transport_error", retryable: false });
    assert.deepEqual(await first, { outcome: "sdk_error", code: "transport_error", retryable: false });
    assert.deepEqual(await relay.submit(captured.request.id, 1, "stable", [["Safe"]]), {
      outcome: "sdk_error", code: "transport_error", retryable: false,
    });
    assert.equal((await relay.poll(principal, delivery.cursor, 1, 0)).deliveries.length, 0);

    const nativeAfterRetryable = ask("sdk-retry-native-resolution");
    if (nativeAfterRetryable.outcome !== "created") throw new Error("request unavailable");
    const interrupted = relay.submit(nativeAfterRetryable.request.id, 1, "native-stable", [["Safe"]]);
    const interruptedDelivery = (await relay.poll(principal, delivery.cursor, 1, 0)).deliveries[0];
    relay.startDelivery(principal, interruptedDelivery.deliveryId, interruptedDelivery.requestId, interruptedDelivery.expectedGeneration);
    relay.acknowledge(principal, interruptedDelivery.deliveryId, {
      requestId: interruptedDelivery.requestId, generation: 1,
      outcome: "sdk_error", code: "transport_error", retryable: true,
    });
    assert.deepEqual(await interrupted, { outcome: "sdk_error", code: "transport_error", retryable: false });
    assert.deepEqual(relay.resolveNative(principal, nativeAfterRetryable.request.id, 1, "occ-sdk-retry-native-resolution", "replied"), { outcome: "resolved" });
    assert.deepEqual(await relay.submit(nativeAfterRetryable.request.id, 1, "native-stable", [["Safe"]]), {
      outcome: "already_resolved",
    });

    const terminal = ask("sdk-terminal");
    if (terminal.outcome !== "created") throw new Error("request unavailable");
    const terminalSubmit = relay.submit(terminal.request.id, 1, "terminal", [["Safe"]]);
    const terminalDelivery = (await relay.poll(principal, interruptedDelivery.cursor, 1, 0)).deliveries[0];
    relay.acknowledge(principal, terminalDelivery.deliveryId, {
      requestId: terminal.request.id, generation: 1, outcome: "sdk_error", code: "BadRequest", retryable: false,
    });
    assert.deepEqual(await terminalSubmit, { outcome: "sdk_error", code: "BadRequest", retryable: false });
    assert.deepEqual(await relay.submit(terminal.request.id, 1, "terminal", [["Safe"]]), {
      outcome: "sdk_error", code: "BadRequest", retryable: false,
    });
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("poll cancellation is prompt and response cancellation quarantines an observed delivery", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-cancel-"));
  try {
    const { relay, principal, ask } = setup(directory, 3_000);
    const controller = new AbortController();
    const startedAt = Date.now();
    const emptyPoll = relay.poll(principal, 0, 1, 30_000, controller.signal);
    controller.abort();
    const empty = await emptyPoll;
    assert.equal(empty.cursor, 0);
    assert.deepEqual(empty.deliveries, []);
    assert.ok(empty.epoch);
    assert.ok(Date.now() - startedAt < 500, "aborted long poll must release its wait resource promptly");

    const captured = ask("observed-cancel");
    if (captured.outcome !== "created") throw new Error("request unavailable");
    const answerAbort = new AbortController();
    const pending = relay.submit(captured.request.id, 1, "stable", [["Safe"]], answerAbort.signal);
    const delivery = (await relay.poll(principal, 0, 1, 0)).deliveries[0];
    answerAbort.abort();
    const retry = relay.submit(captured.request.id, 1, "stable", [["Safe"]]);
    assert.equal((await relay.poll(principal, delivery.cursor, 1, 0)).deliveries.length, 0);
    assert.throws(() => relay.startDelivery(principal, delivery.deliveryId, delivery.requestId, delivery.expectedGeneration), /delivery_conflict/);
    assert.deepEqual(await retry, { outcome: "sdk_error", code: "delivery_ambiguous", retryable: false });
    assert.deepEqual(await pending, { outcome: "source_unavailable" }, "the disconnected waiter is abandoned independently");
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("delivery count and ephemeral answer-byte budgets fail closed without persisting raw answers", async () => {
  const countDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-count-limit-"));
  try {
    const fixture = setup(countDirectory, 30_000);
    const pending: Array<Promise<unknown>> = [];
    for (let index = 0; index < MAX_AGENT_INPUT_DELIVERIES; index += 1) {
      const captured = fixture.ask(`count-${index}`);
      if (captured.outcome !== "created") throw new Error("request unavailable");
      pending.push(fixture.relay.submit(captured.request.id, 1, `key-${index}`, [["Safe"]]));
    }
    const overflow = fixture.ask("count-overflow");
    if (overflow.outcome !== "created") throw new Error("request unavailable");
    assert.deepEqual(await fixture.relay.submit(overflow.request.id, 1, "overflow", [["Safe"]]), {
      outcome: "source_unavailable",
    });
    fixture.relay.dispose();
    await Promise.all(pending);
  } finally {
    fs.rmSync(countDirectory, { recursive: true, force: true });
  }

  const byteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-byte-limit-"));
  try {
    const fixture = setup(byteDirectory, 30_000);
    const sentinel = ["TRANSIENT", "BYTE", "BUDGET"].join("_");
    const questions = Array.from({ length: 4 }, (_, index) => ({
      header: `H${index}`, question: `Q${index}`, options: [], multiple: false, custom: true,
    }));
    const answer = `${sentinel}${"x".repeat(4_096 - sentinel.length)}`;
    const bytes = Buffer.byteLength(JSON.stringify([[answer], [answer], [answer], [answer]]));
    const accepted = Math.floor(MAX_AGENT_INPUT_TRANSIENT_BYTES / bytes);
    const pending: Array<Promise<unknown>> = [];
    for (let index = 0; index < accepted; index += 1) {
      const captured = fixture.requests.capture(occurrenceInput({
        occurrenceId: `occ-bytes-${index}`,
        sourceId: fixture.principal.sourceId, workspaceId: "workspace", tabId: "tab", paneId: "pane", machineId: "local",
        openCodeSessionId: "session", openCodeRequestId: `bytes-${index}`, questions,
      }));
      if (captured.outcome !== "created") throw new Error("request unavailable");
      pending.push(fixture.relay.submit(captured.request.id, 1, `bytes-${index}`, [[answer], [answer], [answer], [answer]]));
    }
    const overflow = fixture.requests.capture(occurrenceInput({
      occurrenceId: "occ-bytes-overflow",
      sourceId: fixture.principal.sourceId, workspaceId: "workspace", tabId: "tab", paneId: "pane", machineId: "local",
      openCodeSessionId: "session", openCodeRequestId: "bytes-overflow", questions,
    }));
    if (overflow.outcome !== "created") throw new Error("request unavailable");
    assert.deepEqual(await fixture.relay.submit(
      overflow.request.id, 1, "bytes-overflow", [[answer], [answer], [answer], [answer]],
    ), { outcome: "source_unavailable" });
    assert.ok(accepted < MAX_AGENT_INPUT_DELIVERIES);
    for (const candidate of [fixture.requests.filePath, `${fixture.requests.filePath}.bak`]) {
      if (fs.existsSync(candidate)) assert.doesNotMatch(fs.readFileSync(candidate, "utf8"), new RegExp(sentinel));
    }
    fixture.relay.dispose();
    await Promise.all(pending);
  } finally {
    fs.rmSync(byteDirectory, { recursive: true, force: true });
  }
});

test("complete empty snapshot settles buffered answer waiters and removes raw delivery", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-empty-snapshot-buffer-"));
  try {
    const { relay, principal, ask } = setup(directory, 3_000);
    const captured = ask("snapshot-buffered");
    if (captured.outcome !== "created") throw new Error("request unavailable");
    const answer = relay.submit(captured.request.id, 1, "snapshot-buffered", [["Safe"]]);
    assert.deepEqual(relay.reconcileNativeList(principal, []), { outcome: "reconciled", closed: 1 });
    assert.deepEqual(await answer, { outcome: "already_resolved" });
    assert.equal((await relay.poll(principal, 0, 1, 0)).deliveries.length, 0,
      "the authoritative barrier removes and zeroes the buffered raw delivery");
    relay.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("one source exhausting its delivery quota cannot deny an unrelated source", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-source-delivery-isolation-"));
  try {
    const credentials = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "key" });
    const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "key" });
    const issue = (name: string) => {
      const capability = credentials.issueRegistrationCapability({
        workspaceId: `workspace-${name}`, tabId: `tab-${name}`, paneId: `pane-${name}`, sourceKind: "opencode",
      });
      const registration = credentials.authenticate(capability.capability);
      if (registration?.kind !== "agent-input-registration") throw new Error("registration unavailable");
      const exchange = credentials.exchange(registration, registrationInput(name[0].toUpperCase().padEnd(43, "N")));
      if (exchange.outcome !== "issued") throw new Error("source unavailable");
      const principal = credentials.authenticate(exchange.relaySecret);
      if (principal?.kind !== "agent-input-source") throw new Error("principal unavailable");
      return { exchange, principal };
    };
    const malicious = issue("malicious");
    const healthy = issue("healthy");
    const relay = new AgentInputRelay(requests, credentials, { deliveryTimeoutMs: 30_000, isPaneLive: () => true });
    const question = [{ header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: true }];
    const captureFor = (source: typeof malicious, name: string) => requests.capture(occurrenceInput({
      occurrenceId: `occ-${name}`, sourceId: source.exchange.sourceId,
      workspaceId: `workspace-${name.startsWith("bad") ? "malicious" : "healthy"}`,
      tabId: `tab-${name.startsWith("bad") ? "malicious" : "healthy"}`,
      paneId: `pane-${name.startsWith("bad") ? "malicious" : "healthy"}`,
      openCodeSessionId: "session", openCodeRequestId: name, questions: question,
    }));
    const maliciousPending: Array<Promise<unknown>> = [];
    for (let index = 0; index < MAX_AGENT_INPUT_DELIVERIES_PER_SOURCE; index += 1) {
      const captured = captureFor(malicious, `bad-${index}`);
      if (captured.outcome !== "created") throw new Error("malicious request unavailable");
      maliciousPending.push(relay.submit(captured.request.id, 1, `bad-${index}`, [["Safe"]]));
    }
    const overflow = captureFor(malicious, "bad-overflow");
    if (overflow.outcome !== "created") throw new Error("overflow request unavailable");
    assert.deepEqual(await relay.submit(overflow.request.id, 1, "bad-overflow", [["Safe"]]), { outcome: "source_unavailable" });

    const healthyCapture = captureFor(healthy, "healthy-one");
    if (healthyCapture.outcome !== "created") throw new Error("healthy request unavailable");
    const healthySubmit = relay.submit(healthyCapture.request.id, 1, "healthy", [["Safe"]]);
    const delivery = (await relay.poll(healthy.principal, 0, 1, 0)).deliveries[0];
    assert.ok(delivery, "the unrelated source retains delivery capacity");
    relay.acknowledge(healthy.principal, delivery.deliveryId, {
      requestId: healthyCapture.request.id, generation: 1, outcome: "applied",
    });
    assert.deepEqual(await healthySubmit, { outcome: "delivered" });
    relay.dispose();
    await Promise.all(maliciousPending);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
