import { api, loadBinding, withBinding } from "./wmux-binding.mjs";
import { mirrorTitle, validTitle } from "./wmux-title.mjs";
import { wmuxSessionName, rememberWmuxSessionName } from "./wmux-name-ownership.mjs";

async function resolve(record) { return api("/api/codex-bindings/resolve", { sessionId: record.sessionId, receipt: record.receipt }); }
function outcome(record, name = null) {
  return { sessionId: record.sessionId, bindingId: record.bindingId, namingMode: "wmux-owned-name", wmuxName: name,
    nativeNameRead: false, nativeNameSet: false, wmuxNameSaved: false, workspaceApplied: false, tabApplied: false };
}
async function mirror(record, name) {
  const result = { ...outcome(record, name), wmuxNameSaved: true };
  // The endpoint revalidates the receipt and enforces manual ownership atomically.
  // A saved semantic name is not evidence of a sidebar change.
  try { return { ...result, ...await mirrorTitle(record, name, "auto") }; }
  catch (error) { return { ...result, error: error.message, retry: "sync_current_wmux_session" }; }
}
export async function getSession(sessionId, bindingId) {
  const record = loadBinding(sessionId, bindingId), tuple = await resolve(record);
  return { sessionId, bindingId, workspaceId: tuple.workspaceId, tabId: tuple.tabId, paneId: tuple.paneId, expiresAt: tuple.expiresAt, titleRead: false };
}
export async function nameSession(sessionId, bindingId, title, mode = "auto") {
  const initial = loadBinding(sessionId, bindingId), name = validTitle(title);
  if (mode !== "auto") throw new Error("The Codex naming plugin supports auto mode only; manual titles belong to the wmux UI.");
  return withBinding(initial, async record => {
    await resolve(record);
    // Refuse an unsafe store before any title side effect. The write rechecks it.
    try { wmuxSessionName(sessionId); }
    catch (error) { return { ...outcome(record), error: error.message }; }
    let applied;
    // Only /title validates and applies atomically on the server. Never save a
    // rejected title that a later valid prompt could otherwise inherit.
    try { applied = await mirrorTitle(record, name, "auto"); }
    catch (error) { return { ...outcome(record, name), error: error.message, retry: "name_current_wmux_session" }; }
    try { await rememberWmuxSessionName(sessionId, name); }
    catch (error) { return { ...outcome(record, name), ...applied, error: error.message, retry: "name_current_wmux_session" }; }
    return { ...outcome(record, name), ...applied, wmuxNameSaved: true };
  });
}
export async function synchronize(sessionId, bindingId) {
  const initial = loadBinding(sessionId, bindingId);
  return withBinding(initial, async record => {
    await resolve(record);
    let saved;
    try { saved = wmuxSessionName(sessionId); }
    catch (error) { return { ...outcome(record), error: error.message }; }
    if (!saved) return { ...outcome(record), skipped: "No wmux semantic name is saved for this session. Choose one for the substantive task with name_current_wmux_session." };
    return mirror(record, saved.name);
  });
}
