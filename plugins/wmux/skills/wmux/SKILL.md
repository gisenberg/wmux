---
name: wmux
description: Give a normal Codex task a semantic wmux sidebar title through its trusted prompt binding, without changing native Codex names.
---

Use the `wmux` MCP tools only when the trusted prompt hook supplies both
`sessionId` and `bindingId`. Use those exact IDs, not inherited pane variables,
browser focus, another workspace, or a binding from an earlier prompt. The
private receipt is not available to the model or tool arguments.

For the first substantive objective, choose a semantic 3–7 word title and call
`name_current_wmux_session` with the supplied IDs and `mode: "auto"`. Name the
actual task, not the last user prompt. Keep that title through ordinary
follow-ups, tests, clarifications, and status work. Choose a new title for a
material objective shift or substantially corrected understanding, not greetings
or administrative turns. Respect explicit user naming preferences.

On an ordinary follow-up or resume, call `sync_current_wmux_session` with the
NEW prompt binding. It reuses wmux's stored semantic title. If no wmux name is
stored and there is a substantive task, choose one with the naming tool.
Names are stored by native session ID in wmux's private plugin state, not in
Codex. Native automatic names and `/rename` remain untouched and independent;
never call native name APIs to make them match.

The server preserves manual wmux workspace/tab titles. These tools cannot
override or release a manual pin; use the wmux UI for that. Check `workspaceTitle`
and `workspaceApplied`: `tabApplied` or `wmuxNameSaved` alone does not prove the
sidebar changed. `namingMode` is `wmux-owned-name`.

If a sync failed, retry with `sync_current_wmux_session` using the same
still-current binding. Naming saves the new title only after wmux accepts it;
if `wmuxNameSaved` is false, follow the reported naming retry instead of
syncing an older title. A stale, pending, expired, or restarted
server binding is nonblocking: continue the task and wait for a fresh prompt
binding. Do not guess a replacement. Root-agent guidance is instructional;
hooks reject `agent_id`, but this is not a hard subagent sandbox.

The plugin works with ordinary `codex`, without wrappers, required launch flags,
or Codex source changes. Automatic activity observation is separate from model
naming calls. Unknown activity is not evidence of completion or idle status.
