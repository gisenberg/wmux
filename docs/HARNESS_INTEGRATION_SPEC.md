# Harness integration behavior contract

Status: normative target, revision 1.1, 2026-09-06. This specifies what a complete
wmux integration must do; it does **not** certify that any existing adapter
already does all of it. The [conformance record](#current-conformance-record)
separates observed behavior, gaps, and untested capabilities.

This contract covers Codex, Prime Agent, OpenCode, Claude, and future agent
harnesses. Harness-specific installation instructions and implementation designs
must reference it instead of redefining user-facing behavior. MUST requirements
are acceptance gates; SHOULD requirements permit documented tradeoffs. Optional
capabilities must be explicitly declared and tested before being advertised.

## What the user should expect

After one-time installation, authentication, hook trust, and tool approval:

1. Open a wmux terminal and run the harness's normal command, such as `codex`.
   No special launcher, replacement binary, extra startup flags, or per-task
   naming prompt is necessary.
2. Describe a task. The agent chooses a meaningful task name, visible in its
   owned tab and, when it owns that shared surface, the sidebar workspace.
   Other sessions retain their names in session details. “Testing that now”
   does not replace the task name.
3. See Working while the agent is actually doing the task, including reasoning
   without tool calls. See a gold `?` when it needs a real decision or input,
   and see completion, failure, or interruption when that turn ends.
4. Follow-ups keep the name. A genuinely different objective gets a new name.
   A name explicitly chosen by the user remains theirs.
5. Resume a conversation without losing its saved name or sending updates to
   an old terminal. Independently opened child sessions describe their own work
   and do not rename or complete their parent.
6. Refresh the browser or reconnect without restarting the agent, duplicating
   notifications, or changing title ownership. Unsupported or disconnected
   integration features are reported honestly; the native terminal stays usable.
7. Where scheduled agent wake-ups are supported, see a red heart pulse while
   idle with a verified active schedule, then Working during the actual wake-up
   turn. The heart does not mean the agent is currently thinking or merely online.
8. Where structured browser questions are supported, answer the exact question
   through the browser without simulated terminal typing. Permission prompts and
   unsupported question formats remain in the native harness.

“Session name” in this document means the harness's saved conversation name.
“Sidebar title” means the wmux workspace name, **not** just the tab, terminal OSC
title, descriptor, or shell process name. In shared workspaces the ownership
rules below determine which session supplies each shared title.

## Scope, authority, and installation

- **SET-01 — Plain startup.** All authored integration code MUST belong to wmux.
  Use supported harness plugins, hooks, tools, and public APIs. Do not patch
  harness source/binaries or write its session database/transcripts directly.
  Normal plugin installation may create the harness's supported config/cache
  records. An optional wmux delegation launcher must not be required for the
  ordinary interactive integration to work.
- **SET-02 — Repeatable setup.** Installation/update MUST preserve unrelated
  configuration and disclose required versions, dependencies, trust/approval
  steps, matching server updates, and which process must reopen to load them.
  Do not bypass approval or restart shared harness services merely to install a
  plugin. Successful installation is not evidence that hooks or MCP are active.
- **SET-03 — Optional presence.** Without a wmux binding, integration operations
  MUST leave other workspaces and saved names untouched and allow native use.
  A binding probe may expire harmlessly. Failure diagnostics must be bounded,
  not a repeated modal or an obstacle to completing the user's native task.
- **SET-04 — Capability honesty.** Publish per-platform, per-runtime-mode support
  for startup, binding, naming, lifecycle, attention, reconnect, and optional
  features. A naming-only adapter MUST NOT be advertised as complete integration.
  Missing environment propagation in a supported daemon mode is an adapter gap,
  not a requirement that the user start a different command.

## Identity and session boundaries

An adapter needs a stable harness/profile identity, an explicit conversation ID,
a distinct turn/run identity, and a validated wmux workspace/tab/pane binding
with a freshness generation. These are logical concepts, not a new wire schema.
Existing contracts remain in `src/shared/protocol.ts` and server-owned services.

- **BND-01 — Exact target.** Resolve identity from supported session-scoped
  metadata or an authenticated wmux binding protocol. Browser focus, cwd,
  “latest session,” similar prompts, process timing, and parent environment alone
  MUST NOT select a target. A shared daemon is not one shared pane identity.
- **BND-02 — Freshness.** Validate binding before every side effect. Resume,
  backend replacement, pane disposal, expiry, and server restart must invalidate
  obsolete authority. Re-establishment MUST reject callbacks from the old
  generation even if a pane ID or native request ID is reused.
- **BND-03 — Ambiguity.** Concurrent views of the same saved conversation MUST
  use a supported explicit owner protocol or fail closed. Never let arrival
  order choose between workspaces. Document the safe recovery action; no global
  title reset, unrelated pane closure, or broad session search is acceptable.
- **BND-04 — Observation is not authority.** Terminal replay, screenshots,
  transcripts, and another pane displaying diagnostic output MUST NOT acquire
  write authority. Same-pane redraw must be idempotent. A conflicting live
  marker may invalidate a binding, but must never transfer it. Controllers and
  tests MUST redact live binding markers before echoing observed output into
  another wmux terminal; report this failure mode in the adapter's diagnostics.
  The sole testing exception is deliberate R20 conflict injection between
  isolated, disposable test panes, never an observer or user-work pane. This is
  a negative test, not an acceptable normal observation path.
- **BND-05 — One binding model.** Naming, lifecycle, attention, notifications,
  and any optional helper operations MUST agree on the same exact identity.
  Adding a daemon-safe naming path while retaining environment-only lifecycle
  routing does not satisfy this contract.

## Naming and ownership

- **NAM-01 — Semantic naming.** On the first substantive objective, the agent
  MUST choose a concise, task-level title, normally 3–7 words and no more than
  80 characters. It must describe the objective rather than mechanically copy
  the newest prompt. Greetings need not generate a name. Hook instructions may
  trigger naming, but copying/truncating prompts is not semantic generation.
  On a healthy, approved integration, naming and mirroring MUST complete within
  that first substantive turn, before its terminal outcome. A pending approval
  or unavailable integration must be reported as pending/degraded, not a pass.
- **NAM-02 — Canonical value.** Where supported, the saved harness name MUST be
  canonical: set through the supported API, read the accepted value back, then
  mirror that value. Do not use a preview or an old TUI exit hint as the oracle.
  Harnesses without a saved-name API must declare a `wmux-owned-name` fallback;
  they must not claim native-name synchronization. Naming must not start a model
  turn, resume another conversation, or mutate an unrelated profile.
- **NAM-03 — Stability.** Follow-ups, tests, clarifications, status questions,
  retrying a failed tool, and compaction MUST preserve a still-accurate name.
  A material objective change or substantial correction to task understanding
  MUST produce a new semantic name within that originating turn, before its
  terminal outcome, unless an explicit user name takes precedence. Judge a shift
  by whether the previous title still accurately describes the requested
  deliverable: adding a regression case to the same plan is a follow-up;
  finishing that plan and starting a community event plan is a material shift.
  Store this expected classification with each semantic test fixture.
- **NAM-04 — User ownership.** An explicit native rename MUST suppress subsequent
  automatic native renaming until the user releases that choice. A manual wmux
  title MUST block automatic writes to that surface, independently for workspace
  and tab. Mirroring a native name must not unpin wmux or push a wmux manual name
  back into the harness. Clearing a pin must be an explicit user action.
  Where native ownership signals are absent, use conservative provenance:
  treat an existing name of unknown origin, or a read-back value different from
  the adapter's last confirmed automatic name, as user-owned until explicit
  release. If an adapter cannot enforce preservation safely, it must declare
  that limitation and remain partially conformant; instructional best effort is
  not enforcement. For the declared `wmux-owned-name` fallback, native-name
  writes are disabled, native names remain untouched, and wmux pins provide
  explicit ownership. R05's native mirroring assertion is then not applicable,
  but its no-overwrite invariant and R06 still apply.
- **NAM-05 — Native rename latency.** A native rename MUST mirror by the next
  eligible prompt/sync. Idle event-driven synchronization is an optional stronger
  capability. The adapter must disclose which it supports. Never invent a fresh
  semantic title merely because a conversation was resumed.
- **NAM-06 — Shared surfaces.** The first pane in tab layout order owns that
  tab's automatic title. The first pane of the first tab owns the workspace's
  automatic title. Other panes retain independent names/activity without
  overwriting these shared labels. Ownership transfers deterministically after
  layout changes/removal; it is not based on browser focus or last event arrival.
  Manual pins survive automatic-owner transfer.
- **NAM-07 — Separate producers.** Descriptors may summarize recent activity;
  lifecycle hooks MUST NOT replace the task title with a prompt or completion
  summary. Legacy and new integrations must not race as competing title writers.
- **NAM-08 — Truthful results.** Report saved-name set/read outcome separately
  from workspace and tab writes, including no-op, user-owned, not-owner,
  unbound/stale, and delivery failure where observable. A tab change alone is
  not success. If the native name changed but mirroring failed, retry reading
  and mirroring; do not roll back or rename again blindly. Unknown write outcome
  must remain unknown until read-back resolves it.

## Activity, attention, and completion

These are user-visible semantic states; adapters map native events into existing
wmux contracts rather than introducing independent client/server state enums.

| Native situation | Required wmux behavior |
| --- | --- |
| Native session open, no active turn | Idle; no Working animation just because a process exists |
| Turn accepted and executing | Working, including model reasoning, tool execution, compaction, and internal continuations |
| Recoverable provider retry/backoff | Retain the active turn; indicate retry detail, not a terminal failure |
| Explicit approval, login, question, or blocked input request | Attention with the actual reason; not ordinary completion or an unexplained spinner |
| Last outstanding attention request resolved, turn continues | Working resumes; an earlier overlapping request cannot clear a later one |
| Native turn completes | Working stops; completed outcome persists even if the TUI remains open |
| Explicit cancellation/interruption or terminal error | Working stops; interrupted/failed respectively, not successful completion |
| Transport/controller lost without an authoritative outcome | Unknown/stale integration status; do not infer success, idle, or failure from silence |
| Idle with an explicitly registered future wake-up | Optional scheduled indicator, distinct from Working; only while that schedule really exists |

- **ACT-01 — Native lifecycle.** Activity MUST be emitted automatically from
  native lifecycle observations, not depend on the model remembering to call a
  tool. A no-tool reasoning turn and a failed naming call still need activity.
  Prompt delivery/queue acknowledgment alone does not prove a turn ran.
- **ACT-02 — Correlation and ordering.** Associate events with a conversation,
  turn, and binding generation. Duplicate delivery has idempotent state effects;
  delayed start/Stop/tool events must not regress a terminal turn or finish a
  newer turn. A tool-loop end, child completion, or compaction is not root-task
  completion. Keep transition time distinct from liveness observation time.
- **ACT-03 — Visible progress.** On a healthy connected system, lifecycle and
  attention transitions MUST reach server state and the visible sidebar within
  five seconds of the native event. This is a revision-1 acceptance target,
  not a measurement of today's adapters. For a turn held active at least ten
  seconds, verify animation advances across frames, not just a static glyph.
  An accessibility reduced-motion mode may use an equivalent static Working
  label. Background browser throttling may suspend frames, not corrupt state.
- **ACT-04 — Loss detection.** A lifecycle-capable adapter MUST document a bounded
  liveness/reconciliation interval and a stale deadline. Baseline acceptance is
  reconciliation at most every 15 seconds and stale indication within 45 seconds
  of lost evidence. A connected native status source can supply this evidence;
  periodic model calls are neither required nor appropriate. Silence must not
  leave an indefinitely authoritative Working indicator.
- **ACT-05 — Independent aggregation.** Workspace activity aggregates its live
  sessions independently of title ownership. Attention takes visual priority
  over ordinary running work, but other running panes remain discoverable in
  details. Completion of one pane must not stop another pane's indicator.
  Nested workspaces retain their own states; any parent roll-up must identify
  child activity rather than falsely declaring the parent's native turn active.
- **ACT-06 — Notifications.** Attention and terminal transitions MUST produce
  at most one logical notification per occurrence under wmux's notification
  policy. Retries, reconnect, and history replay must not duplicate it. No
  notification for each tool call. Browser OS-notification denial must not hide
  in-app attention. Idle alone is never an explicit input request.

## Indicators and explicit user input

The shared chrome uses the following presentation vocabulary. Color names mean
theme roles, not hard-coded RGB values; color or animation alone is insufficient.

| Situation | Desktop sidebar cue | User meaning |
| --- | --- | --- |
| Working | Blue animated braille spinner; `working` label | A native turn is executing |
| Input/approval/login needed | Gold `?`; `waiting` label with reason/detail | An explicit attention request exists |
| Idle with active agent schedule | Red `· → ♡ → ♥ → ♡` pulse; `heartbeat` label | A future agent wake-up is registered, not currently executing |
| Completed | Green `✓`; `done` label | The latest relevant turn completed |
| Failed/interrupted | Red `×`; retain exact outcome in details | Not a successful completion; interruption is not silently relabeled success |
| No active agent status | Online/offline connection cue | Reachability alone says nothing about agent work or scheduling |

- **UI-01 — Consistent meaning.** Desktop and mobile MUST distinguish Working,
  input-needed, and scheduled-idle with matching semantic labels and accessible
  text. Mobile may use different settled-state glyphs. Reduced-motion equivalents
  preserve state meaning. Do not confuse a service reconnect animation with
  agent work. A question mark in prose is not an input event.
- **UI-02 — Aggregation is explicit.** Derive the latest event per pane before
  selecting a workspace representative. Waiting outranks running; running
  outranks scheduled-idle; settled results cannot hide an active sibling. Show
  active/scheduled counts such as `1/2 panes active` or `1/2 panes scheduled` as
  workspace context, not as a claim about the focused pane. Collapsed descendants
  retain hidden attention/activity cues and unread counts. Error prominence in
  the subtree roll-up is separate from the per-workspace active-pane selection;
  neither should falsely change the parent's native lifecycle.
- **INP-01 — Positive request identity.** Maintain outstanding requests by exact
  session, request kind, native request ID, and generation. Questions, permissions,
  login, and blocked input should preserve distinct reasons wherever the native
  event provides them. A generic adapter that collapses reasons must disclose
  that gap; “waiting” alone is not proof of structured-question support.
- **INP-02 — Overlap and nesting.** The first pending request produces attention.
  Duplicate asks do not create another logical request or notification. Resolving
  one of several requests MUST NOT clear the others; resolve/reject/cancel only
  the matching occurrence. Return to Working when the last request resolves and
  work continues, otherwise use the authoritative terminal outcome. A descendant
  questionnaire can put its owning pane's root lifecycle into waiting without
  acquiring root naming authority. Descendant shutdown clears only its requests.
- **INP-03 — Optional structured answering.** Declare this independently from the
  `?` indicator. On supported surfaces, render native question order, options,
  single/multi-select rules, and permitted custom answers. Bind submissions to
  request ID/generation and a stable submission ID; stale browser views must not
  answer a newer occurrence. Permission/login approval MUST remain native unless
  a separately reviewed capability explicitly supports it. Unsupported/child
  question events must not accidentally gain a browser-answer path.
- **INP-04 — Answer success and recovery.** Use the native typed reply API, never
  paste answer text or synthetic Enter into the terminal. Show success only after
  authoritative acceptance; “already resolved” is not proof that this answer was
  applied. Preserve deterministic rejection and ambiguous-delivery outcomes.
  Once a reply may have reached the native API, do not blindly retry it. Reconcile
  from native replies/rejections or complete validated snapshots. Source/server
  restart must not replay raw answers. An unavailable browser bridge must leave
  the user a clear native-terminal path and generic lifecycle reporting intact.

## Scheduled heartbeat modes

Three mechanisms are often called heartbeat and MUST NOT be conflated:

| Mechanism | Purpose | Agent heart indicator? |
| --- | --- | --- |
| Native agent schedule (Prime `heartbeat` / `rlm_heartbeat`) | Wake a specific conversation for future work | Yes, only when verified active and idle |
| Integration liveness/reconciliation (ACT-04) | Establish whether reported state is still trustworthy | No; this is transport/status health |
| wmux host-registration heartbeat | Keep a machine in the host catalog and refresh reachability | No; this is machine discovery |

Scheduled-wake support is optional, but HBT rules are required when claimed.

- **HBT-01 — Evidence, not intent.** Read an authoritative schedule registration
  for the exact conversation. Starting a daemon, keeping a process alive,
  enqueueing input, sleeping, or saying “I will check later” MUST NOT set the
  scheduled indicator. Report configured/active schedule state, not a guarantee
  that a future invocation will succeed. Polling the registration is not itself
  the scheduler and must never launch a model turn.
- **HBT-02 — Orthogonal state.** Store schedule presence independently from turn
  lifecycle. While active work executes, show Working even if a future heartbeat
  remains scheduled. Explicit input overrides both. On completion return to the
  heart only if the schedule remains active; a failed/interrupted result must
  not be hidden by that same pane's schedule bit. Clearing the schedule alone
  must not invent a completed turn or erase a failure.
- **HBT-03 — Whole lifecycle.** Observe schedule creation, cancellation,
  consumption/expiry, native resume, and legitimate re-registration while idle,
  without requiring another user prompt. A healthy schedule transition should
  be visible within five seconds; uncertainty follows the ACT-04 stale deadline.
  Transient malformed/unreadable schedule data is unknown, not confirmed absence
  or a new active schedule. Display may retain the last-known value until marked
  stale, but must not silently certify it indefinitely.
- **HBT-04 — Independent owners.** Aggregate only validated active schedules
  from the root and its relevant descendants in the bound pane. Clearing one
  schedule must not clear another. Ignore stale generation callbacks and remove
  only the retiring owner's membership. Switching harnesses or native sessions
  in a reused pane must not inherit the predecessor's heartbeat bit.
- **HBT-05 — Quiet metadata.** Duplicate schedule observations are idempotent.
  Schedule-only updates do not change task titles, create completion events, or
  emit routine work notifications. Each actual wake-up is a normally correlated
  executing turn and receives the normal attention/terminal treatment. Do not
  duplicate a turn from both the native start event and a heartbeat-message event.

## Children, continuation, and recovery

- **SES-01 — Visible children.** A separately launched child TUI in its own wmux
  workspace is an independently bound root conversation. It names and reports
  only itself. Parent/child nesting is navigation metadata, not naming authority.
  Launching it from wmux should preserve the source cwd and record its exact
  returned IDs and direct link. Tests must check both child and parent state.
- **SES-02 — Internal subagents.** A harness-internal subagent without its own
  terminal MUST NOT inherit authority to rename the root workspace or report
  root completion. Its work may contribute to the root's active turn. Per-child
  display is optional; do not fabricate a terminal binding for it. Instructional
  root-only policy must not be represented as a hard authorization boundary.
- **SES-03 — Resume.** Resuming the same saved conversation in the same valid
  pane keeps its saved name and reconciles actual current activity. Moving it
  requires verified handoff or rejection of concurrent ownership. Resume/sync
  must not queue input, execute pending work, or start another turn merely to
  read its name. Deliberate continuation is a separate authorized action.
- **SES-04 — Browser and service recovery.** Browser reconnect changes neither
  native process ownership nor title ownership. A wmux service restart must
  reattach supported durable backends, retire obsolete integration authority,
  and re-establish current state without replaying old side effects. Raw PTYs
  are not restart-durable. A shared harness-daemon restart may interrupt other
  work and must not be used as an unexamined integration repair.
- **SES-05 — Retention.** Native turn completion must not close an ordinary
  interactive workspace. One-shot delegation cleanup is a separate explicit
  policy. Explicit wmux pane closure disposes only its owned terminal backend;
  do not kill a shared daemon or unrelated conversations. Preserve saved native
  conversation history so supported resume remains possible.

## Optional capabilities and security boundary

Structured browser questions, mobile Chat/history, delegated task control,
clipboard/media helpers, idle native-name subscriptions, scheduled wake-up
indicators, and budget notifications are separate capabilities. Their absence
does not excuse missing core naming or lifecycle behavior. A port MUST declare
each supported, unsupported, or unverified; avoid an undifferentiated “parity”
claim. Structured answers require exact request generation, native validation,
and replay-safe delivery; use the [OpenCode question contract](OPENCODE_QUESTION_COMPATIBILITY.md)
as a specialized reference, not a universal native API assumption.

- **EXT-01 — Idle names and contextual refresh.** A port may mirror native names
  while idle and periodically reassess an automatic title from context recaps.
  It MUST preserve user ownership and NAM-03 stability. A refresh interval is not
  permission to rename on every Nth turn regardless of task meaning. Disclose
  the interval and whether generated words come from a model or a text heuristic.
- **EXT-02 — Delegation and observation.** Optional agent tools may open visible
  agent-owned workspaces and continue tracked work through exact returned IDs.
  Native permission, write-access, supported runtime/host, and retention checks
  remain explicit. A controller timeout after dispatch is observation loss, not
  worker failure: retain the live workspace and report that distinction. Only
  an explicit cancellation may request interruption; naming must not imply it.
  A close tool must reject workspaces it does not own.
- **EXT-03 — Browser bridge compatibility.** Pin supported native event/API
  shapes, validate source identity and generation, and expose bridge failure
  separately from the terminal's status. Metadata-only reconciliation can recover
  after compatible plugin/broker/server refresh; ambiguous answers must not be
  resubmitted. Browser permission to answer an exact question is not general
  automation authority. Document supported browser surfaces rather than implying
  that a desktop question shelf is already available on mobile.

- **SEC-01.** Keep wmux's private-network boundary and exact-route authorization.
  Use least-privilege credentials, protect them in transport/storage, and never
  expose them in terminal output, URLs, browser payloads, test reports, or model
  context. A configured invalid credential must not fall back to broader auth.
- **SEC-02.** Binding/control metadata must be validated and bounded in size,
  retention, retry count, and lifetime. Treat native event and tool text as data.
  Diagnostic failure must not route an operation to a guessed target.
- **SEC-03.** Integration must preserve native approval, login, sandbox, and
  user-ownership decisions. Reporting an approval request does not authorize
  answering it. Single-user file/terminal access is not a multi-tenant isolation
  boundary; claims of protection must match the actual mechanism.

## Regression acceptance catalog

Use stable case IDs in automated test names and live acceptance reports.
Each case records native evidence, wmux authoritative state, browser observation
where required, and unrelated-parent/peer invariants. “Pass” requires all stated
assertions, not just a successful HTTP response or the agent's own final claim.

| Case | Given / action | Expected assertions |
| --- | --- | --- |
| R01 | Installed/trusted plugin; type only the ordinary CLI command | Fresh session loads integration; no wrapper or extra flags; outside wmux no unrelated mutations (SET-01–03) |
| R02 | Fresh unnamed session; ordinary substantive prompt without naming hints | Agent-derived saved name equals eligible sidebar/tab; no reminder required (NAM-01–02) |
| R03 | Follow-up “Testing that now”; then tool activity and Stop | Name stays unchanged before sync, after sync, and after Stop; no prompt-title writer (NAM-03,07) |
| R04 | Material task shift | New semantically relevant saved name mirrors to eligible surfaces; not a fixed expected wording (NAM-01–03) |
| R05 | Explicit native rename; next prompt; later task shift | Next eligible sync mirrors it; later automatic renaming does not replace the explicit choice (NAM-04–05) |
| R06 | Pin workspace, then independently pin tab; rename native session | Each pinned surface stays unchanged; eligible unpinned surface can update; no reverse sync (NAM-04,08) |
| R07 | Split panes/tabs; switch focus; remove/reorder owner | Only deterministic owner updates each shared title; pins persist; other panes still report activity (NAM-06, ACT-05) |
| R08 | Native no-tool reasoning turn held active ≥10 seconds | Working state and changing browser animation within ACT-03 target; stops at actual completion |
| R09 | Tool calls, provider retry, auto-compaction/internal continuation | One root turn remains active; no premature completed notification (ACT-01–02) |
| R10 | Approval/login/question and overlapping requests; resolve one then last | Correct attention reason; waits until last outstanding request resolves; resumes Working; no duplicate notification |
| R11 | Complete, cancel, fail; deliver duplicate/out-of-order events and old Stop during a new turn | Exact terminal outcomes; newer turn unaffected; at most one notification per occurrence (ACT-02,06) |
| R12 | Separate visible child; task, follow-up, task shift | Child independently names/reports itself; parent's name and root-turn outcome unchanged (SES-01) |
| R13 | Internal subagent; child tool-loop end/completion | No root title write or premature root completion (SES-02) |
| R14 | Same-pane resume; verified move; simultaneous views of same conversation | Saved name preserved; valid target only; ambiguous ownership rejected (BND-01–03, SES-03) |
| R15 | Daemon mode strips pane variables; two unrelated conversations active | Both naming and lifecycle still correctly isolated; missing lifecycle is a failure, not a naming pass (BND-05) |
| R16 | Browser reload/reconnect and second browser; replay old output | Native work survives; state resyncs; no side effects from replay or focus change (BND-04, SES-04) |
| R17 | Restart wmux during durable work; replace/recycle pane | Durable work reattaches; fresh authority required; old callbacks rejected; no stale Working beyond deadline |
| R18 | Lost network, expired credential, unavailable plugin/native-name API, or model skips naming | Native work remains usable; truthful partial/degraded status; bounded recovery; no fallback authority or false pass |
| R19 | Native name set succeeds, wmux mirror fails, then recover | Read/sync retries preserve canonical name; no blind second set or rollback (NAM-08) |
| R20 | Redraw/chunked marker, foreign marker echoed into another live pane, expired receipt | Same-pane idempotence; conflict fails closed without takeover; fresh uncontaminated binding recovers (BND-02–04) |
| R21 | Lose lifecycle source while active; reconnect after stale deadline | Stale/unknown appears within ACT-04 target; authoritative state reconciles without invented completion |
| R22 | Ordinary TUI completes/exits; explicit pane close; one-shot finishes | Retention matches chosen policy; only owned backend disposed; shared daemon/peer work preserved (SES-05) |
| R23 | Install/update with unrelated hooks, stale plugin cache, or missing trust | Unrelated config preserved; diagnostic identifies required reload/trust; no global resets (SET-02) |
| R24 | Unsupported OS/runtime/API version or missing optional capability | Support record says unsupported/unverified; no blanket complete/parity claim (SET-04) |
| R25 | Working, question, scheduled-idle, and terminal states in desktop/mobile, including reduced motion | Distinct UI-01 labels/cues; gold `?` for attention, red heart for schedule, no dependence on color alone |
| R26 | Root/descendant questionnaires overlap; duplicate ask; one child shuts down | One attention state persists until the last distinct request resolves; duplicate asks do not add an occurrence; exact request cleanup; root naming unaffected (INP-01–02) |
| R27 | A question and a permission share a native ID; reply to only one | Kind-qualified keys remain independent; waiting persists; permission never appears as a browser-answerable question unless separately supported |
| R28 | Supported ordered single/multi/custom questions; double browser submission; typed accept/not-found/reject or ambiguous delivery | Exact-generation, idempotent submission; truthful outcomes; no duplicate native reply after exposure; zero answer bytes/Enter events on pane input (INP-03–04) |
| R29 | Unsupported API/event shape, child-session question, unavailable broker, or stale request generation | Structured path fails closed, native terminal remains usable, generic activity remains independent (EXT-03) |
| R30 | Create active schedule while idle, cancel it, consume last one-shot schedule, then re-register | Heart appears/disappears from verified schedule state without a new user prompt; no fabricated terminal events (HBT-01–03,05) |
| R31 | Schedule remains active while work starts, asks a question, resumes, completes or fails | Working → `?` → Working; completion returns to heart only if still scheduled; failed/interrupted outcome is not hidden (HBT-02) |
| R32 | Root and two descendants schedule; clear one, retire/rebind another; reuse pane with a different harness | Aggregate retains remaining real schedule; old generation and predecessor heartbeat cannot leak (HBT-04) |
| R33 | Malformed/unreadable schedule record; then verified removal or valid recovery | Unknown is not false/true; no false completion/notification; bounded stale indication and native reconciliation (HBT-03) |
| R34 | Machine-registration heartbeat, integration keepalive, daemon running, queued message, or sleep without native schedule | None alone activates the agent heart or proves future execution (HBT-01) |
| R35 | Waiting/running/scheduled siblings and collapsed descendants; focus idle pane | Active/scheduled counts and hidden attention remain truthful; focus and newer settled sibling do not hide active work (UI-02) |
| R36 | Native rename while idle; automatic contextual-refresh interval passes during same task | Advertised idle sync works; manual name remains owned; refresh never bypasses NAM-03 stability (EXT-01) |
| R37 | Optional delegation denied, unsupported host/mode, controller observer timeout, explicit cancel, or close of user-owned workspace | Permission/support gates enforced; observation loss retains worker; cancellation distinct; unauthorized closure rejected (EXT-02) |
| R38 | Browser/source reconnect or server restart during question capture, before reply starts, and after possible reply exposure | Reconcile metadata/native request generations; reject stale authority; do not persist/replay raw answers or blindly repeat uncertain native replies (INP-04, EXT-03) |

Automate identity, ordering, ownership, and failure cases deterministically using
real wmux routes/session services where practical. Keep native API fixtures
explicit. Run actual installed-harness acceptance separately: a fake name API
does not certify CLI behavior, and CLI behavior does not certify browser chrome.

For semantic tests, assess task relevance, brevity, stability, and ownership;
do not assert one model-generated string. Record every attempt and any reminder.
A reminder-assisted retry can verify recovery, but cannot convert a failed
first-prompt automatic-naming attempt into an R02 pass. Sanitize terminal markers
*before* returning captured output to an observing agent's terminal, except for
the isolated negative-test injection defined in BND-04/R20.

For conformance, run applicable R01–R38 on each claimed harness version,
OS, local/SSH path, and embedded/shared-daemon mode. A case is not applicable only
with an explicit capability rationale; core startup, binding, naming (including
declared fallback), and lifecycle cannot be waived. Record separate browser tests
for desktop/mobile and reduced motion. Persist sanitized artifacts and timestamps,
including state before/after follow-up and after Stop. Documentation-only edits
require link/diff validation; runtime integration changes require `npm run check`
and affected live/browser acceptance before deployment claims.

R25–R27 and R35 refine core presentation/attention. Cases testing optional
structured questions, schedules, idle-name subscriptions, and delegation apply
only where that capability is claimed; record unsupported cases explicitly.
R34's prohibition on fabricated schedule indicators applies to every adapter.

## Porting checklist

Before implementing another harness, add a versioned adapter support record:

1. Identify supported extension installation/discovery, trust, startup/reload,
   exact conversation/turn identity, root/subagent metadata, and daemon scoping.
2. Map native saved-name read/write/change and ownership signals to NAM rules.
   Declare unsupported ownership detection and idle sync rather than guessing.
3. Map accepted/start/continuation/tool/attention/terminal/liveness events to ACT
   rules; specify ordering, duplicate keys, and reconciliation deadlines.
4. Choose and validate one binding protocol for all side effects, including
   resume, concurrent views, backend replacement, and absent environment fields.
5. Map native events in the harness adapter. Keep title ownership, transition
   acceptance, persistence, notification deduplication, and authorization in wmux's
   shared services. Do not duplicate these policies in per-harness UI code.
6. Declare platform/API bounds, optional capabilities, credential provisioning,
   timeout/failure behavior, upgrade/rollback, and diagnostic/recovery procedures.
7. Attach a case-by-case R01–R38 report with harness/plugin/server revisions and
   real evidence. Repeat affected cases after harness updates, not just after
   wmux changes. Obtain fresh-context review of mapping and final diff.

## Current conformance record

This is a starting ledger, not certification of other harnesses by association.
No adapter has a complete applicable R01–R38 report under this contract yet.

### Codex plain-start plugin

Implementation baseline: wmux PR #121 commit `23eb15d`; deployed integration
branch baseline `d91883a`; Codex `0.153.4`; plugin
`0.2.0+codex.20260906011825`. Observations below are from 2026-09-06 Linux tests.
The deployment baseline is unmerged dogfood code. No private host inventory or
credentials are required to reproduce the contract.

- Saved-name/sidebar/tab mirroring, semantic task changes, ordinary follow-ups,
  next-prompt mirroring after a native rename, manual wmux pins, and resume have live
  evidence in [plain-start acceptance](CODEX_PLAIN_START_DESIGN.md). These are
  bounded scenario observations, not a full conformance matrix or visual proof,
  and do not establish native explicit-name ownership preservation under R05.
- A later visible-child test chose “Draft Refresh Regression Planning,” preserved
  it on a follow-up with a no-op sync, and changed to “Community Book Exchange
  Planning” for a new objective. Saved-name results and wmux state agreed;
  the parent workspace name remained unchanged.
- That child's first naming attempt returned 404 after its raw live hook marker
  was echoed into the observing parent terminal. A fresh prompt with marker
  redaction and an explicit retry succeeded. This is recovery evidence, not an
  uncontaminated R02 pass. Other installation tests also observed a model skip
  initial naming until reminded. Instruction-based naming remains fallible.
- **Known core gap: BND-05 / ACT-01 / R08 / R15.** During a real child Working
  turn, no corresponding wmux activity event existed. Its tool environment lacked
  all three pane identity variables; legacy lifecycle reporting still requires
  them. Naming's trusted binding does not yet serve lifecycle reporting. The
  parent's activity also remained at an earlier completed event after resume.
  The observed missing sidebar animation is not fixed by successful naming.
- Explicit native-name ownership is not exposed by the current name API; its
  preservation is instructional. Idle native-name synchronization is not claimed.
  Loss detection/timing, full attention behavior, and visual animation acceptance
  against this contract remain unverified. Native Windows plugin/privacy behavior
  and unrelated remote thread stores are not certified.

### Prime and OpenCode: source-backed feature inventory

Inspection baseline: tracked integration sources and tests at `23eb15d`, examined
2026-09-06. This is an implementation inventory, not a new live-harness acceptance
run. Conditional requirements above describe the portable behavior; implementation
details below explain how these two adapters currently obtain it.

| Capability | Prime Agent | OpenCode |
| --- | --- | --- |
| Specific input-needed indicator | `questionnaire` tool call/result drives waiting/Resume; root and nested requests are tracked independently by session/tool-call ID | Top-level `question.asked` and `permission.asked` use separate pending keys; question reply/rejection and permission reply resume only after the last pending key clears |
| Attention reason precision | Questionnaire is explicitly reported as input-needed | Both questions and permissions currently emit the generic `Question` hook; distinct approval-vs-question lifecycle reasons are a known gap, not claimed parity |
| Scheduled heartbeat mode | Reads exact-session active `heartbeat` or `rlm_heartbeat` jobs; idle red heart pulse, ordinary Working during delivered turns | No schedule-state publisher in this adapter; do not infer support from the shared UI's ability to render a heart |
| Idle schedule changes and descendants | Directory watcher plus one-second reconciliation; root/descendant schedule membership aggregates by generation; clearing one does not clear the others | Not implemented as an agent-schedule capability |
| Structured browser answers | No structured questionnaire-to-browser answer bridge is established by this inspection; the `?` still directs the user to the native questionnaire | Compatible top-level question events project into an active-pane desktop shelf; ordered single/multi/custom responses use the typed native API, not pane input. Permission prompts and child questions are excluded |
| Native names | Canonical name reconciliation while idle; explicit external names tracked; automatic contextual-title refresh after six additional root turns | Native session title is consulted on top-level prompts and terminal reporting; idle native-name subscription is not established by this inspection |
| Continuing/nested work | Defers root terminal reporting until relevant descendants settle; reactivation via agent-to-agent messages restores activity; ignores intermediate tool-use ends; provider retries receive a bounded grace | Generic telemetry is top-level and bypassed for delegated workers; one-shot delegation uses its controller lifecycle instead |
| Visible delegation and close tools | Supported through wmux's CLI/runtime integration; no equivalent native in-extension tools are claimed here | `wmux_delegate` and `wmux_close` use native permission checks. POSIX local/SSH, change/deploy, not read-only review; observer timeout retains submitted work; close rejects user-owned workspaces |

The Prime title refresher uses text-derived/context-recap candidates, not the
Codex model-chosen title path. Its six-turn cadence and potentially changed
wording are implementation behavior, not proof of NAM-01/NAM-03 conformance.
Prime's retry grace defaults to 15 seconds; a later recovery can become a new run
after terminal failure was already published. This is not an unbounded promise
that every provider error remains Working indefinitely.

OpenCode structured answering is pinned to the existing 1.18.9 compatibility
contract. It distinguishes typed acceptance, already-resolved, deterministic
failure, and ambiguous native delivery. Its broker supports metadata-only
reconciliation and fresh source registration after durable-pane reattachment;
raw answer replay is prohibited. This inspection does not certify the real-live
browser-answer-to-TUI-continuation proof gate. Mobile question answering is not
claimed merely because mobile chrome can show a waiting indicator.

The server can inherit a latest event's `heartbeatActive` when an incoming event
omits it. Cross-harness/pane-reuse cleanup therefore needs R32 evidence before
claiming no schedule-state leakage; absence of an OpenCode publisher alone does
not establish that guarantee. Prime's malformed-schedule handling suppresses
updates, but this inspection does not establish the HBT-03 bounded stale UI.

Source and regression anchors:

- [`prime-agent.ts`](../src/integrations/prime-agent.ts): `markQuestionPending`,
  `markQuestionResolved`, `readScheduledHeartbeatActive`,
  `publishHeartbeatAggregate`, `startReconciliation`, and lifecycle handlers.
  [`hooks-installer.test.ts`](../test/hooks-installer.test.ts) exercises nested
  questionnaires, scheduled setup/delivery/cancellation, retries, and title refresh.
- [`opencode.ts`](../src/integrations/opencode.ts): top-level lifecycle pending
  set, structured question bridge, delegation and close tools.
  [`opencode-question-plugin.test.ts`](../test/opencode-question-plugin.test.ts)
  and [`opencode-delegation-plugin.test.ts`](../test/opencode-delegation-plugin.test.ts)
  cover the corresponding native-adapter fixtures.
- [`sidebar-agent-status.ts`](../src/client/src/sidebar-agent-status.ts),
  [`OpenTuiSidebar.tsx`](../src/client/src/OpenTuiSidebar.tsx),
  [`OpenTuiMobileChrome.tsx`](../src/client/src/OpenTuiMobileChrome.tsx), and
  [`workspace-agent-activity.ts`](../src/client/src/workspace-agent-activity.ts)
  define glyphs, theme colors, accessible context, and aggregation.
- [`prime-agent-sidebar.spec.ts`](../e2e/prime-agent-sidebar.spec.ts) drives
  synthetic API events through the desktop browser heartbeat sequence; it does
  not itself run a native Prime scheduler. The 15 selected unit tests in
  `sidebar-agent-status.test.ts`, `workspace-agent-activity.test.ts`, and
  `workspace-tree.test.ts` passed during this documentation update. No new live
  Prime/OpenCode or browser run is claimed.

Consult the [integration guide](../README.md#helpers-and-integrations) and
[OpenCode compatibility guide](OPENCODE_QUESTION_COMPATIBILITY.md) for setup and
specialized contracts. Claude and future adapters need their own explicit records.

## Implementation references

- [Codex plugin guide](CODEX_PLUGIN.md): current binding transport and API limits.
- [Codex hooks](https://learn.chatgpt.com/docs/hooks): native hook metadata and
  trust model; installed plugin hooks require review/trust, not just installation.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): supported native
  thread/name control surface. Pin and test the actual installed API version.
- [`src/server/agent-sessions.ts`](../src/server/agent-sessions.ts): shared
  transition/title/notification service; [`state.ts`](../src/server/state.ts)
  owns workspace/tab title application and layout ownership.

Changes to expected behavior must update this contract, affected stable case IDs,
and adapter support records together. Fixing a known gap must not silently weaken
the acceptance expectation to match the previous implementation.
