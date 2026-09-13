# Codex native API design checkpoint

Updated 2026-09-11. Installed CLI schema: **0.154.0**; existing daemon checked:
**0.153.4**, Linux. The previous 2026-09-06 native-write and wmux-owned-name
experiments remain historical in [CODEX_CONFORMANCE.md](CODEX_CONFORMANCE.md).

## Approved name source

The selected Codex profile is **native-name-mirror**. Read the exact native
`Thread.name`, then apply it through the existing terminal receipt to eligible
wmux titles. Native automatic naming, desktop renames and CLI renames are equally
canonical. The adapter never issues `thread/name/set` or writes names back.

The older API's absent ownership provenance and compare-and-set blocked safe
automatic **native writes**. They do not block this one-way read-only profile:
there is no native write to race a user rename. Native-generated title quality
and native automatic-vs-manual arbitration remain Codex's responsibility.
Manual wmux pins stay server-enforced and independent for workspace and tab.

## Read and notification contract

The installed experimental schema exposes `thread/read`, `Thread.name` and
`thread/name/updated`. `thread/read` reads stored metadata without resuming,
loading or subscribing to a thread. The observer uses `includeTurns: false`
and verifies the returned exact root identity.

No observation-only thread subscription is used or established by this audit.
Connecting and initializing a WebSocket is not proof of receiving every client's
rename event. The implementation polls every two seconds, including after turn
completion, through the still-live binding. It never calls `thread/resume` to
subscribe. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server)

Read-only live checks found:
- An active desktop task's name was visible on its host's existing daemon.
- That daemon could not read a desktop task on another host.
- The second task's stored name was visible through its host's managed native
  socket with `status: notLoaded`; the default daemon socket was absent there.

These establish endpoint-specific metadata access, not common runtime ownership,
notification broadcasting, or a native desktop rename acceptance test. Configure
the verified existing socket explicitly when it is not at the default path.
No live names, credentials or private endpoint inventory belong in this document.

## Binding boundary

A trusted hook's exact session ID plus wmux's live observation of its one-time
marker establishes the receipt's terminal target. A desktop-only task that never
renders the marker to a wmux backend has no such target. Cwd, focus, native
`source: vscode`, daemon-global environment and a stored thread name cannot
supply it. Such tasks remain unbound; no unrelated title is overwritten.

The existing lease protects against superseded prompts, concurrent-pane
ambiguity, backend replacement and stale writes after async native reads.
A browser reconnect to the same retained backend preserves it; wmux restart or
actual backend replacement requires a fresh prompt. Name polling is bounded by
that lease and does not adopt successor lifecycle turns.

## Other unresolved contracts

| Requirement | Available interface | Remaining guarantee |
| --- | --- | --- |
| Immediate terminal-client exit cleanup | Native SessionEnd hook; shared-client detach does not immediately end a native session | Excluded from this PR. Keep receipt-scoped cleanup on delivered SessionEnd and existing replacement/disposal/24-hour expiry bounds. Immediate per-client cleanup needs an authoritative attachment-scoped native event; process timing and aggregate thread status cannot supply it. |
| Continued work belongs to the bound terminal | Native turn IDs/status and prompt hook session/turn IDs | No established per-TUI attachment generation shared by hooks and successor turns; no automatic successor-turn adoption. |
| Exact pending native request set | Aggregate active flags and controller request payloads | No observation-only pending-request snapshot/subscription established. Aggregate waiting is not exact request identity or browser answer authority. |
| Native recurring schedules | Goal and queue operations | Goals, queued input and a persistent daemon do not establish a recurring scheduler or heartbeat. |
| Native automatic naming arbitration | Name read/set and rename notifications | No provenance/conditional write guarantee. The read-only mirror makes no writes and delegates naming to Codex. |

No source/binary modifications, database/transcript patches, alternate CLI,
native resume/control calls, or new App Server are permitted as observation
substitutes. Unknown metadata retains the last visible title and leaves native
work usable.

## Reproduce the schema audit

```sh
codex --version
codex app-server generate-json-schema --experimental --out test-results/codex-name-schema
```

Inspect `ClientRequest.json`, `ServerNotification.json`, and
`v2/ThreadReadResponse.json`. Generated schema files are protocol artifacts,
not account data; keep them out of source control. Repeat endpoint-specific
read checks after upgrades. The [plugin guide](CODEX_PLUGIN.md) documents
installation, exact mirroring limits and failure behavior.
