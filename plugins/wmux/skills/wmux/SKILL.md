---
name: wmux
description: Inspect or name the current wmux workspace and tab from a normal Codex session. Use whenever working in a wmux-bound Codex session; automatically title a new substantive task.
---

Use the `wmux` MCP tools when the current Codex session has a complete pane
binding. `get_current_wmux_session` reports only the current workspace, tab, and
pane; it deliberately does not request broader wmux read access merely to fetch
titles. `name_current_wmux_session` changes that exact bound session through
wmux's title API.

At the start of a new substantive user task, derive a compact, descriptive
title from that task and immediately call `name_current_wmux_session` with
`mode: "auto"`. This is the default behavior; do not wait for the user to ask
for a title. Do not name a greeting, an acknowledgement, a request to clarify
the task, or an otherwise non-substantive turn. If the binding is unavailable,
continue the task without a title unless the user explicitly asked to name it.
Retitle only when the user clearly switches to a different substantive task.
Choose a semantic 3–7 word summary of the overall objective using the conversation
and your understanding of the work. Never copy or truncate the latest prompt.
Keep the title stable through follow-up tests, status questions, and refinements
of the same task. Only the root agent names its sidebar workspace; subagents do
not rename their parent's workspace. Check `workspaceTitle` and `workspaceApplied`
in the result; a changed tab alone is not proof that the sidebar changed.

Use automatic naming by default. It respects manual wmux workspace and tab
names, and associates the update with the bound pane so split panes cannot name
the wrong session. Use manual naming only when the user explicitly asks for a
manual/persistent wmux title. Never infer the current session from browser focus
or another workspace, and report the unavailable binding if the tool fails.

This plugin works with the ordinary `codex` command. It does not launch a
replacement TUI or change Codex's own conversation name. Its bundled prompt hook
reminds the agent of the naming policy, including when this skill is not selected.
