import assert from "node:assert/strict";
import test from "node:test";
import { summarizeWorkspaceVersion } from "../src/client/src/workspace-version.js";
import type { MachineStatus, Workspace } from "../src/client/src/types.js";

const machine = (overrides: Partial<MachineStatus> = {}): MachineStatus => ({
  id: "win",
  name: "Windows",
  kind: "powershell-ssh",
  platform: "win",
  reachable: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  releaseVersion: "v0.1.1-win",
  runtimeVersion: "0.7",
  expectedRuntimeVersion: "0.7",
  versionStatus: "current",
  ...overrides,
});

const workspace = (machineIds: string[] = ["win"]): Workspace => ({
  id: "ws_test",
  name: "Test",
  machineId: machineIds[0],
  activeTabId: "tab_test",
  tabs: [{
    id: "tab_test",
    title: "Shell",
    activePaneId: "pane_0",
    layout: { type: "pane", paneId: "pane_0" },
    panes: machineIds.map((machineId, index) => ({
      id: `pane_${index}`,
      machineId,
      title: "Shell",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
    createdAt: "2026-01-01T00:00:00.000Z",
  }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

test("workspace version reports a current single-machine runtime", () => {
  assert.deepEqual(summarizeWorkspaceVersion(workspace(), [machine()]), {
    status: "current",
    label: "✓ v0.1.1-win",
    detail: "Up to date. Windows: release v0.1.1-win; runtime 0.7",
  });
});

test("an outdated machine wins for a mixed-machine workspace", () => {
  const summary = summarizeWorkspaceVersion(workspace(["win", "runner"]), [
    machine(),
    machine({
      id: "runner",
      name: "Runner",
      runtimeVersion: "0.4",
      expectedRuntimeVersion: "0.7",
      versionStatus: "outdated",
    }),
  ]);
  assert.equal(summary?.status, "outdated");
  assert.equal(summary?.label, "↑ 2H");
  assert.match(summary?.detail ?? "", /Runner: release v0\.1\.1-win; runtime 0\.4, expected 0\.7/);
});

test("helper mismatch is explained in the version detail", () => {
  const summary = summarizeWorkspaceVersion(workspace(), [machine({
    versionStatus: "outdated",
    helperBundleVersion: "1234567890abcdef",
    expectedHelperBundleVersion: "abcdef1234567890",
  })]);
  assert.equal(summary?.status, "outdated");
  assert.match(summary?.detail ?? "", /helpers 12345678, expected abcdef12/);
});

test("workspace version is absent when none of its machines are versioned", () => {
  assert.equal(summarizeWorkspaceVersion(workspace(), [machine({ versionStatus: undefined })]), undefined);
});
