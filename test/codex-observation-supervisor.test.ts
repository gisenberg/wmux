import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SUPERVISED_BINDINGS, runCodexObservationSupervisor } from "../plugins/wmux/scripts/wmux-observation-supervisor.mjs";
import { parseCodexObservation } from "../src/server/codex-observation.js";

const receipt = (index: number) => `r${String(index).padStart(42, "x")}`;
const record = (index: number, turn = `turn_${index}`) => ({ sessionId: `root_${index}`, bindingId: String(index).padStart(22, "b"), receipt: receipt(index), createdAt: 100, promptTurnId: turn });

test("supervisor bounds a synthetic twenty-task endpoint to one transport and four requests at a time", async () => {
  const records = Array.from({ length: MAX_SUPERVISED_BINDINGS }, (_, index) => record(index));
  let connects = 0, activeRequests = 0, peakRequests = 0;
  const lifecycle: any[] = [], titles: any[] = [];
  const result = await runCodexObservationSupervisor({
    list: () => records, load: (sessionId: string, bindingId: string) => records.find(item => item.sessionId === sessionId && item.bindingId === bindingId)!,
    lock: async (value: any, action: any) => action(value), nextSequence: (() => { let value = 0; return () => ++value; })(), maxCycles: 1, random: () => 0.5,
    connect: async () => { connects += 1; return { close() {}, request: async (method: string, params: any) => {
      activeRequests += 1; peakRequests = Math.max(peakRequests, activeRequests);
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (method === "thread/read") return { thread: { id: params.threadId, sessionId: `native_${params.threadId}`, parentThreadId: null, name: `Name ${params.threadId}`, status: { type: "active", activeFlags: [] } } };
        return { data: [{ id: params.threadId.replace("root", "turn"), status: "inProgress", startedAt: 1, completedAt: null }], nextCursor: null };
      } finally { activeRequests -= 1; }
    } }; },
    post: async (endpoint: string, body: any) => {
      if (endpoint.endsWith("observation")) return {};
      if (endpoint.endsWith("resolve")) return { sessionId: body.sessionId, turnId: body.sessionId.replace("root", "turn") };
      if (endpoint.endsWith("lifecycle")) lifecycle.push(body);
      if (endpoint.endsWith("title")) titles.push(body);
      return {};
    },
    sleep: async () => {},
  });
  assert.equal(result.reason, "cycle_limit");
  assert.equal(connects, 1);
  assert.ok(peakRequests > 1 && peakRequests <= 4);
  assert.equal(lifecycle.length, MAX_SUPERVISED_BINDINGS);
  assert.equal(titles.length, MAX_SUPERVISED_BINDINGS);
});

test("newer receipt and manual pins cannot receive an older delayed title", async () => {
  const older = record(1), newer = { ...record(2), sessionId: older.sessionId, promptTurnId: "turn_1" };
  const titles: any[] = [];
  await runCodexObservationSupervisor({
    list: () => [older], load: () => newer, lock: async (value: any, action: any) => action(value), nextSequence: () => 1, maxCycles: 1,
    connect: async () => ({ close() {}, request: async (_method: string, params: any) => ({ thread: { id: params.threadId, sessionId: "native_root_1", parentThreadId: null, name: "Too late", status: { type: "idle" } } }) }),
    post: async (endpoint: string, body: any) => {
      if (endpoint.endsWith("observation")) return {};
      if (endpoint.endsWith("resolve")) { assert.equal(body.receipt, newer.receipt); return { sessionId: older.sessionId, turnId: "turn_1" }; }
      if (endpoint.endsWith("title")) titles.push(body); // server preserves user pins; receipt is fresh regardless.
      return {};
    }, sleep: async () => {},
  });
  assert.equal(titles.length, 1);
  assert.equal(titles[0].receipt, newer.receipt);
});

test("transport failure closes the socket, reports bounded backoff, and a later cycle reconnects", async () => {
  const item = record(3); let connects = 0, reads = 0;
  let time = 100;
  const diagnostics: any[] = [];
  await runCodexObservationSupervisor({
    list: () => [item], load: () => item, lock: async (value: any, action: any) => action(value), nextSequence: (() => { let value = 0; return () => ++value; })(), maxCycles: 2, random: () => 0.5,
    connect: async () => { connects += 1; return { close() {}, request: async () => { reads += 1; if (reads === 1) throw new Error("socket lost"); return { thread: { id: item.sessionId, sessionId: "native_root_3", parentThreadId: null, name: "Recovered", status: { type: "idle" } } }; } }; },
    post: async (endpoint: string, body: any) => endpoint.endsWith("resolve") ? { sessionId: item.sessionId, turnId: item.promptTurnId } : {},
    now: () => time, report: async (body: any) => { diagnostics.push(body); }, sleep: async () => { time += 1_000; },
  });
  assert.equal(connects, 2);
  assert.ok(diagnostics.some(item => item.status === "backing_off" && item.reason === "socket_unavailable"));
  assert.ok(diagnostics.every(item => item.pluginVersion === "0.4.0" && item.counters.transportFailures <= 1_000_000));
});

test("supervisor cancellation terminates its transport and suppresses a late title write", async () => {
  const item = record(11), controller = new AbortController();
  let closed = 0, titles = 0;
  const result = await runCodexObservationSupervisor({
    list: () => [item], load: () => item, lock: async (value: any, action: any) => action(value), nextSequence: () => 1, signal: controller.signal,
    connect: async () => ({ close() { closed += 1; }, request: async () => { controller.abort(); return { thread: { id: item.sessionId, sessionId: "native_root_11", parentThreadId: null, name: "Late", status: { type: "idle" } } }; } }),
    post: async (endpoint: string, body: any) => {
      if (endpoint.endsWith("observation")) return {};
      if (endpoint.endsWith("resolve")) return { sessionId: item.sessionId, turnId: item.promptTurnId };
      if (endpoint.endsWith("title")) titles += 1;
      return {};
    }, sleep: async () => {},
  });
  assert.equal(result.reason, "observer_stopped");
  assert.equal(titles, 0);
  assert.ok(closed >= 1);
});

test("invalid names and title delivery failures leave independent active lifecycle reporting intact", async () => {
  const bad = { ...record(30), socketPath: "/socket-a" }, good = { ...record(31), socketPath: "/socket-a" };
  const reports: any[] = [], lifecycle: any[] = [];
  await runCodexObservationSupervisor({
    list: () => [bad, good], load: (id: string) => id === bad.sessionId ? bad : good, lock: async (value: any, action: any) => action(value), nextSequence: (() => { let value = 0; return () => ++value; })(), maxCycles: 1,
    connect: async () => ({ close() {}, request: async (method: string, params: any) => {
      if (method === "thread/read") return { thread: { id: params.threadId, sessionId: `native_${params.threadId}`, parentThreadId: null, name: params.threadId === bad.sessionId ? "x".repeat(513) : "Valid", status: { type: "active", activeFlags: [] } } };
      return { data: [{ id: params.threadId.replace("root", "turn"), status: "inProgress", startedAt: 1, completedAt: null, durationMs: null }], nextCursor: null, backwardsCursor: null };
    } }),
    post: async (endpoint: string, body: any) => {
      if (endpoint.endsWith("resolve")) return { sessionId: body.sessionId, turnId: body.sessionId.replace("root", "turn") };
      if (endpoint.endsWith("title") && body.sessionId === good.sessionId) throw Object.assign(new Error("down"), { status: 503 });
      if (endpoint.endsWith("lifecycle")) lifecycle.push(body);
      return {};
    }, report: async (body: any) => { parseCodexObservation(body, Number.MAX_SAFE_INTEGER); reports.push(body); }, sleep: async () => {},
  });
  assert.equal(lifecycle.length, 2);
  assert.ok(reports.some(item => item.sessionId === bad.sessionId && item.channel === "naming" && item.reason === "invalid_native_name"));
  assert.ok(reports.some(item => item.sessionId === good.sessionId && item.channel === "naming" && item.reason === "delivery_failed"));
  assert.ok(reports.filter(item => item.channel === "activity").every(item => item.status === "active"));
});

test("cycle budget reports deferred roots without reading all twenty", async () => {
  const records = Array.from({ length: 20 }, (_, index) => ({ ...record(100 + index), socketPath: "/socket-budget" }));
  let clock = 0, reads = 0;
  const reports: any[] = [];
  await runCodexObservationSupervisor({
    list: () => records, load: (id: string) => records.find(item => item.sessionId === id)!, lock: async (value: any, action: any) => action(value), nextSequence: (() => { let value = 0; return () => ++value; })(), maxCycles: 1,
    now: () => clock, connect: async () => ({ close() {}, request: async (method: string, params: any) => {
      if (method === "thread/read") { reads += 1; clock += 4_000; return { thread: { id: params.threadId, sessionId: `native_${params.threadId}`, parentThreadId: null, name: "Name", status: { type: "active", activeFlags: [] } } }; }
      return { data: [{ id: params.threadId.replace("root", "turn"), status: "inProgress", startedAt: 1, completedAt: null }], nextCursor: null, backwardsCursor: null };
    } }),
    post: async (endpoint: string, body: any) => endpoint.endsWith("resolve") ? { sessionId: body.sessionId, turnId: body.sessionId.replace("root", "turn") } : {},
    report: async (body: any) => { reports.push(body); }, sleep: async () => {},
  });
  assert.ok(reads < 20);
  const deferred = new Set(reports.filter(item => item.reason === "sample_budget_exceeded").map(item => item.sessionId));
  assert.ok(deferred.size > 0);
  assert.equal(new Set(reports.map(item => item.sessionId)).size, 20);
});
