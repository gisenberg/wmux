import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_LIFECYCLE_TURN_PAGE_LIMIT, CODEX_LIFECYCLE_MAX_TURN_PAGES, observeCodexLifecycle } from "../plugins/wmux/scripts/codex-lifecycle.mjs";

const threadId = "thread_root", sessionId = "session_root", turnId = "turn_current";
const thread = (status: unknown, extra: Record<string, unknown> = {}) => ({ thread: { id: threadId, sessionId, parentThreadId: null, status, ...extra } });
const turn = (status: string, id = turnId) => ({ id, status, startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: status === "inProgress" ? null : 1, items: [], itemsView: "notLoaded", error: null });

function transport(...responses: unknown[]) {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("snapshots an active bound root turn with a bounded read-only request sequence", async () => {
  const api = transport(thread({ type: "active", activeFlags: [] }), { data: [turn("inProgress")], nextCursor: null, backwardsCursor: null }, thread({ type: "active", activeFlags: [] }));
  const result = await observeCodexLifecycle({ request: api.request, threadId, sessionId, turnId });
  assert.deepEqual(result, { threadId, sessionId, turnId, state: "active", attention: null, reason: null });
  assert.deepEqual(api.calls.map(call => call.method), ["thread/read", "thread/turns/list", "thread/read"]);
  assert.deepEqual(api.calls[1]?.params, { threadId, cursor: null, limit: CODEX_LIFECYCLE_TURN_PAGE_LIMIT, sortDirection: "desc", itemsView: "notLoaded" });
});

test("maps only recognized active attention flags and never fabricates a request id", async () => {
  const api = transport(thread({ type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"] }), { data: [turn("inProgress")], nextCursor: null, backwardsCursor: null }, thread({ type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"] }));
  assert.deepEqual(await observeCodexLifecycle({ request: api.request, threadId, sessionId, turnId }), { threadId, sessionId, turnId, state: "attention", attention: "approval_and_input", reason: null });
});

test("returns unknown for unrecognized active flags", async () => {
  const api = transport(thread({ type: "active", activeFlags: ["futureFlag"] }), { data: [turn("inProgress")], nextCursor: null, backwardsCursor: null }, thread({ type: "active", activeFlags: ["futureFlag"] }));
  assert.deepEqual(await observeCodexLifecycle({ request: api.request, threadId, sessionId, turnId }), { threadId, sessionId, turnId, state: "unknown", attention: null, reason: "unknown_active_flag" });
  const extended = transport(thread({ type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput", "futureFlag"] }), { data: [turn("inProgress")], nextCursor: null, backwardsCursor: null }, thread({ type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput", "futureFlag"] }));
  assert.equal((await observeCodexLifecycle({ request: extended.request, threadId, sessionId, turnId })).reason, "unknown_active_flag");
});

test("requires a stable bracketed read before accepting a terminal outcome", async () => {
  const raced = transport(thread({ type: "active", activeFlags: [] }), { data: [turn("completed")], nextCursor: null, backwardsCursor: null }, thread({ type: "idle" }));
  assert.equal((await observeCodexLifecycle({ request: raced.request, threadId, sessionId, turnId })).reason, "cross_read_race");
  const settled = transport(thread({ type: "idle" }), { data: [turn("interrupted")], nextCursor: null, backwardsCursor: null }, thread({ type: "idle" }));
  assert.deepEqual(await observeCodexLifecycle({ request: settled.request, threadId, sessionId, turnId }), { threadId, sessionId, turnId, state: "interrupted", attention: null, reason: null, completedAt: 2, durationMs: 1 });
});

test("never infers completion from idle or accepts a terminal status for another turn", async () => {
  const idle = transport(thread({ type: "idle" }), { data: [], nextCursor: null, backwardsCursor: null }, thread({ type: "idle" }));
  assert.equal((await observeCodexLifecycle({ request: idle.request, threadId, sessionId, turnId })).reason, "idle_without_terminal");
  const other = transport(thread({ type: "idle" }), { data: [turn("completed", "turn_other")], nextCursor: null, backwardsCursor: null }, thread({ type: "idle" }));
  assert.equal((await observeCodexLifecycle({ request: other.request, threadId, sessionId, turnId })).reason, "idle_without_terminal");
});

test("keys a terminal observation by explicit turn id instead of page arrival order", async () => {
  const api = transport(thread({ type: "idle" }), {
    data: [turn("completed", "turn_newer"), turn("failed")], nextCursor: "older", backwardsCursor: "newer",
  }, thread({ type: "idle" }));
  const result = await observeCodexLifecycle({ request: api.request, threadId, sessionId, turnId });
  assert.equal(result.state, "failed");
});

test("rejects child and inconsistent root identities without reading a turn page", async () => {
  const child = transport(thread({ type: "active", activeFlags: [] }, { parentThreadId: "parent" }));
  assert.equal((await observeCodexLifecycle({ request: child.request, threadId, sessionId, turnId })).reason, "child_thread");
  assert.deepEqual(child.calls.map(call => call.method), ["thread/read"]);
  const wrongSession = transport({ thread: { id: threadId, sessionId: "another", parentThreadId: null, status: { type: "idle" } } });
  assert.equal((await observeCodexLifecycle({ request: wrongSession.request, threadId, sessionId, turnId })).reason, "identity_mismatch");
});

test("contains malformed or oversized pages and transport failures as unknown", async () => {
  const oversized = Array.from({ length: CODEX_LIFECYCLE_TURN_PAGE_LIMIT + 1 }, () => turn("inProgress"));
  const malformed = transport(thread({ type: "active", activeFlags: [] }), { data: oversized, nextCursor: null, backwardsCursor: null });
  assert.equal((await observeCodexLifecycle({ request: malformed.request, threadId, sessionId, turnId })).reason, "invalid_turn_page");
  const failed = transport(new Error("offline"));
  assert.equal((await observeCodexLifecycle({ request: failed.request, threadId, sessionId, turnId })).reason, "transport_error");
});

test("reconciles an exact terminal turn beyond the newest page without loading items", async () => {
  const api = transport(thread({ type: "idle" }), {
    data: Array.from({ length: CODEX_LIFECYCLE_TURN_PAGE_LIMIT }, (_, i) => turn("completed", `newer_${i}`)),
    nextCursor: "older", backwardsCursor: null,
  }, { data: [turn("failed")], nextCursor: null, backwardsCursor: "newer" }, thread({ type: "idle" }));
  assert.equal((await observeCodexLifecycle({ request: api.request, threadId, sessionId, turnId })).state, "failed");
  assert.deepEqual(api.calls[2], { method: "thread/turns/list", params: {
    threadId, cursor: "older", limit: CODEX_LIFECYCLE_TURN_PAGE_LIMIT, sortDirection: "desc", itemsView: "notLoaded",
  } });
  assert.equal(api.calls.at(-1)?.method, "thread/read");
});

test("pagination remains bounded and reports lookup exhaustion rather than completion", async () => {
  const pages = Array.from({ length: CODEX_LIFECYCLE_MAX_TURN_PAGES }, (_, i) => ({
    data: [turn("completed", `other_${i}`)], nextCursor: `older_${i}`, backwardsCursor: null,
  }));
  const api = transport(thread({ type: "idle" }), ...pages);
  assert.equal((await observeCodexLifecycle({ request: api.request, threadId, sessionId, turnId })).reason, "turn_lookup_limit");
  assert.equal(api.calls.length, 1 + CODEX_LIFECYCLE_MAX_TURN_PAGES);
});

test("rejects cursor cycles, duplicate turn identities and malformed cursors", async () => {
  for (const nextCursor of ["", "x".repeat(4097), 42]) {
    const api = transport(thread({ type: "idle" }), { data: [], nextCursor, backwardsCursor: null });
    assert.equal((await observeCodexLifecycle({ request: api.request, threadId, sessionId, turnId })).reason, "invalid_turn_page");
  }
  for (const duplicateId of [false, true]) {
    const api = transport(thread({ type: "idle" }), {
      data: [turn("completed", "other")], nextCursor: "older", backwardsCursor: null,
    }, {
      data: [turn("completed", duplicateId ? "other" : "different")], nextCursor: duplicateId ? null : "older", backwardsCursor: null,
    });
    assert.equal((await observeCodexLifecycle({ request: api.request, threadId, sessionId, turnId })).reason, "inconsistent_turn_pages");
  }
});

test("a status change across multiple pages still invalidates the observation", async () => {
  const api = transport(thread({ type: "idle" }), { data: [], nextCursor: "older", backwardsCursor: null },
    { data: [turn("completed")], nextCursor: null, backwardsCursor: null }, thread({ type: "active", activeFlags: [] }));
  assert.equal((await observeCodexLifecycle({ request: api.request, threadId, sessionId, turnId })).reason, "cross_read_race");
});
