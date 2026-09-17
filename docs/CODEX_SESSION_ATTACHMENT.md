# Open an existing Codex task in wmux

## Qualification update — 2026-09-17

**Desktop connected to Haswell is qualified; Desktop-local ice3070 is not.**
The installed Desktop SSH route already reaches Haswell's persistent native
server through the guarded Desktop proxy. A managed wmux CLI can join that same
server with `codex-guard resume EXACT_UUID`, without endpoint, prompt, cwd or
permission overrides. No production connection changes were necessary.

The independent connection task passed eight native lifecycle checks, then
recorded direct user UAT: approval answered in Desktop completed in wmux, and a
Desktop-submitted continuation appeared in both clients after reopening the
Desktop task view. Server/guard processes and configuration hashes were
preserved. Full Desktop process shutdown, host reboot and phone/catalog UI
were not covered. Private evidence is in
`/home/iceparrot/reports/codex-connection-cleanup-20260917/`, especially
`HANDOFF.md`, `UAT.md`, `evidence/proof-result.json`,
`evidence/desktop-final-result.json` and `evidence/preservation-check.json`.

This supersedes the September 16 blanket description of Desktop attachment as
blocked. The lane-readiness failures below apply specifically to Desktop's
**local ice3070** server. Exact-task catalog implementation is now assigned in
an isolated wmux worktree; the deployed catalog remains unchanged and M6 remains
unaccepted. The next implementation targets loaded tasks on the qualified
managed route, with exact owner/generation, queue, readiness and terminal checks.

## Investigation — 2026-09-16

The intended workflow is **select an existing task → open that exact conversation
in a wmux CLI → continue working with its existing history and active turn**.
The deployed catalog does not implement this workflow. The user rejected its
inspection/association-only experience as insufficient; M6 is not accepted.

The initial blanket restriction on resume was too broad. Codex CLI 0.154.0
supports `codex resume --remote unix:///absolute/socket THREAD_UUID`. Its generated
`ThreadResumeParams` contract explicitly distinguishes joining a running thread
from loading a stored thread. Joining the same running App Server does not need
exclusive ownership of that task by one client. This does not establish exclusive
terminal binding or grant a new pane permission to replace naming ownership.

Official references: [CLI remote mode](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [App Server thread lifecycle](https://learn.chatgpt.com/docs/app-server).
Installed CLI help, generated version-specific schemas and live tests qualify
the specific behavior below; documentation alone is not the test result.

## Native findings

On the two configured Linux background servers, disposable native tasks passed:

- Attach a CLI by exact task UUID while idle; recover history without adding a turn.
- Attach a second CLI during an active turn; keep the same native turn ID.
- Observe that turn's completion in both CLIs.
- Submit one harmless message from the second CLI; both clients display the
  continuation in the original task, with no fork or new conversation.
- Quit the added CLI during another active turn; the original task remains active
  and completes for the surviving client.

These probes used the existing managed CLI and preserved native policy and the
installed usage guard. No Codex code, configuration or service was changed.
Tests used fresh owned tasks; existing user tasks were not driven.
Native `canAcceptDirectInput` metadata is useful capability evidence, but does
not override a launcher's refusal or prove that its eventual connection uses
the same server as the metadata query.

### Route to the running server, not just its saved database

The workstation's Desktop owns a different native App Server from its background
CLI service. Both can see saved tasks under the same account home. A successful
`thread/read` or matching task UUID in the background catalog therefore does not
prove that server owns Desktop's active turn. Its `notLoaded` status is local to
that server, not proof that the task is idle everywhere.

The installed managed CLI also owns its endpoint selection: passing `--remote`
to the shell's managed alias is rejected. The existing Desktop lane configuration
identifies its native server and preserves the same account and guard policy,
but passing that configuration to the managed CLI did not pass readiness.
wmux must validate an already supported route, rather than bypass the wrapper or
create/change a native configuration.
Plain native CLI deployments can use the explicit remote command above.

The Desktop-local ice3070 route is **not qualified**. The standard managed dispatcher
ignores the Desktop lane environment hint and selects the background server;
the native client then reports that the conversation is open in another app.
Using the existing `managed-cli` command with the Desktop lane's configuration
also failed its readiness check. Read-only `installation-status` isolated the
failure: native connection and trusted required hooks were good, but
`runtime_descriptor_usable` was false. The installed descriptor names the base
configuration, while this launch selects the Desktop lane configuration. No
descriptor was rewritten, guard bypassed or native service restarted.

Thus native same-server sharing is proven, but Desktop-local ice3070 → CLI access
through that managed route remains blocked. An already supported,
policy-preserving route must be demonstrated before that row is enabled. Changes
to the usage guard or Codex are outside this wmux-only task. Do not call this
Desktop workflow deliverable merely because background-server tests passed.

This makes endpoint discovery and route qualification part of the feature.
Never fall back from an unavailable Desktop server to an independent local
`codex resume`, another server, a title match or a working-directory match.

### Saved tasks can already have input waiting

A disposable completed task was archived/unarchived through native methods to
establish `notLoaded`, then given one harmless queued message. Queue inspection
confirmed one pending item and no new turn. Opening its exact UUID in the managed
CLI consumed that message and completed exactly one new turn, without any prompt
sent through the CLI. This is an observed resume side effect, not just a theoretical
race. Unsubscribing alone did not unload the test task and was not counted as an
unloaded-task test.

## Recommended wmux implementation

| Task situation | Action |
| --- | --- |
| Already open in a verified live wmux CLI | **Open terminal** focuses that pane. A display association alone is insufficient proof. |
| Loaded on one verified reachable server with a qualified managed CLI route, idle or active | **Open in CLI** joins that server using the exact UUID. Explain that it shares the task; an active turn continues. Desktop's Haswell SSH route is qualified; Desktop-local ice3070 is not. |
| Saved but not loaded on any fully checked supported server | **Continue in CLI** may load it, subject to explicit queue and route checks. |
| Queued input exists | Explain that opening can run the existing queued work; require an explicit decision for that consequence. Do not enqueue another prompt. |
| Owner, queue, route or capability is unknown; conflicting owners; server unavailable | Keep inspection available and explain the specific missing evidence. Do not try another executor. |

The supported initial scope is shared App Servers on Linux. Arbitrary standalone
processes and unqualified hosts remain outside this scope. Finding no owner in a
partial endpoint inventory cannot establish that a saved task is safe to load.

Implementation stays entirely in wmux:

1. **Resolve ownership and preserve the managed route.** Extend catalog discovery
   to trusted already-running servers and their loaded-task inventories. Keep
   stored discovery separate from live ownership. Bind the route to server
   identity/generation and revalidate before launch; reject replaced sockets,
   stale lane files and ambiguous owners. Do not start servers or alter guard
   configuration. Bound discovery, timeouts and retained metadata.
2. **Launch an exact existing task.** Extend the authenticated launch contract,
   helper argv and persisted attempts with operation kind and exact native UUID.
   Preserve the native task's cwd and policy instead of applying fresh-task
   defaults. Keep prompts, trust responses and permission overrides absent.
   Maintain idempotency, uncertainty reconciliation and exact pane links.
   A preflight is not an atomic ownership/queue lock: explain resume semantics
   honestly and handle a changed/unavailable route without automatic retry.
3. **Make the primary action useful.** Put **Open in CLI / Open terminal** on the
   selected task. Present **Start new task** separately. Label display associations
   as optional activity monitoring. Keep native task sharing distinct from wmux
   title ownership; opening another view must preserve independent manual pins.

## Milestones and acceptance

These are corrective checkpoints within M5/M6, not an accepted new release.

| Checkpoint | Deliverable | Gate |
| --- | --- | --- |
| M5a — Exact owner and launch route | Qualified server discovery, loaded-state resolution and preserved managed launcher | Haswell connection dependency and native Desktop UAT passed. Implement automated wrong-server, stale/replaced endpoint, ambiguous owner, queue and policy checks. Desktop-local ice3070 remains unsupported. |
| M5b — Existing-task CLI action | Idempotent existing-task launch, focus existing terminal, actionable uncertainty and clear catalog controls | Native and browser tests for idle/active attachment, history, continuation, duplicate clicks, failures and closing an extra client; then direct Desktop → wmux and phone UAT on a disposable task. |
| M6 — Revised release acceptance | The real daily workflow works with naming, pins, notifications and recovery | User can select a Desktop task, open the same task in wmux, see current work and continue it; qualified rollback and relevant soak evidence remain required. |

The wmux-only first increment is exact-task access on the qualified Haswell
shared server, including tasks used through Desktop's Haswell connection.
It must not be presented as completing M6 before the catalog action and its UAT
pass. Keep the unqualified Desktop-local route explicit rather than weakening
the installed checks or making an out-of-scope migration a prerequisite.

Required automated coverage includes a task loaded on a Desktop-owned server but
listed as stored on another server, simultaneous native clients, no prompt on
attach, queued-input consequences, preserved policy/cwd, stale target handling,
endpoint replacement, idempotency/reload, independent pins and failure cleanup.
Approval/login decisions remain native and interactive. Actual Desktop rendering
and physical-phone usability need direct UAT; protocol clients cannot substitute
for that acceptance.

## Evidence and limits

Private artifacts are under `test-results/m6-session-attachment-20260916/`.
`haswell-success.json`, `haswell.log` and `ice3070/result.json` record successful
native probes. `queued/result.json` records the queued-input side effect.
`desktop-wrong-route/`, `ice3070-desktop-lane/` and
`desktop-managed-readiness.json` record the two Desktop failures and diagnosis.
These do not qualify Desktop attachment or Desktop rendering. Generated schemas
and raw terminal/RPC evidence remain private.
The first explicit-endpoint managed-launch attempt was rejected before native
attachment. An early harness Escape key raced with turn startup; that turn was
interrupted and is not a successful active-attachment test. The corrected run
waited for terminal input to settle before starting the next turn.
Other harness setup failures (an accidental import run and querying turn history
before initial history initialization) were retained and are not counted as
successful tests. Reports identify exact owned task IDs; no outcome is inferred
from a matching task name or directory.
Owned test workspaces were closed and disposable tasks archived after checking
that they were inactive with no queued input. User workspaces and the previously
retained trust-test views were preserved.

This investigation does not enable the action in the deployed catalog. The
existing M6 synthetic soak does not qualify code that has not been implemented.
