import { setTimeout as delay } from "node:timers/promises";
import { api, loadBinding, withBinding } from "./wmux-binding.mjs";
import { connectCodexObserver } from "./codex-rpc.mjs";
import { nativeTitle } from "./wmux-session.mjs";

export const CODEX_NAME_INTERVAL_MS = 2000;
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const bindingGone = error => [400, 401, 403, 404, 409].includes(error.status);

// Names outlive a turn, but never the exact terminal receipt. Serialize reads
// with MCP sync so an older snapshot cannot overwrite a newer one.
export async function runCodexNameObserver({ sessionId, bindingId }, {
  load = loadBinding, post = api, connect = connectCodexObserver, lock = withBinding,
  sleep = delay, now = Date.now, signal,
} = {}) {
  const record = load(sessionId, bindingId);
  let client, bound = false;
  const close = () => { client?.close(); client = undefined; };
  signal?.addEventListener("abort", close, { once: true });
  try {
    while (!signal?.aborted && now() < record.createdAt + LIFETIME_MS) {
      try { load(sessionId, bindingId); }
      catch { return { reason: "binding_unavailable" }; }
      try {
        await lock(record, async current => {
          const tuple = await post("/api/codex-bindings/resolve", { sessionId, receipt: current.receipt });
          if (tuple.sessionId !== sessionId) throw Object.assign(new Error("binding mismatch"), { status: 409 });
          bound = true;
          let name;
          try {
            client ??= await connect({ threadId: sessionId, ...(current.schemaVersion === 3 ? { socketPath: current.socketPath } : {}) });
            const { thread } = await client.request("thread/read", { threadId: sessionId, includeTurns: false });
            name = nativeTitle(thread, sessionId);
          } catch { close(); return; }
          if (name === null || signal?.aborted) return;
          load(sessionId, bindingId);
          // Reapply unchanged names: unpinning must converge without a rename.
          await post("/api/codex-bindings/title", { sessionId, receipt: current.receipt, title: name, mode: "auto" });
        });
      } catch (error) {
        if (bindingGone(error) && (bound || error.status !== 409)) return { reason: "binding_unavailable" };
        if (!bound && now() - record.createdAt >= 60_000) return { reason: "binding_not_observed" };
      }
      try { await sleep(bound ? CODEX_NAME_INTERVAL_MS : 200, undefined, { signal }); }
      catch { if (!signal?.aborted) throw new Error("Name observer sleep failed."); }
    }
    return { reason: signal?.aborted ? "observer_stopped" : "binding_expired" };
  } finally { signal?.removeEventListener("abort", close); close(); }
}
