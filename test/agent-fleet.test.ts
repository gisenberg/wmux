import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAgentFleetRows,
  formatFleetElapsed,
} from "../src/client/src/AgentFleet.js";
import type { BootstrapPayload, MachineStatus } from "../src/shared/protocol.js";

test("fleet rows prioritize attention and resolve pane-local machines and timelines", () => {
  const state = {
    delegations: [
      delegation("run-local", "session-local", "running", "workspace-local", "tab-local", "pane-local", "2026-01-01T00:00:03.000Z"),
      {
        ...delegation("run-remote", "session-remote", "waiting", "workspace-remote", "tab-remote", "pane-remote", "2026-01-01T00:00:01.000Z"),
        attentionReason: "approval",
      },
      delegation("run-done", "session-done", "completed", "workspace-local", "tab-local", "pane-local", "2026-01-01T00:00:04.000Z"),
    ],
    agentTimelines: [
      {
        id: "session-remote",
        runtime: "claude",
        workspaceId: "workspace-remote",
        tabId: "tab-remote",
        paneId: "pane-remote",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        entries: [
          {
            id: "entry-remote",
            sessionId: "session-remote",
            turnId: "run-remote",
            kind: "status",
            actor: "agent",
            text: "Approval is required before editing.",
            state: "waiting",
            filesTouched: [],
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      },
    ],
    workspaces: [
      workspace("workspace-local", "Local work", "local", "tab-local", "pane-local"),
      workspace("workspace-remote", "Remote work", "remote", "tab-remote", "pane-remote"),
    ],
  } as unknown as BootstrapPayload;
  const machines = [
    { id: "local", name: "Local" },
    { id: "remote", name: "Remote node" },
  ] as MachineStatus[];

  const rows = buildAgentFleetRows(state, machines);
  assert.deepEqual(rows.map((row) => row.id), [
    "run-remote",
    "run-local",
    "run-done",
  ]);
  assert.equal(rows[0].machineName, "Remote node");
  assert.equal(rows[0].lastEntry?.text, "Approval is required before editing.");
  assert.equal(rows[0].attentionReason, "approval");

  state.workspaces = state.workspaces.filter(
    (workspace) => workspace.id !== "workspace-remote",
  );
  assert.equal(buildAgentFleetRows(state, machines)[0].machineId, "remote");
});

test("fleet elapsed time uses compact state-age units", () => {
  assert.equal(
    formatFleetElapsed("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:42.000Z")),
    "42s",
  );
  assert.equal(
    formatFleetElapsed("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T02:10:00.000Z")),
    "2h",
  );
});

const delegation = (
  runId: string,
  sessionId: string,
  state: "running" | "waiting" | "completed",
  workspaceId: string,
  tabId: string,
  paneId: string,
  updatedAt: string,
) => ({
  runId,
  sessionId,
  state,
  runtime: runId.includes("remote") ? "claude" : "codex",
  title: runId,
  summary: state,
  result: "",
  error: "",
  workspaceId,
  tabId,
  paneId,
  machineId: runId.includes("remote") ? "remote" : "local",
  stateChangedAt: updatedAt,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});

const workspace = (
  id: string,
  name: string,
  machineId: string,
  tabId: string,
  paneId: string,
) => ({
  id,
  name,
  machineId,
  activeTabId: tabId,
  tabs: [{
    id: tabId,
    activePaneId: paneId,
    panes: [{ id: paneId, machineId }],
  }],
});
