# Codex plain-start conformance matrix

Status date: 2026-09-06.  This is an evidence ledger for the normative
[harness integration contract](HARNESS_INTEGRATION_SPEC.md), revision 1.1; it is
not a certification claim.  Scope is the ordinary interactive `codex` plugin
path, not wmux delegation/headless Codex or other harnesses.

## Baseline, method, and status vocabulary

| Item | Value |
| --- | --- |
| Source baseline inspected | wmux `23eb15d` |
| Dogfood/deployed integration baseline reported | `d91883a` (unmerged) |
| Native runtime reported | Codex `0.153.4`, Linux |
| Plugin reported | `0.2.0+codex.20260906011825` |
| Live evidence source | [plain-start design](CODEX_PLAIN_START_DESIGN.md), plus the explicitly scoped native experiments recorded below |

**Verified scope** means a source/test assertion and the stated live evidence
cover the precise claim. **Partial** means a useful implementation or bounded
observation exists but at least one required assertion, mode, platform, or
independent invariant is absent. **Missing** means the Codex plugin has no
implementation that can meet the requirement. **Unclaimed optional** means
Codex does not advertise the optional capability; it is not a waiver of a core
case. Fixture-only tests demonstrate wiring and failure behavior, never native
CLI or browser acceptance.
**Failed** means a current-source native acceptance test contradicted a required
assertion; an older successful baseline does not override that result.

The two most important qualifiers are deliberate:

1. The isolated Linux daemon fixture now provides fresh wmux-owned first-task,
   follow-up, objective-shift, nested-child, and manual-pin evidence. It is a
   bounded native acceptance slice, not a full native-name or cross-platform
   parity pass; model adherence remains an instruction-level risk.
2. A raw marker copied into an observer terminal caused the documented conflict.
   That is a correctly fail-closed mechanism plus a real operational hazard,
   not evidence that ordinary observation is safe. Markers must be redacted
   before observed terminal content is displayed elsewhere.

The [native API design checkpoint](CODEX_NATIVE_API_GAPS.md) records the installed
experimental schema audit, rejected look-alike interfaces, and decisions needed
for naming, continuation ownership, exact native requests, and optional scope.
It is not full-parity certification. Publication of the narrower capability
profile below is explicitly approved; the original harness-neutral contract
remains intact.

## Approved achievable scope

The approved Codex naming mode is **wmux-owned-name**. The plugin resolves and
preflights its private title store, then the server atomically accepts the bound
automatic workspace/tab write before the agent-selected semantic title is
persisted in wmux. Codex saved names, including native `/rename`, are
intentionally untouched and are not a synchronization source. This selected
fallback is narrower than the contract's native-canonical path: it preserves
native user choices by never writing them, but it must not be represented as
native-name parity.

The implementation record is the owner-private, bounded
`wmux-session-names-v1.json` store (maximum 512 entries). Naming results identify
`namingMode: "wmux-owned-name"`, the `wmuxName`, `wmuxNameSaved`, false native
read/set flags, and independent workspace/tab application. They do not expose
native-name result fields.

The prior native-canonical failures below are retained as historical evidence.
They are failures of the superseded native-canonical design, not failures of the
fresh wmux-owned acceptance slice; neither record completes the original
full-parity goal. Prompt-bound lifecycle/aggregate attention remains a separately
supported, bounded capability with the gaps recorded in this matrix.

The retained focused wmux-owned fixture log records 19 passing checks, including
`409` rejection, `503` title-delivery uncertainty, and injected local-store
failure after title acceptance. These are source/fixture checks, separate from
the native acceptance slice.

## Fresh isolated native acceptance

The ignored, local-only evidence records
`test-results/codex-wmux-owned-native-evidence.json`,
`codex-wmux-owned-native-resumed.json`, and
`codex-wmux-owned-native-input.json` capture an isolated HOME, plain `codex`,
and Codex 0.153.4 daemon fixture. They must not be read as deployment evidence
or copied into published artifacts.
The six native sidebar captures are likewise local-only because their fixture
host labels are unsuitable for publication.

- The first substantive root turn chose **Fair Community Book Exchange** and
  applied it to both automatic workspace and tab surfaces while the native name
  remained **We are organizing a small community**. A follow-up used a new
  binding to sync that unchanged wmux title. A material garden objective chose
  **Community Garden Volunteer Welcome**, again applying both surfaces.
- A nested child workspace `ws_886c0a94` was recorded under parent
  `ws_43d3eaaa`. Its **Community Rain Barrel Care** wmux title remained separate
  from native **Suggest rain barrel checklist**; the parent was unaffected.
- After native UI `/rename` to **Native User Notebook**, a manually pinned root
  workspace remained **User Sidebar Pin**. The controlled objective updated its
  automatic tab to **Controlled Wmux Activity Test** with `tabApplied: true` and
  `workspaceApplied: false`; native name remained unchanged.
- Four root turns and one child turn each recorded running → waiting-for-approval
  → running → completed, with one approval and one completion notification per
  turn. Desktop and mobile captures show `?`, spinner, and `✓` indicators, but
  still images do not prove animation.

The first running capture missed a short completed turn; a later controlled
20-second turn captured both viewport projects. After normal TUI exit, plain
`codex` and native same-pane `/resume`, a fresh binding sync preserved the
automatic tab, user workspace pin, and native name through a fifth completed
turn. This verifies R14's same-pane resume scope; cross-pane handoff remains
fail-closed and open. A native `/plan` flow also produced a distinct
`waiting: input` state and notification after approval, while the user answered
only in the native TUI. It supplies aggregate input-attention evidence, not
pending-request identities or a browser question-answer bridge. Browser-fixture
dynamic-animation assertions passed separately (2/2). Restart/reconnect,
deployment, and continuous native-animation acceptance remain open.

The final native record, `test-results/codex-wmux-owned-native-final.json`,
confirmed the question's native answer returned the turn to running and then
completed. Across six parent turns there were six completion, six approval,
and one input notifications; the child retained its separate two notifications.
Both native names stayed unchanged. Disposable panes, fixture services, and
the copied test credentials were removed after collecting the local evidence;
the normal services were not restarted or redeployed.

The final pre-base-integration `npm run check` passed with 1,075 passing tests,
four skipped, and no failures (1,079 total), plus types, generated/script checks,
and production build. Log: `test-results/codex-wmux-owned-complete-check.log`.
An earlier run failed one Windows side-by-side rollout test; that suite passed
21/21 on its focused rerun, and subsequent full gates passed without changing
that runtime. The retained browser log is
`test-results/codex-wmux-owned-browser.log` (2/2).
Independent naming review found a stale-receipt persistence race, reproduced
red-to-green by the 409/503 delivery tests, then approved the corrected order.
Native acceptance used plugin `0.2.0+codex.20260906222906`; the later Stop-hook
status-label correction changes display text only, not the tested executable.
PR #121 was already merged when publication was checked; this work therefore
requires a follow-up PR against current `main`, not rewriting the merged PR.

### Current-main integration gate

The implementation was rebased onto `main` at `4849e88`. The first post-rebase
browser run failed in both layouts: the server published `observer_stale`, but
the new session-inventory projection replaced it with the delegation's last
known `waiting` state. A separate API assertion confirmed publication before
the browser assertion failed. A new unit regression reproduced the defect for
both running and waiting delegations.

The corrected projection presents a current same-run stale observation without
rewriting native outcome history. It suppresses obsolete aggregate attention,
preserves an actual pending input request, and lets newer authoritative state
or terminal outcomes win. An independent fresh-context reviewer checked both
the complete profile and this integration fix; no outstanding findings remained
in that reviewed scope.

Final gates on the corrected current-main source:

- `npm run check`: 1,081 passing, four skipped, zero failing (1,085 total),
  including TypeScript, script/generated checks, and production build.
  Local log: `test-results/codex-wmux-profile-final-check.log`.
- `e2e/codex-sidebar-lifecycle.spec.ts`, Chromium and mobile Chromium: **2/2**
  passed, including live marker animation, input attention, API-confirmed stale
  withdrawal, recovery, completion, and current-state retention after history
  churn. Local log: `test-results/codex-wmux-profile-final-browser.log`.
- The focused inventory regression passed after its recorded red run.

These browser fixtures are separate from the real native acceptance above.
The original conformance matrix remains deliberately partial; this gate verifies
the approved capability profile, not full harness parity or a deployment.

### Durable browser reconnect repair, 2026-09-07

Post-deployment testing found that the first browser viewer after all viewers
disconnected recycled the live local tmux client and revoked its Codex receipt.
The durable process survived, but the plugin observer stopped on the revoked
receipt and wmux subsequently displayed stale observation. A native
delayed-response menu was present in one reported incident; it was not proven
to trigger the reconnect. This is a wmux connection-lifetime defect, not a
native request classification claim.

wmux now keeps the exact live client while a currently resolvable observed
binding belongs to that pane, and restores the browser from that client's VT
checkpoint without an extra forced refresh. It neither transfers the receipt
to a replacement client nor extends its lease. Actual exits, replacements,
closure, and server restart retain their existing revocation behavior.

The real tmux/HTTP/Unix-socket observer fixture in
`test/codex-observer-integration.test.ts` failed on client identity before the
repair and passes repeated viewer reconnects during active/attention/completed
states, including resize and a restored screen. Its native metadata source is
a fixture, not a new Codex CLI acceptance run. The independent server-coupled
`e2e/codex-durable-reconnect.spec.ts` failed with receipt 404 before the repair
and passes in desktop/mobile Chromium after it: receipt continuity, moving
working glyph, input-to-working-to-completed transitions, and closure revocation.
Registry and session-manager tests cover retention eligibility, unchanged
agent-input authority, checkpoint/refresh fallback, raw output watchers, and
shutdown revocation. This does not claim cross-process or server-restart
recovery, and already-revoked receipts still need a fresh prompt binding.

## Implementation inventory

The naming binding is implemented by the source plugin and wmux server together:
the trusted prompt hook issues a challenge, a live-pane parser observes its
visible marker, and a private receipt resolves before any title write. See
[`wmux-context.mjs`](../plugins/wmux/scripts/wmux-context.mjs),
[`wmux-session.mjs`](../plugins/wmux/scripts/wmux-session.mjs),
[`codex-terminal-binding.ts`](../src/server/codex-terminal-binding.ts), and
[`codex-binding-routes.ts`](../src/server/routes/codex-binding-routes.ts).
`setAutoTitle` applies deterministic layout ownership and respects wmux user
pins ([`state.ts`](../src/server/state.ts)).

Useful automated anchors are
[`codex-terminal-binding.test.ts`](../test/codex-terminal-binding.test.ts),
[`codex-binding-lifecycle.test.ts`](../test/codex-binding-lifecycle.test.ts),
[`wmux-binding-store.test.ts`](../test/wmux-binding-store.test.ts),
[`wmux-plugin-mcp.test.ts`](../test/wmux-plugin-mcp.test.ts), and
[`codex-plugin-terminal-integration.test.ts`](../test/codex-plugin-terminal-integration.test.ts).
The last test uses a real wmux HTTP/session/PTy path but does not certify a
native Codex naming operation.

The plugin installs `UserPromptSubmit` and `Stop` hooks
([`hooks.json`](../plugins/wmux/hooks/hooks.json)). The deployed baseline has no
daemon-safe lifecycle publisher. The current source adds a receipt-bound observer,
publisher, and stale reconciler, but no request-identity bridge or schedule reader.
Legacy Codex lifecycle reporting depends on
`WMUX_WORKSPACE_ID`, `WMUX_TAB_ID`, and `WMUX_PANE_ID`; the documented live
daemon test lacked all three. New source wiring does not yet establish native
acceptance of BND-05.

## Gap-closing work in progress

The matrices below remain acceptance statuses, not claims that source-only
repairs have passed native/browser regression cases. The following additions
are not in the deployed baseline:

- The approved naming replacement persists wmux-owned semantic titles privately
  only after atomic server acceptance of eligible automatic wmux surfaces. It neither
  reads nor writes Codex saved names. The former native provenance/release flow,
  including the `wmux: resume automatic naming` prompt, is not a supported
  feature of this scope. Historical ownership/release tests remain historical;
  the replacement's focused tests and native evidence are recorded above.
- [`codex-rpc.mjs`](../plugins/wmux/scripts/codex-rpc.mjs) connects to an existing
  owner-only local Unix App Server socket and exposes only bounded `thread/read`
  and metadata-only `thread/turns/list` for one explicit thread. It cannot
  resume/queue/start a turn, rename a thread, or answer native server requests.
  A reproducibly bundled MIT-licensed `ws` dependency keeps the installed plugin
  independent of ambient npm packages. The root prompt hook now starts it through
  [`wmux-observer.mjs`](../plugins/wmux/scripts/wmux-observer.mjs).
- [`codex-lifecycle.mjs`](../plugins/wmux/scripts/codex-lifecycle.mjs) brackets a
  bounded turn-page read with native thread-status reads, requires exact root/
  session-tree/turn identity, and reports generic active/attention or an exact
  terminal outcome conservatively. Idle alone is not completion; identity or
  status uncertainty is not success. The observer polls every two seconds;
  [`codex-lifecycle.ts`](../src/server/codex-lifecycle.ts) validates the receipt,
  exact native turn, and monotonic sequence before using `AgentSessionService`.
  Its five-second sweep withdraws confidence after 30 seconds without an
  authoritative sample, including revoked receipts whose old run remains latest.
  Stale never creates a terminal outcome, and cannot overwrite a replacement run.

### Lifecycle wiring verification, 2026-09-06

- Final prompt-turn gate: `npm run check` passed (1,070 passed, 4 skipped,
  0 failed), including type checks, script validation, and production build.
  The new browser spec is assigned to the browser-only capability group.
  A separate fresh-context review and focused 36-test lifecycle/binding/observer
  run found no remaining blocking defect in the implemented prompt-turn path.
  Plugin manifest validation and whitespace checks passed. At this earlier
  checkpoint the changes were uncommitted and undeployed; the later native
  evidence and publication checkpoint above supersede that work status.
- [`codex-observer-integration.test.ts`](../test/codex-observer-integration.test.ts)
  exercises the production hook's automatic detached observer, private Unix
  WebSocket transport, live PTY marker binding, real wmux HTTP/state/timeline,
  running → approval waiting → completed, and sibling isolation. Only the native
  App Server responses are fixtures. No naming tool or native control call is used.
- [`codex-sidebar-lifecycle.spec.ts`](../e2e/codex-sidebar-lifecycle.spec.ts) passed
  on desktop and mobile Chromium: real receipt binding, changing Working marker,
  input `?`, actual watchdog timeout to static `! status unknown`, recovery, and
  completion. Screenshots were saved under `test-results/playwright/` and inspected
  for distinct symbols and readable status labels. This is browser-fixture evidence,
  not an updated native Codex deployment or complete reduced-motion acceptance.
- Read-only inspection of this task's seven private prompt-binding records found
  seven native `turn_id` values; all seven matched metadata returned by the installed
  Codex `0.153.4` App Server. Identifiers and receipts were not printed. The current
  [official hook contract](https://learn.chatgpt.com/docs/hooks) also specifies this
  field for `UserPromptSubmit`. Other versions must fail closed if it is absent.
- Fresh-context lifecycle review identified missing interruption notifications;
  native `interrupted` now uses the shared exact-once terminal notification gate.
  The real-state tests cover stale/recovery, native outcome preservation, revoked
  bindings, replacement activity, restart handling, and terminal immutability.
- **Open core work:** the observer currently exits after its bound prompt turn;
  goal/automatic continuations without a new root prompt hook are not tracked.
  Exact-turn reconciliation now searches at most four pages of eight native
  turn metadata records. Cursor cycles, duplicate IDs, malformed pages, and
  lookup exhaustion remain unknown, never inferred completion. Embedded-runtime observation,
  legacy-event coexistence, live server-restart/reconnect/child acceptance, and
  exact overlapping input/approval identities remain unresolved. These are not
  waived by the successful prompt-turn fixture path.

### Continuation ownership and bounded reconciliation follow-up

The installed native protocol exposes a new turn's thread and turn IDs, but
does not expose its originating terminal/controller identity or trigger in the
read-only turn metadata. `turnTrigger` is a `turn/start` request parameter, not
an observation field. A root thread with an active goal is therefore not proof
that a later turn belongs to the original wmux terminal: another terminal may
have resumed that conversation, and the original shell/pane may remain alive
after its Codex TUI exits. Fresh review rejected advancing the old receipt from
turn arrival alone because it would violate BND-02/BND-03. The prompt-turn
observer continues to stop after its exact terminal outcome. R09 remains open;
this is not permission to weaken the ownership requirements.

A supported continuation hook with exact identity and owner provenance, or an
equivalent native owner-generation API, would permit a safe continuation design.
Before declaring a definitive upstream blocker, live acceptance still needs
goal-hook/event ordering, same-thread cross-pane resume, TUI exit with a live
shell, and reconnect experiments. No resume, queue, or native control operation
has been substituted for read-only observation.

The [official paginated turn API](https://learn.chatgpt.com/docs/app-server)
supports reading older turn metadata without resuming the thread. The bounded
lookup follow-up passed 22 focused transport/lifecycle/observer tests and an
independent 12-test lifecycle rereview. A read-only probe against this task's
native root selected an exact turn beyond the first page and confirmed two
pages were read. Because the root was currently active on another turn, the
result correctly remained `unknown / turn_status_conflict`, with no terminal
claim. This validates native pagination wiring, not continuation ownership or
an older-turn completion under an idle root.

Initial observation failure is now visible as one receipt-bound static
`observer_stale` activity and system timeline entry. It does not fabricate a
native delegation, running state, outcome, or notification. Repeated unknown
samples do not renew confidence or duplicate the diagnostic. Valid stale leases
and initial diagnostics survive activity in other panes; revoked bindings cannot
report recovery. This closes the silent first-sample failure in the implemented
prompt-turn path, not every SET-03/platform setup case.

Final verification of this follow-up source passed `npm run check`: **1,076
passed, 4 skipped, 0 failed**, plus typechecks, script/contract validation, and
production build. These local checks cover the uncommitted iteration; remote
commit-based verification remains an integration gate. The updated desktop and
mobile Chromium sidebar test passed **2/2**, including initial status-unknown,
recovery to animated Working, input attention, real stale timeout, and completion.
Both initial-unknown screenshots were inspected. Fresh review passed **29**
focused tests with no blocking defect in this follow-up path. Logs:
`test-results/codex-lifecycle-reconciliation-check.log` and
`test-results/codex-lifecycle-initial-unknown-browser.log` (untracked artifacts).

### Current-state retention follow-up, 2026-09-06

A regression test reproduced a missing initial-unknown sidebar state after 305
unrelated activity events: the global 300-event history evicted the activity,
while correct observer duplicate suppression prevented re-emitting it. The
shared activity store now retains the recent 300 events plus the current event
for every extant layout pane. Retention is bounded by `300 + layout pane count`,
preserves newest-first order and existing IDs/timestamps, and does not imply
that a retained pane process is running. It creates no synthetic event,
delegation, notification, or timeline entry. Authoritative replacement releases
an old protected entry; pane/tab/workspace removal releases its current state.
No persisted shape or wire-contract change was required.

A second failing regression found that successive events from different
harnesses within one clock tick could move a pane's timestamp backwards, making
the browser select the old harness. New event timestamps now advance past all
retained events for the same pane, including older persisted cross-harness clock
skew. This aligns array order with the browser's timestamp-based current-state
selection.

Verification: **30 focused tests passed**, covering initial uncertainty,
duplicate suppression, persistence reload, recovery and exact-once terminal
notification, replacement, disposal, and retention of 301 panes with mixed
Prime/OpenCode states under 610 further events. The new regression cases failed
before their respective fixes. Independent retention review found no blocking
issue. Desktop/mobile Chromium browser tests passed **2/2** after 305 unrelated
events and browser reload, then exercised Working, attention, watchdog stale,
recovery, and completion. Fresh original-resolution visual review confirmed
both screenshots retain the distinct `!` and `status unknown` text without
overlap. These are receipt-driven browser fixtures, not native CLI acceptance.

The final `npm run check` passed **1,079 tests, 4 skipped, 0 failed**, plus all
typechecks, script/contract validation, and the production build. The browser
retention run preceded the separate pane-clock correction; the final source's
clock behavior is covered by its regression and full check. Evidence logs are
`test-results/codex-activity-retention-focused.log`,
`test-results/codex-activity-retention-final-check.log`, and
`test-results/codex-activity-retention-browser.log`; screenshots named
`codex-retained-unknown-sidebar.png` are under the corresponding ignored
Playwright output directories. Changes remain uncommitted and undeployed;
native naming and continuation/request-identity blockers remain open.

### Real native acceptance: lifecycle works; naming guard fails, 2026-09-06

Two different native checks changed the next implementation decision:

1. A retained, task-owned ordinary Codex session on the existing deployment ran
   an explicitly requested two-turn goal. Both native turns completed, but only
   the initial user-prompt turn had a matching private prompt receipt. The
   automatic continuation did not. After normal EOF exit, Codex displayed its
   disconnect/resume hint and the shell prompt returned. Read-only native status
   remained `idle`, and the old receipt still resolved to the live shell pane.
   The parent workspace title stayed unchanged. Thus neither a live pane nor a
   still-resolving receipt proves that the original Codex TUI remains attached.
2. A separate owner-private runtime profile installed the current source plugin
   using `codex plugin add`, with an isolated native Unix-socket App Server and
   loopback wmux service. Both independent parent/child panes launched the exact
   command `codex`. Repository trust and the two reviewed plugin hooks were
   accepted through the native UI; MCP naming approvals were scoped to the test
   sessions. The ordinary account's plugins, trust settings, wmux deployment,
   and shared App Server were unchanged. The test profile reported a native
   warning that helper aliases are unavailable under `/tmp`; this is isolated
   native evidence, not full acceptance of the normal installed profile or every
   native tool capability.

The updated automatic observer reported real root activity before the naming
tool ran, then `waiting` with `approval` while its native MCP permission dialog
was open, `running` after resolution, and `completed` after the actual outcome.
The independently opened child had its own native thread, receipt, lifecycle,
workspace, and title; its approval/completion did not change the parent's native
turn. The parent had three completed test turns and exactly five notifications
(three outcomes, two approval occurrences); the child had one outcome and one
approval notification. No lifecycle event was manually injected. A canceled
parent sync approval also returned to Working and then completed normally.

Real desktop and mobile browser captures showed `? waiting`, the Working glyph
and label, and `✓ done`, driven by those native events. Artifacts are the
untracked `test-results/native-{desktop,mobile}-{waiting,running,completed}.png`.
These captures do not yet prove a measured five-second transition SLA, a
continuous ten-second animation assertion, reduced motion, native loss recovery,
or strict no-tool-turn acceptance. The attempted no-tool prompt still triggered
the hook's higher-priority sync instruction; its canceled tool request makes it
a naming-failure independence test, not a clean no-tool test. One late browser
Working capture timed out after that earlier turn had already completed; a
later capture observed actual running state without restarting native work.

**Historical native-canonical naming failure.** In the fresh parent, Codex
independently generated `Plan a fair book exchange` before the model's requested
`Fair Community Book Exchange` tool was approved. No user had renamed the
session. The provenance guard refused the model's title as unknown-origin,
returning the misleading text “Codex saved name is user-owned.” On a major shift
to garden-volunteer onboarding it also refused `Welcoming New Garden Volunteers`,
leaving the book-exchange title in both native storage and wmux. The child showed
the same problem: native `Plan a simple maintenance checklist` was preserved
instead of the requested `Community Rain Barrel Care`. Mirroring and isolation
worked, but agent-selected naming and task-shift acceptance did not. This is not
the acceptance result for the selected wmux-owned replacement; that replacement
still requires a fresh semantic naming and ownership rerun.

Read-only investigation of installed `0.153.4` generated schemas found no
title-origin field in `Thread`, `ThreadNameUpdatedNotification`, or
`ThreadSetNameParams`, and no naming control in `ThreadSettingsUpdateParams`.
`codex features list` provided no automatic-thread-title toggle. The
[official config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [config schema](https://developers.openai.com/codex/config-schema.json) expose
no supported automatic saved-title disable; `tui.terminal_title` concerns terminal
rendering instead. Native automatic titles and explicit native renames are
indistinguishable through these supported interfaces. Do not solve this by
silently treating an unknown name as automatically owned. A safe canonical-name
implementation needs native title provenance or a supported automatic-title
disable. The user instead selected the wmux-owned-name fallback: it leaves those
native names untouched. Its subsequent scoped NAM-01/NAM-03 evidence is recorded
in the fresh wmux-owned native acceptance section above.

### Native lifetime-hook probe, 2026-09-06

A separate reviewed diagnostic plugin recorded only hook type, native
session/turn IDs, source/reason, timestamp, and whether pane environment existed.
It did not read transcripts, retain prompts, answer approvals, or drive native
threads. The corrected test used the explicit raw-PTY fixture machine and
verified its temporary `HOME` and `CODEX_HOME` before startup and cross-pane
resume. This is a probe, not a shipped lifecycle implementation.

The new root started with plain `codex`. For a short exact-response prompt, the
native TUI made no model tool calls and wmux recorded `running → completed`.
The hook sequence was `SessionStart(startup) → UserPromptSubmit → Stop`; every
hook lacked pane environment. This closes the basic no-tool dependence question,
not R08's ten-second animation/timing assertion. The historical native-name
sync behavior is not part of the selected wmux-owned naming mode.

After the confirmed-idle TUI exited normally, read-only native metadata still
reported that exact root as loaded/idle. The first bounded hook-log inspection
had no `SessionEnd`; a later one in the detach/reopen sequence did. The exact
root was reopened with native `codex resume UUID` in a different raw-PTY pane.
At its first subsequent user turn, `SessionStart(source=resume)` was recorded
19 ms before `UserPromptSubmit`, followed by `Stop`. No resume hook was recorded
at the initial idle display before that prompt. This is evidence that supported
hooks may establish an ownership epoch before resumed work; it does not yet
prove ordering for queued/goal continuations, concurrent clients, delayed old
hooks, compaction, or failures. No old receipt is being advanced speculatively
to a new turn. Independent design review and decisive race tests remain needed.

Fresh independent review confirmed that this sequential trace does not establish
a per-client ownership generation or cross-client ordering guarantee. A delayed
old `SessionEnd`, an untrusted/failing hook, and `SessionStart(source=compact)`
must not permit successor-turn takeover. The next probe should retain field
names and allowlisted identity metadata (not full prompt/transcript payloads)
across concurrent clients, then test delayed teardown against resume. A
conservative root revocation is safer than advancing a receipt, but can still
withdraw a valid new binding and is not complete handoff support.

The resumed no-tool turn completed natively, but its new pane received no wmux
lifecycle/title update while the old pane was still live. This is the current
same-session cross-pane fail-closed policy, not successful R14 handoff. Closing
the old pane and re-prompting, concurrent-client races, and automatic continuation
ownership remain separate acceptance work.

One earlier probe run was rejected: the fixture's default local tmux pane
inherited the ordinary account environment despite displaying the temporary
cwd. It is not isolated acceptance. Its bounded test thread completed and the
TUI was exited; the task-created temporary project trust and four diagnostic
hook-trust entries were removed from the ordinary profile, which was parsed
successfully afterward. Its metadata-only log was moved into ignored local
test artifacts. Future tests must verify the actual profile, not infer it from
cwd or fixture-service environment. No shared daemon restart occurred.

After these probes, the native test turns were verified idle and their TUIs
exited normally. All four fixture workspaces were closed, the isolated wmux
server and native daemon stopped, and their temporary runtime profile (including
the copied authentication file) was removed. Sanitized metadata and private
local sidebar captures remain in ignored `test-results`; they are not a running
demonstration or public screenshot assets. The ordinary wmux and native Codex
services remained active. No production code changed during this probe phase;
the prior full check remains the runtime gate, not proof of the failed native
naming requirements.

### Sanitized native observation evidence, 2026-09-06

On 2026-09-06, the source transport and lifecycle adapter were run against
the already-running native Codex `0.153.4` daemon and this authorized task's
explicit root thread. The bounded, read-only result was:

```json
{"mode":"read-only existing daemon","root":true,"state":"active","attention":null,"reason":null,"turnMatched":true}
```

The test initialized a separate observation connection, read the explicit thread
and current turn metadata, applied the adapter, then closed only that connection.
No native thread was resumed, queued, driven, renamed, or answered. This proves
native Unix-socket interoperability and active-turn observation, not plugin
startup, wmux event delivery, liveness deadlines, or browser animation. Private
identifiers, paths, prompts, hook markers, and credentials are omitted.

The installed generated protocol and official [App Server documentation](https://learn.chatgpt.com/docs/app-server)
support runtime status and paginated turn reads. There is no pending-request
snapshot/read-only subscription method in the inspected `0.153.4` request union;
`thread/resume` may execute pending input and is not an observation substitute.
Aggregate `waitingOnApproval` / `waitingOnUserInput` flags cannot reconstruct
answerable native request identities. A shared daemon also cannot establish the
live status of an independently embedded TUI merely by reading its disk history.
Those remaining interface gaps are not waivers of INP or ACT requirements.

### Foundation verification and review

- `npm run check`: **passed**, 1,052 tests passed, 4 skipped, 0 failed; TypeScript,
  generated contracts/hooks/dependency-bundle validation, and production build
  completed. The first run exposed two existing test fixtures whose `mkdir`
  modes were filtered by umask `077`; the fixtures now explicitly `chmod` their
  intended unsafe directories, without changing production permission checks.
- Historical focused ownership/RPC/lifecycle review evidence includes
  `npm run check:scripts`; its native-clear, ownership-release, and native-pin
  cases apply to the superseded native-canonical design and must not be counted
  as verification of wmux-owned naming.
- Plugin manifest validation and `git diff --check`: **passed**.
- A separate fresh-context reviewer inspected the actual code and protocol
  schemas. Native-name provenance and one-shot release findings belong to the
  superseded design; lifecycle future-flag diagnostics remain relevant.
- **Not deployed or fully accepted:** wmux-owned naming startup/ownership tests,
  lifecycle publishing, binding-generation ordering, stale deadlines, and
  desktop/mobile indicator acceptance remain open. Do not upgrade R05, R08,
  R15, R17, or R21 to passed based on these fixture/foundation checks.

## Requirement-to-case coverage (all 45 normative IDs)

Status below is for this Codex port, not for wmux generally. `— optional` means
the requirement applies only when the capability is claimed; the named case is
still retained so the requirement cannot disappear from planning.

| Requirement | Cases | Current Codex status and evidence gap |
| --- | --- | --- |
| SET-01 | R01 | Partial — ordinary CLI and source-only integration are documented/live-observed; repeatable outside-wmux non-mutation proof is absent. |
| SET-02 | R23 | Partial — guide documents trust/approval/reload; update/cache/unrelated-hook acceptance is absent. |
| SET-03 | R01, R18 | Partial — expiry/error paths are bounded in code; no live unbound/degraded UX acceptance. |
| SET-04 | R24 | Partial — limitations are disclosed in both Codex docs, but no version/OS/mode support table with tested negatives. |
| BND-01 | R14, R15 | Partial — fixtures and isolated real parent/child approval/completion show independent lifecycle; full resume/concurrent-client acceptance open. |
| BND-02 | R17, R20 | Partial — expiry, supersession, pane invalidation, and replacement tests exist; no live durable restart/recycle acceptance. |
| BND-03 | R14, R20 | Partial — concurrent same-session panes fail closed in tests; valid handoff and full live simultaneous-view acceptance absent. |
| BND-04 | R16, R20 | Partial — redraw/conflict safeguards tested; live observer-marker conflict occurred, so redacted-observation recovery needs acceptance. |
| BND-05 | R15 | Partial — isolated native source plugin uses the shared receipt for names and lifecycle without pane environment; full profile/platform acceptance open. |
| NAM-01 | R02, R04 | Partial — isolated native daemon evidence covers fresh first-task and material-shift wmux titles with native names untouched; historical native-canonical failures remain historical, and broader acceptance is open. |
| NAM-02 | R02, R19 | Partial — `wmux-owned-name` native slice confirms no native set/read while title acceptance precedes persistence; bounded storage and fault recovery have fixture evidence, but broader recovery acceptance is open. |
| NAM-03 | R03, R04, R36 | Partial — fresh native follow-up preserved the stored title and material shift replaced it; compaction/contextual-refresh acceptance remains open. |
| NAM-04 | R05, R06 | Partial — isolated native evidence confirms native names are untouched and a manual workspace pin blocks only that surface; fresh split/reorder coverage remains open. |
| NAM-05 | R05 | Partial — native UI `/rename` remained independent in the isolated fixture; no native mirroring is supported, and broader idle/change acceptance is inapplicable to this scope. |
| NAM-06 | R07 | Partial — native manual-workspace/automatic-tab outcome and source ownership exist; split/tab/reorder live assertions remain absent. |
| NAM-07 | R03 | Partial — plugin auto-only policy and legacy `--no-title` guidance exist; no coexistence acceptance. |
| NAM-08 | R06, R19 | Partial — focused fixtures cover fallback-specific 409, 503 delivery uncertainty, and post-acceptance local-store failure; isolated native evidence confirms manual-pin result flags. Native write results are inapplicable. |
| ACT-01 | R08, R09, R15 | Partial — isolated native daemon evidence shows receipt-bound running/waiting/completed publication and same-pane resume; deployment, cross-pane handoff, and non-prompt continuations remain open. |
| ACT-02 | R09, R11 | Partial — native-turn/receipt sequence pipeline and terminal gate tested; broader continuation ordering open. |
| ACT-03 | R08, R25 | Partial — browser animation fixture and short real no-tool lifecycle pass; native ten-second animation/timing acceptance open. |
| ACT-04 | R17, R21 | Partial — two-second polling, 30-second stale watchdog, browser timeout/recovery fixtures pass; native loss/restart open. |
| ACT-05 | R07, R35 | Partial — receipt-bound per-pane lifecycle and shared aggregation fixtures pass; mixed native panes/descendants still need acceptance. |
| ACT-06 | R10, R11 | Partial — exact turn terminal notifications tested; native request-identity attention deduplication missing. |
| UI-01 | R25 | Partial — isolated native desktop/mobile static captures show waiting/running/completed indicators; browser fixture dynamic-animation assertions pass, while continuous native animation/reduced-motion acceptance is open. |
| UI-02 | R35 | Partial — generic aggregation is source-backed; no Codex sibling/descendant event evidence. |
| INP-01 | R10, R26, R27 | Partial — isolated native evidence distinguishes aggregate approval and input attention; no request identity/event adapter or browser answer path exists. |
| INP-02 | R10, R26, R27 | Partial — native aggregate `waiting: input` is observed, but there is no pending-request set or exact request reconciliation. |
| INP-03 | R28, R29 | Unclaimed optional — no structured Codex browser answers. |
| INP-04 | R28, R38 | Unclaimed optional — no typed Codex reply bridge or recovery model. |
| HBT-01 | R30, R34 | Unclaimed optional; R34 still needs a negative acceptance proving no false heart from daemon/queue/host heartbeat. |
| HBT-02 | R31 | Unclaimed optional — no Codex schedule state exists. |
| HBT-03 | R30, R33 | Unclaimed optional — no schedule watcher/reconciliation exists. |
| HBT-04 | R32 | Unclaimed optional — no root/descendant schedule membership exists. |
| HBT-05 | R30, R31 | Unclaimed optional — no schedule-only publication path exists. |
| SES-01 | R12 | Partial — isolated native parent/child evidence confirms separate semantic wmux titles, untouched native names, and lifecycle/notification isolation; cwd/direct-link and cross-pane-resume assertions remain. |
| SES-02 | R13 | Partial — root-only instruction is explicitly not an authorization boundary; no native subagent event policy. |
| SES-03 | R14 | Partial — same-pane native resume/fresh-binding sync is verified; handoff and concurrency acceptance remain incomplete. |
| SES-04 | R16, R17 | Partial — bindings are in-memory and invalidated on lifecycle replacement; browser/service recovery acceptance missing. |
| SES-05 | R22 | Partial — implementation does not intentionally close the TUI on Stop; ordinary exit/pane-close/shared-daemon live checks absent. |
| EXT-01 | R36 | Unclaimed optional — next-prompt sync only; no idle subscription/contextual refresh. |
| EXT-02 | R37 | Unclaimed for this plain-start plugin — wmux delegation is a different surface and must not be used as evidence. |
| EXT-03 | R29, R38 | Unclaimed optional — no Codex browser bridge. |
| SEC-01 | R01, R18, R23 | Partial — helper-only routes, private receipt storage, credential precedence, URL checks, and fixture auth tests exist; platform/deployed credential acceptance is absent. |
| SEC-02 | R14, R17, R20 | Partial — bounded IDs/records/TTLs, fail-closed resolution, and current-state retention stress/reload fixtures pass; live restart acceptance remains open. |
| SEC-03 | R10, R18, R23 | Partial — real native MCP approval, cancel, and completion observed without observer responses; login and overlapping-request acceptance remain. |

## R01–R38 evidence and acceptance matrix

“Next acceptance” is deliberately an assertion set, not merely “run a test.”
No entry marked Partial or Missing may be promoted based only on fixtures.

| Case | Current status | Evidence / source anchor | Next acceptance needed |
| --- | --- | --- | --- |
| R01 | Partial | Plain `codex` live evidence; plugin docs; hook source. | Fresh install/trust, plain CLI, then native outside wmux; prove no unrelated mutation and bounded unbound diagnostic. |
| R02 | Partial | Isolated native daemon fixture: first substantive wmux title applied to workspace/tab while native automatic name remained untouched. | Repeat under clean installation/trust and model variation; assert no unrelated mutation. |
| R03 | Partial | Isolated native follow-up used a fresh binding and retained its wmux-stored title. | Assert Stop while tools run and compaction behavior. |
| R04 | Partial | Isolated native material objective shift replaced wmux title while native name remained untouched. | Repeat before terminal outcome and across model variation. |
| R05 | Partial | Isolated native UI `/rename` remained independent of wmux-owned title behavior. | Cover idle/native-name changes without a manual workspace pin; native mirroring is inapplicable. |
| R06 | Partial | Isolated fixture manually pinned workspace, then applied automatic tab title with exact `workspaceApplied: false`/`tabApplied: true`. | Independently pin workspace and tab; assert no reverse sync. |
| R07 | Partial | Deterministic source ownership in `state.ts`. | Browser split/tab/reorder/remove owner test with activity invariant. |
| R08 | Partial | Automatic observer wiring, browser animation fixtures, and short isolated native no-tool running/completion pass. | Native no-tool turn ≥10 s; measure desktop/mobile state and latency. |
| R09 | Partial | Prompt-turn observer exists; non-prompt continuations remain untracked. | Implement and test tool/retry/compaction/goal continuation correlation. |
| R10 | Partial | Isolated native fixture distinguishes approval from `waiting: input`, with corresponding notifications; no request IDs or browser response exists. | Native approval/login/question overlap identity, exact-once attention/notification acceptance, and no-response bridge boundary. |
| R11 | Partial | Sequence rejection and real-state terminal/notification immutability tests pass. | Native duplicate/out-of-order/start-old-Stop/new-turn acceptance. |
| R12 | Partial | Isolated native parent/child fixture records separate wmux semantic titles, untouched native names, and independent approval/completion sequences. | Child/parent direct links and cwd together with same-pane resume. |
| R13 | Partial | Root-only instruction only. | Native internal-subagent instrumentation; prove no root title/outcome side effect. |
| R14 | Verified (same-pane scope) | Isolated native daemon fixture: normal TUI exit, plain `codex`, native same-pane `/resume`, then fresh-binding sync preserved wmux title, user pin, and native name through completion. | Cross-pane move/handoff, concurrent views, and explicit safe recovery remain separate fail-closed acceptance work. |
| R15 | Partial | Isolated plain-`codex` daemon parent/child fixture used shared receipt-bound naming/lifecycle and recorded independent activity. | Repeat with absent pane environment explicitly asserted, plus resume/concurrent-client coverage. |
| R16 | Partial | Parser rejects replay takeover; binding design. | Two browsers/reload/replayed output while work runs; prove no side effects or ownership change. |
| R17 | Partial | Pane replacement invalidation tests. | Durable wmux restart/recycle during active Codex; fresh binding, stale deadline, no old callback. |
| R18 | Partial | Failure result fields, TTLs, no broad-auth fallback tests. | Lost network/expired credential/API unavailable/model skip live UX and native usability. |
| R19 | Partial | Focused wmux-owned fixtures cover 409 rejection, 503 title-delivery uncertainty, and injected post-acceptance local-store failure; the historical native-write fixture is superseded. | Exercise recovery across an actual process restart and verify no native access. |
| R20 | Partial | Chunking, redraw, expiry and conflict tests; live observer conflict. | Isolated conflict injection plus separately redacted real observation and clean recovery. |
| R21 | Partial | Browser fixture proves watchdog stale/recovery; native connection-loss fixtures report uncertainty. | Disconnect actual native source; stale ≤45 s and authoritative reconnect reconciliation. |
| R22 | Partial | General backend behavior only; Codex guide says no TUI replacement. | Ordinary TUI exit, explicit pane close, and one-shot behavior, including shared-daemon peer survival. |
| R23 | Partial | Installation guide; plugin config tests. | Update/cache/missing-trust/unrelated-hook matrix with exact recovery/reload diagnostics. |
| R24 | Partial | Linux-only and unsupported modes disclosed in both Codex docs. | Published support table exercised on unsupported OS/API/runtime, with honest UI/diagnostic. |
| R25 | Partial | Isolated native desktop/mobile static captures show waiting/running/completed; separate browser fixture has 2/2 dynamic-animation assertions. | Native continuous animation, transition timing, reduced-motion and accessibility assertions. |
| R26 | Missing | No request adapter. | Exact overlapping root/descendant request lifecycle after implementation. |
| R27 | Missing | No request adapter. | Same native ID but different kind isolation and native-only permission assertion. |
| R28 | Unclaimed optional | No Codex answer bridge. | Only if claimed: typed API, ordering, idempotency, no pane input, ambiguous-delivery test. |
| R29 | Unclaimed optional | No Codex answer bridge. | Only if claimed: unsupported/stale/child/broker failure leaves terminal usable. |
| R30 | Unclaimed optional | No schedule publisher. | Only if schedule is claimed: authoritative create/cancel/consume/re-register without prompt. |
| R31 | Unclaimed optional | No schedule publisher. | Only if claimed: working/question/terminal precedence over heart. |
| R32 | Unclaimed optional | No schedule publisher. | Only if claimed: root/descendant generation/reuse aggregation isolation. |
| R33 | Unclaimed optional | No schedule publisher. | Only if claimed: malformed schedule becomes unknown/stale, not false state. |
| R34 | Partial | No Codex schedule publisher observed, but no negative live test. | Demonstrate daemon, queue, sleep, liveness, and host heartbeat never set the agent heart. |
| R35 | Partial | Shared aggregation implementation only. | Codex lifecycle siblings/collapsed descendant/focus browser test. |
| R36 | Unclaimed optional | Documentation says next eligible prompt only. | If idle sync is advertised later, native ownership and stability interval acceptance. |
| R37 | Unclaimed optional | Delegation is out of plain-start scope. | If plugin adds it, authorization/timeout/cancel/close matrix; do not borrow wmuxctl evidence. |
| R38 | Unclaimed optional | No Codex question/reply bridge. | If claimed, restart/reconnect at every reply exposure boundary without replay. |

## Ordered work packages to close Codex gaps

1. **Lifecycle binding foundation (blocks core conformance).** Extend the
   receipt-bound protocol—not environment-only legacy hooks—to carry an exact
   session, turn, binding generation, native lifecycle event, and liveness
   observation into `AgentSessionService`. Ensure native event metadata is
   validated, duplicate-safe, bounded, and cannot select a pane by focus/cwd.
   Add deterministic source/service tests before live daemon work. This closes
   the implementation gap behind BND-05, ACT-01/02, and enables R08–R11/R15/R21.

2. **Lifecycle correctness, stale handling, and chrome acceptance.** Define the
   native Codex event mapping for accepted/running/retry/attention/completed/
   failed/interrupted, a ≤15-second reconciliation interval, and ≤45-second
   stale state. Preserve per-pane aggregation and exactly-once notifications.
   Then run real embedded and shared-daemon R08–R11, R15, R21, R25, and R35 in
   desktop/mobile/reduced-motion contexts. Do not claim generic wmux UI tests
   as Codex proof.

3. **wmux-owned naming acceptance.** Verify private persistent semantic-title
   storage, clean first-task naming, follow-up stability, material shifts,
   workspace/tab pins, layout-owner movement, and store/mirror recovery. Assert
   that no naming or sync action reads or writes a native Codex saved name and
   that native `/rename` remains independent. Historical native-canonical tests
   must be reported separately, not repurposed as success. This package targets
   R01–R07, R14, R18–R20, R23–R24 within the declared fallback.

4. **Recovery, children, and platform matrix.** Exercise durable wmux restart,
   reload/two-browser replay, pane recycling, explicit closure, visible child,
   resume/move/concurrent ownership, and real approval/login failure paths.
   Repeat applicable cases on Linux embedded and shared daemon first, then macOS,
   SSH, and Windows only when native plugin/privacy support is implemented. This
   package closes the unverified portions of R12–R18 and R22.

5. **Optional capabilities only after core lifecycle works.** Explicitly decide
   whether Codex will claim structured browser questions, schedule hearts, idle
   native-name subscription, or delegation. For each claimed feature implement
   its authoritative native source and complete its corresponding R28–R38
   tests; otherwise retain the explicit unclaimed record. R34's anti-fabrication
   test remains required even with no schedule capability.

6. **Evidence gate and documentation maintenance.** Update this matrix and the
   current conformance record after each completed package with sanitized,
   timestamped native evidence, authoritative wmux state, and required browser
   observation. Run focused tests plus `npm run check` for runtime changes; do
   not call the unmerged `d91883a` deployment complete until its matching commit,
   tests, and live acceptance are recorded.

## Link and ID validation

This document intentionally names every normative requirement from SET-01
through SEC-03 (45 total) and every stable regression case R01 through R38
exactly in the coverage/acceptance matrices. Relative source links point only to
tracked files at the inspected baseline. Validation should check those targets,
the 45 requirement IDs, all 38 case IDs, and the contract anchor before merge.
