#!/usr/bin/env node
// A prompt hook supplies instructions; the agent with the conversation context
// chooses the title. Never derive a title from the incoming prompt here.
const ids = ["WMUX_WORKSPACE_ID", "WMUX_TAB_ID", "WMUX_PANE_ID"];
const bound = ids.every((key) => /^[A-Za-z0-9_-]{1,128}$/.test(process.env[key] || ""));
if (bound) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "wmux task naming: In the root agent, maintain a concise 3–7 word title for the workspace displayed in the wmux sidebar. On the first substantive task, use your understanding of the objective and relevant conversation context to call wmux.name_current_wmux_session with mode auto. Summarize the actual task; do not copy or truncate the latest user prompt. Keep the title unchanged for acknowledgements, clarifications, requests for status, testing, and follow-up work on that objective. Rename only when the overall objective materially changes or your understanding of it is substantially corrected. For a new objective, choose a new semantic title and use the same auto tool. Subagents must leave the root workspace title alone. Never switch to manual mode to defeat title ownership. Check workspaceTitle and workspaceApplied in the result: tabApplied alone does not prove the sidebar was renamed. If the tool is unavailable, continue the task without shell-title fallbacks."
    }
  }) + "\n");
}
