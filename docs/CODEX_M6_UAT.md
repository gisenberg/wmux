# Combined M3–M6 UAT

## Candidate — 2026-09-16

The unmerged `feat/codex-m3-m6` candidate is deployed on Haswell for combined
UAT. Runtime source is `ff524a44878067ca85dbec035974fbf34b559215`.
M0–M2 retain their prior acceptance; **M3–M6 are not yet accepted**.
No Codex/App Server source, configuration or lifecycle changes were made.

Open **Codex tasks** from the desktop command palette, or mobile
**Chat → Actions → Open Codex tasks**. Configuration, authority boundaries and
recovery details are in the [catalog runbook](CODEX_TASK_CATALOG.md).

## Direct UAT still required

Use disposable tasks and display targets. Keep these as one combined checkpoint.

| Case | User action and expected result | Decision |
| --- | --- | --- |
| M6-01 — Find and inspect | Find known Desktop, CLI and stored tasks on both configured Linux hosts. Check exact endpoint/thread identity, duplicate names, pagination, history and stale labels. Browsing must not start a turn. | Pending |
| M6-02 — Associate and observe | Associate a native task, move/remove the association, and reload. Workspace and tab pins remain independent. Run a later turn from its normal native client and verify task activity and one catalog notification across multiple display associations. An association is not a terminal binding. | Pending |
| M6-03 — Open a fresh view | Select the intended endpoint and absolute cwd, then use **New CLI view**. Verify the native host/cwd and ordinary trust/approval behavior. No prompt is submitted automatically. Inspect any uncertain attempt through its exact pane link; acknowledgement permits a separate deliberate launch and never retries the original. | Pending |
| M6-04 — Browser usability | Repeat the new catalog, association and recovery controls in desktop and mobile browsers. Check long Unicode names and clear stale/unavailable explanations. | Pending |

Resume is deliberately disabled. Current native metadata cannot prove exclusive
client ownership, so seamless Desktop/CLI takeover is outside this release's
supported matrix. Windows native observation and unqualified macOS transports
remain unsupported. Existing receipt-bound naming is independent of display
associations. Catalog notification deduplication applies across associations;
its outbox is separate from receipt-bound lifecycle reporting.

## Engineering qualification

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
soak source is `ce6ee74`; the final candidate's 97 server/harness artifacts were
verified byte-identical, so the browser-only follow-up does not reset that run.
Short fixture runs and elapsed wall time alone do not accept the gate: inspect
the final report, all assertions and successful unit exit.

## Release decision

Accept M6 only after the direct UAT rows and overnight gate pass. Record any
rework or deferred capability explicitly. The previous accepted release and
private state/configuration backup remain available for rollback. A deployment
or passing fixture does not by itself accept a milestone or merge the branch.
