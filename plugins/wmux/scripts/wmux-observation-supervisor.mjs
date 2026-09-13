import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ID, api, liveBindings, loadBinding, nextLifecycleSequence, runtimeDirectory, withBinding } from "./wmux-binding.mjs";
import { connectCodexObservationBatch } from "./codex-rpc.mjs";
import { observeCodexLifecycle } from "./codex-lifecycle.mjs";
import { nativeTitle } from "./wmux-session.mjs";
import { acquireWmuxLock } from "./wmux-lock.mjs";

export const MAX_SUPERVISED_BINDINGS = 20;
export const SUPERVISOR_INTERVAL_MS = 2000;
export const SUPERVISOR_BACKOFF_MAX_MS = 30_000;
export const SUPERVISOR_CYCLE_BUDGET_MS = 10_000;
const TERMINAL = new Set(["completed", "failed", "interrupted"]);

/** A crash-safe, owner-liveness lock for the one plugin supervisor. It never
 * takes a lock from a slow but still-live reader. */
export async function acquireObservationSupervisorLock() {
  const lock = path.join(runtimeDirectory(), "observation-supervisor.lock");
  try { const held = await acquireWmuxLock(lock, { timeoutMs: 50 }); return () => held.release(); }
  catch (error) { if (error?.code === "lock_contended") return null; throw error; }
}

const statusError = error => Number.isInteger(error?.status) ? error.status : 0;
const bindingGone = error => [400, 401, 403, 404, 409].includes(statusError(error));
const jitter = (milliseconds, random) => Math.max(0, Math.floor(milliseconds * (0.8 + random() * 0.4)));

export async function runCodexObservationSupervisor({
  list = liveBindings, load = loadBinding, nextSequence = nextLifecycleSequence, post = api, connect = connectCodexObservationBatch,
  lock = withBinding, sleep = delay, now = Date.now, random = Math.random, report,
  signal, maxBindings = MAX_SUPERVISED_BINDINGS, maxCycles = Infinity, stayAlive = false,
} = {}) {
  const counters = { attempts: 0, reconnects: 0, transportFailures: 0, requestFailures: 0, lockContention: 0, staleResponses: 0, cancelled: 0 };
  const endpoints = new Map(), histories = new Map(), rejected = new Set();
  let cycles = 0, cursor = 0;
  const closeEndpoint = endpoint => { endpoint.client?.close(); endpoint.client = undefined; };
  const close = () => { for (const endpoint of endpoints.values()) closeEndpoint(endpoint); };
  const history = record => {
    if (!histories.has(record.bindingId)) histories.set(record.bindingId, {});
    return histories.get(record.bindingId);
  };
  const emit = async (record, channel, status, reason, success = false) => {
    const sampledAt = now(), previous = history(record);
    if (success) previous[channel] = sampledAt;
    const body = { sessionId: record.sessionId, receipt: record.receipt, channel, status, reason,
      sampledAt, ...(previous[channel] === undefined ? {} : { lastSuccessAt: previous[channel] }),
      counters: Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, Math.min(1_000_000_000, value)])),
      pluginVersion: "0.4.0" };
    try { await (report ? report(body) : post("/api/codex-bindings/observation", body)); } catch {}
  };
  const fault = (endpoint, error) => {
    if (endpoint.retryAt <= now()) {
      endpoint.failures = Math.min(16, endpoint.failures + 1);
      endpoint.retryAt = now() + jitter(Math.min(SUPERVISOR_BACKOFF_MAX_MS, 500 * 2 ** (endpoint.failures - 1)), random);
      counters.transportFailures += 1;
    }
    endpoint.reason = error?.reason === "unsupported_endpoint" ? "unsupported_endpoint" : "socket_unavailable";
    closeEndpoint(endpoint);
  };
  const pause = async () => {
    try { await sleep(jitter(SUPERVISOR_INTERVAL_MS, random), undefined, { signal }); }
    catch { if (!signal?.aborted) throw new Error("supervisor sleep failed"); }
  };
  signal?.addEventListener("abort", close, { once: true });
  try {
    while (!signal?.aborted && cycles++ < maxCycles) {
      const newest = new Map();
      for (const record of list(512)) {
        const key = record.socketPath + "\0" + record.sessionId;
        if (!newest.has(key)) newest.set(key, record);
      }
      const all = [...newest.values()], ids = new Set(all.map(record => record.bindingId));
      for (const id of histories.keys()) if (!ids.has(id)) histories.delete(id);
      for (const id of rejected) if (!ids.has(id)) rejected.delete(id);
      const eligibleEndpoints = new Set(all.map(record => record.socketPath));
      for (const [key, endpoint] of endpoints) if (!eligibleEndpoints.has(key)) { closeEndpoint(endpoint); endpoints.delete(key); }
      if (!all.length) { if (!stayAlive) return { reason: "no_live_bindings", counters }; await pause(); continue; }
      const cycleStartCursor = cursor;
      const records = [], budget = Math.max(1, Math.min(MAX_SUPERVISED_BINDINGS, maxBindings));
      for (let offset = 0; offset < all.length && records.length < budget; offset++) {
        const record = all[(cursor + offset) % all.length];
        if (!rejected.has(record.bindingId)) records.push(record);
      }
      cursor = (cursor + Math.max(1, records.length)) % all.length;
      if (!records.length) { if (!stayAlive) return { reason: "no_live_bindings", counters }; await pause(); continue; }
      const scopes = new Map();
      for (const record of records) {
        const roots = scopes.get(record.socketPath) ?? [];
        roots.push(record.sessionId); scopes.set(record.socketPath, roots);
      }
      for (const [key, endpoint] of endpoints) if (!scopes.has(key)) closeEndpoint(endpoint);
      for (const [key, roots] of scopes) {
        const scope = [...new Set(roots)].sort().join("\0");
        let endpoint = endpoints.get(key);
        if (!endpoint) { endpoint = { failures: 0, retryAt: 0 }; endpoints.set(key, endpoint); }
        if (endpoint.scope !== scope) closeEndpoint(endpoint);
        endpoint.scope = scope;
      }
      const sample = async record => {
        if (signal?.aborted) return;
        const endpoint = endpoints.get(record.socketPath);
        if (endpoint.retryAt > now()) {
          await emit(record, "naming", "backing_off", endpoint.reason);
          await emit(record, "activity", "backing_off", endpoint.reason);
          return;
        }
        counters.attempts += 1;
        const sampleDeadline = now() + 8_000;
        let budgetExceeded = false;
        try {
          const current = load(record.sessionId, record.bindingId);
          await lock(current, async trusted => {
            if (signal?.aborted) return;
            const tuple = await post("/api/codex-bindings/resolve", { sessionId: trusted.sessionId, receipt: trusted.receipt });
            if (tuple.sessionId !== trusted.sessionId) throw Object.assign(new Error("binding mismatch"), { status: 409 });
            let thread, client;
            try {
              if (!endpoint.client) {
                endpoint.connecting ??= connect({ threadIds: scopes.get(record.socketPath), socketPath: record.socketPath }).then(value => {
                  if (signal?.aborted) { value.close(); throw new Error("observer stopped"); }
                  endpoint.client = value; counters.reconnects += 1; return value;
                }).finally(() => { endpoint.connecting = undefined; });
                await endpoint.connecting;
              }
              client = endpoint.client;
              ({ thread } = await client.request("thread/read", { threadId: trusted.sessionId, includeTurns: false }));
            } catch (error) {
              fault(endpoint, error);
              await emit(trusted, "naming", "backing_off", endpoint.reason);
              await emit(trusted, "activity", "backing_off", endpoint.reason);
              return;
            }
            if (signal?.aborted) return;
            if (thread?.id !== trusted.sessionId || thread.parentThreadId !== null || !ID.test(thread.sessionId || "")) {
              counters.staleResponses += 1;
              await emit(trusted, "naming", "unknown", "native_root_mismatch");
              await emit(trusted, "activity", "unknown", "native_root_mismatch");
              return;
            }
            endpoint.failures = 0; endpoint.retryAt = 0;
            // Naming failures must not suppress independent prompt-turn activity.
            let name, invalidName = false;
            try { name = nativeTitle(thread, trusted.sessionId); } catch { invalidName = true; }
            if (invalidName || name === null) {
              await emit(trusted, "naming", "unknown", invalidName ? "invalid_native_name" : "missing_native_name");
            } else {
              try {
                load(trusted.sessionId, trusted.bindingId);
                await post("/api/codex-bindings/title", { sessionId: trusted.sessionId, receipt: trusted.receipt, title: name, mode: "auto" });
                await emit(trusted, "naming", "active", "none", true);
              } catch (error) {
                if (bindingGone(error)) throw error;
                counters.requestFailures += 1;
                await emit(trusted, "naming", "unknown", "delivery_failed");
              }
            }
            if (signal?.aborted) return;
            if (!ID.test(trusted.promptTurnId || "")) { await emit(trusted, "activity", "unknown", "missing_turn_id"); return; }
            if (tuple.turnId !== trusted.promptTurnId) throw Object.assign(new Error("binding turn mismatch"), { status: 409 });
            const prior = history(trusted);
            if (prior.terminal) { await emit(trusted, "activity", "active", "terminal_observed"); return; }
            const request = (method, params) => {
              if (now() >= sampleDeadline) { budgetExceeded = true; throw new Error("sample budget exceeded"); }
              return client.request(method, params);
            };
            const snapshot = await observeCodexLifecycle({ request, initialThread: thread, threadId: trusted.sessionId, sessionId: thread.sessionId, turnId: trusted.promptTurnId });
            if (signal?.aborted) return;
            if (snapshot.reason === "transport_error" && !budgetExceeded) fault(endpoint, { reason: "socket_unavailable" });
            try {
              await post("/api/codex-bindings/lifecycle", { sessionId: trusted.sessionId, receipt: trusted.receipt,
                turnId: trusted.promptTurnId, sequence: nextSequence(trusted), state: snapshot.state, attention: snapshot.attention });
              const unknown = snapshot.state === "unknown" || snapshot.state === "notLoaded";
              const terminal = TERMINAL.has(snapshot.state);
              if (terminal) prior.terminal = true;
              await emit(trusted, "activity", unknown ? "unknown" : "active",
                budgetExceeded ? "sample_budget_exceeded" : snapshot.reason === "transport_error" ? "transport_error" : terminal ? "terminal_observed" : "none", !unknown);
            } catch (error) {
              if (bindingGone(error)) throw error;
              counters.requestFailures += 1;
              await emit(trusted, "activity", "unknown", "delivery_failed");
            }
          });
        } catch (error) {
          const pending = error?.status === 409 && now() - record.createdAt < 60_000;
          const reason = pending ? "binding_not_observed" : bindingGone(error) ? "binding_unavailable"
            : error?.code === "lock_contended" ? "lock_contended" : "delivery_failed";
          if (reason === "lock_contended") counters.lockContention += 1;
          else counters.requestFailures += 1;
          if (bindingGone(error) && !pending) rejected.add(record.bindingId);
          await emit(record, "naming", "unknown", reason);
          await emit(record, "activity", "unknown", reason);
        }
      };
      let index = 0, sampled = 0, deferred = false;
      const cycleDeadline = now() + SUPERVISOR_CYCLE_BUDGET_MS;
      await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
        while (index < records.length && !signal?.aborted) {
          const record = records[index++];
          if (now() >= cycleDeadline) {
            deferred = true;
            await emit(record, "naming", "unknown", "sample_budget_exceeded");
            await emit(record, "activity", "unknown", "sample_budget_exceeded");
          } else { sampled += 1; await sample(record); }
        }
      }));
      if (deferred) cursor = (cycleStartCursor + Math.max(1, sampled)) % all.length;
      if (!signal?.aborted) await pause();
    }
    if (signal?.aborted) counters.cancelled += 1;
    return { reason: signal?.aborted ? "observer_stopped" : "cycle_limit", counters };
  } finally { signal?.removeEventListener("abort", close); close(); }
}
