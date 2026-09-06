---
name: wmux
description: Keep a normal Codex session's saved semantic name and its bound wmux title aligned through the trusted prompt binding.
---

Use the `wmux` MCP tools only when the trusted prompt hook supplies both
`sessionId` and `bindingId`. They identify one short-lived binding and cannot
list or infer any other wmux session. The private receipt is deliberately not
available to the model or tool arguments.

For the first substantive objective, choose a semantic 3–7 word name and call
`name_current_wmux_session` with the exact supplied IDs and `mode: "auto"`.
It resolves the binding first, sets the local Codex saved conversation name,
reads back Codex's canonical value, and then mirrors that value to wmux. Keep
the name through normal follow-ups, tests, clarifications, and status work.
Rename only for a material objective shift or substantially corrected
understanding. Do not name greetings or non-substantive turns. Preserve explicit
user names. These tools support only automatic naming and cannot override a
manual wmux title; use the wmux UI for manual title ownership.

On an ordinary follow-up or resume, call `sync_current_wmux_session` using the
NEW current prompt binding instead of naming again. This also mirrors a native
`/rename` without inventing another title. Check `workspaceTitle` and
`workspaceApplied`: `tabApplied` alone is not proof of a sidebar rename.

If Codex was named but mirroring failed, call
`sync_current_wmux_session` with the same IDs. It reads and mirrors the saved
name without setting a new one. A stale, pending, expired, or restarted daemon
binding is nonblocking: continue the task and wait for a later prompt hook to
provide fresh IDs. Root-agent guidance is instructional; hooks reject an
`agent_id`, but this plugin does not claim a hard subagent sandbox.

This works with ordinary `codex`, without wrappers, launch flags, Codex source
edits, or Codex configuration changes. Native `/rename` is reconciled from the
actual saved thread name at the next eligible prompt binding; previews are not
used as names.
