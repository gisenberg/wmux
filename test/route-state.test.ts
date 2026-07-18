import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activatePaneInState,
  activateWorkspaceTabInState,
  applyClientViewToState,
  applyRouteTargetToState,
  findWorkspaceTab,
  markPaneNotificationsReadInState,
  markWorkspaceNotificationsReadInState,
  parseRouteTarget,
  workspaceTabPath,
} from "../src/client/src/route-state.ts";
import type { BootstrapPayload } from "../src/client/src/types.ts";

const payload = (): BootstrapPayload =>
  ({
    machines: [],
    activeWorkspaceId: "ws1",
    workspaces: [
      {
        id: "ws1",
        name: "One",
        machineId: "local",
        activeTabId: "t1",
        tabs: [
          {
            id: "t1",
            title: "a",
            activePaneId: "p1",
            layout: { type: "split", direction: "vertical", ratio: 0.5, first: { type: "pane", paneId: "p1" }, second: { type: "pane", paneId: "p1b" } },
            panes: [
              { id: "p1", machineId: "local", title: "one", status: "running", createdAt: "" },
              { id: "p1b", machineId: "local", title: "two", status: "running", createdAt: "" },
            ],
            createdAt: "",
          },
          { id: "t2", title: "b", activePaneId: "p2", layout: { type: "pane", paneId: "p2" }, panes: [{ id: "p2", machineId: "local", title: "two", status: "running", createdAt: "" }], createdAt: "" },
        ],
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "ws2",
        name: "Two",
        machineId: "local",
        activeTabId: "t3",
        tabs: [{ id: "t3", title: "c", activePaneId: "p3", layout: { type: "pane", paneId: "p3" }, panes: [{ id: "p3", machineId: "local", title: "three", status: "running", createdAt: "" }], createdAt: "" }],
        createdAt: "",
        updatedAt: "",
      },
    ],
    notifications: [
      { id: "n1", workspaceId: "ws2", tabId: "t3", paneId: "p3", title: "t", subtitle: "", body: "", createdAt: "", read: false },
    ],
    agentEvents: [],
    runs: [],
    terminalFontFamily: "monospace",
    settings: {
      terminalFontSize: 14,
      terminalScrollbackRows: 1000,
      colorScheme: "wmux",
      inactiveTabStreaming: "suspend",
      tuiFrameRate: 15,
      terminalScrollMode: "batched",
      machineAliases: {},
    },
    settingsDefaults: {
      terminalFontSize: 14,
      terminalScrollbackRows: 10000,
      colorScheme: "wmux",
      inactiveTabStreaming: "suspend",
      tuiFrameRate: 15,
      terminalScrollMode: "batched",
      machineAliases: {},
    },
    streams: [],
  }) as unknown as BootstrapPayload;

test("parseRouteTarget parses workspace and optional tab", () => {
  assert.deepEqual(parseRouteTarget("/workspaces/ws1"), { workspaceId: "ws1", tabId: undefined });
  assert.deepEqual(parseRouteTarget("/workspaces/ws1/tabs/t2"), { workspaceId: "ws1", tabId: "t2" });
  assert.deepEqual(parseRouteTarget("/workspaces/a%20b/tabs/c%2Fd"), { workspaceId: "a b", tabId: "c/d" });
  assert.equal(parseRouteTarget("/"), null);
  assert.equal(parseRouteTarget("/other"), null);
});

test("workspaceTabPath round-trips through parseRouteTarget", () => {
  const path = workspaceTabPath("ws x", "t/y");
  assert.deepEqual(parseRouteTarget(path), { workspaceId: "ws x", tabId: "t/y" });
});

test("findWorkspaceTab resolves explicit and default tabs", () => {
  assert.equal(findWorkspaceTab(payload(), "ws1", "t2")?.tab.id, "t2");
  assert.equal(findWorkspaceTab(payload(), "ws1")?.tab.id, "t1");
  assert.equal(findWorkspaceTab(payload(), "missing"), null);
});

test("activateWorkspaceTabInState switches active workspace and tab", () => {
  const next = activateWorkspaceTabInState(payload(), "ws1", "t2");
  assert.equal(next.activeWorkspaceId, "ws1");
  assert.equal(next.workspaces.find((w) => w.id === "ws1")?.activeTabId, "t2");
});

test("activating an unknown workspace leaves state unchanged (same reference)", () => {
  const input = payload();
  assert.equal(activateWorkspaceTabInState(input, "nope", "t2"), input);
});

test("activating a workspace marks its notifications read", () => {
  const next = activateWorkspaceTabInState(payload(), "ws2", "t3");
  assert.equal(next.notifications.find((n) => n.id === "n1")?.read, true);
});

test("markWorkspaceNotificationsReadInState returns same ref when nothing changes", () => {
  const input = payload();
  assert.equal(markWorkspaceNotificationsReadInState(input, "ws1"), input);
});

test("pane activation is local and marks only that pane read", () => {
  const input = payload();
  input.notifications.push({
    id: "n2",
    workspaceId: "ws1",
    tabId: "t1",
    paneId: "p1b",
    title: "t",
    subtitle: "",
    body: "",
    createdAt: "",
    read: false,
  });
  const next = activatePaneInState(input, "t1", "p1b");
  assert.equal(next.workspaces[0].tabs[0].activePaneId, "p1b");
  assert.equal(next.notifications.find((notification) => notification.id === "n2")?.read, true);
  assert.equal(next.notifications.find((notification) => notification.id === "n1")?.read, false);
  assert.equal(input.workspaces[0].tabs[0].activePaneId, "p1");
});

test("pane notification projection is a no-op when nothing changes", () => {
  const input = payload();
  assert.equal(markPaneNotificationsReadInState(input, "p1"), input);
});

test("different browser views project independently over the same server payload", () => {
  const serverPayload = payload();
  const firstBrowser = applyClientViewToState(
    serverPayload,
    { workspaceId: "ws1", tabId: "t1" },
    { ws2: "t3" },
    { t1: "p1b" },
  );
  const secondBrowser = applyClientViewToState(
    serverPayload,
    { workspaceId: "ws2", tabId: "t3" },
    {},
    {},
  );

  assert.equal(firstBrowser.activeWorkspaceId, "ws1");
  assert.equal(firstBrowser.workspaces[0].activeTabId, "t1");
  assert.equal(firstBrowser.workspaces[0].tabs[0].activePaneId, "p1b");
  assert.equal(secondBrowser.activeWorkspaceId, "ws2");
  assert.equal(serverPayload.activeWorkspaceId, "ws1");
  assert.equal(serverPayload.workspaces[0].tabs[0].activePaneId, "p1");
});

test("invalid stored pane selections do not replace a valid fallback", () => {
  const input = payload();
  const next = applyClientViewToState(input, { workspaceId: "ws1", tabId: "t1" }, {}, { t1: "removed-pane" });
  assert.equal(next.workspaces[0].tabs[0].activePaneId, "p1");
});

test("stored tabs are browser-local for inactive workspaces", () => {
  const input = payload();
  const next = applyClientViewToState(input, { workspaceId: "ws2", tabId: "t3" }, { ws1: "t2" }, {});
  assert.equal(next.activeWorkspaceId, "ws2");
  assert.equal(next.workspaces.find((workspace) => workspace.id === "ws1")?.activeTabId, "t2");
  assert.equal(input.workspaces.find((workspace) => workspace.id === "ws1")?.activeTabId, "t1");
});

test("applyRouteTargetToState is a no-op for null and unknown targets", () => {
  const input = payload();
  assert.equal(applyRouteTargetToState(input, null), input);
  assert.equal(applyRouteTargetToState(input, { workspaceId: "ghost" }), input);
  assert.equal(applyRouteTargetToState(input, { workspaceId: "ws2" }).activeWorkspaceId, "ws2");
});
