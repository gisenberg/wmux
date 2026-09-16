# Combined M3–M6 UAT

## Candidate — 2026-09-16

The unmerged `feat/codex-m3-m6` candidate is deployed on Haswell for combined
UAT. Runtime source is `e24c127b05e811b708410ca88a7e10951280d6ea`.
M0–M2 retain their prior acceptance; **M3–M6 are not yet accepted**.
No Codex/App Server source, configuration or lifecycle changes were made.

Open **Codex tasks** from the desktop command palette, or mobile
**Chat → Actions → Open Codex tasks**. Configuration, authority boundaries and
recovery details are in the [catalog runbook](CODEX_TASK_CATALOG.md).

## Direct interaction still required

The functional cases below have been exercised by the agent. The user does not
need to repeat API, persistence, deduplication, fault or layout assertions.
Only these interaction checks remain for the combined checkpoint:

| Case | User action and expected result | Decision |
| --- | --- | --- |
| M6-H1 — Native decision and input | Open the retained **M6 UAT — host native trust** views on each configured Linux host. Make your own trust decision; wmux must not answer it. If you continue, confirm the native prompt feels usable with your keyboard/paste workflow. In **Codex tasks**, inspect the corresponding uncertain attempt through **Open target**, then acknowledge that inspection. Acknowledgement does not retry or cancel the launch. | Pending direct interaction |
| M6-H2 — Personal desktop/mobile workflow | On your desktop and physical phone, find a task you recognize and try the catalog's inspection/association controls. Judge whether names, host identity, status, explanations and touch targets are understandable and usable. Mobile emulation cannot establish physical keyboard, touch or assistive-technology experience. | Pending direct interaction |

The retained native trust prompts show the requested directories. No trust,
login or approval response was automated. Prior M0–M2 acceptance, including
sidebar actions, unpin, mobile appearance and diagnostics clarity, is retained;
this checkpoint concerns the new catalog and launch flow.

## Functional cases completed by automation

| Original case | Qualification and limits |
| --- | --- |
| M6-01 — Find and inspect | Real list, exact-ID read and bounded history succeeded on both Linux endpoints; remote pagination was exercised. Duplicate identities and history-on-demand are covered by browser/server fixtures. No native resume is used for inspection. |
| M6-02 — Associate and observe | Served desktop/mobile controls created, moved and removed the same exact task association; a second browser agreed after reload. Independent Unicode workspace and tab pins survived. A real later native CLI turn produced exactly one catalog notification across two display associations within nine seconds; another poll did not duplicate it. Exact identity came from that owned CLI's native `/status`, never a title/cwd match. |
| M6-03 — Open a fresh view | Both hosts opened new CLI views in an already trusted directory. Native `/status` and exact-ID read verified identity, cwd and no automatic turn. An explicit harmless native turn completed. Repeating a launch UUID returned the same attempt/pane. Both untrusted-directory launches stopped at native trust with exact target links; real unknown-attempt acknowledgement preserved the outcome without retry. |
| M6-04 — Browser and recovery | Live desktop/mobile reload, Unicode pins and natural sample expiry passed; stale selection disabled association. Isolated tests cover endpoint outages, stale identities, launch uncertainty, reload recovery, authorization and backup/rollback. Physical-device usability remains M6-H2. |

Private live evidence is under `test-results/m6-automation-20260916/`, including
`catalog/root-browser-result.json`, `cli/notification-result.json`,
`cli-final/result.json` and `audit/coverage-audit.md`. Failed browser harness
attempts were corrected and rerun; only completed assertions are counted.
Test associations and ordinary test workspaces were removed. Only the two
native trust views remain deliberately retained for direct interaction; the
immutable launch ledger retains test attempt history by design.

Resume is deliberately disabled. Current native metadata cannot prove exclusive
client ownership, so seamless Desktop/CLI takeover is outside this release's
supported matrix. Windows native observation and unqualified macOS transports
remain unsupported. Existing receipt-bound naming is independent of display
associations. Catalog notification deduplication applies across associations;
its outbox is separate from receipt-bound lifecycle reporting.

## Engineering qualification

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
- Final source `ff524a4`: external `npm run check` passed **1,170 tests**, with
  **8 skips**, plus TypeScript, script validation and production build.
- Full browser run on `ce6ee74`: **116 passed / 109 intentional skips**, followed
  by **3 passed** login-only tests. The final change touched only catalog browser
  code and its fixture; that complete fixture passed again on `ff524a4` in
  desktop Chromium, mobile Chromium and mobile WebKit (**3/3**).
- Live served desktop/mobile Chromium smoke used the real native catalog and
  real association route. Both returned HTTP 200 and preserved independent
  workspace/tab pins. Temporary associations/workspaces were removed afterward.
  This is agent-run qualification, not direct user acceptance.
- Native read-only probes on two existing Linux endpoints returned exact-ID
  metadata and bounded turn information, including remote pagination. The
  installed CLI/App Server contract is 0.154.0. No task was resumed for inspection.
- Isolated disable/rollback/backup-restore qualification passed. Both releases
  use main state schema 10; the prior release ignores the separate new ledgers.
- Deployment preserved existing workspace/tab identities, names and pins.
  Codex App Server and the naming observer retained their existing processes.

Full checks ran on the external POSIX runner through visible wmux workspaces.
The complete POSIX browser fallback was used because no Windows browser runner
was configured. Haswell lacked the local WebKit executable, so final WebKit
qualification ran on the external runner.

Private evidence is retained under `test-results/m6-qualification-20260916/`.
Remote full-check IDs are `53a35d2d694e4ec2` (final source) and
`12cbff5194aab931` (preceding runtime); full browser ID is `159d4a86616ec8c4`.
The deployment record includes the exact artifact hashes and predeployment
backup; live inventories and credentials are not committed.

## Overnight gate — running, not accepted

A new real 24-hour synthetic mixed-task soak started on **2026-09-16 at
04:37:45 UTC**. Its earliest finish is **2026-09-17 at 04:37:45 UTC**.
The durable user unit is `wmux-codex-m6-soak-20260916.service`; its report is
`test-results/m6-qualification-20260916/soak-24h/report.json` when complete.

It exercises twenty exact task identities across two private socket fixtures,
endpoint faults/recovery, association persistence, notification deduplication
and resource bounds. It does not fault or modify native services. The frozen
soak source is `ce6ee74`; the candidate's 97 server/harness artifacts were
verified byte-identical. The CLI wrapper correction is qualified separately by
live launch tests; it does not change the backend exercised by this soak.
Short fixture runs and elapsed wall time alone do not accept the gate: inspect
the final report, all assertions and successful unit exit.

## Release decision

Accept M6 only after M6-H1, M6-H2 and the overnight gate pass. The soak remains
an automated engineering gate, not a test delegated to the user. Record any
rework or deferred capability explicitly. The previous accepted release and
private state/configuration backup remain available for rollback. A deployment
or passing fixture does not by itself accept a milestone or merge the branch.
