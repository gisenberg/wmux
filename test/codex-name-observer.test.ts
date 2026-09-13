import assert from "node:assert/strict";
import test from "node:test";
import { runCodexNameObserver, CODEX_NAME_INTERVAL_MS } from "../plugins/wmux/scripts/wmux-name-observer.mjs";

const sessionId = "root", bindingId = "b".repeat(22);
const record = { sessionId, bindingId, receipt: "receipt", createdAt: 100, promptTurnId: null };
const gone = (status = 404) => Object.assign(new Error("unavailable"), { status });

function fixture() {
  let iteration = 0, time = 100;
  const titles: any[] = [], reads: string[] = [];
  const state = { name: null as string | null, live: true, available: true, closes: 0, connects: 0,
    parentThreadId: null as string | null, id: sessionId, recordPresent: true };
  const dependencies = {
    load: () => { if (!state.recordPresent) throw gone(); return record; }, now: () => time,
    lock: async (_: any, action: any) => action(record),
    connect: async () => {
      state.connects++;
      return { close() { state.closes++; }, async request(method: string, params: any) {
        assert.equal(method, "thread/read"); assert.deepEqual(params, { threadId: sessionId, includeTurns: false });
        reads.push(method);
        if (!state.available) throw new Error("transport lost");
        return { thread: { id: state.id, name: state.name, parentThreadId: state.parentThreadId, status: { type: "idle" } } };
      } };
    },
    post: async (endpoint: string, body: any) => {
      assert.equal(body.sessionId, sessionId); assert.equal(body.receipt, record.receipt);
      if (!state.live) throw gone();
      if (endpoint.endsWith("resolve")) return { sessionId }; // No native turn ID required for names.
      assert.equal(endpoint, "/api/codex-bindings/title"); titles.push(body); return {};
    },
    sleep: async (ms: number) => { assert.equal(ms, CODEX_NAME_INTERVAL_MS); iteration++; time += ms; },
  };
  return { titles, reads, state, dependencies, advance: () => { iteration++; time += CODEX_NAME_INTERVAL_MS; }, iteration: () => iteration };
}

test("name observation survives idle completion, missing names, and multiple later native renames", async () => {
  const f = fixture(); const names = [null, "Generated Name", "Generated Name", "Desktop Rename", null, "CLI Rename"];
  const result = await runCodexNameObserver({ sessionId, bindingId }, { ...f.dependencies,
    sleep: async () => { f.advance(); f.state.name = names[f.iteration()]; if (f.iteration() >= names.length) f.state.live = false; },
  });
  assert.equal(result.reason, "binding_unavailable");
  assert.deepEqual(f.titles.map(t => t.title), ["Generated Name", "Generated Name", "Desktop Rename", "CLI Rename"]);
  assert.ok(f.titles.every(t => t.mode === "auto"));
  assert.equal(f.state.closes, 1);
});

test("outage never replays a cached name; recovery reconnects and reads the current name", async () => {
  const f = fixture(); f.state.name = "Initial";
  await runCodexNameObserver({ sessionId, bindingId }, { ...f.dependencies,
    sleep: async () => {
      f.advance();
      if (f.iteration() === 1) f.state.available = false;
      if (f.iteration() === 2) { f.state.available = true; f.state.name = "Changed During Outage"; }
      if (f.iteration() === 3) f.state.live = false;
    },
  });
  assert.deepEqual(f.titles.map(t => t.title), ["Initial", "Changed During Outage"]);
  assert.equal(f.state.connects, 2); assert.equal(f.state.closes, 2);
});

test("binding invalidation during native read cannot change the replacement pane", async () => {
  const f = fixture(); f.state.name = "Too Late";
  const result = await runCodexNameObserver({ sessionId, bindingId }, { ...f.dependencies,
    connect: async () => ({ close() {}, request: async () => {
      f.state.live = false;
      return { thread: { id: sessionId, name: f.state.name, parentThreadId: null } };
    } }),
  });
  assert.equal(result.reason, "binding_unavailable"); assert.deepEqual(f.titles, []);
});

test("pending markers expire without native reads and removed local bindings stop the worker", async () => {
  let time = 100;
  const f = fixture();
  const pending = await runCodexNameObserver({ sessionId, bindingId }, { ...f.dependencies,
    now: () => time, post: async () => { throw gone(409); }, sleep: async () => { time += 30_000; },
  });
  assert.equal(pending.reason, "binding_not_observed"); assert.deepEqual(f.reads, []);
  f.state.recordPresent = false;
  // The first load also fails closed before connecting.
  await assert.rejects(runCodexNameObserver({ sessionId, bindingId }, f.dependencies));
  assert.deepEqual(f.reads, []);
});

test("child, mismatched identity, unrepresentable and unsafe names never reach title writes", async () => {
  for (const change of [{ parentThreadId: "parent" }, { id: "different" }, { name: "x".repeat(4097) }, { name: "Bad\u001bName" }]) {
    const f = fixture(); Object.assign(f.state, { name: "Name" }, change);
    await runCodexNameObserver({ sessionId, bindingId }, { ...f.dependencies, sleep: async () => { f.state.live = false; } });
    assert.deepEqual(f.titles, []);
  }
});

test("long bounded native names are mirrored without shortening", async () => {
  const f = fixture();
  f.state.name = "🧪".repeat(512);
  await runCodexNameObserver({ sessionId, bindingId }, { ...f.dependencies, sleep: async () => { f.state.live = false; } });
  assert.deepEqual(f.titles.map((title) => title.title), [f.state.name]);
});

test("manual unpin recovers even when the native name has not changed", async () => {
  const f = fixture(); f.state.name = "Canonical";
  let pinned = true, visible = "User Pinned";
  await runCodexNameObserver({ sessionId, bindingId }, { ...f.dependencies,
    post: async (endpoint: string, body: any) => {
      const response = await f.dependencies.post(endpoint, body);
      if (endpoint.endsWith("title") && !pinned) visible = body.title;
      return response;
    },
    sleep: async () => {
      f.advance();
      if (f.iteration() === 1) { assert.equal(visible, "User Pinned"); pinned = false; }
      else f.state.live = false;
    },
  });
  assert.equal(visible, "Canonical"); assert.equal(f.titles.length, 2);
});

test("abort during a read closes the transport and suppresses its late result", async () => {
  const f = fixture(), controller = new AbortController();
  const result = await runCodexNameObserver({ sessionId, bindingId }, { ...f.dependencies, signal: controller.signal,
    connect: async () => ({ close() {}, request: async () => { controller.abort(); return { thread: { id: sessionId, name: "Late", parentThreadId: null } }; } }),
  });
  assert.equal(result.reason, "observer_stopped"); assert.deepEqual(f.titles, []);
});
