import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentInputRequestStore, capturePayloadDigest, nativeOccurrenceKey } from "../src/server/agent-input-request-store.js";
import { AgentSessionService } from "../src/server/agent-sessions.js";
import { EventBroadcastRuntime } from "../src/server/event-broadcast.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import { StreamRequestStore } from "../src/server/streams.js";
import {
  applyEventDelta,
  bootstrapSatisfiesEventDelta,
  eventDeltaRequiresResync,
} from "../src/client/src/store/reconcile.js";
import type { BootstrapPayload, EventServerMessage, MachineConfig } from "../src/shared/protocol.js";

test("agent-input bootstrap and deltas converge with deterministic order, removals, and contentless notification dedupe", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-projection-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), {
    answerDigestKey: "key", resolvedRetentionMs: 10, tombstoneRetentionMs: 1_000,
  });
  const runtime = new EventBroadcastRuntime({
    bindHost: "127.0.0.1",
    state,
    agentSessions: new AgentSessionService(state),
    settings: new SettingsStore(path.join(directory, "settings.json")),
    streamRequests: new StreamRequestStore(),
    agentInputRequests: requests,
    currentMachines: () => machines,
    machineStatusResolver: async () => [],
    streamStatusResolver: async () => [],
    refreshIntervals: { machines: 60_000, streams: 60_000, agentNotifications: 60_000 },
  });
  const messages: EventServerMessage[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (value: string) => messages.push(JSON.parse(value) as EventServerMessage),
    on: () => undefined,
  } as any;
  runtime.addEventSocket(socket);
  try {
    let reconstructed = runtime.currentPayload() as BootstrapPayload;
    const legacyClientProjection = (({ eventRevision, workspaces, notifications }) => ({
      eventRevision,
      workspaces,
      notifications,
    }))(reconstructed);
    assert.deepEqual(legacyClientProjection, {
      eventRevision: reconstructed.eventRevision,
      workspaces: reconstructed.workspaces,
      notifications: reconstructed.notifications,
    }, "an old client can consume the new server's additive bootstrap shape");
    const context = state.findPaneContext(state.snapshot().workspaces[0].tabs[0].panes[0].id)!;
    const create = (openCodeRequestId: string, nowMs: number) => {
      const input = {
      occurrenceId: `occ-${openCodeRequestId}`,
      occurrenceOrdinal: 1,
      sourceId: "source-one",
      workspaceId: context.workspace.id,
      tabId: context.tab.id,
      paneId: context.pane.id,
      machineId: context.pane.machineId,
      openCodeSessionId: "session-one",
      openCodeRequestId,
      questions: [{
        header: "Mode", question: "Choose private option", options: [{ label: "Safe", description: "Safe" }],
        multiple: false, custom: false,
      }],
      };
      return requests.capture({ ...input, occurrenceKey: nativeOccurrenceKey(input.openCodeSessionId, input.openCodeRequestId), payloadDigest: capturePayloadDigest(input) }, nowMs);
    };
    const first = create("question-one", 1_000);
    const second = create("question-two", 2_000);
    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "created");
    assert.equal(create("question-two", 2_000).outcome, "duplicate");
    const deltas = messages.filter((message): message is Extract<EventServerMessage, { type: "delta" }> => message.type === "delta");
    assert.equal(deltas.length, 2, "one revision per persisted request creation");
    assert.equal(deltas[0].baseEventRevision, reconstructed.eventRevision);
    assert.equal(deltas[1].baseEventRevision, deltas[0].eventRevision);
    assert.equal(eventDeltaRequiresResync(reconstructed, deltas[0]), false);
    assert.equal(eventDeltaRequiresResync(reconstructed, deltas[1]), true, "skipping a delta forces bootstrap resync");
    assert.equal(applyEventDelta(reconstructed, deltas[1]), reconstructed, "a gapped delta is never partially applied");
    assert.equal(bootstrapSatisfiesEventDelta(deltas[1], runtime.currentPayload()), true);
    for (const delta of deltas) reconstructed = applyEventDelta(reconstructed, delta)!;
    assert.deepEqual(reconstructed.agentInputRequests.map((request) => request.openCodeRequestId), ["question-one", "question-two"]);
    const notifications = state.snapshot().notifications.filter((notification) => notification.agentInputRequestId);
    assert.equal(notifications.length, 2);
    assert.ok(notifications.every((notification) => notification.title === "Agent input requested"
      && notification.subtitle === "OpenCode needs attention" && notification.body === ""));
    assert.doesNotMatch(JSON.stringify(notifications), /Choose private option|Safe/);
    assert.ok(notifications.every((notification) => notification.href?.includes("agentInput=")));

    if (first.outcome !== "created") return;
    requests.resolveNative(first.request.id, first.request.generation, "replied", 3_000);
    const resolutionDelta = messages.filter((message): message is Extract<EventServerMessage, { type: "delta" }> => message.type === "delta").at(-1)!;
    reconstructed = applyEventDelta(reconstructed, resolutionDelta)!;
    assert.equal(reconstructed.agentInputRequests.find((request) => request.id === first.request.id)?.state, "answered");
    assert.equal(state.snapshot().notifications.find((notification) => notification.agentInputRequestId === first.request.id)?.read, true);

    requests.prune(3_100);
    const removalDelta = messages.filter((message): message is Extract<EventServerMessage, { type: "delta" }> => message.type === "delta").at(-1)!;
    reconstructed = applyEventDelta(reconstructed, removalDelta)!;
    assert.ok(removalDelta.agentInputRequests?.removedIds.includes(first.request.id));
    const fresh = runtime.currentPayload() as BootstrapPayload;
    assert.deepEqual(reconstructed.agentInputRequests, fresh.agentInputRequests);
    assert.equal(reconstructed.eventRevision, fresh.eventRevision);
  } finally {
    runtime.dispose();
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a new client upgrades an old-server bootstrap shape when agent-input deltas appear", () => {
  const oldBootstrap = {
    eventRevision: 4,
    healthEpoch: 1,
    revision: 1,
    workspaces: [],
    notifications: [],
    agentEvents: [],
    delegations: [],
    agentTimelines: [],
    runs: [],
  } as unknown as BootstrapPayload;
  const request = {
    id: "input-one", sourceId: "source", workspaceId: "workspace", tabId: "tab", paneId: "pane",
    openCodeSessionId: "session", openCodeRequestId: "question", generation: 1,
    questions: [{ header: "H", question: "Q", options: [], multiple: false, custom: true }],
    state: "pending", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  } as const;
  const upgraded = applyEventDelta(oldBootstrap, {
    type: "delta", eventRevision: 5, baseEventRevision: 4, revision: 1, healthEpoch: 1,
    agentInputRequests: { upserted: [request], removedIds: [], order: [request.id] },
  });
  assert.deepEqual(upgraded?.agentInputRequests, [request]);
  assert.equal(upgraded?.eventRevision, 5);
});

test("agent-input bootstrap filters requests whose panes are no longer visible", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-visible-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const requests = new AgentInputRequestStore(path.join(directory, "requests.json"), { answerDigestKey: "key" });
  const context = state.findPaneContext(state.snapshot().workspaces[0].tabs[0].panes[0].id)!;
  const input = { occurrenceId: "occ-request", occurrenceOrdinal: 1, sourceId: "source", workspaceId: context.workspace.id, tabId: context.tab.id, paneId: context.pane.id,
    machineId: "local", openCodeSessionId: "session", openCodeRequestId: "request",
    questions: [{ header: "H", question: "Q", options: [], multiple: false, custom: true }] };
  requests.capture({ ...input, occurrenceKey: nativeOccurrenceKey(input.openCodeSessionId, input.openCodeRequestId), payloadDigest: capturePayloadDigest(input) });
  state.removeWorkspace(context.workspace.id);
  const runtime = new EventBroadcastRuntime({ bindHost: "127.0.0.1", state, agentSessions: new AgentSessionService(state),
    settings: new SettingsStore(path.join(directory, "settings.json")), streamRequests: new StreamRequestStore(),
    agentInputRequests: requests, currentMachines: () => machines, machineStatusResolver: async () => [], streamStatusResolver: async () => [] });
  try { assert.deepEqual(runtime.currentPayload().agentInputRequests, []); } finally {
    runtime.dispose(); state.flush(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
