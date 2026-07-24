import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AgentSessionService,
  DELEGATION_TRANSITIONS,
  TERMINAL_DELEGATION_STATES,
} from "../src/server/agent-sessions.js";
import { StateStore } from "../src/server/state.js";
import type { DelegationState, MachineConfig } from "../src/server/types.js";

const machines: MachineConfig[] = [
  { id: "local", name: "Local", kind: "local" },
];

const withAgentSessions = (
  run: (state: StateStore, agents: AgentSessionService) => void,
): void => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-agent-sessions-"),
  );
  try {
    const state = new StateStore(
      machines,
      path.join(directory, "state.json"),
    );
    run(state, new AgentSessionService(state));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test("delegation transitions make terminal states immutable", () => {
  const states = Object.keys(DELEGATION_TRANSITIONS) as DelegationState[];
  for (const state of states) {
    if (TERMINAL_DELEGATION_STATES.has(state)) {
      assert.deepEqual(DELEGATION_TRANSITIONS[state], []);
      continue;
    }
    assert.ok(DELEGATION_TRANSITIONS[state].includes("completed"));
    assert.ok(DELEGATION_TRANSITIONS[state].includes("interrupted"));
  }
});

test("agent sessions own lifecycle, title, and notification updates", () => {
  withAgentSessions((state, agents) => {
    const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
    agents.recordAgentEvent({
      paneId,
      runId: "run-service",
      agent: "codex",
      status: "running",
      title: "Review architecture",
      summary: "Inspecting",
    });
    const completed = agents.recordAgentEvent({
      paneId,
      runId: "run-service",
      agent: "codex",
      status: "completed",
      summary: "Done",
      message: "Architecture reviewed",
    });

    assert.equal(completed.notification?.subtitle, "completed");
    assert.equal(
      agents.delegationForRun("run-service")?.result,
      "Architecture reviewed",
    );
    assert.equal(
      state.snapshot().workspaces[0].name,
      "Review architecture",
    );
  });
});

test("a terminal delegation rejects late and duplicate outcomes", () => {
  withAgentSessions((state, agents) => {
    const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
    agents.recordAgentEvent({
      paneId,
      runId: "run-terminal",
      agent: "codex",
      status: "completed",
      summary: "First",
      message: "First result",
    });
    agents.recordAgentEvent({
      paneId,
      runId: "run-terminal",
      agent: "codex",
      status: "failed",
      summary: "Late",
      message: "Late failure",
    });

    assert.equal(
      agents.delegationForRun("run-terminal")?.result,
      "First result",
    );
    assert.equal(state.snapshot().notifications.length, 1);
  });
});
