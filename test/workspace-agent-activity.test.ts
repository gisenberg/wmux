import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivity } from "../src/shared/protocol.ts";
import {
  aggregateAgentActivityByWorkspace,
  latestAgentActivityByPane,
} from "../src/client/src/workspace-agent-activity.ts";
import { sidebarWorkspaceAgentContext } from "../src/client/src/sidebar-agent-status.ts";

const event = (
  id: string,
  paneId: string,
  status: string,
  createdAt: string,
): AgentActivity => ({
  id,
  workspaceId: "workspace",
  tabId: "tab",
  paneId,
  agent: paneId === "working" ? "Prime Agent" : "Codex",
  status,
  title: id,
  summary: id,
  createdAt,
});

test("older running pane outranks a newer completed sibling after latest lifecycle is derived per pane", () => {
  const events = [
    event("completed", "settled", "completed", "2026-03-01T12:02:00.000Z"),
    event("running", "working", "running", "2026-03-01T12:01:00.000Z"),
    event("stale-start", "settled", "running", "2026-03-01T12:00:00.000Z"),
  ];
  const latest = latestAgentActivityByPane(events);
  assert.equal(latest.get("settled")?.id, "completed");
  const aggregate = aggregateAgentActivityByWorkspace(events).get("workspace");
  assert.equal(aggregate?.representative.id, "running");
  assert.equal(aggregate?.activePaneCount, 1);
  assert.equal(aggregate?.paneCount, 2);
});

test("focused idle sibling presentation describes workspace-wide working pane context", () => {
  const events = [event("working", "working", "running", "2026-03-01T12:01:00.000Z")];
  const latestByPane = latestAgentActivityByPane(events);
  const aggregate = aggregateAgentActivityByWorkspace(events).get("workspace");
  assert.equal(latestByPane.get("idle"), undefined);
  assert.equal(aggregate?.representative.paneId, "working");
  assert.equal(
    sidebarWorkspaceAgentContext(
      aggregate?.activePaneCount ?? 0,
      aggregate?.heartbeatPaneCount ?? 0,
      aggregate?.paneCount ?? 0,
      2,
    ),
    "1/2 panes active",
  );
});

test("attention lifecycle outranks settled pane results", () => {
  const aggregate = aggregateAgentActivityByWorkspace([
    event("completed", "settled", "completed", "2026-03-01T12:03:00.000Z"),
    event("approval", "working", "approval_required", "2026-03-01T12:01:00.000Z"),
  ]).get("workspace");
  assert.equal(aggregate?.representative.id, "approval");
  assert.equal(aggregate?.activePaneCount, 1);
});

test("all-settled workspace presents the newest pane result", () => {
  const aggregate = aggregateAgentActivityByWorkspace([
    event("older-failure", "working", "failed", "2026-03-01T12:01:00.000Z"),
    event("newer-completion", "settled", "completed", "2026-03-01T12:02:00.000Z"),
    event("old-run", "settled", "running", "2026-03-01T12:00:00.000Z"),
  ]).get("workspace");
  assert.equal(aggregate?.representative.id, "newer-completion");
  assert.equal(aggregate?.activePaneCount, 0);
  assert.equal(sidebarWorkspaceAgentContext(0, 0, aggregate?.paneCount ?? 0, 2), "2 pane results");
});
