#!/usr/bin/env node
import { ID, issue, promptBinding } from "./wmux-binding.mjs";
import { synchronize } from "./wmux-session.mjs";

async function input() { let text = ""; for await (const chunk of process.stdin) { text += chunk; if (text.length > 65536) throw new Error("wmux hook input is too large."); } return JSON.parse(text); }
async function run() {
  const value = await input(), event = value.hook_event_name, sessionId = value.session_id;
  if (!ID.test(sessionId || "") || value.agent_id || !["UserPromptSubmit", "Stop"].includes(event)) return;
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
  const context = `wmux trusted binding: sessionId=${sessionId} bindingId=${challenge.bindingId}. Root agent only: for the first substantive objective choose a semantic 3–7 word title (not a copied prompt) and call wmux.name_current_wmux_session with exactly these sessionId and bindingId, title, mode auto. Keep the semantic name for ordinary follow-ups; when not renaming, call wmux.sync_current_wmux_session with this NEW current bindingId to mirror the actual saved Codex name (including native /rename). Choose a new name only for a material objective shift. Preserve explicit user names. Never guess IDs or use another workspace. Continue normally if unavailable.`;
  process.stdout.write(JSON.stringify({ systemMessage: challenge.marker, hookSpecificOutput: { hookEventName: event, additionalContext: context } }) + "\n");
}
run().catch(() => process.stdout.write(JSON.stringify({ systemMessage: "wmux naming unavailable; continue without changing the title." }) + "\n"));
