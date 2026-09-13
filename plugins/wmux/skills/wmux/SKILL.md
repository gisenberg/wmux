---
name: wmux
description: Mirror a Codex conversation name to its exactly bound wmux sidebar and tab titles, preserving manual wmux pins.
---

Use the wmux MCP tools only when the trusted prompt hook supplies both
`sessionId` and `bindingId`. Use those exact current IDs. The private receipt
is not a tool argument. Browser focus, cwd, inherited pane variables and other
tasks' bindings cannot select the target.

Codex is the naming source of truth. A read-only observer mirrors native
automatic names and later renames while the binding is live, including while
idle. Do not generate a separate wmux name or write a native name to perform
synchronization. `sync_current_wmux_session` reads the current native name and
retries the bound mirror. The older `name_current_wmux_session` is a
compatibility alias; its proposed title is ignored.

Missing native names, unavailable servers, and invalid bindings preserve the
current wmux titles. Do not substitute prompt text or an old locally stored
semantic name. A pending, expired or restarted binding needs a fresh prompt in
the actual wmux terminal; a desktop-only task does not identify a pane.

Manual wmux workspace and tab titles remain independently pinned until explicitly
unpinned in wmux. After unpinning, the observer reapplies the current native name.
These tools cannot clear pins. Check `workspaceTitle`, `tabTitle`,
`workspaceApplied` and `tabApplied`; a tab write alone does not prove a sidebar
write. An unchanged title can legitimately report no write.

Results identify `namingMode: "native-name-mirror"`, native read status and
`nativeNameSet: false`. Retry a failed sync only through a still-current binding.
Continue the user's work if the integration is unavailable. Root-only behavior
is instructional; it is not isolation from another process using the same
user's private files.

Activity observation remains a separate, prompt-turn-bound capability. Unknown
activity is not evidence of completion or idle status.
