import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSessionService } from "../src/server/agent-sessions.js";
import { AgentTimelineStore } from "../src/server/agent-timeline.js";
import { CodexLifecyclePublisher } from "../src/server/codex-lifecycle.js";
import { CodexTerminalBindingRegistry } from "../src/server/codex-terminal-binding.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";
import { latestAgentActivityByPane } from "../src/client/src/workspace-agent-activity.js";

const paneId = "pane", sessionId = "session", turnId = "turn";
const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
function setup() {
  const registry = new CodexTerminalBindingRegistry(() => ({ workspaceId: "workspace", tabId: "tab", paneId }), () => true);
  const issued = registry.issue(sessionId, turnId); registry.observe(paneId, issued.marker);
  const events: any[] = [];
  const publisher = new CodexLifecyclePublisher(registry, { markCodexObserversStale() {}, delegationForRun() {}, markCodexObserverStale: () => events.push({ status: "observer_stale" }), recordAgentEvent: (event: any) => { events.push(event); return {}; } } as any);
  return { registry, issued, events, publisher };
}
test("publishes binding-correlated ordered lifecycle events without receipts", () => {
  const { issued, events, publisher } = setup();
  assert.deepEqual(publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 1, state: "attention", attention: "approval" }), { accepted: true });
  assert.match(events[0].runId, /^codex_[A-Za-z0-9_-]{43}$/);
  assert.equal(events[0].attentionReason, "approval");
  assert.equal(events[0].receipt, undefined);
  assert.deepEqual(publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 1, state: "completed", attention: null }), { accepted: false });
  assert.equal(events.length, 1); publisher.dispose();
});
test("rejects a mismatched turn before any lifecycle side effect", () => {
  const { issued, events, publisher } = setup();
  assert.throws(() => publisher.publish({ sessionId, receipt: issued.receipt, turnId: "other", sequence: 1, state: "active", attention: null }), /binding_turn_mismatch/);
  assert.equal(events.length, 0); publisher.dispose();
});
test("initial unknown/notLoaded produces one static diagnostic without native activity", () => {
  const { issued, events, publisher } = setup();
  publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 1, state: "unknown", attention: null });
  publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 2, state: "notLoaded", attention: null });
  assert.deepEqual(events.map(event => event.status), ["observer_stale"]); publisher.dispose();
});
test("non-authoritative samples cannot postpone a stale observer", () => {
  const { issued, events, publisher } = setup();
  publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 1, state: "active", attention: null });
  publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 2, state: "unknown", attention: null });
  publisher.reconcile(Date.now() + 30_001);
  assert.equal(events.at(-1)?.status, "observer_stale");
  publisher.dispose();
});
test("a terminal event releases its lease and cannot later become stale", () => {
  const { issued, events, publisher } = setup();
  publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 1, state: "active", attention: null });
  publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 2, state: "completed", attention: null });
  publisher.reconcile(Date.now() + 30_001);
  assert.deepEqual(events.map((event) => event.status), ["running", "completed"]);
  publisher.dispose();
});
test("real state and timeline retain attention changes and terminal immutability", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-lifecycle-"));
  try {
    const state = new StateStore(machines, path.join(directory, "state.json"));
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const workspace = state.snapshot().workspaces[0];
    const tab = workspace.tabs[0];
    const agents = new AgentSessionService(state, AgentTimelineStore.persistent(path.join(directory, "timeline.json")));
    const registry = new CodexTerminalBindingRegistry(() => ({ workspaceId: workspace.id, tabId: tab.id, paneId: pane.id }), (id) => Boolean(state.findPane(id)));
    const issued = registry.issue(sessionId, turnId); registry.observe(pane.id, issued.marker);
    const publisher = new CodexLifecyclePublisher(registry, agents);
    publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 1, state: "attention", attention: "approval" });
    publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 2, state: "attention", attention: "input" });
    const beforeTerminal = state.snapshot();
    assert.equal(beforeTerminal.delegations[0]?.attentionReason, "input");
    assert.equal(beforeTerminal.notifications.length, 2);
    publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 3, state: "completed", attention: null });
    publisher.publish({ sessionId, receipt: issued.receipt, turnId, sequence: 4, state: "unknown", attention: null });
    assert.equal(state.snapshot().delegations[0]?.state, "completed");
    assert.equal(agents.timelines.snapshot().find((timeline) => timeline.id === sessionId)?.entries.at(-1)?.state, "completed");
    publisher.dispose();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("initial uncertainty is one non-notifying diagnostic, then authoritative recovery and terminal state are exact", t => {
  const { state, agents, publisher, publish } = realFixture(t);
  publish("unknown"); publish("notLoaded"); publish("unknown");
  let snapshot = state.snapshot();
  assert.equal(snapshot.agentEvents.length, 1);
  assert.equal(snapshot.agentEvents[0]?.status, "observer_stale");
  assert.equal(snapshot.delegations.length, 0, "uncertainty must not fabricate a running native delegation");
  assert.equal(snapshot.notifications.length, 0);
  const timeline = agents.timelines.snapshot().find(item => item.id === sessionId);
  assert.equal(timeline?.entries.length, 1);
  assert.equal(timeline?.entries.find(entry => entry.actor === "system")?.actor, "system");

  publish("active");
  snapshot = state.snapshot();
  assert.equal(snapshot.agentEvents[0]?.status, "running");
  assert.equal(snapshot.delegations[0]?.state, "running");
  assert.equal(snapshot.notifications.length, 0);
  publish("completed"); publish("completed");
  snapshot = state.snapshot();
  assert.equal(snapshot.delegations[0]?.state, "completed");
  assert.equal(snapshot.agentEvents.filter(event => event.status === "completed").length, 1);
  assert.equal(snapshot.notifications.length, 1);
  assert.equal(agents.timelines.snapshot().find(item => item.id === sessionId)?.entries.filter(entry => entry.state === "completed").length, 1);
  publisher.dispose();
});

function realFixture(t: any, withSecondPane = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-lifecycle-real-"));
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const workspace = state.snapshot().workspaces[0], tab = workspace.tabs[0], pane = tab.panes[0];
  const agents = new AgentSessionService(state, AgentTimelineStore.persistent(path.join(directory, "timeline.json")));
  const registry = new CodexTerminalBindingRegistry((id) => {
    const context = state.findPaneContext(id);
    return context ? { paneId: id, workspaceId: context.workspace.id, tabId: context.tab.id } : undefined;
  }, id => Boolean(state.findPane(id)));
  const publisher = new CodexLifecyclePublisher(registry, agents);
  const issued = registry.issue(sessionId, turnId); registry.observe(pane.id, issued.marker);
  const second = withSecondPane ? state.createWorkspace("local") : undefined;
  const secondPane = second?.tabs[0].panes[0];
  const secondSessionId = "session_two", secondTurnId = "turn_two";
  const secondIssued = secondPane ? registry.issue(secondSessionId, secondTurnId) : undefined;
  if (secondPane && secondIssued) registry.observe(secondPane.id, secondIssued.marker);
  let sequence = 0;
  const publish = (status: string, attention: string | null = null) => publisher.publish({ sessionId, turnId, receipt: issued.receipt, sequence: ++sequence, state: status, attention });
  let secondSequence = 0;
  const publishSecond = (status: string, attention: string | null = null) => secondIssued && publisher.publish({ sessionId: secondSessionId, turnId: secondTurnId, receipt: secondIssued.receipt, sequence: ++secondSequence, state: status, attention });
  t.after(() => { publisher.dispose(); state.flush(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { state, agents, registry, publisher, issued, workspace, pane, publish, secondPane, publishSecond, stateFile: path.join(directory, "state.json") };
}

test("another pane cannot evict valid stale or initial-uncertainty evidence", t => {
  const { state, agents, publisher, publish, publishSecond } = realFixture(t, true);
  publish("unknown");
  const initialTimelineCount = agents.timelines.snapshot().find(item => item.id === sessionId)?.entries.length;
  assert.equal(initialTimelineCount, 1);
  publishSecond("active");
  publish("notLoaded");
  assert.equal(agents.timelines.snapshot().find(item => item.id === sessionId)?.entries.length, initialTimelineCount);

  publish("active");
  publisher.reconcile(Date.now() + 30_001);
  assert.equal(state.snapshot().agentEvents.find(event => event.paneId === state.snapshot().workspaces[0].tabs[0].panes[0].id)?.status, "observer_stale");
  const staleTimelineCount = agents.timelines.snapshot().find(item => item.id === sessionId)?.entries.length;
  publishSecond("active");
  publish("unknown");
  assert.equal(agents.timelines.snapshot().find(item => item.id === sessionId)?.entries.length, staleTimelineCount);
  publisher.dispose();
});

test("recent-history churn preserves a live pane's initial unknown state without re-emitting it", t => {
  const { state, agents, pane, secondPane, publish, workspace, stateFile } = realFixture(t, true);
  publish("unknown");
  const initial = state.snapshot().agentEvents[0];
  const floodOtherPane = () => {
    for (let i = 0; i < 305; i++) {
      agents.recordAgentEvent({ paneId: secondPane!.id, agent: "opencode", status: "updated", summary: `other activity ${i}` });
    }
  };
  floodOtherPane();
  publish("notLoaded");
  let snapshot = state.snapshot();
  assert.deepEqual(latestAgentActivityByPane(snapshot.agentEvents).get(pane.id), initial);
  assert.equal(snapshot.agentEvents.length, 301, "300 recent events plus the older current pane state");
  assert.equal(snapshot.delegations.length, 0, "retention must not manufacture a running delegation");
  assert.equal(snapshot.notifications.length, 0);
  assert.equal(agents.timelines.snapshot().find(item => item.id === sessionId)?.entries.length, 1);
  state.flush();
  const reloaded = new StateStore(machines, stateFile);
  new AgentSessionService(reloaded);
  assert.deepEqual(latestAgentActivityByPane(reloaded.snapshot().agentEvents).get(pane.id), initial);
  assert.equal(reloaded.snapshot().delegations.length, 0);
  assert.equal(reloaded.snapshot().notifications.length, 0);
  reloaded.flush();

  publish("active"); publish("completed");
  const completed = state.snapshot().agentEvents.find(event => event.paneId === pane.id);
  floodOtherPane();
  snapshot = state.snapshot();
  assert.deepEqual(latestAgentActivityByPane(snapshot.agentEvents).get(pane.id), completed);
  assert.equal(snapshot.agentEvents.filter(event => event.paneId === pane.id).length, 1, "recovery replaces the protected stale record");
  assert.equal(snapshot.notifications.length, 1, "retention must not duplicate terminal notifications");
  state.removeWorkspace(workspace.id);
  assert.equal(state.snapshot().agentEvents.some(event => event.paneId === pane.id), false, "pane disposal releases its current-state record");
});

test("stale recovery preserves native outcome and clears only the observer error", t => {
  const { state, publisher, publish } = realFixture(t);
  publish("attention", "approval");
  const stateAge = state.snapshot().delegations[0].stateChangedAt;
  publish("unknown"); publish("notLoaded");
  publisher.reconcile(Date.now() + 30_001);
  assert.equal(state.snapshot().agentEvents[0].status, "observer_stale");
  assert.equal(state.snapshot().delegations[0].state, "waiting");
  assert.equal(state.snapshot().delegations[0].stateChangedAt, stateAge);
  assert.equal(state.snapshot().notifications.length, 1);
  publish("active");
  assert.equal(state.snapshot().agentEvents[0].status, "running");
  assert.equal(state.snapshot().delegations[0].observerError, undefined);
  assert.equal(state.snapshot().delegations[0].attentionReason, undefined);
  publish("interrupted");
  assert.equal(state.snapshot().notifications.at(0)?.subtitle, "interrupted");
  const count = state.snapshot().notifications.length;
  assert.deepEqual(publish("interrupted"), { accepted: false });
  assert.deepEqual(publish("active"), { accepted: false });
  publisher.reconcile(Date.now() + 60_000);
  assert.equal(state.snapshot().agentEvents[0].status, "interrupted");
  assert.equal(state.snapshot().notifications.length, count);
});

test("revoking an observer cannot leave old Working permanent or overwrite replacement activity", t => {
  const { state, agents, registry, publisher, pane, publish } = realFixture(t);
  publish("active");
  registry.invalidatePane(pane.id);
  publisher.reconcile(Date.now() + 30_001);
  assert.equal(state.snapshot().agentEvents[0].status, "observer_stale");
  assert.throws(() => publish("completed"), /binding_not_found/);
  agents.recordAgentEvent({ paneId: pane.id, agent: "opencode", runId: "replacement", status: "running" });
  publisher.reconcile(Date.now() + 60_000);
  agents.markCodexObserversStale();
  assert.equal(state.snapshot().agentEvents[0].agent, "opencode");
  assert.equal(state.snapshot().agentEvents[0].status, "running");
});

test("restart invalidates only latest active plugin-owned events and missing panes are harmless", t => {
  const { state, agents, publisher, workspace, publish } = realFixture(t);
  publish("active");
  agents.markCodexObserversStale();
  assert.equal(state.snapshot().agentEvents[0].status, "observer_stale");
  publish("active"); publish("completed");
  agents.markCodexObserversStale();
  assert.equal(state.snapshot().agentEvents[0].status, "completed");
  state.removeWorkspace(workspace.id);
  assert.doesNotThrow(() => publisher.reconcile(Date.now() + 60_000));
  assert.doesNotThrow(() => agents.markCodexObserversStale());
});

test("invalid attention state combinations fail before consuming the sequence", t => {
  const { state, publisher, issued } = realFixture(t);
  const body = { sessionId, turnId, receipt: issued.receipt, sequence: 1 };
  assert.throws(() => publisher.publish({ ...body, state: "active", attention: "approval" }), /invalid_codex_lifecycle/);
  assert.throws(() => publisher.publish({ ...body, state: "attention", attention: null }), /invalid_codex_lifecycle/);
  assert.deepEqual(publisher.publish({ ...body, state: "active", attention: null }), { accepted: true });
  assert.equal(state.snapshot().agentEvents[0].status, "running");
});
