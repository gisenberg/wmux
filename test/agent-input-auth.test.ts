import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentInputCredentialStore,
  CURRENT_AGENT_INPUT_CREDENTIAL_SCHEMA_VERSION,
  UnsupportedAgentInputCredentialVersionError,
} from "../src/server/agent-input-credential-store.js";
import {
  OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
  SUPPORTED_OPENCODE_SDK_VERSION,
} from "../src/server/opencode-question-contract.js";

const context = {
  workspaceId: "workspace-one",
  tabId: "tab-one",
  paneId: "pane-one",
  machineId: "local",
  sourceKind: "opencode" as const,
};
const registration = {
  instanceNonce: "instance-one",
  kind: "opencode" as const,
  pluginVersion: SUPPORTED_OPENCODE_SDK_VERSION,
  sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION,
  compatibilityFingerprint: OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
};

test("single-use capability exchange persists hashes only and relay refresh rotates immediately", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-auth-"));
  const filePath = path.join(directory, "credentials.json");
  try {
    const store = new AgentInputCredentialStore(filePath, { hashKey: "server-key", capabilityTtlMs: 100, relayTtlMs: 500 });
    const issued = store.issueRegistrationCapability(context, 1_000);
    const registrationPrincipal = store.authenticate(issued.capability, 1_001);
    assert.equal(registrationPrincipal?.kind, "agent-input-registration");
    if (registrationPrincipal?.kind !== "agent-input-registration") return;
    const exchange = store.exchange(registrationPrincipal, registration, 1_002);
    assert.equal(exchange.outcome, "issued");
    if (exchange.outcome !== "issued") return;
    assert.notEqual(exchange.relaySecret, issued.capability);
    const persisted = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(persisted, new RegExp(issued.capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(persisted, new RegExp(exchange.relaySecret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(store.authenticate(issued.capability, 1_003), undefined);
    const recoveredExchange = store.exchange(registrationPrincipal, registration, 1_003);
    assert.deepEqual(recoveredExchange, { outcome: "already_exchanged", sourceId: exchange.sourceId });
    assert.deepEqual(store.exchange(registrationPrincipal, { ...registration, instanceNonce: "other" }, 1_003), {
      outcome: "already_exchanged", sourceId: exchange.sourceId,
    });

    const sourcePrincipal = store.authenticate(exchange.relaySecret, 1_010);
    assert.equal(sourcePrincipal?.kind, "agent-input-source");
    if (sourcePrincipal?.kind !== "agent-input-source") return;
    assert.equal(sourcePrincipal.sourceId, exchange.sourceId);
    assert.equal(sourcePrincipal.paneId, context.paneId);
    const refreshed = store.refresh(sourcePrincipal, 1_020);
    assert.notEqual(refreshed.relaySecret, exchange.relaySecret);
    assert.equal(store.authenticate(exchange.relaySecret, 1_021), undefined);
    const refreshedPrincipal = store.authenticate(refreshed.relaySecret, 1_021);
    assert.equal(refreshedPrincipal?.kind, "agent-input-source");
    assert.equal(store.revoke(exchange.sourceId, 1_030), true);
    assert.equal(store.authenticate(refreshed.relaySecret, 1_031), undefined);
    const disabledCapability = store.issueRegistrationCapability(context, 2_000);
    assert.equal(store.invalidateCapabilities(2_001), 1);
    assert.equal(store.authenticate(disabledCapability.capability, 2_002), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("capability and source expiry, unsupported versions, migrations, backup recovery, and future refusal fail closed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-auth-durable-"));
  const filePath = path.join(directory, "credentials.json");
  try {
    const store = new AgentInputCredentialStore(filePath, { hashKey: "server-key", capabilityTtlMs: 10, relayTtlMs: 20 });
    const expired = store.issueRegistrationCapability(context, 1_000);
    assert.equal(store.authenticate(expired.capability, 1_011), undefined);
    const valid = store.issueRegistrationCapability(context, 2_000);
    const principal = store.authenticate(valid.capability, 2_001);
    assert.equal(principal?.kind, "agent-input-registration");
    if (principal?.kind !== "agent-input-registration") return;
    const unsupported = store.exchange(principal, { ...registration, sdkVersion: "future" }, 2_002);
    assert.equal(unsupported.outcome === "issued" && unsupported.supported, false);
    if (unsupported.outcome === "issued") assert.equal(store.isAvailable(unsupported.sourceId, 2_003), false);

    const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const legacyHash = { salt: "00".repeat(16), digest: "00".repeat(32) };
    const migrationPath = path.join(directory, "migration.json");
    fs.writeFileSync(migrationPath, JSON.stringify({
      schemaVersion: 0,
      capabilities: envelope.capabilities.map(({ verifier: _verifier, ...value }: any) => ({ ...value, hash: legacyHash })),
      sources: envelope.sources.map(({ secretVerifier: _verifier, ...value }: any) => ({ ...value, secretHash: legacyHash })),
    }), { mode: 0o600 });
    const migrated = new AgentInputCredentialStore(migrationPath, { hashKey: "server-key" });
    assert.equal(JSON.parse(fs.readFileSync(migrationPath, "utf8")).schemaVersion, 2);
    assert.ok(migrated.snapshot().sources.every((source) => source.revokedAt !== undefined));

    store.issueRegistrationCapability(context, 3_000);
    store.issueRegistrationCapability(context, 3_001);
    fs.writeFileSync(filePath, "{broken", { mode: 0o600 });
    const recovered = new AgentInputCredentialStore(filePath, { hashKey: "server-key" });
    assert.ok(recovered.snapshot().capabilities.length >= 1);

    const futurePath = path.join(directory, "future.json");
    const future = `${JSON.stringify({ schemaVersion: CURRENT_AGENT_INPUT_CREDENTIAL_SCHEMA_VERSION + 1 })}\n`;
    fs.writeFileSync(futurePath, future, { mode: 0o600 });
    assert.throws(() => new AgentInputCredentialStore(futurePath, { hashKey: "key" }), UnsupportedAgentInputCredentialVersionError);
    assert.equal(fs.readFileSync(futurePath, "utf8"), future);

    let fail = false;
    const atomicPath = path.join(directory, "atomic.json");
    const atomic = new AgentInputCredentialStore(atomicPath, {
      hashKey: "server-key",
      beforeRename: () => { if (fail) throw new Error("injected"); },
    });
    fail = true;
    assert.throws(() => atomic.issueRegistrationCapability(context), /injected/);
    assert.equal(atomic.snapshot().capabilities.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(atomicPath, "utf8")).capabilities.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("credential store refuses unsafe parents and symlinks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-auth-security-"));
  try {
    fs.chmodSync(directory, 0o755);
    assert.throws(() => new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "key" }), /owner-only/);
    fs.chmodSync(directory, 0o700);
    const target = path.join(directory, "target.json");
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    const link = path.join(directory, "link.json");
    fs.symlinkSync(target, link);
    assert.throws(() => new AgentInputCredentialStore(link, { hashKey: "key" }), /non-symlink/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("record-id HMAC authentication keeps malformed bearer floods off the event-loop scrypt path", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-auth-flood-"));
  try {
    const store = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "server-key" });
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    for (let index = 0; index < 10_000; index += 1) {
      assert.equal(store.authenticate(`ais_00000000-0000-4000-8000-${String(index).padStart(12, "0")}.${"x".repeat(43)}`), undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearTimeout(timer);
    assert.equal(timerFired, true);
    assert.doesNotMatch(fs.readFileSync(new URL("../src/server/agent-input-credential-store.ts", import.meta.url), "utf8"), /scryptSync|dummyHash/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("credential rotation and revoke fsync directory rename boundaries and fail closed after an unacknowledged primary fsync", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-auth-directory-fsync-"));
  const filePath = path.join(directory, "credentials.json");
  try {
    const events: string[] = [];
    const store = new AgentInputCredentialStore(filePath, {
      hashKey: "server-key",
      directoryFsync: (syncedDirectory, target) => {
        assert.equal(syncedDirectory, directory);
        assert.ok(fs.existsSync(target === "backup" ? `${filePath}.bak` : filePath));
        events.push(target);
      },
    });
    assert.deepEqual(events, ["primary"]);
    const capability = store.issueRegistrationCapability(context, 1_000);
    const registrationPrincipal = store.authenticate(capability.capability, 1_001);
    if (registrationPrincipal?.kind !== "agent-input-registration") throw new Error("registration unavailable");
    const exchange = store.exchange(registrationPrincipal, registration, 1_002);
    if (exchange.outcome !== "issued") throw new Error("source unavailable");
    const principal = store.authenticate(exchange.relaySecret, 1_003);
    if (principal?.kind !== "agent-input-source") throw new Error("principal unavailable");
    events.length = 0;
    const refreshed = store.refresh(principal, 1_004);
    assert.deepEqual(events, ["backup", "primary"], "rotation fsyncs the backup and primary directory entries");
    events.length = 0;
    assert.equal(store.revoke(exchange.sourceId, 1_005), true);
    assert.deepEqual(events, ["backup", "primary"], "revoke fsyncs the backup and primary directory entries");
    assert.equal(store.authenticate(refreshed.relaySecret, 1_006), undefined);

    const faultPath = path.join(directory, "fault-credentials.json");
    let failPrimarySync = false;
    const faulted = new AgentInputCredentialStore(faultPath, {
      hashKey: "server-key",
      directoryFsync: (_syncedDirectory, target) => {
        if (failPrimarySync && target === "primary") {
          assert.equal(JSON.parse(fs.readFileSync(faultPath, "utf8")).sources[0].credentialGeneration, 2,
            "credential rotation rename precedes its directory fsync");
          throw new Error("injected-directory-fsync");
        }
      },
    });
    const faultCapability = faulted.issueRegistrationCapability(context, 2_000);
    const faultRegistration = faulted.authenticate(faultCapability.capability, 2_001);
    if (faultRegistration?.kind !== "agent-input-registration") throw new Error("fault registration unavailable");
    const faultExchange = faulted.exchange(faultRegistration, registration, 2_002);
    if (faultExchange.outcome !== "issued") throw new Error("fault source unavailable");
    const faultPrincipal = faulted.authenticate(faultExchange.relaySecret, 2_003);
    if (faultPrincipal?.kind !== "agent-input-source") throw new Error("fault principal unavailable");
    failPrimarySync = true;
    assert.throws(() => faulted.refresh(faultPrincipal, 2_004), /injected-directory-fsync/);
    const restarted = new AgentInputCredentialStore(faultPath, { hashKey: "server-key" });
    assert.equal(restarted.snapshot().sources[0].credentialGeneration, 2);
    assert.equal(restarted.authenticate(faultExchange.relaySecret, 2_005), undefined,
      "restart fails closed because the unreturned rotated plaintext cannot be reconstructed");

    fs.writeFileSync(filePath, "{broken", { mode: 0o600 });
    events.length = 0;
    new AgentInputCredentialStore(filePath, {
      hashKey: "server-key",
      directoryFsync: (_syncedDirectory, target) => events.push(target),
    });
    assert.deepEqual(events, ["quarantine", "primary"], "recovery fsyncs both quarantine and restored-primary renames");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("backup recovery invalidates pre-refresh, pre-revoke, and pre-exchange authority before authentication", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-auth-monotonic-recovery-"));
  try {
    const createSource = (name: string) => {
      const filePath = path.join(directory, `${name}.json`);
      const store = new AgentInputCredentialStore(filePath, { hashKey: "server-key" });
      const capability = store.issueRegistrationCapability(context, 1_000);
      const registrationPrincipal = store.authenticate(capability.capability, 1_001);
      if (registrationPrincipal?.kind !== "agent-input-registration") throw new Error("registration unavailable");
      const exchange = store.exchange(registrationPrincipal, registration, 1_002);
      if (exchange.outcome !== "issued") throw new Error("source unavailable");
      const principal = store.authenticate(exchange.relaySecret, 1_003);
      if (principal?.kind !== "agent-input-source") throw new Error("principal unavailable");
      return { filePath, store, capability, exchange, principal };
    };

    const exchanged = createSource("exchange");
    fs.writeFileSync(exchanged.filePath, "{broken", { mode: 0o600 });
    const recoveredExchange = new AgentInputCredentialStore(exchanged.filePath, { hashKey: "server-key" });
    assert.equal(recoveredExchange.authenticate(exchanged.capability.capability, 1_004), undefined);
    assert.equal(recoveredExchange.authenticate(exchanged.exchange.relaySecret, 1_004), undefined);
    assert.ok(recoveredExchange.snapshot().capabilities.every((item) => item.usedAt !== undefined));
    assert.ok(recoveredExchange.snapshot().sources.every((item) => item.revokedAt !== undefined));

    const refreshed = createSource("refresh");
    const rotated = refreshed.store.refresh(refreshed.principal, 1_004);
    fs.writeFileSync(refreshed.filePath, "{broken", { mode: 0o600 });
    const recoveredRefresh = new AgentInputCredentialStore(refreshed.filePath, { hashKey: "server-key" });
    assert.equal(recoveredRefresh.authenticate(refreshed.exchange.relaySecret, 1_005), undefined);
    assert.equal(recoveredRefresh.authenticate(rotated.relaySecret, 1_005), undefined);
    assert.ok(recoveredRefresh.snapshot().sources.every((item) => item.revokedAt !== undefined));

    const revoked = createSource("revoke");
    revoked.store.revoke(revoked.exchange.sourceId, 1_004);
    fs.writeFileSync(revoked.filePath, "{broken", { mode: 0o600 });
    const recoveredRevoke = new AgentInputCredentialStore(revoked.filePath, { hashKey: "server-key" });
    assert.equal(recoveredRevoke.authenticate(revoked.exchange.relaySecret, 1_005), undefined);
    assert.ok(recoveredRevoke.snapshot().sources.every((item) => item.revokedAt !== undefined));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("retired source records compact without allowing an old source ID or credential to return", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-auth-retirement-"));
  try {
    const store = new AgentInputCredentialStore(path.join(directory, "credentials.json"), { hashKey: "server-key" });
    const issue = (nonce: string, nowMs: number) => {
      const capability = store.issueRegistrationCapability(context, nowMs);
      const principal = store.authenticate(capability.capability, nowMs + 1);
      if (principal?.kind !== "agent-input-registration") throw new Error("registration unavailable");
      const exchange = store.exchange(principal, { ...registration, instanceNonce: nonce }, nowMs + 2);
      if (exchange.outcome !== "issued") throw new Error("source unavailable");
      return exchange;
    };
    const old = issue("old", 1_000);
    assert.equal(store.revoke(old.sourceId, 2_000), true);
    store.prune(31 * 24 * 60 * 60 * 1_000);
    assert.equal(store.source(old.sourceId), undefined);
    assert.equal(store.authenticate(old.relaySecret, 31 * 24 * 60 * 60 * 1_000), undefined);
    const current = issue("current", 31 * 24 * 60 * 60 * 1_000 + 1_000);
    assert.notEqual(current.sourceId, old.sourceId);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
