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
  createOpenCodeRuntimeAttestation,
} from "../src/server/opencode-question-contract.js";

const context = {
  workspaceId: "workspace-one",
  tabId: "tab-one",
  paneId: "pane-one",
  machineId: "local",
  sourceKind: "opencode" as const,
};
const registration = (
  store: AgentInputCredentialStore,
  principal: Parameters<AgentInputCredentialStore["issueRuntimeChallenge"]>[0],
  nonce: string,
  nowMs: number,
) => {
  const challenge = store.issueRuntimeChallenge(principal, nowMs - 1);
  return {
    instanceNonce: nonce,
    kind: "opencode" as const,
    runtimeAttestation: createOpenCodeRuntimeAttestation(nonce, challenge, nowMs),
  };
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
    const exchange = store.exchange(registrationPrincipal, registration(store, registrationPrincipal, "N".repeat(43), 1_002), 1_002);
    assert.equal(exchange.outcome, "issued");
    if (exchange.outcome !== "issued") return;
    assert.notEqual(exchange.relaySecret, issued.capability);
    const persisted = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(persisted, new RegExp(issued.capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(persisted, new RegExp(exchange.relaySecret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(store.authenticate(issued.capability, 1_003), undefined);
    assert.throws(() => registration(store, registrationPrincipal, "N".repeat(43), 1_003), /unauthorized/);

    const sourcePrincipal = store.authenticate(exchange.relaySecret, 1_010);
    assert.equal(sourcePrincipal?.kind, "agent-input-source");
    if (sourcePrincipal?.kind !== "agent-input-source") return;
    assert.equal(sourcePrincipal.sourceId, exchange.sourceId);
    assert.equal(sourcePrincipal.paneId, context.paneId);
    const refreshed = store.refresh(sourcePrincipal, registration(store, sourcePrincipal, "R".repeat(43), 1_020), 1_020);
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

test("server challenges are one-shot, renewable, and exact to capability, pane, source, and credential generation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-server-challenge-"));
  try {
    const store = new AgentInputCredentialStore(path.join(directory, "credentials.json"), {
      hashKey: "server-key", challengeTtlMs: 1_000, relayTtlMs: 10_000,
    });
    const issuePrincipal = (paneId: string, nowMs: number) => {
      const issued = store.issueRegistrationCapability({ ...context, paneId }, nowMs);
      const principal = store.authenticate(issued.capability, nowMs + 1);
      if (principal?.kind !== "agent-input-registration") throw new Error("registration unavailable");
      return principal;
    };
    const principalA = issuePrincipal("pane-a", 1_000);
    const principalB = issuePrincipal("pane-b", 1_000);
    const challengeA = store.issueRuntimeChallenge(principalA, 1_002);
    const challengeB = store.issueRuntimeChallenge(principalB, 1_002);
    const bodyA = {
      instanceNonce: "A".repeat(43), kind: "opencode" as const,
      runtimeAttestation: createOpenCodeRuntimeAttestation("A".repeat(43), challengeA, 1_003),
    };
    assert.throws(() => store.exchange(principalB, bodyA, 1_003), /runtime_attestation_invalid/,
      "a challenge for capability A cannot attest capability or pane B");
    const sourceA = store.exchange(principalA, bodyA, 1_003);
    if (sourceA.outcome !== "issued") throw new Error("source A unavailable");

    const bodyB = {
      instanceNonce: "B".repeat(43), kind: "opencode" as const,
      runtimeAttestation: createOpenCodeRuntimeAttestation("B".repeat(43), challengeB, 1_003),
    };
    const sourceB = store.exchange(principalB, bodyB, 1_003);
    if (sourceB.outcome !== "issued") throw new Error("source B unavailable");
    let sourcePrincipalA = store.authenticate(sourceA.relaySecret, 1_004);
    const sourcePrincipalB = store.authenticate(sourceB.relaySecret, 1_004);
    if (sourcePrincipalA?.kind !== "agent-input-source" || sourcePrincipalB?.kind !== "agent-input-source") {
      throw new Error("source principal unavailable");
    }

    const lost = store.issueRuntimeChallenge(sourcePrincipalA, 1_005);
    const renewed = store.issueRuntimeChallenge(sourcePrincipalA, 1_006);
    const lostBody = {
      instanceNonce: "L".repeat(43), kind: "opencode" as const,
      runtimeAttestation: createOpenCodeRuntimeAttestation("L".repeat(43), lost, 1_007),
    };
    assert.throws(() => store.refresh(sourcePrincipalA, lostBody, 1_007), /runtime_attestation_invalid/,
      "the earlier of concurrent or response-loss challenges is unusable after renewal");
    const renewedBody = {
      instanceNonce: "R".repeat(43), kind: "opencode" as const,
      runtimeAttestation: createOpenCodeRuntimeAttestation("R".repeat(43), renewed, 1_007),
    };
    const rotatedA = store.refresh(sourcePrincipalA, renewedBody, 1_007);
    sourcePrincipalA = store.authenticate(rotatedA.relaySecret, 1_008);
    if (sourcePrincipalA?.kind !== "agent-input-source") throw new Error("rotated source unavailable");

    const challengeForA = store.issueRuntimeChallenge(sourcePrincipalA, 1_009);
    const crossSourceBody = {
      instanceNonce: "X".repeat(43), kind: "opencode" as const,
      runtimeAttestation: createOpenCodeRuntimeAttestation("X".repeat(43), challengeForA, 1_010),
    };
    assert.throws(() => store.refresh(sourcePrincipalB, crossSourceBody, 1_010), /runtime_attestation_invalid/);
    const currentA = store.refresh(sourcePrincipalA, crossSourceBody, 1_010);
    const currentPrincipalA = store.authenticate(currentA.relaySecret, 1_011);
    if (currentPrincipalA?.kind !== "agent-input-source") throw new Error("current source unavailable");
    assert.throws(() => store.refresh(currentPrincipalA, crossSourceBody, 1_011), /runtime_attestation_invalid/,
      "a consumed challenge cannot be replayed by the replacement credential");

    const expiringPrincipal = issuePrincipal("pane-expired", 2_000);
    const expired = store.issueRuntimeChallenge(expiringPrincipal, 2_002);
    const expiredBody = {
      instanceNonce: "E".repeat(43), kind: "opencode" as const,
      runtimeAttestation: createOpenCodeRuntimeAttestation("E".repeat(43), expired, 2_003),
    };
    assert.throws(() => store.exchange(expiringPrincipal, expiredBody, expired.deadline), /runtime_attestation_invalid/);
    store.prune(expired.deadline);
    assert.equal(store.snapshot().challenges.length, 0, "expired challenges are removed by bounded cleanup");

    const persisted = fs.readFileSync(store.filePath, "utf8");
    for (const nonce of [challengeA.nonce, challengeB.nonce, lost.nonce, renewed.nonce, challengeForA.nonce, expired.nonce]) {
      assert.doesNotMatch(persisted, new RegExp(nonce));
    }
    const sanitized = store.source(sourceA.sourceId)?.runtimeAttestation as Record<string, unknown>;
    assert.equal("nonce" in sanitized, false);
    assert.equal("serverChallenge" in sanitized, false);
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
    assert.throws(() => store.exchange(principal, {
      ...registration(store, principal, "U".repeat(43), 2_002),
      runtimeAttestation: { ...registration(store, principal, "U".repeat(43), 2_002).runtimeAttestation, release: "future" },
    }, 2_002), /runtime_attestation_invalid/);
    const futureChallenge = store.issueRuntimeChallenge(principal, 2_001);
    assert.throws(() => store.exchange(principal, {
      instanceNonce: "T".repeat(43),
      kind: "opencode",
      runtimeAttestation: createOpenCodeRuntimeAttestation("T".repeat(43), futureChallenge, 20_000),
    }, 2_002), /runtime_attestation_invalid/, "future-dated runtime evidence is not fresh");

    const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const legacyHash = { salt: "00".repeat(16), digest: "00".repeat(32) };
    const migrationPath = path.join(directory, "migration.json");
    fs.writeFileSync(migrationPath, JSON.stringify({
      schemaVersion: 0,
      capabilities: envelope.capabilities.map(({ verifier: _verifier, ...value }: any) => ({ ...value, hash: legacyHash })),
      sources: envelope.sources.map(({ secretVerifier: _verifier, runtimeAttestation: _attestation,
        runtimeReady: _runtimeReady, diagnostic: _diagnostic, ...value }: any) => ({
        ...value, pluginVersion: "1.18.9", sdkVersion: "1.18.9",
        compatibilityFingerprint: "legacy", secretHash: legacyHash,
      })),
    }), { mode: 0o600 });
    const migrated = new AgentInputCredentialStore(migrationPath, { hashKey: "server-key" });
    assert.equal(JSON.parse(fs.readFileSync(migrationPath, "utf8")).schemaVersion, 4);
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

test("schema-2 pre-attestation capabilities and sources migrate disabled and require a fresh pane", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-auth-v2-"));
  const currentPath = path.join(directory, "current.json");
  const migrationPath = path.join(directory, "migration.json");
  try {
    const current = new AgentInputCredentialStore(currentPath, { hashKey: "server-key" });
    const capability = current.issueRegistrationCapability(context, 1_000);
    const principal = current.authenticate(capability.capability, 1_001);
    if (principal?.kind !== "agent-input-registration") throw new Error("registration unavailable");
    const exchange = current.exchange(principal, registration(current, principal, "V".repeat(43), 1_002), 1_002);
    if (exchange.outcome !== "issued") throw new Error("source unavailable");
    const envelope = current.snapshot();
    const inconsistentPath = path.join(directory, "inconsistent-current.json");
    fs.writeFileSync(inconsistentPath, `${JSON.stringify({
      ...envelope,
      sources: envelope.sources.map(({ runtimeAttestation: _attestation, ...source }) => source),
    })}\n`, { mode: 0o600 });
    assert.throws(() => new AgentInputCredentialStore(inconsistentPath, { hashKey: "server-key" }),
      /credential store is invalid/, "schema 4 cannot load a ready source without its attestation");
    fs.writeFileSync(migrationPath, `${JSON.stringify({
      schemaVersion: 2,
      capabilities: envelope.capabilities,
      sources: envelope.sources.map(({ runtimeAttestation: _attestation, runtimeReady: _ready,
        diagnostic: _diagnostic, ...source }) => ({ ...source, pluginVersion: "1.18.9", sdkVersion: "1.18.9",
        compatibilityFingerprint: "legacy-package-authority" })),
      capabilityTombstones: envelope.capabilityTombstones,
    })}\n`, { mode: 0o600 });
    const migrated = new AgentInputCredentialStore(migrationPath, { hashKey: "server-key" });
    const snapshot = migrated.snapshot();
    assert.equal(snapshot.schemaVersion, 4);
    assert.ok(snapshot.capabilities.every((item) => item.usedAt !== undefined));
    assert.ok(snapshot.sources.every((source) => source.revokedAt !== undefined
      && !source.runtimeReady && !source.supported && source.diagnostic === "attestation_required"));
    assert.equal(migrated.authenticate(capability.capability, 1_003), undefined);
    assert.equal(migrated.authenticate(exchange.relaySecret, 1_003), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("schema-3 sources migrate as refresh-only authority and replace old attestation after restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-auth-v3-"));
  const currentPath = path.join(directory, "current.json");
  const migrationPath = path.join(directory, "migration.json");
  try {
    const current = new AgentInputCredentialStore(currentPath, { hashKey: "server-key" });
    const capability = current.issueRegistrationCapability(context, 1_000);
    const registrationPrincipal = current.authenticate(capability.capability, 1_001);
    if (registrationPrincipal?.kind !== "agent-input-registration") throw new Error("registration unavailable");
    const oldInput = registration(current, registrationPrincipal, "O".repeat(43), 1_002);
    const exchange = current.exchange(registrationPrincipal, oldInput, 1_002);
    if (exchange.outcome !== "issued") throw new Error("source unavailable");
    const envelope = current.snapshot();
    fs.writeFileSync(migrationPath, `${JSON.stringify({
      schemaVersion: 3,
      capabilities: envelope.capabilities,
      sources: envelope.sources.map((source) => ({ ...source, runtimeAttestation: oldInput.runtimeAttestation })),
      capabilityTombstones: envelope.capabilityTombstones,
    })}\n`, { mode: 0o600 });

    const migrated = new AgentInputCredentialStore(migrationPath, { hashKey: "server-key" });
    assert.equal(migrated.snapshot().schemaVersion, 4);
    const disabled = migrated.source(exchange.sourceId)!;
    assert.equal(disabled.runtimeReady, false);
    assert.equal(disabled.supported, false);
    assert.equal(disabled.runtimeAttestation, undefined);
    const principal = migrated.authenticate(exchange.relaySecret, 1_003);
    if (principal?.kind !== "agent-input-source") throw new Error("migration lost refresh authority");
    const refreshed = migrated.refresh(principal, registration(migrated, principal, "N".repeat(43), 1_004), 1_004);
    assert.equal(migrated.authenticate(exchange.relaySecret, 1_005), undefined);
    assert.equal(migrated.authenticate(refreshed.relaySecret, 1_005)?.kind, "agent-input-source");
    const ready = migrated.source(exchange.sourceId)!;
    assert.equal(ready.runtimeReady, true);
    assert.equal(ready.supported, true);
    assert.equal("nonce" in (ready.runtimeAttestation as Record<string, unknown>), false);
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
    const exchange = store.exchange(registrationPrincipal, registration(store, registrationPrincipal, "N".repeat(43), 1_002), 1_002);
    if (exchange.outcome !== "issued") throw new Error("source unavailable");
    const principal = store.authenticate(exchange.relaySecret, 1_003);
    if (principal?.kind !== "agent-input-source") throw new Error("principal unavailable");
    const refreshInput = registration(store, principal, "R".repeat(43), 1_004);
    events.length = 0;
    const refreshed = store.refresh(principal, refreshInput, 1_004);
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
    const faultExchange = faulted.exchange(faultRegistration, registration(faulted, faultRegistration, "F".repeat(43), 2_002), 2_002);
    if (faultExchange.outcome !== "issued") throw new Error("fault source unavailable");
    const faultPrincipal = faulted.authenticate(faultExchange.relaySecret, 2_003);
    if (faultPrincipal?.kind !== "agent-input-source") throw new Error("fault principal unavailable");
    const faultRefreshInput = registration(faulted, faultPrincipal, "R".repeat(43), 2_004);
    failPrimarySync = true;
    assert.throws(() => faulted.refresh(
      faultPrincipal,
      faultRefreshInput,
      2_004,
    ), /injected-directory-fsync/);
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
      const exchange = store.exchange(registrationPrincipal,
        registration(store, registrationPrincipal, "N".repeat(42) + name[0], 1_002), 1_002);
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
    const rotated = refreshed.store.refresh(refreshed.principal,
      registration(refreshed.store, refreshed.principal, "R".repeat(43), 1_004), 1_004);
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
      const runtimeNonce = nonce.slice(0, 1).toUpperCase().padEnd(43, "N");
      const exchange = store.exchange(principal, registration(store, principal, runtimeNonce, nowMs + 2), nowMs + 2);
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
