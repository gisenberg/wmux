#!/usr/bin/env node
import { ID, issue, promptBinding, endSessionBindings } from "./wmux-binding.mjs";
import { synchronize } from "./wmux-session.mjs";
import { startCodexObserver } from "./wmux-observer.mjs";

async function input() { let text = ""; for await (const chunk of process.stdin) { text += chunk; if (text.length > 65536) throw new Error("wmux hook input is too large."); } return JSON.parse(text); }
async function run() {
  const value = await input(), event = value.hook_event_name, sessionId = value.session_id;
  if (!ID.test(sessionId || "") || value.agent_id || !["UserPromptSubmit", "Stop", "SessionEnd"].includes(event)) return;
  if (event === "SessionEnd") { await endSessionBindings(sessionId).catch(() => {}); return; }
  if (event === "Stop") {
    // Codex does not always send turn_id. Without it there is no safe way to
    // select a receipt from concurrent prompt bindings.
    const record = promptBinding(sessionId, value.turn_id);
    if (record) await synchronize(record.sessionId, record.bindingId).catch(() => {});
    return;
  }
  let challenge;
  try { challenge = await issue(sessionId, value.turn_id); }
  catch { process.stdout.write(JSON.stringify({ systemMessage: "wmux naming unavailable; continue without changing the title." }) + "\n"); return; }
  const context = `wmux trusted binding: sessionId=${sessionId} bindingId=${challenge.bindingId}. Codex names are the source of truth: a read-only observer mirrors native automatic names and later renames to this bound wmux tab/workspace. Root agent may call wmux.sync_current_wmux_session with exactly these IDs to retry or inspect a sync. Do not invent a separate wmux name or write native names for synchronization. Missing names leave existing titles unchanged. Preserve manual wmux pins until explicitly unpinned in wmux. Never guess IDs or use another workspace. Continue normally if unavailable.`;
  const lifecycleContext = ID.test(value.turn_id || "") ? "" : " wmux activity reporting is unavailable because this native prompt hook omitted turn_id. Naming may still work; report this version/capability limitation without guessing a turn.";
  process.stdout.write(JSON.stringify({ systemMessage: challenge.marker, hookSpecificOutput: { hookEventName: event, additionalContext: context + lifecycleContext } }) + "\n");
  // Lifecycle is automatic and independent of whether the model calls a naming
  // tool. Stop is not a terminal event: another hook may continue the turn.
  try { await startCodexObserver(sessionId, challenge.bindingId); } catch {}
}
run().catch(() => process.stdout.write(JSON.stringify({ systemMessage: "wmux naming unavailable; continue without changing the title." }) + "\n"));
