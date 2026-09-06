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
  assert.equal(sessionActivities(rows)[0].status, "waiting");
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

test("same-run observation loss withdraws working and attention without inventing a terminal outcome", () => {
  for (const previousState of ["running", "waiting"] as const) {
    const state = fixture();
    state.agentEvents = [{ ...state.agentEvents[1], agent: "codex", status: "observer_stale", createdAt: timestamp(3) }];
    state.delegations = [{
      runId: "observed", sessionId: "session", runtime: "codex", paneId: "remote-pane", workspaceId: "ws", tabId: "tab",
      state: previousState, attentionReason: previousState === "waiting" ? "input" : undefined,
      stateChangedAt: timestamp(1), updatedAt: timestamp(3), observerError: "observer_stale",
    }] as BootstrapPayload["delegations"];
    const row = buildSessionRows(state, machines).find(item => item.paneId === "remote-pane")!;
    assert.equal(row.source, "delegation");
    assert.equal(row.state, "stale");
    assert.equal(row.attentionReason, undefined);
    assert.equal(row.stateChangedAt, timestamp(3));
    assert.equal(sessionActivities([row])[0].status, "stale");
    assert.equal(state.delegations[0].state, previousState, "presentation must not mutate native outcome history");

    state.agentInputRequests = [{ paneId: "remote-pane", state: "pending" }] as BootstrapPayload["agentInputRequests"];
    assert.equal(sessionActivities(buildSessionRows(state, machines))[0].status, "waiting", "real pending input remains actionable");
    state.agentInputRequests = [];
    for (const next of ["running", "completed"] as const) {
      state.delegations[0] = { ...state.delegations[0], state: next, attentionReason: undefined, observerError: undefined, updatedAt: timestamp(4) };
      assert.equal(sessionActivities(buildSessionRows(state, machines))[0].status, next, "older stale activity cannot override newer authoritative state");
    }
  }
});
