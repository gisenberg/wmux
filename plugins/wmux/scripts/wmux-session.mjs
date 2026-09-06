import { api, loadBinding, saveBinding, withBinding } from "./wmux-binding.mjs";
import { withCodexName } from "./codex-name.mjs";
import { mirrorTitle, validTitle } from "./wmux-title.mjs";

async function resolve(record) { return api("/api/codex-bindings/resolve", { sessionId: record.sessionId, receipt: record.receipt }); }
async function mirror(record, canonical, codexNameSet, mode) {
  const outcome = { sessionId: record.sessionId, bindingId: record.bindingId, codexName: canonical.name, codexNameSet, workspaceApplied: false, tabApplied: false };
  if (!canonical.name) return { ...outcome, skipped: "Codex has no saved name yet." };
  try { return { ...outcome, ...await mirrorTitle(record, canonical.name, mode) }; }
  catch (error) { return { ...outcome, error: error.message, retry: "sync_current_wmux_session" }; }
}
function binding(sessionId, bindingId) { return loadBinding(sessionId, bindingId); }
export async function getSession(sessionId, bindingId) {
  const record = binding(sessionId, bindingId), tuple = await resolve(record);
  return { sessionId, bindingId, workspaceId: tuple.workspaceId, tabId: tuple.tabId, paneId: tuple.paneId, expiresAt: tuple.expiresAt, titleRead: false };
}
export async function nameSession(sessionId, bindingId, title, mode = "auto") {
  const initial = binding(sessionId, bindingId);
  validTitle(title);
  if (mode !== "auto") throw new Error("The Codex naming plugin supports auto mode only; manual titles belong to the wmux UI.");
  return withBinding(initial, async record => {
    await resolve(record);
    let canonical;
    try { canonical = await withCodexName(sessionId, title); }
    catch (error) { return { sessionId, bindingId, codexNameSet: error.codexNameSet ?? false, workspaceApplied: false, tabApplied: false, error: error.message, retry: "sync_current_wmux_session" }; }
    record.lastName = canonical.name;
    try { saveBinding(record); }
    catch { return { sessionId, bindingId, codexName: canonical.name, codexNameSet: true, workspaceApplied: false, tabApplied: false, error: "Codex was named, but wmux binding state could not be saved.", retry: "sync_current_wmux_session" }; }
    return mirror(record, canonical, canonical.codexNameSet, mode);
  });
}
export async function synchronize(sessionId, bindingId) {
  const initial = binding(sessionId, bindingId);
  return withBinding(initial, async record => {
    await resolve(record);
    const canonical = await withCodexName(sessionId);
    record.lastName = canonical.name;
    try { saveBinding(record); }
    catch { return { sessionId, bindingId, codexName: canonical.name, codexNameSet: false, workspaceApplied: false, tabApplied: false, error: "Codex name was read, but wmux binding state could not be saved.", retry: "sync_current_wmux_session" }; }
    return mirror(record, canonical, false, "auto");
  });
}
