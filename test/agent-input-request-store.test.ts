import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentInputRequestStore,
  AgentInputRequestQuotaError,
  AgentInputRequestStoreError,
  capturePayloadDigest,
  CURRENT_AGENT_INPUT_REQUEST_SCHEMA_VERSION,
  enforceSerializedQuotaGrowth,
  MAX_AGENT_INPUT_LIFECYCLE_BYTES,
  MAX_AGENT_INPUT_LIFECYCLE_BYTES_PER_SOURCE,
  MAX_AGENT_INPUT_PENDING_PER_SOURCE,
  nativeOccurrenceKey,
  UnsupportedAgentInputRequestVersionError,
} from "../src/server/agent-input-request-store.js";
import type { AgentInputQuestion } from "../src/shared/protocol.js";

const questions: AgentInputQuestion[] = [
  { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe mode" }], multiple: false, custom: true },
  { header: "Checks", question: "Choose checks", options: [{ label: "Tests", description: "Tests" }, { label: "Types", description: "Types" }], multiple: true, custom: false },
];
const capture = (store: AgentInputRequestStore, requestId = "oc-request", overrides: Record<string, unknown> = {}) => {
  const input = {
  occurrenceId: `occ-${requestId}`,
  occurrenceOrdinal: 1,
  sourceId: "source-one",
  workspaceId: "workspace-one",
  tabId: "tab-one",
  paneId: "pane-one",
  machineId: "local",
  openCodeSessionId: "session-one",
  openCodeRequestId: requestId,
  questions,
  ...overrides,
  };
  return store.capture({
    ...input,
    occurrenceKey: nativeOccurrenceKey(input.openCodeSessionId, input.openCodeRequestId),
    payloadDigest: capturePayloadDigest(input),
  }, 1_000);
};
const expose = (store: AgentInputRequestStore, id: string, key: string, now = 1_001) => {
  store.bindDelivery(id, 1, key, `delivery_${"a".repeat(16)}`, now);
  store.observe(id, 1, key, now + 1);
};

const readStoredEnvelope = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, "utf8"));
const compactBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const sourceBytes = (data: any, sourceId: string, includeAttention = true): number => {
  const owns = (requestId: string, generation: number) => data.requests.some((request: any) =>
    request.sourceId === sourceId && request.id === requestId && request.generation === generation)
    || data.tombstones.some((tombstone: any) => tombstone.sourceId === sourceId
      && tombstone.id === requestId && tombstone.generation === generation);
  return compactBytes({
    requests: data.requests.filter((request: any) => request.sourceId === sourceId),
    submissions: data.submissions.filter((submission: any) => owns(submission.requestId, submission.generation)),
    tombstones: data.tombstones.filter((tombstone: any) => tombstone.sourceId === sourceId),
    attention: includeAttention
      ? data.attention.filter((attention: any) => owns(attention.requestId, attention.generation))
      : [],
    generationAnchors: data.generationAnchors.filter((anchor: any) => anchor.sourceId === sourceId),
    retiredSources: data.retiredSources.filter((source: any) => source.sourceId === sourceId),
  });
};
const expectQuota = (operation: () => unknown, code: "source_byte_limit" | "global_byte_limit") => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof AgentInputRequestQuotaError);
    assert.equal(error.code, code);
    assert.ok(error.afterBytes > error.beforeBytes);
    return error;
  }
  assert.fail(`expected ${code}`);
};

test("request store enforces ask generations, duplicate semantics, transitions, CAS, and answer validation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-store-"));
  try {
    const store = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "digest-key" });
    let changes = 0;
    store.on("change", () => changes += 1);
    const first = capture(store);
    assert.equal(first.outcome, "created");
    assert.equal(first.outcome === "created" && first.request.generation, 1);
    assert.equal(capture(store).outcome, "duplicate");
    assert.equal(changes, 1, "duplicate must not publish a change");
    assert.deepEqual(capture(store, "oc-request", { openCodeSessionId: "different" }), {
      outcome: "conflict", code: "conflicting_duplicate",
    });
    if (first.outcome !== "created") return;
    const pendingSamePayload = capture(store, "oc-request", {
      occurrenceId: "occ-oc-request-second-envelope", occurrenceOrdinal: 2,
    });
    assert.equal(pendingSamePayload.outcome, "duplicate");
    assert.equal(pendingSamePayload.outcome === "duplicate" && pendingSamePayload.request.id, first.request.id);
    assert.deepEqual(capture(store, "oc-request", {
      occurrenceId: "occ-oc-request-conflict", occurrenceOrdinal: 2,
      questions: [{ ...questions[0], question: "conflicting pending payload" }, questions[1]],
    }), { outcome: "conflict", code: "conflicting_duplicate" });
    assert.throws(() => store.reserve(first.request.id, 1, "submission", [["Safe"], ["unknown"]]), AgentInputRequestStoreError);
    assert.equal(store.reserve(first.request.id, 1, "submission", [["Safe"], ["Tests", "Types"]]).outcome, "reserved");
    assert.equal(store.reserve(first.request.id, 1, "submission", [["Safe"], ["Tests", "Types"]]).outcome, "resumed");
    assert.deepEqual(store.reserve(first.request.id, 1, "submission", [["different"], ["Tests"]]), {
      outcome: "conflict", code: "idempotency_conflict",
    });
    expose(store, first.request.id, "submission");
    assert.deepEqual(store.complete(first.request.id, 1, "submission", "delivered"), { outcome: "delivered" });
    assert.equal(store.find(first.request.id)?.state, "answered");
    const terminalRetry = capture(store);
    assert.equal(terminalRetry.outcome, "duplicate");
    assert.deepEqual(terminalRetry.outcome === "duplicate" && {
      id: terminalRetry.request.id,
      generation: terminalRetry.request.generation,
      state: terminalRetry.request.state,
    }, { id: first.request.id, generation: 1, state: "answered" });
    assert.deepEqual(store.resolveNative(first.request.id, 1, "rejected").outcome, "already_resolved");
    const reused = capture(store, "oc-request", { occurrenceId: "occ-oc-request-reused", occurrenceOrdinal: 2 });
    assert.equal(reused.outcome, "created");
    assert.equal(reused.outcome === "created" && reused.request.generation, 2);
    if (reused.outcome === "created") assert.equal(store.resolveNative(reused.request.id, 1, "replied").outcome, "retired");
    const pane = capture(store, "pane-close");
    if (pane.outcome === "created") {
      assert.equal(store.reserve(pane.request.id, 1, "pane-submission", [["Safe"], ["Tests"]]).outcome, "reserved");
    }
    assert.equal(store.resolvePane("pane-one"), 2);
    if (pane.outcome === "created") {
      assert.equal(store.find(pane.request.id)?.state, "closed");
      assert.deepEqual(store.reserve(pane.request.id, 1, "pane-submission", [["Safe"], ["Tests"]]), {
        outcome: "converged", result: { outcome: "already_resolved" },
      });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("non-retryable SDK failure is a durable public terminal state and later native resolution reconciles it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-sdk-terminal-"));
  const filePath = path.join(directory, "requests.json");
  try {
    let store = new AgentInputRequestStore(filePath, { answerDigestKey: "digest-key" });
    const asked = capture(store, "bad-request");
    if (asked.outcome !== "created") throw new Error("request unavailable");
    store.reserve(asked.request.id, 1, "stable", [["Safe"], ["Tests"]]);
    expose(store, asked.request.id, "stable");
    assert.deepEqual(store.complete(
      asked.request.id, 1, "stable", "sdk_error", "BadRequest", 1_010, false,
    ), { outcome: "sdk_error", code: "BadRequest", retryable: false });
    assert.deepEqual((({ state, resolution }) => ({ state, resolution }))(store.find(asked.request.id)!), {
      state: "failed", resolution: "plugin",
    });

    store.dispose();
    store = new AgentInputRequestStore(filePath, { answerDigestKey: "digest-key" });
    assert.equal(store.find(asked.request.id)?.state, "failed", "reload exposes the same terminal state");
    assert.deepEqual(store.reserve(asked.request.id, 1, "stable", [["Safe"], ["Tests"]]), {
      outcome: "converged", result: { outcome: "sdk_error", code: "BadRequest", retryable: false },
    });
    assert.deepEqual(store.reserve(asked.request.id, 1, "second-client", [["Safe"], ["Tests"]]), {
      outcome: "conflict", code: "idempotency_conflict",
    });
    assert.equal(store.resolveNative(asked.request.id, 1, "occ-bad-request", "replied").outcome, "resolved");
    assert.equal(store.find(asked.request.id)?.state, "answered");
    assert.deepEqual(store.reserve(asked.request.id, 1, "stable", [["Safe"], ["Tests"]]), {
      outcome: "converged", result: { outcome: "already_resolved" },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("request store is owner-only, clone-safe, atomic, backup-recoverable, migrated, and future-safe", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-durable-"));
  const filePath = path.join(directory, "requests.json");
  try {
    const store = new AgentInputRequestStore(filePath, { answerDigestKey: "digest-key" });
    const first = capture(store);
    capture(store, "second");
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(filePath, "utf8"), /occ-oc-request/);
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /occ-oc-request/,
      "occurrence identities remain server-only");
    const snapshot = store.snapshot();
    snapshot.length = 0;
    assert.equal(store.snapshot().length, 2);
    fs.writeFileSync(filePath, "{broken", { mode: 0o600 });
    const recovered = new AgentInputRequestStore(filePath, { answerDigestKey: "digest-key" });
    assert.equal(recovered.snapshot().length, 1);
    assert.equal(recovered.snapshot()[0].id, first.outcome === "created" ? first.request.id : "");

    const futurePath = path.join(directory, "future.json");
    const future = `${JSON.stringify({ schemaVersion: CURRENT_AGENT_INPUT_REQUEST_SCHEMA_VERSION + 1, requests: [] })}\n`;
    fs.writeFileSync(futurePath, future, { mode: 0o600 });
    assert.throws(() => new AgentInputRequestStore(futurePath, { answerDigestKey: "key" }), UnsupportedAgentInputRequestVersionError);
    assert.equal(fs.readFileSync(futurePath, "utf8"), future);

    const migrationPath = path.join(directory, "migration.json");
    fs.writeFileSync(migrationPath, JSON.stringify({ schemaVersion: 0, requests: [], tombstones: [] }), { mode: 0o600 });
    new AgentInputRequestStore(migrationPath, { answerDigestKey: "key" });
    assert.equal(JSON.parse(fs.readFileSync(migrationPath, "utf8")).schemaVersion, CURRENT_AGENT_INPUT_REQUEST_SCHEMA_VERSION);

    const v7Path = path.join(directory, "migration-v7.json");
    const v7 = JSON.parse(fs.readFileSync(filePath, "utf8"));
    v7.schemaVersion = 7;
    fs.writeFileSync(v7Path, `${JSON.stringify(v7)}\n`, { mode: 0o600 });
    const migratedV7 = new AgentInputRequestStore(v7Path, { answerDigestKey: "digest-key" });
    assert.equal(migratedV7.snapshot().length, v7.requests.length);
    assert.equal(JSON.parse(fs.readFileSync(v7Path, "utf8")).schemaVersion, CURRENT_AGENT_INPUT_REQUEST_SCHEMA_VERSION);

    const v4Path = path.join(directory, "migration-v4.json");
    const v4 = JSON.parse(fs.readFileSync(filePath, "utf8"));
    v4.schemaVersion = 4;
    for (const request of v4.requests) delete request.occurrence;
    for (const tombstone of v4.tombstones) delete tombstone.occurrence;
    delete v4.generationAnchors;
    delete v4.retiredSources;
    fs.writeFileSync(v4Path, `${JSON.stringify(v4)}\n`, { mode: 0o600 });
    const migratedV4 = new AgentInputRequestStore(v4Path, { answerDigestKey: "digest-key" });
    const legacyRetry = capture(migratedV4, "oc-request", { occurrenceId: "fresh-after-migration" });
    assert.equal(legacyRetry.outcome, "created", "legacy unbound requests close and a fresh occurrence advances the preserved generation");
    assert.equal(legacyRetry.outcome === "created" && legacyRetry.request.generation, 2);

    let fail = false;
    const atomicPath = path.join(directory, "atomic.json");
    const atomic = new AgentInputRequestStore(atomicPath, { answerDigestKey: "key", beforeRename: () => { if (fail) throw new Error("injected"); } });
    fail = true;
    assert.throws(() => capture(atomic), /injected/);
    assert.equal(atomic.snapshot().length, 0);
    assert.equal(JSON.parse(fs.readFileSync(atomicPath, "utf8")).requests.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("request retention leaves generation tombstones and raw answers never reach disk, backups, snapshots, or errors", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-retention-"));
  const filePath = path.join(directory, "requests.json");
  try {
    const store = new AgentInputRequestStore(filePath, {
      answerDigestKey: "digest-key", resolvedRetentionMs: 10, tombstoneRetentionMs: 1_000,
    });
    const asked = capture(store);
    assert.equal(asked.outcome, "created");
    if (asked.outcome !== "created") return;
    const sentinel = ["EPHEMERAL", "ANSWER", "VALUE"].join("_");
    store.reserve(asked.request.id, 1, "submission", [[sentinel], ["Tests"]], 1_001);
    expose(store, asked.request.id, "submission", 1_001);
    store.complete(asked.request.id, 1, "submission", "delivered", undefined, 1_002);
    const removed = store.prune(1_100);
    assert.deepEqual(removed.removedIds, [asked.request.id]);
    const retainedRetry = capture(store, "oc-request");
    assert.deepEqual(retainedRetry.outcome === "duplicate" && retainedRetry.request, {
      id: asked.request.id, generation: 1, state: "answered",
    });
    const reused = capture(store, "oc-request", { occurrenceId: "occ-oc-request-reused", occurrenceOrdinal: 2 });
    assert.equal(reused.outcome === "created" && reused.request.generation, 2);
    for (const candidate of [filePath, `${filePath}.bak`]) {
      if (fs.existsSync(candidate)) assert.doesNotMatch(fs.readFileSync(candidate, "utf8"), new RegExp(sentinel));
    }
    assert.doesNotMatch(JSON.stringify(store.snapshot()), new RegExp(sentinel));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("request store refuses unsafe parent modes and symlink record paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-security-"));
  try {
    fs.chmodSync(directory, 0o755);
    assert.throws(() => new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "key" }), /owner-only/);
    fs.chmodSync(directory, 0o700);
    const target = path.join(directory, "target.json");
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    const link = path.join(directory, "link.json");
    fs.symlinkSync(target, link);
    assert.throws(() => new AgentInputRequestStore(link, { answerDigestKey: "key" }), /non-symlink/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("production retention timer prunes sustained mutations and dispose stops scheduled pruning", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-retention-timer-"));
  try {
    const store = new AgentInputRequestStore(path.join(directory, "requests.json"), {
      answerDigestKey: "key", resolvedRetentionMs: 1, tombstoneRetentionMs: 1_000, pruneIntervalMs: 5,
    });
    const first = capture(store, "timer-one");
    if (first.outcome !== "created") throw new Error("request unavailable");
    store.resolveNative(first.request.id, 1, "replied");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(store.find(first.request.id), undefined);

    const second = capture(store, "timer-two");
    if (second.outcome !== "created") throw new Error("request unavailable");
    store.resolveNative(second.request.id, 1, "replied");
    store.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(store.find(second.request.id), "dispose cancels the production prune timer");
    assert.deepEqual(store.prune(Date.now() + 10).removedIds, [second.request.id]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("v3 sdk-start, retryable, and in-doubt submissions migrate conservatively to durable ambiguity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-v3-migration-"));
  try {
    for (const [index, status] of ["retryable", "in_doubt", "reserved"] .entries()) {
      const filePath = path.join(directory, `${status}.json`);
      const store = new AgentInputRequestStore(filePath, { answerDigestKey: "key" });
      const asked = capture(store, `legacy-${status}`);
      if (asked.outcome !== "created") throw new Error("request unavailable");
      store.reserve(asked.request.id, 1, "stable", [["Safe"], ["Tests"]]);
      const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
      legacy.schemaVersion = 3;
      for (const request of legacy.requests) delete request.occurrence;
      for (const tombstone of legacy.tombstones) delete tombstone.occurrence;
      delete legacy.generationAnchors;
      delete legacy.retiredSources;
      legacy.submissions[0].status = status;
      legacy.submissions[0].outcome = status === "retryable" ? "source_unavailable" : "delivery_timeout";
      if (index === 2) legacy.submissions[0].sdkStartedAt = new Date().toISOString();
      fs.writeFileSync(filePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
      const migrated = new AgentInputRequestStore(filePath, { answerDigestKey: "key" });
      assert.equal(migrated.find(asked.request.id)?.resolution, "migration-unbound");
      assert.deepEqual(migrated.reserve(asked.request.id, 1, "stable", [["Safe"], ["Tests"]]), {
        outcome: "converged", result: { outcome: "already_resolved" },
      });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("single-shot persistence boundaries fail closed at reserve, buffer, exposure, and SDK result", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-boundary-faults-"));
  const filePath = path.join(directory, "requests.json");
  try {
    let fail = false;
    const store = new AgentInputRequestStore(filePath, {
      answerDigestKey: "key",
      beforeRename: () => { if (fail) throw new Error("injected-boundary"); },
    });
    const asked = capture(store, "faults");
    if (asked.outcome !== "created") throw new Error("request unavailable");
    const id = asked.request.id;
    const expectAtomicFailure = (operation: () => void, expectedStatus: string | undefined) => {
      fail = true;
      assert.throws(operation, /injected-boundary/);
      fail = false;
      const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(persisted.submissions[0]?.status, expectedStatus);
    };
    expectAtomicFailure(() => { store.reserve(id, 1, "stable", [["Safe"], ["Tests"]]); }, undefined);
    store.reserve(id, 1, "stable", [["Safe"], ["Tests"]]);
    expectAtomicFailure(() => { store.bindDelivery(id, 1, "stable", `delivery_${"b".repeat(16)}`); }, "reserved");
    store.bindDelivery(id, 1, "stable", `delivery_${"b".repeat(16)}`);
    expectAtomicFailure(() => { store.observe(id, 1, "stable"); }, "reserved");
    store.observe(id, 1, "stable");
    expectAtomicFailure(() => { store.complete(id, 1, "stable", "delivered"); }, "exposed");
    const restarted = new AgentInputRequestStore(filePath, { answerDigestKey: "key" });
    assert.equal(restarted.submissionState(id)?.status, "reserved");
    assert.equal(restarted.reserve(id, 1, "stable", [["Safe"], ["Tests"]]).outcome, "resumed");
    restarted.bindDelivery(id, 1, "stable", `delivery_${"c".repeat(16)}`);
    restarted.observe(id, 1, "stable");
    restarted.markSdkStarted(id, 1, "stable");
    const afterSdkStart = new AgentInputRequestStore(filePath, { answerDigestKey: "key" });
    assert.equal(afterSdkStart.submissionState(id)?.status, "ambiguous");
    assert.deepEqual(afterSdkStart.reserve(id, 1, "stable", [["Safe"], ["Tests"]]), {
      outcome: "converged", result: { outcome: "sdk_error", code: "delivery_ambiguous", retryable: false },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("request durability fsyncs the containing directory after each rename and restarts from the renamed primary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-directory-fsync-"));
  const filePath = path.join(directory, "requests.json");
  try {
    const events: string[] = [];
    const store = new AgentInputRequestStore(filePath, {
      answerDigestKey: "key",
      directoryFsync: (syncedDirectory, target) => {
        assert.equal(syncedDirectory, directory);
        assert.ok(fs.existsSync(target === "backup" ? `${filePath}.bak` : filePath));
        events.push(target);
      },
    });
    assert.deepEqual(events, ["primary"]);
    events.length = 0;
    const asked = capture(store, "fsync-order");
    assert.deepEqual(events, ["backup", "primary"]);
    if (asked.outcome !== "created") throw new Error("request unavailable");
    store.reserve(asked.request.id, 1, "stable", [["Safe"], ["Tests"]]);
    store.bindDelivery(asked.request.id, 1, "stable", `delivery_${"d".repeat(16)}`);
    events.length = 0;
    store.observe(asked.request.id, 1, "stable");
    assert.deepEqual(events, ["backup", "primary"], "answer exposure is durable only after both directory fsync boundaries");

    let failPrimarySync = false;
    const faultPath = path.join(directory, "fault.json");
    const faulted = new AgentInputRequestStore(faultPath, {
      answerDigestKey: "key",
      directoryFsync: (_syncedDirectory, target) => {
        if (failPrimarySync && target === "primary") {
          assert.equal(JSON.parse(fs.readFileSync(faultPath, "utf8")).requests.length, 1,
            "the primary rename precedes its directory fsync");
          throw new Error("injected-directory-fsync");
        }
      },
    });
    failPrimarySync = true;
    assert.throws(() => capture(faulted, "power-loss-primary"), /injected-directory-fsync/);
    assert.equal(faulted.snapshot().length, 0, "failed durability acknowledgement does not advance in-memory state");
    assert.equal(new AgentInputRequestStore(faultPath, { answerDigestKey: "key" }).snapshot().length, 1,
      "restart accepts the complete renamed primary rather than losing or partially parsing it");

    let failBackupSync = false;
    const backupFaultPath = path.join(directory, "backup-fault.json");
    const backupFault = new AgentInputRequestStore(backupFaultPath, {
      answerDigestKey: "key",
      directoryFsync: (_syncedDirectory, target) => {
        if (failBackupSync && target === "backup") {
          assert.ok(fs.existsSync(`${backupFaultPath}.bak`), "the backup rename precedes its directory fsync");
          throw new Error("injected-backup-directory-fsync");
        }
      },
    });
    failBackupSync = true;
    assert.throws(() => capture(backupFault, "power-loss-backup"), /injected-backup-directory-fsync/);
    assert.equal(new AgentInputRequestStore(backupFaultPath, { answerDigestKey: "key" }).snapshot().length, 0,
      "a backup-boundary failure leaves the prior primary authoritative");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("complete occurrence snapshots close every absent pending state and preserve exact included members", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-occurrence-barrier-"));
  try {
    const store = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "key" });
    const captures = ["ordinary", "reserved", "exposed", "ambiguous", "failed", "present"].map((id) => capture(store, id));
    if (captures.some((item) => item.outcome !== "created")) throw new Error("request unavailable");
    const created = captures.map((item) => item.outcome === "created" ? item.request : undefined!);
    store.reserve(created[1].id, 1, "reserved", [["Safe"], ["Tests"]]);
    store.reserve(created[2].id, 1, "exposed", [["Safe"], ["Tests"]]);
    expose(store, created[2].id, "exposed");
    store.reserve(created[3].id, 1, "ambiguous", [["Safe"], ["Tests"]]);
    expose(store, created[3].id, "ambiguous");
    store.markSdkStarted(created[3].id, 1, "ambiguous");
    store.release(created[3].id, 1, "ambiguous", "delivery_timeout", undefined, true);
    store.reserve(created[4].id, 1, "failed", [["Safe"], ["Tests"]]);
    expose(store, created[4].id, "failed");
    store.complete(created[4].id, 1, "failed", "sdk_error", "BadRequest", 1_010, false);
    const presentInput = {
      occurrenceId: "occ-present", occurrenceKey: nativeOccurrenceKey("session-one", "present"), ordinal: 1,
      payloadDigest: capturePayloadDigest({ openCodeSessionId: "session-one", openCodeRequestId: "present", questions }),
      sessionID: "session-one", requestID: "present", questions,
    };
    const closed = store.resolveNativeAbsent("source-one", [presentInput]);
    assert.deepEqual(closed.map((item) => item.id).sort(), created.slice(0, 5).map((item) => item.id).sort());
    assert.equal(store.find(created[5].id)?.state, "pending");
    for (const request of created.slice(0, 5)) assert.equal(store.find(request.id)?.state, "closed");
    for (const request of created.slice(1, 5)) assert.equal(store.submissionState(request.id)?.status, "already_resolved");
    assert.throws(() => store.resolveNativeAbsent("source-one", [{ ...presentInput, payloadDigest: "0".repeat(64) }]), /invalid_reconciliation/);
    assert.equal(store.find(created[5].id)?.state, "pending", "an invalid/partial barrier performs no closure");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cut-scoped snapshot absence closes only applicable native keys", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-scoped-barrier-"));
  try {
    const store = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "key" });
    const beforeCut = capture(store, "before-cut");
    const afterCut = capture(store, "after-cut");
    if (beforeCut.outcome !== "created" || afterCut.outcome !== "created") throw new Error("request unavailable");
    const beforeKey = nativeOccurrenceKey("session-one", "before-cut");
    assert.deepEqual(store.resolveNativeAbsent("source-one", [], [beforeKey]), [{
      id: beforeCut.request.id, generation: 1,
    }]);
    assert.equal(store.find(beforeCut.request.id)?.state, "closed");
    assert.equal(store.find(afterCut.request.id)?.state, "pending");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("generation anchors survive request and tombstone pruning and retire old exact operations after recovery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-anchor-retention-"));
  const filePath = path.join(directory, "requests.json");
  try {
    let store = new AgentInputRequestStore(filePath, { answerDigestKey: "key", resolvedRetentionMs: 1, tombstoneRetentionMs: 1 });
    const first = capture(store, "reused");
    if (first.outcome !== "created") throw new Error("request unavailable");
    store.resolveNative(first.request.id, 1, "occ-reused", "replied", 1_001);
    store.prune(2_000);
    store.prune(3_000);
    assert.equal(store.find(first.request.id), undefined);
    assert.deepEqual(store.resolveNative(first.request.id, 1, "occ-reused", "replied"), { outcome: "retired" });
    const retry = capture(store, "reused");
    assert.equal(retry.outcome, "retired");
    const second = capture(store, "reused", { occurrenceId: "occ-reused-2", occurrenceOrdinal: 2 });
    assert.equal(second.outcome === "created" && second.request.generation, 2);
    fs.writeFileSync(filePath, "{broken", { mode: 0o600 });
    store = new AgentInputRequestStore(filePath, { answerDigestKey: "key", resolvedRetentionMs: 1, tombstoneRetentionMs: 1 });
    assert.notEqual(store.resolveNative(first.request.id, 1, "occ-reused", "replied").outcome, "resolved");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("occurrence allocation, snapshot barrier, and exact resolution fault cuts remain atomic", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-occurrence-fault-cuts-"));
  const filePath = path.join(directory, "requests.json");
  try {
    let fail = false;
    const store = new AgentInputRequestStore(filePath, { answerDigestKey: "key", beforeRename: () => {
      if (fail) throw new Error("occurrence-fault-cut");
    } });
    fail = true;
    assert.throws(() => capture(store, "allocation"), /occurrence-fault-cut/);
    assert.equal(store.snapshot().length, 0);
    fail = false;
    const captured = capture(store, "allocation");
    if (captured.outcome !== "created") throw new Error("request unavailable");
    fail = true;
    assert.throws(() => store.resolveNativeAbsent("source-one", []), /occurrence-fault-cut/);
    assert.equal(store.find(captured.request.id)?.state, "pending");
    assert.throws(() => store.resolveNative(captured.request.id, 1, "occ-allocation", "replied"), /occurrence-fault-cut/);
    assert.equal(store.find(captured.request.id)?.state, "pending");
    fail = false;
    assert.equal(store.resolveNative(captured.request.id, 1, "occ-allocation", "replied").outcome, "resolved");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("backup recovery closes every potentially exposed submission without losing generation anchors", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-monotonic-recovery-"));
  const filePath = path.join(directory, "requests.json");
  try {
    let store = new AgentInputRequestStore(filePath, { answerDigestKey: "key" });
    const asked = capture(store, "recovery");
    if (asked.outcome !== "created") throw new Error("request unavailable");
    store.reserve(asked.request.id, 1, "stable", [["Safe"], ["Tests"]]);
    store.bindDelivery(asked.request.id, 1, "stable", `delivery_${"e".repeat(16)}`);
    store.observe(asked.request.id, 1, "stable");
    assert.equal(JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8")).submissions[0].status, "reserved");
    fs.writeFileSync(filePath, "{broken", { mode: 0o600 });

    store = new AgentInputRequestStore(filePath, { answerDigestKey: "key" });
    assert.equal(store.find(asked.request.id)?.state, "closed");
    assert.deepEqual(store.reserve(asked.request.id, 1, "stable", [["Safe"], ["Tests"]]), {
      outcome: "converged", result: { outcome: "already_resolved" },
    });
    const exact = capture(store, "recovery");
    assert.deepEqual(exact.outcome === "duplicate" && {
      id: exact.request.id, generation: exact.request.generation, state: exact.request.state,
    }, { id: asked.request.id, generation: 1, state: "closed" });
    const next = capture(store, "recovery", { occurrenceId: "occ-recovery-two", occurrenceOrdinal: 2 });
    assert.equal(next.outcome === "created" && next.request.generation, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("per-source count and byte quotas isolate a saturating source from unrelated capture", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-source-quotas-"));
  try {
    const countStore = new AgentInputRequestStore(path.join(directory, "counts.json"), { answerDigestKey: "key" });
    for (let index = 0; index < MAX_AGENT_INPUT_PENDING_PER_SOURCE; index += 1) {
      assert.equal(capture(countStore, `count-${index}`).outcome, "created");
    }
    assert.throws(() => capture(countStore, "count-overflow"), /source_pending_limit/);
    assert.equal(capture(countStore, "other-source", { sourceId: "source-two" }).outcome, "created");

    const byteStore = new AgentInputRequestStore(path.join(directory, "bytes.json"), { answerDigestKey: "key" });
    const largeQuestions = [{
      header: "Large", question: "x".repeat(16_000), multiple: false, custom: true,
      options: Array.from({ length: 100 }, (_, index) => ({ label: `${index}-${"l".repeat(1_000)}`, description: "d".repeat(4_000) })),
    }];
    let limited = false;
    for (let index = 0; index < 16; index += 1) {
      try { capture(byteStore, `bytes-${index}`, { questions: largeQuestions }); }
      catch (error) {
        assert.match(String(error), /source_byte_limit/);
        limited = true;
        break;
      }
    }
    assert.equal(limited, true);
    assert.equal(capture(byteStore, "bytes-other", { sourceId: "source-two" }).outcome, "created");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("serialized admission quotas are exact while lifecycle headroom guarantees terminal mutations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-hard-byte-quotas-"));
  try {
    const seedPath = path.join(directory, "seed.json");
    const seed = new AgentInputRequestStore(seedPath, { answerDigestKey: "key" });
    assert.equal(capture(seed, "boundary").outcome, "created");
    const seeded = readStoredEnvelope(seedPath);
    const exactSource = sourceBytes(seeded, "source-one");
    const withoutAttention = sourceBytes(seeded, "source-one", false);
    const exactGlobal = compactBytes(seeded);

    const attentionPath = path.join(directory, "attention.json");
    const attentionStore = new AgentInputRequestStore(attentionPath, {
      answerDigestKey: "key", maxSerializedBytesPerSource: withoutAttention,
    });
    const attentionError = expectQuota(() => capture(attentionStore, "boundary"), "source_byte_limit");
    assert.equal(attentionError.limit, withoutAttention);
    assert.equal(readStoredEnvelope(attentionPath).requests.length, 0,
      "attention bytes are attributed before capture persistence");

    const sourcePath = path.join(directory, "source-exact.json");
    const sourceStore = new AgentInputRequestStore(sourcePath, {
      answerDigestKey: "key", maxSerializedBytesPerSource: exactSource,
    });
    const captured = capture(sourceStore, "boundary");
    if (captured.outcome !== "created") throw new Error("boundary capture unavailable");
    assert.equal(sourceBytes(readStoredEnvelope(sourcePath), "source-one"), exactSource);
    let changes = 0;
    sourceStore.on("change", () => changes += 1);
    const exactHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
    const assertRolledBack = () => {
      assert.equal(crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"), exactHash);
      assert.equal(changes, 0, "quota failures publish no change event");
    };
    const reserveError = expectQuota(() => sourceStore.reserve(
      captured.request.id, 1, "stable", [["Safe"], ["Tests"]], 1_001,
    ), "source_byte_limit");
    assert.equal(reserveError.sourceId, "source-one");
    assert.equal(readStoredEnvelope(sourcePath).submissions.length, 0);
    assertRolledBack();
    assert.equal(sourceStore.resolveNative(
      captured.request.id, 1, "occ-boundary", "replied", 1_002,
    ).outcome, "resolved");
    assert.equal(sourceStore.find(captured.request.id)?.state, "answered");
    assert.equal(sourceStore.retireSource("source-one", 1_003), 0);
    assert.deepEqual(readStoredEnvelope(sourcePath).retiredSources, [{
      sourceId: "source-one", retiredAt: new Date(1_003).toISOString(),
    }]);
    assert.equal(changes, 2, "terminal resolution and retirement both publish durable state");

    const globalPath = path.join(directory, "global-exact.json");
    const globalStore = new AgentInputRequestStore(globalPath, {
      answerDigestKey: "key", maxSerializedBytes: exactGlobal,
    });
    const globalCapture = capture(globalStore, "boundary");
    if (globalCapture.outcome !== "created") throw new Error("global boundary capture unavailable");
    assert.equal(compactBytes(readStoredEnvelope(globalPath)), exactGlobal);
    const globalHash = crypto.createHash("sha256").update(fs.readFileSync(globalPath)).digest("hex");
    expectQuota(() => globalStore.reserve(
      globalCapture.request.id, 1, "stable", [["Safe"], ["Tests"]], 1_001,
    ), "global_byte_limit");
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(globalPath)).digest("hex"), globalHash);
    assert.equal(globalStore.retireSource("source-one", 1_002), 1,
      "global lifecycle headroom remains available at the admission boundary");

    const prunePath = path.join(directory, "prune.json");
    let pruneStore = new AgentInputRequestStore(prunePath, { answerDigestKey: "key" });
    const pruneCapture = capture(pruneStore, "prune");
    if (pruneCapture.outcome !== "created") throw new Error("prune capture unavailable");
    assert.equal(pruneStore.resolveNative(pruneCapture.request.id, 1, "occ-prune", "replied", 1_001).outcome, "resolved");
    pruneStore.dispose();
    const beforePrune = readStoredEnvelope(prunePath);
    const beforePruneSource = sourceBytes(beforePrune, "source-one");
    const beforePruneGlobal = compactBytes(beforePrune);
    pruneStore = new AgentInputRequestStore(prunePath, {
      answerDigestKey: "key", resolvedRetentionMs: 1, tombstoneRetentionMs: 1_000,
      maxSerializedBytesPerSource: beforePruneSource - 1,
      maxSerializedBytes: beforePruneGlobal - 1,
    });
    assert.deepEqual(pruneStore.prune(2_000).removedIds, [pruneCapture.request.id]);
    const afterPrune = readStoredEnvelope(prunePath);
    assert.ok(sourceBytes(afterPrune, "source-one") < beforePruneSource);
    assert.ok(compactBytes(afterPrune) < beforePruneGlobal,
      "a reducing prune remains allowed when the loaded store starts above both ceilings");

    const isolationPath = path.join(directory, "isolation.json");
    let isolationStore = new AgentInputRequestStore(isolationPath, { answerDigestKey: "key" });
    assert.equal(capture(isolationStore, "saturated").outcome, "created");
    isolationStore.dispose();
    const saturatedSourceBytes = sourceBytes(readStoredEnvelope(isolationPath), "source-one");
    isolationStore = new AgentInputRequestStore(isolationPath, {
      answerDigestKey: "key", maxSerializedBytesPerSource: saturatedSourceBytes - 1,
    });
    assert.equal(capture(isolationStore, "isolated", { sourceId: "source-two" }).outcome, "created",
      "an unchanged over-ceiling source does not block unrelated source growth");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fixed lifecycle ceilings accept exact serialized boundaries and reject one additional byte", () => {
  const empty = () => ({
    schemaVersion: CURRENT_AGENT_INPUT_REQUEST_SCHEMA_VERSION,
    requests: [], submissions: [], tombstones: [], attention: [], generationAnchors: [], retiredSources: [],
  });
  const request = (index: number, sourceId: string, questionLength = 16_384) => ({
    id: `quota-request-${index}`,
    sourceId,
    workspaceId: "workspace",
    tabId: "tab",
    paneId: "pane",
    machineId: "local",
    openCodeSessionId: "session",
    openCodeRequestId: `native-${index}`,
    generation: 1,
    questions: [{
      header: "H", question: "x".repeat(questionLength), options: [], multiple: false, custom: true,
    }],
    state: "pending",
    createdAt: "1970-01-01T00:00:01.000Z",
    updatedAt: "1970-01-01T00:00:01.000Z",
  });
  const envelopeAt = (target: number, sourceConfined: boolean) => {
    const envelope: any = empty();
    const measure = () => sourceConfined ? sourceBytes(envelope, "source-boundary") : compactBytes(envelope);
    let currentBytes = measure();
    while (true) {
      const sourceId = sourceConfined ? "source-boundary" : `source-${envelope.requests.length}`;
      const candidate = request(envelope.requests.length, sourceId);
      const delta = compactBytes(candidate) + (envelope.requests.length > 0 ? 1 : 0);
      if (target - currentBytes <= delta) break;
      envelope.requests.push(candidate);
      currentBytes += delta;
    }
    const sourceId = sourceConfined ? "source-boundary" : `source-${envelope.requests.length}`;
    const adjustable = request(envelope.requests.length, sourceId, 1);
    const minimumDelta = compactBytes(adjustable) + (envelope.requests.length > 0 ? 1 : 0);
    let gap = target - currentBytes;
    if (gap < minimumDelta) {
      const lastFull = envelope.requests.at(-1);
      assert.ok(lastFull);
      const freed = minimumDelta - gap;
      lastFull.questions[0].question = lastFull.questions[0].question.slice(freed);
      currentBytes -= freed;
      gap += freed;
    }
    const remaining = gap - minimumDelta;
    assert.ok(remaining >= 0 && remaining < 16_384);
    adjustable.questions[0].question += "x".repeat(remaining);
    envelope.requests.push(adjustable);
    assert.equal(measure(), target);
    return envelope;
  };
  const limits = {
    perSource: MAX_AGENT_INPUT_LIFECYCLE_BYTES_PER_SOURCE,
    global: MAX_AGENT_INPUT_LIFECYCLE_BYTES,
  };

  const exactSource: any = envelopeAt(MAX_AGENT_INPUT_LIFECYCLE_BYTES_PER_SOURCE, true);
  assert.doesNotThrow(() => enforceSerializedQuotaGrowth(empty() as any, exactSource, limits));
  const sourceOverflow = structuredClone(exactSource);
  sourceOverflow.requests[0].questions[0].header += "X";
  assert.equal(expectQuota(
    () => enforceSerializedQuotaGrowth(empty() as any, sourceOverflow, limits),
    "source_byte_limit",
  ).afterBytes, MAX_AGENT_INPUT_LIFECYCLE_BYTES_PER_SOURCE + 1);

  const exactGlobal: any = envelopeAt(MAX_AGENT_INPUT_LIFECYCLE_BYTES, false);
  assert.doesNotThrow(() => enforceSerializedQuotaGrowth(empty() as any, exactGlobal, limits));
  const globalOverflow = structuredClone(exactGlobal);
  globalOverflow.requests[0].questions[0].header += "X";
  assert.equal(expectQuota(
    () => enforceSerializedQuotaGrowth(empty() as any, globalOverflow, limits),
    "global_byte_limit",
  ).afterBytes, MAX_AGENT_INPUT_LIFECYCLE_BYTES + 1);
});

test("retired-source churn compacts generation anchors only after request and tombstone evidence expires", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-retired-churn-"));
  const filePath = path.join(directory, "requests.json");
  try {
    const store = new AgentInputRequestStore(filePath, {
      answerDigestKey: "key", resolvedRetentionMs: 1, tombstoneRetentionMs: 1,
    });
    const active = capture(store, "active", { sourceId: "source-active" });
    if (active.outcome !== "created") throw new Error("active request unavailable");
    store.resolveNative(active.request.id, 1, "occ-active", "replied", 1_001);
    for (let index = 0; index < 40; index += 1) {
      const sourceId = `source-retired-${index}`;
      const request = capture(store, `retired-${index}`, { sourceId });
      if (request.outcome !== "created") throw new Error("retired request unavailable");
      store.retireSource(sourceId, 1_001);
      assert.throws(() => capture(store, `new-${index}`, { sourceId }), /source_retired/);
    }
    store.prune(2_000);
    let persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(persisted.generationAnchors.length, 41, "tombstone evidence still pins every anchor");
    store.prune(3_000);
    persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepEqual(persisted.generationAnchors.map((anchor: any) => anchor.sourceId), ["source-active"]);
    assert.deepEqual(persisted.retiredSources, []);
    assert.equal(capture(store, "active", { sourceId: "source-active" }).outcome, "retired",
      "compacting retired sources does not regress a retained source's replay fence");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
