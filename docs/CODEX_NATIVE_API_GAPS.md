# Codex native API design checkpoint

Observed version: Codex CLI/App Server **0.153.4**, Linux, 2026-09-06.
This records blockers and unresolved interface contracts for the ordinary
`codex` plugin. It does not waive requirements in
[HARNESS_INTEGRATION_SPEC.md](HARNESS_INTEGRATION_SPEC.md) or certify the PR.
See [CODEX_CONFORMANCE.md](CODEX_CONFORMANCE.md) for tests and native evidence.

## Constraints that remain in force

Startup stays `codex`. No replacement CLI, required launch flags, native source
or binary changes, database/transcript patches, shared-daemon restart, or native
resume/control calls masquerading as passive observation. Generated schemas
and isolated test artifacts are not native implementation changes.

## Reproduce the interface audit

Run the installed binary's schema generator into a new ignored test directory:

```sh
codex --version
codex app-server generate-json-schema --experimental --out test-results/codex-0.153.4-schema
```

The audit inspected `ClientRequest.json`, `ServerRequest.json`, and the v2
thread/read, turn/item/timeline-list, name, settings, goal, diagnostics, hook,
and remote-control-client schemas. Including experimental fields avoids
mistaking a stable-only schema export for the full installed interface.
These files contain protocol schemas, not account/session data. Do not commit
the generated bundle as wmux-owned code.

## Core requirements

| Requirement | Available evidence | Missing guarantee / required decision |
| --- | --- | --- |
| NAM-01–04: semantic native name and user ownership | `Thread.name`; `thread/name/set` takes only `threadId` and `name`; name notifications expose only thread ID/name. Native acceptance showed Codex auto-generating a name before the model naming call. | The approved Codex-plugin scope is now `wmux-owned-name`: semantic names stay in wmux and native names are untouched. This removes the need to infer native ownership for the selected scope, but does not provide native-name synchronization or justify a native-canonical claim. Native provenance/conditional naming support remains necessary for any future native-name mode. |
| BND-02–03 / ACT-01–02 / R09: continued work belongs to the bound terminal | Read-only `Turn` metadata has IDs, status, timing, error, and items. The diagnostic hooks observed startup/resume/Stop ordering in a sequential test. | No established stable per-TUI ownership generation shared by hook input and subsequent native turns. Root identity and a still-existing shell do not prove terminal ownership. Sequential hook ordering does not settle concurrent clients, delayed teardown, compaction, or failing hooks. Need a documented owner/attachment-generation contract or further supported equivalent evidence before permitting successor-turn adoption. |
| INP-01–02 / R10, R26–27: exact pending request set | `ThreadStatus.activeFlags` contains `waitingOnApproval` and `waitingOnUserInput`. Native server requests carry RPC IDs, thread/turn/item identity, and typed payloads; resolution notifications carry thread/request ID. | No pending-request read/list or observation-only thread-subscription method in the installed client-request schema. Aggregate flags cannot distinguish overlapping requests or exact-once request transitions. Need an observation-only snapshot plus ordered requested/resolved events that never makes the observer an approval controller. |

The documented `thread/read` operation does not subscribe to thread events;
turn/item reads are separate from resuming a conversation. The native request
stream has the detailed approval/question protocol, but joining it through
`thread/resume` is not an observation-only contract. The plugin must not use a
read-then-resume race to assume the thread cannot change in between.
[Official App Server documentation](https://learn.chatgpt.com/docs/app-server)

## Nearby fields are not equivalent guarantees

- `ThreadItem.userMessage.clientId` exists, but the audited schema supplies no
  per-TUI owner semantics for it. `turn/start` separately accepts
  `clientUserMessageId`; neither establishes a stable attachment-generation
  contract. Do not infer terminal identity from the field's name.
- `remoteControl/client/list` describes paired remote clients, without a
  thread/turn ownership mapping. It is not a local TUI attachment registry.
- `server/diagnostics` returns process/memory data and named numeric gauges,
  not pending request identities or terminal ownership.
- `thread/timeline/list` exposes persisted items and turn boundaries, not the
  active pending-request set. An `inProgress` tool item is not necessarily an
  unanswered approval, and an old question is not necessarily still pending.
- `agentMessage.questions` contains question titles and optional string
  choices. Its `AsyncUserInputQuestion` shape has no request ID, resolution
  state, or typed reply capability. It is insufficient for an answer bridge.
- Tool hooks expose some tool-call identity, but coverage is not universal;
  the documented `PermissionRequest` fields do not provide the native pending
  RPC request ID. A tool invocation and an approval request are different
  lifecycle objects. The hook contract also does not establish per-client
  teardown ordering. [Official hook documentation](https://learn.chatgpt.com/docs/hooks)

## Optional capabilities need separate scope decisions

The exported client-method list and CLI help expose goal/queue operations but
no native recurring-schedule read API. `ThreadGoal` has status, objective,
budget/usage, and timestamps, not an enabled schedule with a next wake time.
This is not evidence that an active goal, persistent daemon, queued message,
or host-registration heartbeat is a scheduled agent heartbeat.

A wmux-owned scheduler or wmux-owned structured-question tool could be designed
as additional plugin capabilities. They would not establish native schedule
mirroring or native pending-request parity, and must not be presented as closing
those native gaps. Such designs still require explicit ownership, supported
typed replies, reconciliation, and their own acceptance tests. The current
unclaimed optional rows remain unresolved scope, not automatically passed.

## Approved decision boundary

The user approved wmux-owned titles for the Codex plugin: the server first
atomically accepts the bound automatic wmux title, then the plugin persists the
semantic title; native Codex names—including `/rename`—remain untouched. This
is intentionally narrower than
native-name synchronization. It resolves the demonstrated native ownership
conflict without changing Codex, but does not solve lifecycle ownership,
exact-request identity, schedules, browser answers, or other full-parity gaps.

The earlier native-name failures remain historical failures of the superseded
design. A fresh isolated plain-`codex` daemon fixture now verifies wmux-owned
first-task/follow-up/shift/child/manual-pin behavior and native `/rename`
independence, while keeping native names untouched. That bounded result does not
provide native ownership provenance, request identity, cross-pane handoff,
deployment, or full-original-goal completion. A later same-pane native resume
and aggregate `waiting: input` observation remain bounded evidence only: they
do not provide a pending-request set or browser answer capability. More fixtures cannot supply missing native
ownership/request guarantees for a future native-canonical mode.
