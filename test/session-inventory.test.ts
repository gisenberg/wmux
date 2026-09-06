import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionRows, sessionActivities } from "../src/client/src/session-inventory.js";
import { directionalPane } from "../src/client/src/pane-navigation.js";
import type { BootstrapPayload, LayoutNode, MachineStatus } from "../src/shared/protocol.js";

const timestamp = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
const fixture = () => ({
  delegations: [], agentTimelines: [], notifications: [], agentInputRequests: [],
  workspaces: [{ id: "ws", name: "Mixed hosts", machineId: "local", tabs: [{ id: "tab", title: "Work", panes: [
    { id: "remote-pane", machineId: "remote", createdAt: timestamp(0), status: "running" },
    { id: "shell-pane", machineId: "local", createdAt: timestamp(0), status: "running" },
  ] }] }],
  agentEvents: [1, 2].map((seconds) => ({
    id: `event-${seconds}`, runId: "observed", workspaceId: "ws", tabId: "tab", paneId: "remote-pane",
    agent: "claude", status: "approval_required", title: "Review", summary: "", createdAt: timestamp(seconds),
  })),
}) as unknown as BootstrapPayload;
const machines = [{ id: "local", name: "Local", reachable: true }, { id: "remote", name: "Remote", reachable: false }] as MachineStatus[];

test("inventory includes observed agents and shells without conflating host or delegation authority", () => {
  const rows = buildSessionRows(fixture(), machines);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "hook");
  assert.equal(rows[0].state, "waiting");
  assert.equal(rows[0].machineId, "remote");
  assert.equal(rows[0].reachable, false);
  assert.equal(rows[0].stateChangedAt, timestamp(1));
  assert.equal(rows[1].source, "shell");
  assert.equal(rows[1].state, "idle");
  assert.equal(sessionActivities(rows).length, 1);
});

test("observed work does not erase an independently active managed delegation", () => {
  const state = fixture();
  state.delegations = [{ runId: "old", sessionId: "old-session", paneId: "remote-pane", workspaceId: "ws", tabId: "tab", state: "running", updatedAt: timestamp(0) }] as BootstrapPayload["delegations"];
  const rows = buildSessionRows(state, machines);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, "event-2");
  assert.equal(rows[0].source, "hook");
  assert.equal(rows[1].source, "delegation");
});

test("unread completion remains available to navigation, without implying a running agent", () => {
  const state = fixture();
  state.agentEvents[1].status = "completed";
  state.notifications = [{ paneId: "remote-pane", read: false, createdAt: timestamp(3) }] as BootstrapPayload["notifications"];
  const row = buildSessionRows(state, machines)[0];
  assert.equal(row.state, "completed");
  assert.equal(row.unread, true);
  assert.equal(row.stateChangedAt, timestamp(2));
});

test("directional navigation follows geometry rather than traversal order", () => {
  const pane = (paneId: string): LayoutNode => ({ type: "pane", paneId });
  const layout: LayoutNode = { type: "split", direction: "vertical", ratio: 0.5, first: pane("left"), second: {
    type: "split", direction: "horizontal", ratio: 0.5, first: pane("top"), second: pane("bottom"),
  } };
  assert.equal(directionalPane(layout, "bottom", "left"), "left");
  assert.equal(directionalPane(layout, "bottom", "up"), "top");
  assert.equal(directionalPane(layout, "left", "left"), undefined);
  assert.equal(directionalPane(layout, "missing", "right"), undefined);
});
