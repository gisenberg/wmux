import assert from "node:assert/strict";
import test from "node:test";
import {
  codexRecoveryInstruction,
  codexTransportLabel,
  expiryLabel,
  observationAge,
  type CodexBindingDiagnostic,
} from "../src/client/src/CodexDiagnostics.js";

const binding = (overrides: Partial<CodexBindingDiagnostic> = {}): CodexBindingDiagnostic => ({
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
  sessionId: "session-1",
  expiresAt: "2026-09-12T00:10:00.000Z",
  binding: "live",
  workspaceOwnership: "auto",
  tabOwnership: "user",
  ...overrides,
});

test("Codex diagnostics presents sample ages and expiry without pretending they are fresh", () => {
  const now = Date.parse("2026-09-12T00:00:00.000Z");
  assert.equal(observationAge(now - 65_000, now), "1m ago");
  assert.equal(observationAge(undefined, now), "not sampled");
  assert.equal(expiryLabel("2026-09-11T23:59:30.000Z", now), "expired 30s ago");
  assert.equal(expiryLabel("2026-09-12T00:01:30.000Z", now), "expires in 1m");
});

test("Codex diagnostics distinguishes socket recovery from fresh terminal proof", () => {
  assert.match(codexRecoveryInstruction(binding({ binding: "unavailable" })), /socket recovery alone does not restore title authority/);
  assert.match(codexRecoveryInstruction(binding({ binding: "expired" })), /fresh terminal proof/);
  assert.match(codexRecoveryInstruction(binding({ naming: {
    status: "unknown", receivedAt: 0, counters: {}, stale: true,
  } })), /Recover the socket first/);
});

test("native transport health is separate from terminal proof and ages without a refresh", () => {
  const row = binding({ naming: { status: "active", reason: "none", receivedAt: 100_000,
    sampledAt: 100_000, lastSuccessAt: 100_000, counters: {}, stale: false } });
  assert.equal(codexTransportLabel(row, 101_000), "NATIVE METADATA READ");
  assert.equal(codexTransportLabel(row, 131_001), "UNKNOWN / NO FRESH SAMPLE");
  assert.equal(codexTransportLabel(binding(), 101_000), "UNKNOWN / NO FRESH SAMPLE");
});
