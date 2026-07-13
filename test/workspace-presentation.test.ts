import assert from "node:assert/strict";
import { test } from "node:test";
import { workspacePresentationDescriptor, workspacePresentationMachineId } from "../src/client/src/workspace-presentation.ts";
import type { Workspace } from "../src/client/src/types.ts";

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: "ws_1",
  name: "Workspace",
  machineId: "origin-host",
  activeTabId: "tab_1",
  tabs: [{
    id: "tab_1",
    title: "Terminal",
    activePaneId: "pane_1",
    layout: { type: "pane", paneId: "pane_1" },
    panes: [{ id: "pane_1", machineId: "active-host", title: "shell", status: "running", createdAt: "2026-01-01T00:00:00.000Z" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("workspace presentation uses the active pane host without changing affinity", () => {
  const mixedHost = workspace();
  assert.equal(workspacePresentationMachineId(mixedHost), "active-host");
  assert.equal(mixedHost.machineId, "origin-host");
});

test("workspace presentation falls back through missing active IDs to affinity", () => {
  assert.equal(workspacePresentationMachineId(workspace({ activeTabId: "missing" })), "active-host");
  assert.equal(workspacePresentationMachineId(workspace({ tabs: [{
    ...workspace().tabs[0], activePaneId: "missing",
  }] })), "active-host");
  assert.equal(workspacePresentationMachineId(workspace({ tabs: [] })), "origin-host");
  assert.equal(workspacePresentationMachineId(workspace({ tabs: [{
    ...workspace().tabs[0], activePaneId: "missing", panes: [], layout: { type: "pane", paneId: "missing" },
  }] })), "origin-host");
});

test("workspace presentation replaces only default or legacy affinity descriptors", () => {
  assert.equal(workspacePresentationDescriptor(workspace({ descriptor: "Origin Host", descriptorSource: "default" }), "Active Host", "Origin Host"), "Active Host");
  assert.equal(workspacePresentationDescriptor(workspace({ descriptor: "Origin Host" }), "Active Host", "Origin Host"), "Active Host");
  assert.equal(workspacePresentationDescriptor(workspace({ descriptor: "Origin Host", descriptorSource: "user" }), "Active Host", "Origin Host"), "Origin Host");
  assert.equal(workspacePresentationDescriptor(workspace({ descriptor: "Agent summary", descriptorSource: "auto" }), "Active Host", "Origin Host"), "Agent summary");
});
