import assert from "node:assert/strict";
import { test } from "node:test";
import { isIncomingRevisionStale, reconcile, reconcileIncomingRevision } from "../src/client/src/reconcile.js";

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

test("rejects delayed snapshots without rejecting same-revision health refreshes", () => {
  assert.equal(isIncomingRevisionStale({ revision: 12 }, { revision: 11 }), true);
  assert.equal(isIncomingRevisionStale({ revision: 12 }, { revision: 12 }), false);
  assert.equal(isIncomingRevisionStale({ revision: 12 }, { revision: 13 }), false);
  assert.equal(isIncomingRevisionStale(null, { revision: 1 }), false);
});

test("revision-aware reconciliation keeps newer state and accepts same-revision refreshes", () => {
  const current = { revision: 12, value: "socket" };
  assert.equal(reconcileIncomingRevision(current, { revision: 11, value: "http" }), current);
  assert.deepEqual(reconcileIncomingRevision(current, { revision: 12, value: "health" }), {
    revision: 12,
    value: "health",
  });
});
