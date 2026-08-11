import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AgentSessionService,
  DELEGATION_TRANSITIONS,
  monotonicAgentTimestamp,
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

test("agent timestamps advance when transitions share one clock tick", () => {
  assert.equal(
    monotonicAgentTimestamp(
      ["2026-07-24T21:08:50.543Z"],
      Date.parse("2026-07-24T21:08:50.543Z"),
    ),
    "2026-07-24T21:08:50.544Z",
  );
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


test("scheduled heartbeat metadata is orthogonal to the agent lifecycle", () => {
  withAgentSessions((state, agents) => {
    const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
    const running = agents.recordAgentEvent({
      paneId,
      runId: "run-heartbeat",
      agent: "prime-agent",
      status: "running",
      summary: "prime-agent running",
    });
    const delegationBefore = structuredClone(agents.delegationForRun("run-heartbeat"));
    const timelineCount = agents.timelineForSession("run-heartbeat")?.entries.length;
    const notificationCount = state.snapshot().notifications.length;

    const scheduled = agents.recordHeartbeatState({
      paneId,
      agent: "prime-agent",
      heartbeatActive: true,
    });
    assert.equal(scheduled.agentEvent?.id, running.agentEvent.id);
    assert.equal(scheduled.agentEvent?.status, "running");
    assert.equal(scheduled.agentEvent?.heartbeatActive, true);
    assert.deepEqual(agents.delegationForRun("run-heartbeat"), delegationBefore);
    assert.equal(agents.timelineForSession("run-heartbeat")?.entries.length, timelineCount);
    assert.equal(state.snapshot().notifications.length, notificationCount);
    assert.equal(state.snapshot().agentEvents.length, 1);

    const repeated = agents.recordHeartbeatState({
      paneId,
      agent: "prime-agent",
      heartbeatActive: true,
    });
    assert.equal(repeated.agentEvent?.id, running.agentEvent.id);
    assert.equal(state.snapshot().agentEvents.length, 1);

    const completed = agents.recordAgentEvent({
      paneId,
      runId: "run-heartbeat",
      agent: "prime-agent",
      status: "completed",
      summary: "prime-agent completed",
    });
    assert.equal(completed.agentEvent.status, "completed");
    assert.equal(completed.agentEvent.heartbeatActive, true);

    const cleared = agents.recordHeartbeatState({
      paneId,
      agent: "prime-agent",
      heartbeatActive: false,
    });
    assert.equal(cleared.agentEvent?.id, completed.agentEvent.id);
    assert.equal(cleared.agentEvent?.status, "completed");
    assert.equal(cleared.agentEvent?.heartbeatActive, undefined);
    assert.equal(agents.delegationForRun("run-heartbeat")?.state, "completed");

    const eventCount = state.snapshot().agentEvents.length;
    const idleOnly = agents.recordHeartbeatState({
      paneId,
      agent: "prime-agent-idle",
      heartbeatActive: true,
    });
    assert.equal(idleOnly.agentEvent, undefined);
    assert.equal(state.snapshot().agentEvents.length, eventCount);
    assert.equal(state.snapshot().delegations.length, 1);

    const coalescedBefore = agents.recordAgentEvent({
      paneId,
      runId: "run-heartbeat-coalesce",
      agent: "prime-agent-coalesce",
      status: "running",
      coalesce: true,
      heartbeatActive: false,
    });
    const coalescedChanged = agents.recordAgentEvent({
      paneId,
      runId: "run-heartbeat-coalesce",
      agent: "prime-agent-coalesce",
      status: "running",
      coalesce: true,
      heartbeatActive: true,
    });
    assert.notEqual(coalescedChanged.agentEvent.id, coalescedBefore.agentEvent.id);
    assert.equal(coalescedChanged.agentEvent.heartbeatActive, true);
    const coalescedSame = agents.recordAgentEvent({
      paneId,
      runId: "run-heartbeat-coalesce",
      agent: "prime-agent-coalesce",
      status: "running",
      coalesce: true,
      heartbeatActive: true,
    });
    assert.equal(coalescedSame.agentEvent.id, coalescedChanged.agentEvent.id);
  });
});

test("Prime Agent identity triples route status and naming to only their bound pane", () => {
  withAgentSessions((state, agents) => {
    const first = state.snapshot().workspaces[0];
    const second = state.createWorkspace("local");
    const firstTab = first.tabs[0];
    const secondTab = second.tabs[0];
    const firstPane = firstTab.panes[0].id;
    const secondPane = secondTab.panes[0].id;

    agents.recordAgentEvent({
      workspaceId: first.id,
      tabId: firstTab.id,
      paneId: firstPane,
      agent: "prime-agent",
      status: "running",
      title: "First attached session",
    });
    agents.recordAgentEvent({
      workspaceId: second.id,
      tabId: secondTab.id,
      paneId: secondPane,
      agent: "prime-agent",
      status: "running",
      title: "Second attached session",
    });
    const snapshot = state.snapshot();
    assert.equal(snapshot.workspaces.find((workspace) => workspace.id === first.id)?.name, "First attached session");
    assert.equal(
      snapshot.workspaces.find((workspace) => workspace.id === first.id)?.tabs[0]?.title,
      "First attached session",
    );
    assert.equal(snapshot.workspaces.find((workspace) => workspace.id === second.id)?.name, "Second attached session");
    assert.equal(
      snapshot.workspaces.find((workspace) => workspace.id === second.id)?.tabs[0]?.title,
      "Second attached session",
    );
    assert.throws(() => agents.recordAgentEvent({
      workspaceId: second.id,
      tabId: secondTab.id,
      paneId: firstPane,
      agent: "prime-agent",
      status: "running",
      title: "Ambiguous stale identity",
    }), /pane does not belong to workspace/);
    assert.throws(() => agents.recordAgentEvent({
      workspaceId: first.id,
      tabId: secondTab.id,
      paneId: firstPane,
      agent: "prime-agent",
      status: "running",
      title: "Mismatched tab identity",
    }), /pane does not belong to tab/);
    const afterRejectedIdentity = state.snapshot();
    assert.equal(
      afterRejectedIdentity.workspaces.find((workspace) => workspace.id === first.id)?.name,
      "First attached session",
    );
    assert.equal(
      afterRejectedIdentity.workspaces.find((workspace) => workspace.id === first.id)?.tabs[0]?.title,
      "First attached session",
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

test("attention transitions are explicit, prioritized, and notified once", () => {
  withAgentSessions((state, agents) => {
    const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
    agents.recordAgentEvent({
      paneId,
      runId: "run-attention",
      agent: "codex",
      status: "running",
      summary: "Working",
    });
    const waiting = agents.recordAgentEvent({
      paneId,
      runId: "run-attention",
      agent: "codex",
      status: "waiting",
      summary: "Approve the repository change",
      attentionReason: "approval",
    });
    assert.equal(waiting.notification?.subtitle, "approval required");
    assert.equal(
      agents.delegationForRun("run-attention")?.attentionReason,
      "approval",
    );

    agents.recordAgentEvent({
      paneId,
      runId: "run-attention",
      agent: "codex",
      status: "waiting",
      summary: "Still waiting for approval",
      attentionReason: "approval",
    });
    assert.equal(state.snapshot().notifications.length, 1);

    agents.recordAgentEvent({
      paneId,
      runId: "run-attention",
      agent: "codex",
      status: "running",
      summary: "Resumed",
    });
    assert.equal(
      agents.delegationForRun("run-attention")?.attentionReason,
      undefined,
    );

    const blocked = agents.recordAgentEvent({
      paneId,
      runId: "run-blocked",
      agent: "codex",
      status: "failed",
      summary: "Delegation blocked",
      attentionReason: "blocked",
      message: "Remote dependency is unavailable",
    });
    assert.equal(blocked.notification?.subtitle, "blocked");
    assert.equal(
      agents.delegationForRun("run-blocked")?.attentionReason,
      "blocked",
    );
    assert.equal(state.snapshot().notifications.length, 2);
  });
});

test("Prime Agent sessions transition from active work to input attention and resume", () => {
  withAgentSessions((state, agents) => {
    const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
    agents.recordAgentEvent({
      paneId,
      runId: "prime-visible-session",
      agent: "prime-agent",
      status: "running",
      summary: "Prime Agent is working",
    });

    const waiting = agents.recordAgentEvent({
      paneId,
      runId: "prime-visible-session",
      agent: "prime-agent",
      status: "waiting",
      summary: "Prime Agent is waiting for input",
      attentionReason: "input",
    });
    assert.equal(waiting.notification?.subtitle, "input required");
    assert.deepEqual(
      agents.delegationForRun("prime-visible-session") && {
        state: agents.delegationForRun("prime-visible-session")?.state,
        attentionReason: agents.delegationForRun("prime-visible-session")?.attentionReason,
      },
      { state: "waiting", attentionReason: "input" },
    );

    agents.recordAgentEvent({
      paneId,
      runId: "prime-visible-session",
      agent: "prime-agent",
      status: "running",
      summary: "Prime Agent resumed",
    });
    assert.deepEqual(
      agents.delegationForRun("prime-visible-session") && {
        state: agents.delegationForRun("prime-visible-session")?.state,
        attentionReason: agents.delegationForRun("prime-visible-session")?.attentionReason,
      },
      { state: "running", attentionReason: undefined },
    );
  });
});

test("state-age budgets notify once with the transition timeline entry", () => {
  withAgentSessions((state, agents) => {
    const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
    agents.recordAgentEvent({
      paneId,
      runId: "run-budget",
      sessionId: "session-budget",
      agent: "codex",
      status: "running",
      summary: "Running repository checks",
      prompt: "Verify the repository.",
    });
    const running = agents.delegationForRun("run-budget");
    assert.ok(running);
    const runningNotifications = agents.notifyExceededStateBudgets(
      { running: 1, waiting: 1 },
      Date.parse(running.stateChangedAt) + 1_001,
    );
    assert.equal(runningNotifications.length, 1);
    assert.equal(
      runningNotifications[0].subtitle,
      "running budget exceeded",
    );
    assert.equal(
      runningNotifications[0].body,
      "Running repository checks",
    );
    assert.equal(
      agents.notifyExceededStateBudgets(
        { running: 1, waiting: 1 },
        Date.parse(running.stateChangedAt) + 2_000,
      ).length,
      0,
    );

    const waitingEvent = agents.recordAgentEvent({
      paneId,
      runId: "run-budget",
      sessionId: "session-budget",
      agent: "codex",
      status: "waiting",
      attentionReason: "login",
      summary: "Sign in to the remote runtime",
    });
    assert.equal(waitingEvent.notification?.subtitle, "login required");
    const waiting = agents.delegationForRun("run-budget");
    assert.ok(waiting);
    assert.ok(
      Date.parse(waiting.stateChangedAt) > Date.parse(running.stateChangedAt),
    );
    assert.equal(waiting.budgetNotifiedAt, undefined);

    const waitingNotifications = agents.notifyExceededStateBudgets(
      { running: 1, waiting: 1 },
      Date.parse(waiting.stateChangedAt) + 1_001,
    );
    assert.equal(waitingNotifications.length, 1);
    assert.equal(
      waitingNotifications[0].subtitle,
      "waiting budget exceeded",
    );
    assert.equal(
      waitingNotifications[0].body,
      "Sign in to the remote runtime",
    );

    const reloaded = new AgentSessionService(state);
    assert.equal(
      reloaded.notifyExceededStateBudgets(
        { running: 1, waiting: 1 },
        Date.parse(waiting.stateChangedAt) + 2_000,
      ).length,
      0,
    );
  });
});
