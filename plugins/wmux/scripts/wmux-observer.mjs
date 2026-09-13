#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ID, BINDING_ID, api, loadBinding, runtimeDirectory } from "./wmux-binding.mjs";
import { connectCodexObserver } from "./codex-rpc.mjs";
import { observeCodexLifecycle } from "./codex-lifecycle.mjs";
import { runCodexNameObserver } from "./wmux-name-observer.mjs";
import { acquireObservationSupervisorLock, runCodexObservationSupervisor } from "./wmux-observation-supervisor.mjs";
import { acquireWmuxLock } from "./wmux-lock.mjs";

export const CODEX_OBSERVER_INTERVAL_MS = 2000;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const filename = fileURLToPath(import.meta.url);

// This starts a plugin-owned *observer*, never a Codex process. Its stdin/out
// cannot hold a native hook open or leak a binding receipt into another pane.
export async function startCodexObserver(sessionId, bindingId, { load = loadBinding, spawnChild = spawn, acquire = acquireWmuxLock, probe = acquireObservationSupervisorLock } = {}) {
  if (!ID.test(sessionId || "") || !BINDING_ID.test(bindingId || "")) return;
  load(sessionId, bindingId);
  let launcher;
  try { launcher = await acquire(path.join(runtimeDirectory(), "observation-launch.lock"), { timeoutMs: 1_000 }); }
  catch { return; }
  try {
    // A live service owns the kernel supervisor lock. Do not create a second
    // detached Node process for every native prompt in that case.
    const release = await probe();
    if (!release) return;
    await release();
    // Scan trusted receipts using one bounded sampler.
    const child = spawnChild(process.execPath, [filename, "--supervisor"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    child.on?.("error", () => {});
    await new Promise(resolve => {
      const done = () => { child.off?.("message", received); child.off?.("error", done); clearTimeout(timer); resolve(); };
      const received = message => { if (message?.wmuxObserver === "acquired" || message?.wmuxObserver === "busy") done(); };
      const timer = setTimeout(done, 1_000);
      child.once?.("error", done); child.on?.("message", received);
    });
    if (child.connected) child.disconnect?.();
    child.unref?.();
  } finally { await launcher.release(); }
}

/** Observe exactly the prompt-bound root turn; injected dependencies keep tests
 * isolated from a user's native daemon and private binding store.
 */
export async function runCodexObserver({ sessionId, bindingId }, {
  load = loadBinding, post = api, connect = connectCodexObserver,
  sleep = delay, now = Date.now, signal,
} = {}) {
  const record = load(sessionId, bindingId);
  const turnId = record.promptTurnId;
  if (!ID.test(turnId || "")) return { reason: "missing_turn_id" };
  const deadline = record.createdAt + MAX_LIFETIME_MS;
  let connected, sequence = 0, bound = false;
  const close = () => { connected?.close(); connected = undefined; };
  const aborted = () => { close(); };
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    while (!signal?.aborted && now() < deadline) {
      try { load(sessionId, bindingId); }
      catch { return { reason: "binding_unavailable" }; }
      // Every iteration resolves the exact receipt. New prompts, another pane,
      // replacement backends, and server restarts cannot inherit this authority.
      let tuple;
      try { tuple = await post("/api/codex-bindings/resolve", { sessionId, receipt: record.receipt }); }
      catch (error) {
        if ([400, 401, 403, 404].includes(error.status) || (bound && error.status === 409)) return { reason: "binding_unavailable" };
        if (!bound && now() - record.createdAt >= 60_000) return { reason: "binding_not_observed" };
        await sleep(bound ? CODEX_OBSERVER_INTERVAL_MS : 200);
        continue;
      }
      if (tuple?.sessionId !== sessionId || tuple.turnId !== turnId) return { reason: "binding_turn_mismatch" };
      bound = true;
      let snapshot = { state: "unknown", attention: null };
      try {
        connected ??= await connect({ threadId: sessionId, ...(record.schemaVersion === 3 ? { socketPath: record.socketPath } : {}) });
        const { thread } = await connected.request("thread/read", { threadId: sessionId, includeTurns: false });
        if (thread?.id !== sessionId || thread.parentThreadId !== null || !ID.test(thread.sessionId || "")) return { reason: "native_root_mismatch" };
        snapshot = await observeCodexLifecycle({ request: connected.request, threadId: sessionId, sessionId: thread.sessionId, turnId });
        if (snapshot.reason === "transport_error") close();
      } catch { close(); }
      if (signal?.aborted) break;
      try {
        await post("/api/codex-bindings/lifecycle", {
          sessionId, receipt: record.receipt, turnId, sequence: ++sequence,
          state: snapshot.state, attention: snapshot.attention,
        });
        if (TERMINAL.has(snapshot.state)) return { reason: "terminal_observed", state: snapshot.state };
      } catch (error) {
        if ([400, 401, 403, 404, 409].includes(error.status)) return { reason: "binding_unavailable" };
        // An ambiguous delivery is reconciled by a newer sample/sequence. The
        // server owns deduplication; never infer success or retry native work.
      }
      await sleep(CODEX_OBSERVER_INTERVAL_MS);
    }
    return { reason: signal?.aborted ? "observer_stopped" : "binding_expired" };
  } finally { signal?.removeEventListener("abort", aborted); close(); }
}

if (process.argv[1] === filename) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  if (process.argv[2] === "--supervisor" || process.argv[2] === "--service") {
    acquireObservationSupervisorLock().then(release => {
      if (process.send && process.connected) process.send({ wmuxObserver: release ? "acquired" : "busy" }, () => {
        if (process.connected) process.disconnect();
      });
      if (release) runCodexObservationSupervisor({ signal: controller.signal, stayAlive: process.argv[2] === "--service" }).catch(() => {}).finally(release);
    }).catch(() => {});
  } else {
    // Compatibility entrypoint for focused fixtures and older staged helpers.
    const [sessionId, bindingId] = process.argv.slice(2);
    Promise.allSettled([
      runCodexObserver({ sessionId, bindingId }, { signal: controller.signal }),
      runCodexNameObserver({ sessionId, bindingId }, { signal: controller.signal }),
    ]).catch(() => {});
  }
}
