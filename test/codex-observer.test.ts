import assert from "node:assert/strict";
import test from "node:test";
import { runCodexObserver, CODEX_OBSERVER_INTERVAL_MS } from "../plugins/wmux/scripts/wmux-observer.mjs";

const sessionId = "root", bindingId = "b".repeat(22), turnId = "turn";
const record = { sessionId, bindingId, receipt: "private_receipt", createdAt: 100, promptTurnId: turnId };
const nativeThread = (type: string, flags: string[] = []) => ({ thread: { id: sessionId, sessionId, parentThreadId: null, status: type === "active" ? { type, activeFlags: flags } : { type } } });
function native(state: string) {
  const status = ["completed", "failed", "interrupted"].includes(state) ? "idle" : "active";
  return {
    async request(method: string) {
      if (method === "thread/read") return nativeThread(status, state === "attention" ? ["waitingOnApproval"] : []);
      assert.equal(method, "thread/turns/list");
      return { data: [{ id: turnId, status: status === "idle" ? state : "inProgress", startedAt: 1, completedAt: status === "idle" ? 2 : null, durationMs: null }], nextCursor: null, backwardsCursor: null };
    }, close() {},
  };
}
const expiredError = (status: number) => Object.assign(new Error("sanitized"), { status });

test("observer publishes exact bound native states automatically, then exits after the actual terminal outcome", async () => {
  const events: any[] = [], calls: string[] = [];
  let count = 0, closed = false;
  const outcomes = ["active", "attention", "completed"];
  const result = await runCodexObserver({ sessionId, bindingId }, {
    load: () => record, now: () => 100,
    connect: async () => ({ request: (method: string) => native(outcomes[count]).request(method), close: () => { closed = true; } }),
    post: async (endpoint: string, body: any) => {
      calls.push(endpoint);
      assert.equal(body.sessionId, sessionId); assert.equal(body.receipt, record.receipt);
      if (endpoint.endsWith("resolve")) return { sessionId, turnId };
      events.push(body); count++; return { accepted: true };
    }, sleep: async (ms: number) => { assert.equal(ms, CODEX_OBSERVER_INTERVAL_MS); },
  });
  assert.deepEqual(result, { reason: "terminal_observed", state: "completed" });
  assert.deepEqual(events.map(e => [e.turnId, e.sequence, e.state, e.attention]), [[turnId, 1, "active", null], [turnId, 2, "attention", "approval"], [turnId, 3, "completed", null]]);
  assert.ok(calls.every(c => c === "/api/codex-bindings/resolve" || c === "/api/codex-bindings/lifecycle"));
  assert.equal(closed, true);
});

test("an unobserved marker never connects to Codex or reports work, and expires in a bounded interval", async () => {
  let time = 100, nativeCalls = 0, posts = 0;
  const result = await runCodexObserver({ sessionId, bindingId }, {
    load: () => record, now: () => time,
    connect: async () => { nativeCalls++; throw new Error("must not connect"); },
    post: async (endpoint: string) => { assert.ok(endpoint.endsWith("resolve")); posts++; throw expiredError(409); },
    sleep: async () => { time += 30_000; },
  });
  assert.equal(result.reason, "binding_not_observed"); assert.equal(nativeCalls, 0); assert.equal(posts, 3);
});

test("native connection loss reports uncertainty, retries observation, and never invents completion", async () => {
  const samples: any[] = [];
  let nativeCalls = 0;
  const result = await runCodexObserver({ sessionId, bindingId }, {
    load: () => record, now: () => 100,
    connect: async () => { nativeCalls++; throw new Error("native unavailable"); },
    post: async (endpoint: string, body: any) => {
      if (endpoint.endsWith("resolve")) { if (samples.length === 2) throw expiredError(404); return { sessionId, turnId }; }
      samples.push(body); return {};
    }, sleep: async () => {},
  });
  assert.equal(result.reason, "binding_unavailable");
  assert.equal(nativeCalls, 2); assert.deepEqual(samples.map(s => s.state), ["unknown", "unknown"]);
});

test("missing turn, mismatched binding, and native child identities fail closed", async () => {
  const missing = await runCodexObserver({ sessionId, bindingId }, { load: () => ({ ...record, promptTurnId: null }) });
  assert.equal(missing.reason, "missing_turn_id");
  let connected = false;
  const mismatch = await runCodexObserver({ sessionId, bindingId }, { load: () => record, now: () => 100, post: async () => ({ sessionId, turnId: "other" }), connect: async () => { connected = true; } });
  assert.equal(mismatch.reason, "binding_turn_mismatch"); assert.equal(connected, false);
  let published = false;
  const child = await runCodexObserver({ sessionId, bindingId }, {
    load: () => record, now: () => 100, post: async (endpoint: string) => { if (!endpoint.endsWith("resolve")) published = true; return { sessionId, turnId }; },
    connect: async () => ({ request: async () => ({ thread: { id: sessionId, sessionId, parentThreadId: "parent" } }), close() {} }),
  });
  assert.equal(child.reason, "native_root_mismatch"); assert.equal(published, false);
});

test("a terminal delivery failure is retried as observation, never as native work", async () => {
  let attempts = 0;
  const result = await runCodexObserver({ sessionId, bindingId }, {
    load: () => record, now: () => 100, connect: async () => native("completed"),
    post: async (endpoint: string) => {
      if (endpoint.endsWith("resolve")) return { sessionId, turnId };
      if (++attempts === 1) throw new Error("lost response");
      return { accepted: false }; // A repeated native terminal is harmless.
    }, sleep: async () => {},
  });
  assert.equal(attempts, 2); assert.equal(result.state, "completed");
});
