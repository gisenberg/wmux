import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOptimisticCreations,
  optimisticSplitCreation,
  optimisticTabCreation,
  optimisticWorkspaceCreation,
} from "../src/client/src/optimistic-creation.ts";
import type { BootstrapPayload } from "../src/client/src/types.ts";

const payload = (): BootstrapPayload => ({
  revision: 4,
  healthEpoch: 8,
  machines: [{
    id: "local",
    name: "Local machine",
    kind: "local",
    platform: "linux",
    reachable: true,
    checkedAt: "",
    releaseVersion: "v0.1.2-linux",
  }],
  activeWorkspaceId: "ws_existing",
  workspaces: [{
    id: "ws_existing",
    name: "Local 1",
    nameSource: "default",
    machineId: "local",
    activeTabId: "tab_existing",
    tabs: [{
      id: "tab_existing",
      title: "Shell",
      titleSource: "default",
      activePaneId: "pane_existing",
      layout: { type: "pane", paneId: "pane_existing" },
      panes: [{
        id: "pane_existing",
        machineId: "local",
        title: "Shell",
        cwd: "/work",
        status: "running",
        createdAt: "",
      }],
      createdAt: "",
    }],
    createdAt: "",
    updatedAt: "",
  }],
  notifications: [],
  agentEvents: [],
  runs: [],
  settings: {
    terminalFontSize: 14,
    terminalScrollbackRows: 10_000,
    colorScheme: "wmux",
    inactiveTabStreaming: "suspend",
    tuiFrameRate: 30,
    terminalScrollMode: "batched",
    machineAliases: {},
  },
  keybindings: {},
  streams: [],
});

test("optimistic workspace creation rebases without duplicating an authoritative acknowledgement", () => {
  const ids = {
    workspaceId: `ws_${"a".repeat(32)}`,
    tabId: `tab_${"b".repeat(32)}`,
    paneId: `pane_${"c".repeat(32)}`,
  };
  const creation = optimisticWorkspaceCreation(payload(), "local", ids, "/work");
  const optimistic = applyOptimisticCreations(payload(), [creation]);
  assert.equal(optimistic.activeWorkspaceId, ids.workspaceId);
  assert.equal(optimistic.workspaces[0].tabs[0].panes[0].id, ids.paneId);

  const acknowledged = structuredClone(optimistic);
  acknowledged.revision += 1;
  acknowledged.workspaces[0].name = "Authoritative name";
  const rebased = applyOptimisticCreations(acknowledged, [creation]);
  assert.equal(rebased.workspaces.filter((workspace) => workspace.id === ids.workspaceId).length, 1);
  assert.equal(rebased.workspaces[0].name, "Authoritative name");
});

test("optimistic tabs and splits survive unrelated incoming snapshots and remain idempotent", () => {
  const base = payload();
  const tabCreation = optimisticTabCreation(
    base,
    "ws_existing",
    "local",
    { tabId: `tab_${"d".repeat(32)}`, paneId: `pane_${"e".repeat(32)}` },
    "/work",
  );
  assert.ok(tabCreation);
  const withTab = applyOptimisticCreations(base, [tabCreation]);
  assert.equal(withTab.workspaces[0].activeTabId, tabCreation.tab.id);

  const splitCreation = optimisticSplitCreation(
    withTab,
    tabCreation.tab.id,
    tabCreation.paneId,
    "vertical",
    "local",
    { paneId: `pane_${"f".repeat(32)}` },
    "/work",
  );
  assert.ok(splitCreation);
  const withSplit = applyOptimisticCreations(withTab, [tabCreation, splitCreation]);
  const tab = withSplit.workspaces[0].tabs.find((candidate) => candidate.id === tabCreation.tab.id);
  assert.equal(tab?.activePaneId, splitCreation.pane.id);
  assert.equal(tab?.panes.filter((pane) => pane.id === splitCreation.pane.id).length, 1);
  assert.equal(tab?.layout.type, "split");

  const repeated = applyOptimisticCreations(withSplit, [tabCreation, splitCreation]);
  const repeatedTab = repeated.workspaces[0].tabs.find((candidate) => candidate.id === tabCreation.tab.id);
  assert.equal(repeatedTab?.panes.filter((pane) => pane.id === splitCreation.pane.id).length, 1);
});
