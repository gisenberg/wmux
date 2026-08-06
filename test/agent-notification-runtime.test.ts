import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { AgentSessionService } from "../src/server/agent-sessions.js";
import { AgentInputRequestStore } from "../src/server/agent-input-request-store.js";
import { EventBroadcastRuntime } from "../src/server/event-broadcast.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import { StreamRequestStore } from "../src/server/streams.js";
import type {
  MachineConfig,
  TerminalNotification,
} from "../src/server/types.js";

test("the agent heartbeat emits one durable exceeded-budget notification", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-agent-notification-runtime-"),
  );
  const machines: MachineConfig[] = [{
    id: "local",
    name: "Local",
    kind: "local",
  }];
  const state = new StateStore(
    machines,
    path.join(directory, "state.json"),
  );
  const agents = new AgentSessionService(state);
  const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
  agents.recordAgentEvent({
    paneId,
    runId: "run-heartbeat-budget",
    sessionId: "session-heartbeat-budget",
    agent: "codex",
    status: "running",
    summary: "Running checks on the remote host",
  });
  state.commitMutation((persisted) => {
    persisted.delegations[0].stateChangedAt =
      new Date(Date.now() - 2_000).toISOString();
    return { result: undefined, changed: true };
  });

  const notifications: TerminalNotification[] = [];
  state.on("notification", (notification) => {
    notifications.push(notification as TerminalNotification);
  });
  const runtime = new EventBroadcastRuntime({
    bindHost: "127.0.0.1",
    state,
    agentSessions: agents,
    settings: new SettingsStore(path.join(directory, "settings.json")),
    streamRequests: new StreamRequestStore(),
    agentInputRequests: new AgentInputRequestStore(path.join(directory, "agent-input.json"), { answerDigestKey: "key" }),
    currentMachines: () => machines,
    machineStatusResolver: async () => [],
    streamStatusResolver: async () => [],
    delegation: {
      preferHeadless: false,
      waitTimeoutSeconds: {
        review: 1_800,
        change: 7_200,
        deploy: 7_200,
      },
      notificationBudgetSeconds: { running: 1, waiting: 1 },
      waitTimeoutBoundsSeconds: { min: 0.1, max: 14_400 },
    },
    refreshIntervals: {
      agentNotifications: 5,
      machines: 60_000,
      streams: 60_000,
    },
  });

  try {
    await delay(30);
    assert.equal(notifications.length, 1);
    assert.equal(
      notifications[0].subtitle,
      "running budget exceeded",
    );
    assert.equal(
      state.snapshot().delegations[0].budgetNotifiedAt,
      notifications[0].createdAt,
    );
    await delay(20);
    assert.equal(notifications.length, 1);
  } finally {
    runtime.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
