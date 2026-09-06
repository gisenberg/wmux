# Codex plain-start integration: approved scope and historical evidence

The ordinary interactive command remains exactly `codex`; wmux supplies no
wrapper, replacement binary, startup flag, native source change, database edit,
or transcript edit. This document records the selected scope as of 2026-09-06.
It is not a deployment or full-conformance claim.

## Approved wmux-owned naming mode

wmux owns the automatic semantic task title. A trusted prompt binding identifies
the exact live wmux pane; the plugin preflights its private store and asks the
server to atomically accept the automatic workspace/tab title before persisting
the agent-selected title. Follow-ups reuse that stored title; a material
objective change replaces it. Manual wmux workspace/tab titles remain user-owned.

Codex saved conversation names are intentionally untouched. Naming and sync do
not call `thread/read` or `thread/name/set`, and native `/rename` is neither
imported into wmux nor overwritten. Tool results use the wmux-owned fields
`namingMode: "wmux-owned-name"`, `wmuxName`, `nativeNameRead: false`,
`nativeNameSet: false`, `wmuxNameSaved`, `workspaceApplied`, and `tabApplied`.
There is no `codexName` or `codexNameSet` result in this mode.

If title acceptance is rejected, `wmuxNameSaved` is false and only a fresh
`name_current_wmux_session` retry may establish the title; sync cannot invent a
stored semantic name. If the server accepted the title but title persistence
failed, report the actual workspace/tab application with `wmuxNameSaved: false`
and retry `name_current_wmux_session`. A retry of a mirror for an already stored
title remains `sync_current_wmux_session`.

The retained focused fixture log records 19 passing checks, covering `409`
rejection, `503` title-delivery/acceptance uncertainty, and injected
post-acceptance local-store write failure. That is fixture evidence, not native
CLI acceptance.

The visible hook marker remains the binding transport for daemon-backed Codex
where pane environment variables are unavailable. A private receipt, never the
marker alone, authorizes the store/mirror operation. Markers must be redacted
before terminal output is shown in another live pane.

## Prompt-bound lifecycle is separate

The plugin's read-only observer may use the local supported App Server surface
to report an exact bound turn's generic active/attention/terminal state. It does
not start or resume a native turn, answer requests, or control the TUI. A lack of
authoritative observation becomes wmux `status unknown`, not success, failure,
or a scheduled heartbeat. Native request identities, non-prompt continuations,
platform coverage, and full recovery/animation acceptance remain bounded gaps;
see [CODEX_CONFORMANCE.md](CODEX_CONFORMANCE.md).

## Historical native-canonical evidence

Earlier local Linux tests used a different design: the plugin set a Codex saved
name through `thread/name/set`, read it back, and mirrored it to wmux. They
included embedded/daemon naming, follow-up, task-shift, pinned-surface, native
`/rename`, and resume scenarios. That design is superseded and its observed
native writes/mirroring are not current behavior or acceptance evidence for the
wmux-owned mode.

Its later native acceptance also failed when Codex-generated names could not be
distinguished from manual names. Those failures remain historical failures of
the superseded design; changing scope does not convert them into passes.

## Fresh wmux-owned native acceptance

An ignored, local-only record at
`test-results/codex-wmux-owned-native-evidence.json` captures a plain-`codex`,
isolated-HOME, Codex 0.153.4 daemon fixture. Its companion local-only resumed
and input records verify a same-pane native `/resume` and aggregate input
attention. The fixture verified first-task semantic naming, a fresh-binding follow-up
sync, material objective shift, a nested child workspace, manual workspace pin
with automatic tab update, and independence from native UI `/rename`. Native
names remained untouched throughout; the child did not alter its parent.

The initial four parent turns, same-pane resumed follow-up, and final input
question all completed. The final local record
`test-results/codex-wmux-owned-native-final.json` contains six parent completion,
six approval, and one input notifications; the child has one approval and one
completion notification. The native question answer returned input-waiting to
running and then completed. Local desktop/mobile captures show the waiting, working, and completed
indicators; they are not publishable or animation proof because they contain a
fixture host label. A separate browser fixture supplies the dynamic-animation
assertion. This native slice verifies same-pane resume only; it does not certify
restart/reconnect, deployment, other platforms, cross-pane handoff, request identities, a browser
answer bridge, or full conformance.

The final pre-base-integration full check passed (1,075 passing tests, four
skipped), and the desktop/mobile lifecycle browser fixture passed 2/2.
The temporary native fixture and copied test credentials were removed afterward;
the normal services were not deployed or restarted.

## Remaining boundaries

- Native Codex name synchronization and ownership provenance are intentionally
  unsupported in this selected mode; see [CODEX_NATIVE_API_GAPS.md](CODEX_NATIVE_API_GAPS.md).
- Linux/POSIX evidence does not certify Windows ACLs/native plugin execution,
  remote App Servers with another thread store, macOS/SSH, or a deployed service.
- This is a trusted single-user integration, not isolation from another process
  with the same user's terminal or file access.
