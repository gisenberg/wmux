import { api, loadBinding, withBinding } from "./wmux-binding.mjs";
import { mirrorTitle, validTitle } from "./wmux-title.mjs";
import { connectCodexObserver } from "./codex-rpc.mjs";

async function resolve(record) { return api("/api/codex-bindings/resolve", { sessionId: record.sessionId, receipt: record.receipt }); }
export function nativeTitle(thread, sessionId) {
  if (thread?.id !== sessionId || thread.parentThreadId !== null) throw new Error("Codex root identity could not be verified.");
  if (thread.name === null || thread.name === undefined || thread.name === "") return null;
  const title = validTitle(thread.name);
  // Exact mirroring: never silently shorten or rewrite the native name.
  if (title !== thread.name) throw new Error("Codex name cannot be represented exactly as a wmux title.");
  return title;
}
export async function getSession(sessionId, bindingId) {
  const record = loadBinding(sessionId, bindingId), tuple = await resolve(record);
  return { sessionId, bindingId, workspaceId: tuple.workspaceId, tabId: tuple.tabId, paneId: tuple.paneId, expiresAt: tuple.expiresAt, titleRead: false };
}
// Compatibility for older tool callers. Their proposed title has no authority.
export async function nameSession(sessionId, bindingId, _title, mode = "auto") {
  if (mode !== "auto") throw new Error("Manual titles belong to the wmux UI.");
  return synchronize(sessionId, bindingId);
}
export async function synchronize(sessionId, bindingId) {
  const initial = loadBinding(sessionId, bindingId);
  return withBinding(initial, async record => {
    await resolve(record);
    const result = { sessionId, bindingId, namingMode: "native-name-mirror", nativeNameRead: false,
      nativeNameSet: false, workspaceApplied: false, tabApplied: false };
    let client;
    try {
      client = await connectCodexObserver({ threadId: sessionId, ...(record.socketPath ? { socketPath: record.socketPath } : {}) });
      const { thread } = await client.request("thread/read", { threadId: sessionId, includeTurns: false });
      const name = nativeTitle(thread, sessionId);
      result.nativeNameRead = true;
      if (name === null) return { ...result, skipped: "Codex has no name yet; keep the current wmux title." };
      loadBinding(sessionId, bindingId);
      // The server checks the receipt and manual pins again after the async read.
      return { ...result, nativeName: name, ...await mirrorTitle(record, name) };
    } catch (error) { return { ...result, error: error.message, retry: "sync_current_wmux_session" }; }
    finally { client?.close(); }
  });
}
