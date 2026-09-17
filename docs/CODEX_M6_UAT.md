# Combined M3–M6 UAT

## Attachment rollout candidate — 2026-09-17

Runtime candidate: `bf2b030019d73d40f08a1c73fb54bfd17083c5d4`, pushed on
`feat/codex-m3-m6` and unmerged. M5a/M5b now provides **Open in CLI** for a
loaded Haswell task and **Open terminal** for a freshly verified existing view.
Both configured catalog endpoints remain visible; bounded remote loaded-owner
inspection prevents another configured server from being ignored. Remote
attachment and Desktop-local ice3070 remain unqualified. Haswell fresh launch
is disabled pending separate managed-route qualification.

Final external `npm run check` passed **1,197 tests / 8 skips**, typechecks,
script validation and build (run `32399ab317f88488`). The integrated attachment
base `df2837c` previously passed the full external browser matrix: **119 cases**,
109 intentional skips, plus all **3 login-only cases**. The rollout adds focused
coverage for remote ownership and dismissing the catalog on terminal navigation.
Deployment, served-browser, rollback and final focused-browser evidence is
retained privately under `test-results/m6-attachment-rollout-20260917/`.

Direct desktop UAT after rollout: refresh wmux, use **Ctrl+K → Open Codex tasks**,
select a familiar **loaded Haswell** task, and choose **Open in CLI**. Confirm
history, enter a harmless continuation and see it in Desktop. Judge whether
Open terminal and inspection explanations are usable. If a native approval
appears, the user decides it. Phone usability is deferred below.

The dated original-candidate findings below describe the earlier deployment;
they do not imply that the new attachment action is still missing.

## Original candidate — 2026-09-16

The unmerged `feat/codex-m3-m6` candidate is deployed on Haswell for combined
UAT. Runtime source is `e2322905d37c995c36fa851c7cdd317d8551553c`.
M0–M2 retain their prior acceptance; **M3–M6 are not yet accepted**.
No Codex/App Server source, configuration or lifecycle changes were made.

**UAT finding:** the user could not use the catalog to open an existing task in
a wmux CLI. The observation-only experience does not meet the intended workflow.
Existing-task attachment must be implemented and qualified before repeating
catalog UAT. See the [investigation and corrective plan](CODEX_SESSION_ATTACHMENT.md).

Connection update — 2026-09-17: Desktop's Haswell connection and a managed wmux
CLI passed shared-task UAT, including an approval answered in Desktop and a
Desktop-origin continuation visible in both clients after reopening the task
view. This qualifies the existing connection dependency, not the missing catalog
action. Desktop-local ice3070 remains unqualified. M5a/M5b implementation and
revised M6-H2 remain open.

Open **Codex tasks** from the desktop command palette, or mobile
**Chat → Actions → Open Codex tasks**. Configuration, authority boundaries and
recovery details are in the [catalog runbook](CODEX_TASK_CATALOG.md).

## Direct interaction acceptance

The functional cases below have been exercised by the agent. The user does not
need to repeat API, persistence, deduplication, fault or layout assertions.
The combined checkpoint tracks these interaction checks:

| Case | User action and expected result | Decision |
| --- | --- | --- |
| M6-H1 — Native trust decision | Make your own trust decision in the retained native views; wmux must not answer it. | User confirmed: “did the trust interaction” (2026-09-16) |
| M6-H2 — Personal desktop workflow | Select a familiar loaded Haswell task and open that exact conversation in a wmux CLI. See its current work/history and continue it through the native prompt; confirm the continuation appears in Desktop. Judge whether host selection, Open terminal and inspection explanations are usable. | Pending direct UAT of the corrective M5a/M5b rollout. |
| M6-H3 — Physical-phone usability | Use the catalog attachment flow on a phone and judge controls, terminal input and navigation. | Deferred by the user on 2026-09-17 until the Mac Mini is running and set up for wmux mobile testing. Not accepted; does not block the current desktop rollout. |

The phone deferral applies to direct physical-device usability only. Keep
automated mobile browser coverage and prior mobile acceptance intact. M6-H2 is
the only remaining direct user check for the current desktop rollout; engineering
qualification and deployment remain separate gates. Mac Mini setup is deferred
follow-up work, not part of this rollout.

The retained native trust prompts show the requested directories. No trust,
login or approval response was automated. Prior M0–M2 acceptance, including
sidebar actions, unpin, mobile appearance and diagnostics clarity, is retained;
this checkpoint concerns the new catalog and launch flow.
The trust confirmation records the user's interaction only; it does not imply
acceptance of the remaining usability check or confirmation that a launch
attempt was acknowledged. Acknowledgement behavior was already qualified by
automation and does not retry or cancel a launch.

## Functional cases completed by automation

| Original case | Qualification and limits |
| --- | --- |
| M6-01 — Find and inspect | Real list, exact-ID read and bounded history succeeded on both Linux endpoints; remote pagination was exercised. Duplicate identities and history-on-demand are covered by browser/server fixtures. No native resume is used for inspection. |
| M6-02 — Associate and observe | Served desktop/mobile controls created, moved and removed the same exact task association; a second browser agreed after reload. Independent Unicode workspace and tab pins survived. A real later native CLI turn produced exactly one catalog notification across two display associations within nine seconds; another poll did not duplicate it. Exact identity came from that owned CLI's native `/status`, never a title/cwd match. |
| M6-03 — Open a fresh view | Both hosts opened new CLI views in an already trusted directory. Native `/status` and exact-ID read verified identity, cwd and no automatic turn. An explicit harmless native turn completed. Repeating a launch UUID returned the same attempt/pane. Both untrusted-directory launches stopped at native trust with exact target links; real unknown-attempt acknowledgement preserved the outcome without retry. |
| M6-04 — Browser and recovery | Live desktop/mobile reload, Unicode pins and natural sample expiry passed; stale selection disabled association. Isolated tests cover endpoint outages, stale identities, launch uncertainty, reload recovery, authorization and backup/rollback. Physical-device usability is deferred as M6-H3. |

Private live evidence is under `test-results/m6-automation-20260916/`, including
`catalog/root-browser-result.json`, `catalog/native-pages.json`,
`cli/notification-result.json`, `cli-final/result.json`,
`final-native-smoke.json` and `audit/coverage-audit.md`. Failed browser harness
attempts were corrected and rerun; only completed assertions are counted.
Test associations and ordinary test workspaces were removed. Only the two
native trust views remain deliberately retained for direct interaction; the
immutable launch ledger retains test attempt history by design.

Resume is disabled in this deployed build. The original blanket ownership
restriction is under correction: same-server multi-client attachment is natively
supported, while wrong-server resume is a different operation. The attachment
investigation defines the required routing and capability gates. Windows native observation and unqualified macOS transports
remain unsupported. Existing receipt-bound naming is independent of display
associations. Catalog notification deduplication applies across associations;
its outbox is separate from receipt-bound lifecycle reporting.

## Engineering qualification

- Final runtime `e232290`: external `npm run check` passed **1,170 tests / 8
  skips**, typechecks, script validation and production build (run
  `32a8ebffbd064796`). The exact checked build was deployed, and served
  desktop/mobile association create/move/remove/reload and natural expiry
  passed again. Both retained native trust prompts survived deployment.
- Long Unicode names exposed mobile overflow in catalog controls. Compact,
  recognizable option labels now fit while full selected names and exact
  identities remain visible below. The complete catalog browser fixture passed
  **3/3** on the final runtime in desktop Chromium, mobile Chromium and mobile
  WebKit, including geometry checks before and after opening association controls.
- Live automation found and corrected two fresh-view deployment problems:
  installed local helpers referenced an old release, and remote CLI argv lacked
  explicit `--cd`. Local helper links now follow the active release; the wmux
  launcher passes the validated cwd explicitly. Both hosts were requalified
  through their real native clients. External `npm run check` on `e24c127`
  passed **1,170 tests / 8 skips**, typechecks, script validation and build
  (run `416bcc5ee525049d`). Native services and the soak retained their PIDs.
- An additional isolated catalog/association/launch/API/CLI-boundary run passed
  **36/36**. It includes strict authorization, uncertain-attempt recovery,
  endpoint failure, persistence and notification deduplication.
- Earlier runtime `ff524a4`: external `npm run check` passed **1,170 tests**, with
  **8 skips**, plus TypeScript, script validation and production build.
- Full browser run on `ce6ee74`: **116 passed / 109 intentional skips**, followed
  by **3 passed** login-only tests. Subsequent changes affected the launcher and
  catalog browser code; final full checks, native launches and the complete
  catalog fixture above qualify those changes.
- Live served desktop/mobile Chromium smoke used the real native catalog and
  real association route. Both returned HTTP 200 and preserved independent
  workspace/tab pins. Temporary associations/workspaces were removed afterward.
  This is agent-run qualification, not direct user acceptance.
- Native read-only probes on two existing Linux endpoints returned exact-ID
  metadata and bounded turn information, fetched a real second remote page,
  and queried archived tasks. Stored tasks remained `notLoaded` after history
  reads. The installed CLI/App Server contract is 0.154.0. No task was resumed
  for inspection. These probes passed again after workstation maintenance.
- Isolated disable/rollback/backup-restore qualification passed. Both releases
  use main state schema 10; the prior release ignores the separate new ledgers.
- Deployment preserved existing workspace/tab identities, names and pins.
  Codex App Server and the naming observer retained their existing processes.

Full checks ran on the external POSIX runner through visible wmux workspaces.
The complete POSIX browser fallback was used because no Windows browser runner
was configured. Haswell lacked the local WebKit executable, so final WebKit
qualification ran on the external runner.

Earlier private evidence is retained under `test-results/m6-qualification-20260916/`.
Earlier remote full-check IDs are `53a35d2d694e4ec2` (`ff524a4`) and
`12cbff5194aab931` (preceding runtime); full browser ID is `159d4a86616ec8c4`.
Final checks and deployment records are under
`test-results/m6-automation-20260916/`; final full-check ID is
`32a8ebffbd064796` (`e232290`).
The deployment record includes the exact artifact hashes and predeployment
backup; live inventories and credentials are not committed.

The external workstation rebooted for user-confirmed maintenance around
15:45 and 15:50 UTC. Shared storage paused and the disposable runner was lost.
Interrupted run `34eb1dd12e12a88f` is not a pass. The runner was rebuilt and
the final full check and native reachability checks passed after maintenance.
The obsolete remote trust view was replaced with a fresh native trust prompt.

## Original catalog overnight gate — passed, attachment excluded

Reviewed on 2026-09-17: the original run ended at **04:37:47 UTC**, after
86,401,679 ms. All **13 assertions** passed; all **287 faults** recovered, with
287 metadata recoveries/reloads, zero unexpected errors or dropped events,
one peak socket and peak RSS 125,308,928 bytes. The unit exited successfully
(`ExecMainStatus=0`, `SubState=exited`). The maintenance/storage pause described
below remains part of this qualified run. The report qualifies only its frozen
catalog/association code, not the new attachment code or overall M6 acceptance.

The real 24-hour synthetic mixed-task soak started on **2026-09-16 at
04:37:45 UTC**. Its earliest finish is **2026-09-17 at 04:37:45 UTC**.
The durable user unit is `wmux-codex-m6-soak-20260916.service`; its report is
`test-results/m6-qualification-20260916/soak-24h/report.json` when complete.

It exercises twenty exact task identities across two private socket fixtures,
endpoint faults/recovery, association persistence, notification deduplication
and resource bounds. It does not fault or modify native services. The frozen
soak source is `ce6ee74`; the candidate's 97 server/harness artifacts were
verified byte-identical. The CLI wrapper correction is qualified separately by
live launch tests; it does not change the backend exercised by this soak.
The soak process survived workstation maintenance without a restart; shared
storage access paused and fault/recovery events resumed afterward. Review that
interruption in the final evidence rather than claiming an uninterrupted run.
Short fixture runs and elapsed wall time alone do not accept the gate: inspect
the final report, all assertions and successful unit exit.

## Release decision

Accept M6 only after corrective M5a/M5b qualification, M6-H1, revised M6-H2 and
the relevant overnight gate pass, with M6-H3 explicitly recorded as deferred
rather than accepted. The original soak does not qualify newly implemented
attachment code. Overnight qualification remains
an automated engineering gate, not a test delegated to the user. Record any
rework or deferred capability explicitly. The previous accepted release and
private state/configuration backup remain available for rollback. A deployment
or passing fixture does not by itself accept a milestone or merge the branch.
