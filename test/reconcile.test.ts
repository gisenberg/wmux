import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEventDelta,
  applyHealthDelta,
  bootstrapSatisfiesEventDelta,
  bootstrapSatisfiesHealthDelta,
  eventDeltaRequiresResync,
  healthDeltaRequiresResync,
  isIncomingRevisionNewer,
  isIncomingRevisionStale,
  reconcile,
  reconcileIncomingRevision,
} from "../src/client/src/reconcile.js";
import type { BootstrapPayload, EventStateDelta } from "../src/shared/protocol.js";

test("returns the previous reference when content is deep-equal", () => {
  const prev = { workspaces: [{ id: "a", tabs: [{ id: "t", panes: [] }] }], count: 1 };
  const next = JSON.parse(JSON.stringify(prev));
  assert.equal(reconcile(prev, next), prev);
});

test("keeps identity for unchanged subtrees when siblings change", () => {
  const prev = {
    workspaces: [
      { id: "a", name: "one" },
      { id: "b", name: "two" },
    ],
  };
  const next = {
    workspaces: [
      { id: "a", name: "one" },
      { id: "b", name: "renamed" },
    ],
  };
  const result = reconcile(prev, next);
  assert.notEqual(result, prev);
  assert.equal(result.workspaces[0], prev.workspaces[0]);
  assert.notEqual(result.workspaces[1], prev.workspaces[1]);
  assert.equal(result.workspaces[1].name, "renamed");
});

test("handles added and removed array entries", () => {
  const prev = { items: [{ id: 1 }, { id: 2 }] };
  const grown = reconcile(prev, { items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.equal(grown.items[0], prev.items[0]);
  assert.equal(grown.items.length, 3);
  const shrunk = reconcile(prev, { items: [{ id: 1 }] });
  assert.equal(shrunk.items[0], prev.items[0]);
  assert.equal(shrunk.items.length, 1);
});

test("handles nulls, primitives, and mismatched shapes", () => {
  assert.equal(reconcile(null, 5), 5);
  assert.equal(reconcile({ a: 1 }, null), null);
  assert.equal(reconcile([1, 2], { a: 1 }).a, 1);
  assert.equal(reconcile(undefined, "x"), "x");
});

test("always reflects next's content, never prev's", () => {
  const prev = { a: { deep: [1, 2, 3] }, gone: true };
  const next = { a: { deep: [1, 2, 3] }, added: "yes" };
  const result = reconcile(prev, next) as Record<string, unknown>;
  assert.equal(result.a, prev.a);
  assert.equal(result.added, "yes");
  assert.equal("gone" in result, false);
});

test("orders snapshots by persisted revision then health epoch", () => {
  assert.equal(isIncomingRevisionStale({ revision: 12, healthEpoch: 4 }, { revision: 11, healthEpoch: 99 }), true);
  assert.equal(isIncomingRevisionStale({ revision: 12, healthEpoch: 4 }, { revision: 12, healthEpoch: 3 }), true);
  assert.equal(isIncomingRevisionStale({ revision: 12, healthEpoch: 4 }, { revision: 12, healthEpoch: 4 }), false);
  assert.equal(
    isIncomingRevisionStale(
      { revision: 12, healthEpoch: 4, eventRevision: 9 },
      { revision: 12, healthEpoch: 4, eventRevision: 8 },
    ),
    true,
  );
  assert.equal(
    isIncomingRevisionStale(
      { revision: 12, healthEpoch: 4, eventRevision: 9 },
      { revision: 12, healthEpoch: 5, eventRevision: 0 },
    ),
    false,
  );
  assert.equal(isIncomingRevisionStale({ revision: 12, healthEpoch: 4 }, { revision: 13, healthEpoch: 0 }), false);
  assert.equal(isIncomingRevisionStale(null, { revision: 1, healthEpoch: 0 }), false);
  // A reconnect bootstrap from before the accepted health delta must not regress it.
  assert.equal(isIncomingRevisionStale({ revision: 12, healthEpoch: 5 }, { revision: 12, healthEpoch: 4 }), true);
});

test("later process epochs supersede same-revision state while lower same-process epochs remain stale", () => {
  const previousProcess = { revision: 12, healthEpoch: 1_024_005, value: "previous process" };
  const restartedProcess = { revision: 12, healthEpoch: 1_025_024, value: "restarted process" };
  assert.equal(isIncomingRevisionStale(previousProcess, restartedProcess), false);
  assert.deepEqual(reconcileIncomingRevision(previousProcess, restartedProcess), restartedProcess);
  const currentProcess = { ...restartedProcess, healthEpoch: 1_025_029 };
  assert.equal(isIncomingRevisionStale(currentProcess, { ...currentProcess, healthEpoch: 1_025_028 }), true);
});

test("pending health floors advance only for strictly newer deltas", () => {
  const pending = { revision: 8, healthEpoch: 4 };
  assert.equal(isIncomingRevisionNewer(pending, { revision: 8, healthEpoch: 4 }), false);
  assert.equal(isIncomingRevisionNewer(pending, { revision: 8, healthEpoch: 3 }), false);
  assert.equal(isIncomingRevisionNewer(pending, { revision: 8, healthEpoch: 5 }), true);
  assert.equal(isIncomingRevisionNewer(pending, { revision: 9, healthEpoch: 0 }), true);
  assert.equal(isIncomingRevisionNewer(pending, { revision: 7, healthEpoch: 99 }), false);
});

test("future-revision health deltas require resync without promoting stale state", () => {
  const current = { revision: 7, healthEpoch: 2, machines: [], streams: [], workspaces: [{ id: "current" }] };
  const future = { revision: 8, healthEpoch: 4, machines: [{ id: "future" }] };
  assert.equal(healthDeltaRequiresResync(current, future), true);
  assert.equal(healthDeltaRequiresResync(current, { revision: 7, healthEpoch: 3 }), false);
  assert.equal(healthDeltaRequiresResync(current, { revision: 6, healthEpoch: 99 }), false);
  assert.equal(healthDeltaRequiresResync(null, future), true);
  assert.equal(applyHealthDelta(current, future), current);
  assert.equal(bootstrapSatisfiesHealthDelta(future, { revision: 8, healthEpoch: 3 }), false);
  assert.equal(bootstrapSatisfiesHealthDelta(future, { revision: 8, healthEpoch: 4 }), true);
  assert.equal(bootstrapSatisfiesHealthDelta(future, { revision: 9, healthEpoch: 0 }), true);
});

test("applies only newer compatible health deltas without rebuilding unrelated state", () => {
  const current = { revision: 7, healthEpoch: 2, machines: [{ id: "a", reachable: false }], streams: [], workspaces: [{ id: "w" }] };
  assert.equal(applyHealthDelta(current, { revision: 6, healthEpoch: 3, machines: [] }), current);
  assert.equal(applyHealthDelta(current, { revision: 8, healthEpoch: 3, machines: [] }), current);
  assert.equal(applyHealthDelta(current, { revision: 7, healthEpoch: 2, machines: [] }), current);
  const updated = applyHealthDelta(current, { revision: 7, healthEpoch: 3, machines: [{ id: "a", reachable: true }] });
  assert.notEqual(updated, current);
  assert.equal(updated?.workspaces, current.workspaces);
  assert.deepEqual(updated?.machines, [{ id: "a", reachable: true }]);
});

test("event deltas update one domain while preserving unrelated store identity", () => {
  const current = {
    eventRevision: 4,
    revision: 7,
    workspaceTreeRevision: 2,
    healthEpoch: 3,
    workspaces: [
      { id: "workspace-a", name: "A" },
      { id: "workspace-b", name: "B" },
    ],
    activeWorkspaceId: "workspace-a",
    notifications: [],
    agentEvents: [],
    delegations: [],
    agentTimelines: [],
    runs: [],
    settings: { terminalFontSize: 14 },
    machines: [],
    streams: [],
  } as unknown as BootstrapPayload;
  const delta: EventStateDelta = {
    type: "delta",
    baseEventRevision: 4,
    eventRevision: 5,
    revision: 8,
    healthEpoch: 3,
    workspaces: {
      items: {
        upserted: [{ ...current.workspaces[0], name: "Renamed" }],
        removedIds: [],
      },
    },
  };
  const updated = applyEventDelta(current, delta);
  assert.notEqual(updated, current);
  assert.equal(updated?.eventRevision, 5);
  assert.equal(updated?.workspaces[0].name, "Renamed");
  assert.equal(updated?.workspaces[1], current.workspaces[1]);
  assert.equal(updated?.notifications, current.notifications);
});

test("event revision gaps require snapshot resync and stale deltas stay ignored", () => {
  const current = { eventRevision: 7 } as BootstrapPayload;
  const gap = {
    type: "delta",
    baseEventRevision: 8,
    eventRevision: 9,
    revision: 12,
    healthEpoch: 3,
  } satisfies EventStateDelta;
  assert.equal(eventDeltaRequiresResync(current, gap), true);
  assert.equal(eventDeltaRequiresResync(current, {
    ...gap,
    baseEventRevision: 7,
    eventRevision: 8,
  }), false);
  assert.equal(eventDeltaRequiresResync(current, {
    ...gap,
    baseEventRevision: 5,
    eventRevision: 6,
  }), false);
  assert.equal(
    bootstrapSatisfiesEventDelta(gap, { eventRevision: 8, healthEpoch: 3 }),
    false,
  );
  assert.equal(
    bootstrapSatisfiesEventDelta(gap, { eventRevision: 0, healthEpoch: 4 }),
    true,
  );
});

test("revision-aware reconciliation keeps newer state and accepts current snapshots", () => {
  const current = { revision: 12, healthEpoch: 4, value: "socket" };
  assert.equal(reconcileIncomingRevision(current, { revision: 11, healthEpoch: 99, value: "http" }), current);
  assert.equal(reconcileIncomingRevision(current, { revision: 12, healthEpoch: 3, value: "stale health" }), current);
  assert.deepEqual(reconcileIncomingRevision(current, { revision: 12, healthEpoch: 4, value: "refresh" }), {
    revision: 12,
    healthEpoch: 4,
    value: "refresh",
  });
});
