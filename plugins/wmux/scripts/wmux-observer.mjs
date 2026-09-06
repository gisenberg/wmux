#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ID, BINDING_ID, api, loadBinding } from "./wmux-binding.mjs";
import { connectCodexObserver } from "./codex-rpc.mjs";
import { observeCodexLifecycle } from "./codex-lifecycle.mjs";

export const CODEX_OBSERVER_INTERVAL_MS = 2000;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const filename = fileURLToPath(import.meta.url);

// This starts a plugin-owned *observer*, never a Codex process. Its stdin/out
// cannot hold a native hook open or leak a binding receipt into another pane.
export function startCodexObserver(sessionId, bindingId) {
  if (!ID.test(sessionId || "") || !BINDING_ID.test(bindingId || "")) return;
  const record = loadBinding(sessionId, bindingId);
  if (!ID.test(record.promptTurnId || "")) return;
  const child = spawn(process.execPath, [filename, sessionId, bindingId], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {}); // Optional integration failure never blocks native Codex.
  child.unref();
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
        connected ??= await connect({ threadId: sessionId });
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
  const [sessionId, bindingId] = process.argv.slice(2);
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  runCodexObserver({ sessionId, bindingId }, { signal: controller.signal }).catch(() => {});
}
