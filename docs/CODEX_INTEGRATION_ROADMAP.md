# Codex integration roadmap

Status: M0–M2 implementation is available in
[PR #127](https://github.com/gisenberg/wmux/pull/127) for deployment preparation;
engineering qualification and native-client UAT are separate gates. Naming
[PR #126](https://github.com/gisenberg/wmux/pull/126) is the fixed baseline at
`d3be8801f4b3b4e6f6d6ad34de4d66dec4cc34a3`. M1 closes the observed unpin gap;
M2 adds bounded recovery. M3–M6 remain proposed. Unpin, immediate CLI exit cleanup,
and the M2 24-hour soak are not accepted by authorization to implement.
Updated: 2026-09-12.

| Implemented milestone | Deployment acceptance still required |
| --- | --- |
| M0 | Artifact/capability collector and conformance ledger delivered; repeat native smoke against the deployed candidate |
| M1 | Independent workspace/tab reset controls, title persistence/display and diagnostics delivered; desktop/mobile idle unpin and failure UAT pending |
| M2 | Bounded Linux observation worker and wmux-owned supervision delivered; native fault UAT and the actual 24-hour soak pending |

The candidate is staged separately from the active release. Consult PR #127's
checks for the qualified revision and the private release manifest for built
artifact identity. No live deployment, native service change, unpin acceptance,
or immediate CLI exit-cleanup acceptance follows from this implementation status.

## Objective and boundary

Make Codex tasks discoverable, understandable, and accessible from wmux across
desktop, CLI, and existing App Server use. Every implementation change belongs
in this repository, including its plugin, helpers, protocol, UI, and deployment
scripts. No Codex/App Server source patches, replacement binaries, native
database edits, or changes to their service/configuration are prerequisites.
Use existing supported interfaces and endpoints. Installing a wmux-owned
component is part of a separately authorized wmux rollout.

Native names remain canonical. Preserve independent manual workspace/tab pins.
Keep three concepts separate throughout the implementation:

- A native task, identified by configured host/endpoint and exact thread ID.
- A persistent wmux display association between that task and a pane.
- A short-lived, live-proven terminal binding that permits automatic pane/title
  reporting. A saved display association does not restore this authority.

Task activity does not prove which client submitted a turn. Stored metadata
does not prove that the endpoint owns active execution. Missing or unavailable
capabilities must produce an explicit unavailable/unknown state.

## Milestones and release order

| Milestone | User-visible result | Dependency | UAT checkpoint |
| --- | --- | --- | --- |
| M0 — Establish baseline | Current naming behavior has a reproducible acceptance record | None | Native names, pins, reconnect, and known limitations |
| M1 — Explain and restore automatic naming | Doctor/inspector explains health; long names display correctly; workspace and tab can independently return to automatic naming | M0 baseline decision with unpin gap explicitly recorded | Accessible reset controls, independent pins, idle convergence, reload and failure recovery |
| M2 — Recover observation | wmux observation survives its own worker failures and uses bounded resources | M1 | Fault injection and an overnight soak |
| M3 — Discover native tasks | Task inventory includes native tasks without terminal panes | M2 | Desktop, CLI, stored, and background task visibility |
| M4 — Associate and inspect | Explicit display associations and useful native task details | M3 | Move associations, reconnect, and inspect related tasks without affecting execution |
| M5 — Open supported CLI views | Explicit opening/resuming through existing endpoints and exact task IDs | M4 | Supported launch/resume paths, ambiguous ownership, and delivery failure |
| M6 — Release acceptance | Accepted features work together on the declared host/client matrix | M1–M5 | Integrated daily workflow and rollback rehearsal |

Each milestone must be useful independently. M1–M4 can ship without M5.
UAT occurs against a concrete, versioned wmux candidate after engineering checks;
it is not deferred until the final milestone. Record accept/rework/defer before
promoting a milestone. The user authorized building M0–M2 together with the M0
unpin gap carried into M1; this allows implementation to proceed without treating
the missing behavior as accepted. The [M1–M2 UAT and rollout procedure](CODEX_M1_M2_UAT.md)
keeps their deployment and acceptance checkpoints explicit.
Do not estimate dates until the candidate baseline and target UAT hosts are set.

## M0 — Establish the naming baseline

Execution procedure: [CODEX_M0_UAT.md](CODEX_M0_UAT.md). Candidate qualification
uses PR #126's committed revision. M0 tooling
must not stage or overwrite that workstream's in-progress source changes.

Deliverables:

- Record the exact wmux commit, plugin artifact, CLI/server versions, and
  supported endpoint capabilities. Reconcile the existing naming working-tree
  changes before preparing a reproducible candidate; preserve unrelated work.
- Update the current sections of the plugin guide and conformance ledger from
  fresh evidence. Preserve historical results as historical.
- Prepare disposable tasks/panes and documented fault fixtures. Start with one
  supported POSIX host and existing private socket; do not require another
  native service or configuration change.

UAT: create a native name, rename from each available native client, finish a
turn, rename while idle, independently pin/unpin workspace and tab, reconnect
the browser, and exit the CLI while leaving its shell alive. Verify the exact
intended surfaces change and unrelated tasks remain unaffected. Demonstrate
that a desktop-only task without terminal proof remains unbound.

Exit: native-client tests are distinguished from socket fixtures, supported
client paths are explicit, and any failure has a reproducible case. Existing
restart/lease limitations are documented rather than counted as new regressions.

Live UAT gap (2026-09-12): no browser unpin control was available. The workspace
title API already accepts reset, but the tab title API has no clear/reset
operation. Manual workspace pin preservation passed; user-facing independent
unpin did not. M0 N05–N07 must record the reset portions as blocked by missing
product support, not passed via direct state edits. M1 closes this explicit gap;
moving the implementation there does not accept or waive it. The user subsequently
authorized M0–M2 execution while carrying this gap into M1. Immediate shared-client
quit/disconnect cleanup is excluded by PR #126 because client detach does not
immediately emit native `SessionEnd`; neither that behavior nor native event
delivery on exit is accepted. Delivered-event cleanup retains fixture coverage.

## M1 — Explain integration state and restore automatic naming

Deliverables:

- Extend doctor and the session inspector with separate naming, activity,
  transport, and binding health; last success/sample age; expiry; and sanitized
  reason codes. Surface CLI/server/plugin compatibility where verifiable.
- Differentiate manual pin, missing native name, missing turn ID, pending or
  expired binding, unsupported endpoint, unavailable socket, and failed delivery.
- Store a bounded full native name separately from presentation. Ellipsize in
  narrow chrome and expose the full name through accessible inspection. Define
  an explicit maximum and visible handling for larger names; retain control
  character validation and never split a Unicode grapheme in display text.
- Specify persistence/wire migrations and preserve existing manual title values.
- Add accessible actions named **Use automatic workspace name** and **Use
  automatic tab name** in the corresponding desktop and mobile surface controls.
  Show the current ownership and exact target; support keyboard activation,
  screen-reader labels, visible focus, touch, and result/error feedback. Reset
  only after the user invokes that surface's action; opening a menu or a native
  rename must never remove a pin.
- Reuse `POST /api/workspaces/:workspaceId/title` with `{ "clear": true }` for
  workspace reset. Extend the existing
  `POST /api/workspaces/:workspaceId/tabs/:tabId/title` route with the same
  explicit reset form and a dedicated state clear operation for the selected
  tab. Both route bodies must distinguish reset from setting a manual title;
  reject ambiguous/invalid requests instead of interpreting an empty title as
  unpin. This is planned API work, not a claim that tab reset already exists.
- Preserve existing route authorization: normal browser authorization on both;
  scoped automation/helper grants on workspace title, scoped automation on tab
  title. Do not grant helper credentials tab-reset authority, broaden routes,
  or add reset authority to the read-only naming MCP tools. Add real-server
  route-policy checks for valid, invalid and unauthorized reset requests.
- Persist only the selected surface's ownership transition from `user` to
  automatic eligibility (`default` until an accepted automatic sample sets
  `auto`). Preserve the other surface's pin/title, layout-owner rules and task
  identity. Repeated reset is ownership-idempotent. Publish the resulting state
  to connected browsers and retain it across reload/restart. Until a valid
  sample arrives, show an explicitly provisional surface fallback, not a stale
  cached native name claimed as synchronized.
- With a live binding and available metadata, the observer must restore the
  **current** native name on the next normal sample (currently two seconds plus
  request/delivery time), including while idle and without another rename or
  prompt. Unpin is not native renaming and must not revive stale/expired binding
  authority. If metadata is unavailable or the binding is stale, save the reset,
  show automatic-but-awaiting-sync status, and keep native work usable. Socket
  recovery may converge through a still-live binding; stale bindings require
  fresh terminal proof before any automatic title write.

Engineering gate for reset: test each pin independently and both together,
workspace/tab API and state transitions, exact-target authorization, repeated
reset, idle reset without a new rename, current-name selection after a rename
while pinned, reload persistence, unavailable metadata, stale/expired bindings,
and a delayed sample after the user pins the surface again. Browser tests must
activate the real controls and traverse the authorized routes. Direct state
mutation fixtures establish only internal behavior, not user-facing acceptance.

UAT: long and Unicode names on desktop/mobile; pinned surfaces; an unnamed task;
and controlled unavailable/missing-capability fixtures. Complete M0 N05–N07's
reset portions through the actual desktop/mobile controls, first while idle,
then across reload and an unavailable/stale binding. Confirm the other pin stays
intact and current-name convergence requires no new native rename or prompt.
A user should be able to
identify the problem and the appropriate existing recovery action without logs.
No restart of a live shared native service is required to simulate an outage.

Exit: diagnosis is specific, title rendering is usable, both reset actions have
user-facing acceptance evidence, and no error state overwrites another manual
pin or exposes credentials/receipts. Record unpin acceptance separately from
CLI exit-cleanup acceptance; success in either does not establish the other.

## M2 — Make wmux observation recoverable and bounded

Deliverables:

- Add wmux-owned supervision and connection reuse per configured endpoint.
  Consolidate sampling while preserving independent task identity, title
  authority, and prompt-bound lifecycle checks. Choose the hosting location
  within existing wmux service/session-agent boundaries during implementation.
- Recover abandoned locks using verifiable owner liveness or an equivalent
  crash-safe mechanism. Never reclaim a lock solely because a valid read is slow.
- Add bounded backoff, jitter, shutdown, worker limits, and diagnostic counters.
  Preserve the existing freshness/stale contract for healthy active observation;
  document any idle cadence separately.
- Recover read-only observation after worker/socket failure. A wmux restart
  still requires fresh terminal proof before automatic title writes resume.
  Do not persist or renew title authority merely because polling succeeds.

Engineering gate: test worker termination, stale locks, delayed reads, outdated
responses, title pins, newer prompt receipts, and repeated reconnects. Use a
synthetic 20-task load fixture to check process/socket/request bounds.

UAT: terminate only a disposable wmux observer, simulate endpoint failure,
restore it, reconnect browsers, and restart an isolated wmux candidate. Confirm
native work continues, unknown state is visible, observation recovers, and
expired title authority stays expired. Follow with a 24-hour soak.

Exit: no orphan worker accumulation, stuck locks, duplicate terminal
notifications, stale-title replay, or unexplained growth in resource counters.

## M3 — Discover native tasks independently of panes

Deliverables:

- Add a native task catalog keyed by host/endpoint identity and exact thread ID,
  with session-tree identity, metadata provenance, sample age, and runtime
  confidence. Do not merge tasks by title, cwd, or apparent recency.
- Use bounded existing list/read methods with pagination and capability checks.
  Keep inventory permission separate from the current narrowly bound MCP tools;
  do not broaden those tools into global discovery implicitly.
- Add explicit wmux endpoint configuration. A remote host uses a bounded,
  authenticated wmux-owned bridge to its existing supported local endpoint,
  not a general native RPC proxy. Land single-host discovery first.
- Include tasks without panes. Label active, idle, stored/not-loaded,
  unavailable, and unknown distinctly. Preserve useful last-known metadata
  without presenting it as fresh runtime state.

UAT: find disposable desktop, standalone CLI, existing-server, and stored tasks;
verify exact identities against the native clients. Exercise pagination,
same-title tasks, endpoint loss, and tasks on two configured hosts when existing
supported endpoints are available. Record inaccessible tasks as unsupported
visibility, not successful discovery. Browsing must not resume any task.

Exit: task identity and provenance remain clear across refresh/reconnect, and
inventory operations produce no native turns, subscriptions through resume,
or unsolicited native state changes.

## M4 — Associate panes and inspect native task context

Deliverables:

- Provide explicit associate/remove/move actions for wmux display associations.
  Persist them with schema versioning; revalidate endpoint and pane identity
  after reload. Missing/replaced panes leave an unresolved association.
- Show association separately from live terminal binding. An association grants
  neither automatic title ownership nor permission to send terminal input.
- Show available project/cwd/model, parent/child relationships, latest native
  outcomes, and bounded on-demand history. Label configuration metadata as such;
  do not claim it is the model used for every turn.
- Show task-level successor activity independently of prompt-bound pane
  activity. Deduplicate native task notifications across display associations;
  child activity must not overwrite a parent's name or borrow its title binding.

UAT: associate a desktop task without starting it, move its display association,
associate duplicate titles correctly, inspect parent/child tasks, reconnect two
browsers, and restart wmux. Close/recreate a pane and verify the old association
cannot silently target its replacement. Trigger a later turn through a native
client and verify task-level activity without asserting terminal origin.

Exit: associations survive as display metadata, stale title authority does not,
and inspection never sends input or changes native task state.

## M5 — Open supported CLI views through existing interfaces

Deliverables:

- Extend wmux launch contracts with explicit existing endpoint and native task
  ID; use the installed CLI's supported remote/resume commands. Keep launch
  controls separate from the read-only observation transport.
- Support a fresh task on a configured existing server and an explicit resume
  for eligible tasks. Preserve native sandbox/approval behavior; pass prompts
  through supported structured input or protected files, not shell interpolation.
- Before resume, inspect available runtime/queue state and wmux's own launch
  records. These checks cannot prove ownership across arbitrary standalone
  processes: ambiguous or foreign-active cases must remain unavailable for
  automatic launch. Show the reason and retain inspection access.
- Track one wmux launch attempt and its resulting native identity. A successful
  process spawn or queued input is not successful execution. After uncertain
  submission, reconcile and show unknown rather than automatically resubmitting.
- Where existing interfaces cannot prove a safe resume path, ship a disabled
  action with a specific reason. Do not make an upstream fix a dependency.

UAT: start a disposable task, reopen an eligible idle task by exact ID, inspect
queued input before an explicit resume, attempt a foreign-active/unknown task,
double-click launch, disconnect after submission, and exercise native trust or
approval prompts. Confirm one intended submission, the correct host/cwd, no
automatic retry after uncertain delivery, and no silent permission changes.

Exit: the supported eligibility matrix is precise. Seamless desktop/CLI takeover
is not claimed. A capability may be deferred without blocking M1–M4 release.

## M6 — Integrated UAT and release

Run the accepted workflow end to end: discover a task, inspect it, associate a
pane, observe a native rename, preserve a pin, follow a later native turn, recover
from a wmux observer interruption, and use an eligible explicit CLI launch.
Exercise wmux desktop and mobile browser layouts against each supported native
client/host combination. Mobile browser support is distinct from a native host
transport claim. macOS/remote rows require existing compatible endpoints;
Windows native observation remains explicitly unsupported unless a wmux-only
adapter can use an already available, verified interface.

Repeat an overnight soak with mixed tasks and verify notification deduplication,
bounded resource usage, diagnostics, persistence, and supported rollback.
For schema changes, demonstrate a wmux-owned migration/backup restore procedure;
do not run an older binary against a newer state schema blindly. Reverting wmux
must not require modifications to native task stores or services.

Exit: accepted scenarios, unsupported combinations, release/plugin identities,
and recovery instructions are recorded in the maintained conformance ledger.

## Gate procedure and evidence

Before each UAT handoff, run proportionate focused tests, relevant browser tests,
and the repository's required runtime checks. Prefer the documented remote
verification workflow for full checks. Use isolated candidate services and
fixtures for destructive/failure tests; do not interrupt active shared work.

Every checkpoint records:

| Field | Required evidence |
| --- | --- |
| Candidate | Committed wmux revision and matching plugin/build identity |
| Environment | Native CLI/server versions, supported endpoint type, browser, and host platform |
| Scenario | Reproduction steps, expected result, actual result, and evidence location |
| Isolation | Which disposable tasks/panes/workers may be affected |
| Decision | User/UAT owner: accept, rework, or defer; unresolved issues and release impact |
| Recovery | Tested rollback or component-disable path; persistence implications |

Keep live inventories, personal task content, private URLs, receipts, and
credentials out of committed evidence. Store sanitized scenarios and outcomes
in [CODEX_CONFORMANCE.md](CODEX_CONFORMANCE.md). Automated fixture success is not
native-client UAT acceptance. Wrong-task writes, unintended input, false
completion, and overwritten manual pins block release of the affected milestone.

## Explicit exclusions

No native naming writes, guaranteed cross-client execution takeover, inferred
terminal attachment generations, observation-by-resume, dependency on a new
subscription API, or browser approval answering without an existing verified
request contract. No native recurring scheduler is introduced. API limitations
reduce wmux's advertised capabilities rather than expanding the project boundary.

Reference implementation and constraints:
[plugin guide](CODEX_PLUGIN.md), [native API checkpoint](CODEX_NATIVE_API_GAPS.md),
[harness contract](HARNESS_INTEGRATION_SPEC.md), and
[verification workflow](VERIFICATION.md).
