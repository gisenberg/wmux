# M1–M2 candidate qualification and rollout

M0–M2 implementation and deployment preparation are authorized. Engineering
results qualify an identified candidate; deployment and native-client acceptance
must be recorded separately. The naming baseline is
[PR #126](https://github.com/gisenberg/wmux/pull/126), commit
`d3be8801f4b3b4e6f6d6ad34de4d66dec4cc34a3`. Keep the name workstream's checkout
isolated from integration work. See [M0 UAT](CODEX_M0_UAT.md) and the
[roadmap](CODEX_INTEGRATION_ROADMAP.md) for the original requirements.

Implementation is reviewed in [PR #127](https://github.com/gisenberg/wmux/pull/127).
The full external POSIX `npm run check` passed at
`48a02b40e3807d247363e846df7423482c82af3b` (1,116 passed, four skipped).
Hosted CI then exposed an installer fixture inheriting `XDG_CONFIG_HOME`;
`e1b85c4` isolates that fixture and tests both supported configuration locations.
It changes no runtime artifact. Record final browser/hosted checks against their
actual revision in the private release evidence and PR validation record; the
earlier check alone does not certify a later runtime change. No rows below have
native UAT acceptance merely because their engineering fixture passes.

## Candidate contents and preflight

Qualify a clean, pushed integration commit containing the server, browser,
plugin, and wmux observer service together. Record its source SHA/tree, built
server/client hashes, plugin file manifest, Node version, and engineering logs
under private `test-results/`. Run the M0 collector against that same checkout.
An installed cachebuster version or executable-only match does not qualify a
different hook/MCP configuration or compiled deployment.

The Linux supervised profile requires the wmux-owned observer user unit on each
executing host. Its worker reads existing private native sockets; systemd owns
worker restart. Hook-only fallback cannot certify recovery after an idle worker
crash. Preserve each host's existing native endpoint selection and wmux helper
credentials. Never infer one host's socket from another host's successful read.
CLI/server versions in browser diagnostics remain explicitly unverified unless
separately measured; plugin versions are observer reports, not install proofs.

Before activation, inspect the live pane/backend mix and save the current wmux
release target, unit settings, plugin artifact, observer processes and a private
state snapshot. State schema 10 increases the stored workspace/tab title bound.
Older builds must refuse it; restoring an older release requires the matching
pre-upgrade state snapshot rather than deleting the version marker. Preserve
post-upgrade evidence before rollback. Restoring a snapshot reverts subsequent
wmux layout/name edits, so record that cost explicitly.

## Engineering gate

Run focused Codex, binding, title, route-policy, diagnostics and persistence
tests while editing. Run `npm run check` on a clean external POSIX runner, then
the browser matrix in [VERIFICATION.md](VERIFICATION.md). Use its complete POSIX
fallback if the Windows lane is unavailable, and record the reason. New reset
tests must operate controls through real authorized HTTP routes. Synthetic
native sockets are deliberate fault fixtures, not native-client certification.

| Check | Required evidence |
| --- | --- |
| Reset API | Independent workspace/tab pins; explicit reset; ambiguous/invalid bodies rejected; browser/helper/automation route grants unchanged; missing exact target rejected |
| State and display | Schema 9 → 10 migration preserves names/pins; future schema refused; reset survives reload; full long/Unicode names retained; grapheme-safe shortened labels |
| Native authority | Exact root/endpoint and live receipt before reads and writes; manual re-pin wins against late samples; stale receipts never regain authority |
| Diagnostics | Naming/activity/transport/binding distinguished; missing name/turn, pin, unavailable socket and delivery failure explained; sample age/expiry visible; no receipts, native paths or credentials returned |
| Worker recovery | Real worker termination and replacement using isolated supervision; kernel lock release after owner death; no lock stealing from a live slow reader; increasing lifecycle sequence after replacement |
| Resource bounds | Twenty synthetic tasks with actual bounded socket concurrency; idle names still sampled; repeated reconnects do not accumulate workers/connections; failing endpoints do not block healthy endpoints |

## Milestone UAT checkpoints

### Final qualification — 2026-09-14

The user requested completion of all open M0–M2 work and confirmed that the
Haswell deployment is in use with a soak already underway. Preserve that running
deployment and its observation history; inject faults only into disposable
fixtures. This section supersedes the earlier rework/pending observations below
where an explicit result is recorded.

| Cases | Result and evidence scope |
| --- | --- |
| N10 | Passed through Codex Desktop's native title control on an idle, unbound disposable task sharing an existing cwd. Eight subsequent samples found no binding or change to any existing wmux workspace/tab name or pin. The exact disposable task was archived. Private evidence: `test-results/m0-unbound-20260914/result.json`. |
| M1-01–M1-03 | Browser tab pinning is now available through **Rename current tab** in Ctrl/Cmd+K or mobile **Chat → Actions**. Its dialog exposes full title, ownership and **Use automatic tab name**, alongside the existing workspace controls. Browser tests preserve the workspace pin through tab rename, reload and reset. Delayed automatic delivery after re-pin preserves the new manual values on desktop/mobile. |
| M1-04 | Renderer now paints complete grapheme clusters once, reserves wide cells and clips only at cluster boundaries. Joined emoji, combining accents and Japanese match browser-shaped reference text in the corrected canvas reproduction. Native full-name/reload and real cycle evidence remains in `test-results/unicode-cycle-20260914/`; corrected visual evidence is in `test-results/unicode-fixed-20260914/`. Final deployed chrome is checked separately. |
| M1-05 | Real authorized title routes now return `404 workspace_not_found` or `404 tab_not_found` for deleted targets. A private Unix-socket outage fixture runs the production observer and real HTTP/PTTY binding; reset persists, other pins survive, and current metadata returns through the same live receipt on recovery. Stale-receipt browser coverage rejects the old receipt and requires fresh PTY proof. These are controlled synthetic native endpoints, not a production outage. |
| M2-01–M2-03, N08 | A unique disposable systemd user unit replaces its SIGKILLed observer; lifecycle sequence advances without duplicate terminal notification. A failed endpoint backs off and recovers while its healthy peer continues. Two actual wmux app browser contexts disconnect entirely and reopen with the same live receipt and an idle rename. After an isolated same-port server restart, the old receipt returns 404 and fresh terminal proof restores the title. `test-results/m2-recovery-20260914/qualification.txt` records the run. |
| M2 resource bounds | Twenty synthetic roots share one actual private Unix-socket transport, with at most four concurrent RPC requests. This short engineering test does not establish a 24-hour soak. |
| M2-04 | Existing production observer uptime exceeded 41 hours at the read-only 2026-09-14 16:23 UTC capture, with zero restarts, no warning-level journal entries and a recorded peak of 48,123,904 bytes (about 46 MiB). This supports production continuity, but no retained 24-hour twenty-root/fault/counter record has been found. Keep the specified synthetic soak open; neither uptime nor the bounded fixture is equivalent evidence. Private capture: `test-results/soak-existing-20260914/service-evidence.json`. |

Run browser-enabled isolated recovery against freshly built assets with
`WMUX_BROWSER_QUALIFICATION=1 node --import tsx --test test/codex-supervised-recovery.test.ts test/codex-outage-reset-recovery.test.ts`.
Default unit runs must not depend on pre-existing build output or browser binaries.
Full candidate checks, deployment identity and live smoke are recorded with the
final release rather than inferred from earlier revisions.

The supplemental load lane uses `node scripts/codex-observer-soak.mjs --out
/absolute/fresh/private-report-dir`. It runs for an actual 86,400 seconds by
default with twenty synthetic binding records, the production supervisor and
two private fixture sockets. Every five minutes one endpoint is unavailable for
twenty seconds; the healthy endpoint must continue sampling and every affected
root must recover its current name. The fixture records ten-second resource
samples, RPC/socket bounds, title and diagnostic counts, and exactly one terminal
lifecycle delivery per synthetic root. Its binding/post adapter is synthetic;
real HTTP authorization, receipt expiry, systemd replacement and server
notification deduplication are qualified by the separate recovery tests above.
The load harness never contacts production wmux or a native Codex endpoint.

Use a fresh output directory, and retain `events.jsonl` and `report.json` with the
source revision. A shorter `--duration-seconds` or explicit accelerated fault
interval is only harness qualification, never a 24-hour pass. Do not replace the
user's already-running production soak with this supplemental fixture lane.

### Direct user observations — 2026-09-14

- **N04: user-confirmed** Codex Desktop → wmux name syncing. This confirms
  the reported Desktop rename flow; it does not accept N10's unbound-task
  isolation or the independent pin/reset matrix.
- **M1-01: original discoverability gap, now resolved.** The user could not find a return
  to automatic action in the deployed desktop browser sidebar menu. The
  sidebar's own rename menu has no reset action. In the deployed candidate,
  select the intended workspace/tab, open **Ctrl/Cmd+K**, and search
  **Use automatic workspace name** or **Use automatic tab name**. The palette's
  **Rename current workspace** dialog also exposes workspace reset; it is a
  different surface from the sidebar rename menu. Mobile uses **Chat → Actions**.
  The sidebar follow-up below supplies that entry point and is user-accepted.
- **Unpin behavior: user-confirmed.** After the control-location guidance,
  the user reported "unpin behavior confirmed." Accept the exercised unpin
  flow. The report does not enumerate surfaces, pin orders, idle timing or
  devices, so it does not independently certify every M1-01–M1-03 matrix case.
  Keep existing agent evidence separate. Outage, stale-binding, race,
  exit-cleanup and soak status are unchanged.

- **Mobile appearance/usability: user-confirmed.** The user reported "mobile
  looks ok as well." Accept the reviewed mobile presentation and usability.
  Specific long/Unicode title edge cases, fault diagnostics and recovery tests
  retain their separate evidence requirements.
- **Sidebar follow-up: user-accepted.** Adds **Use
  automatic workspace name** next to **Rename workspace** in the desktop
  sidebar context menu. Right-click a workspace row or focus it and press
  **Shift+F10**; arrow keys and Enter operate the menu. The action resets that
  row's workspace through the existing route, preserving its tab pins and any
  other active workspace. Browser regression coverage includes keyboard focus,
  exact-target behavior and reload persistence. The user subsequently reported
  "sidebar action confirmed." [PR #130](https://github.com/gisenberg/wmux/pull/130),
  revision `9499c0cd14ae3141c53577ce79d216cfbd555584`, passed external full checks
  (1,116 tests passed, four skipped), the staged sidebar browser regression and
  a live public-browser right-click reset test with pin preservation and reload.
  The wmux-only activation preserved existing workspace/tab names, ownership and
  layouts; native and observer processes/configuration were unchanged. Full
  browser-suite evidence is recorded separately; these targeted passes do not
  accept remaining recovery or soak cases.
- **Diagnostics clarity: user-accepted.** The user explicitly accepted clarity.
  This accepts presentation; controlled outage and stale-binding behavior retain
  separate qualification requirements.
- **Native cycle: agent-tested pass.** On the deployed sidebar revision, a
  disposable native CLI task on the existing App Server issued a real blocking
  Plan-mode input question. Native `waitingOnUserInput` and wmux waiting agreed;
  answering through that exact CLI resumed running, then completed. The browser
  showed waiting, working and done. Exactly one input-required notification and
  one completion notification remained stable for over two minutes, including
  idle native renames and browser reloads. No synthetic lifecycle events or
  receipts supplied this result.
- **M1-04: rework.** Two native titles of 232 and 336 grapheme clusters, including
  combining accents, skin-tone/ZWJ emoji, flags and Japanese, mirrored exactly to
  workspace/tab and survived desktop/mobile reload with complete rename-input
  values. However, canvas labels decompose joined emoji, separate combining
  accents and overlap wide glyphs. An isolated reproduction using the unchanged
  production grid renderer confirms that `writeText` and `GridPainter.paint`
  draw individual code points in successive single-width cells, unlike the
  browser-shaped input. Fix cluster shaping, width allocation and final clipping;
  repeat visual acceptance on sidebar/tab chrome. Normal ellipsis truncation is
  distinct from this defect. Private evidence is under
  `test-results/unicode-cycle-20260914/`, including `cycle-result.json`,
  `unicode-results.json` and `renderer-repro.png`. The exact idle native test task
  was archived and its workspace removed; existing names/pins and all service
  PIDs/restart counts were preserved.

Use disposable tasks and explicit pane IDs. Keep personal names, paths, receipt
markers and tokens in private evidence. Record expected/actual behavior, latency,
candidate identity, screenshots where useful, and accept/rework/defer per row.

| ID | Action and acceptance criterion |
| --- | --- |
| M1-01 | Pin workspace and tab separately through their normal controls. Invoke **Use automatic workspace name**, then **Use automatic tab name** in separate trials. Only the selected ownership changes; the other pin survives. Repeat with both pins set. |
| M1-02 | Rename the native task while one surface is pinned; leave it idle. Reset that surface through the actual desktop/mobile control. The current native name returns on the next healthy sample without another rename or prompt. Measure from metadata visibility, allowing request/delivery time. |
| M1-03 | Reload after reset and re-pin while a controlled sample is delayed. Automatic eligibility persists across reload; the late sample cannot overwrite the new manual pin. |
| M1-04 | Use long names, combining characters and emoji; inspect the full name and narrow chrome on desktop/mobile. Oversized or invalid native names produce a visible diagnostic without silently changing the native name. |
| M1-05 | Simulate metadata outage in an isolated fixture, then reset workspace or tab. Show automatic/awaiting-sync, retain the other pin, and converge after socket recovery through a still-live binding. Repeat with a stale binding: no automatic write until fresh terminal proof. |
| M1-06 | Open diagnostics and the session inspector; refresh explicitly. Identify pin ownership, missing name/turn ID, pending/expired binding, socket outage and failed delivery. Let the view age without refresh; old samples must not remain marked fresh. |
| M2-01 | Kill only a disposable wmux observation worker supervised by the candidate wmux user unit. The owner replaces it while the task stays idle; locks release and current native names return. Verify process/socket bounds and increasing receipt sequence. |
| M2-02 | Simulate endpoint failure and restore the fixture. Healthy endpoints continue sampling; the failed one backs off and recovers without cached title replay, native mutation or duplicate completion notifications. |
| M2-03 | Restart an isolated wmux server and reconnect two browsers. Native work continues; old receipts remain invalid. A fresh observed prompt restores authority. Do not restart a shared native service to inject failure. |
| M2-04 | Run a real 24-hour soak with twenty synthetic bound tasks and periodic controlled faults, retaining process/socket/request counters, samples and notification counts. A shortened or accelerated fixture is engineering coverage, not this acceptance row. |

Complete the M1 checkpoint before promoting its features. Complete M2 fault UAT
and the actual soak before accepting recoverability. User-facing reset acceptance
is distinct from CLI exit cleanup: shared-client `/quit` does not immediately
emit native `SessionEnd`. Immediate detach cleanup is excluded and remains
unaccepted. Delivered-event fixtures do not certify native event delivery.

## Activation and rollback order

1. Stage the exact clean candidate in a new immutable wmux release directory;
   install its dependencies and build there, then verify the artifact manifest.
   Stage its matching wmux plugin and observer-unit definition. Staging does not
   change the active release or restart any service.
2. At the authorized wmux rollout, stop only the old wmux-owned observation
   workers and preserve the previous state/artifacts. Replace server/browser and
   wmux plugin together; keep existing native hooks trusted and host-specific
   endpoint selection intact. Keep legacy wmux Codex reporters disabled. Do not
   modify or restart Codex or its App Server.
3. Install/start the candidate wmux observation user unit on the executing host.
   Record its exact ExecStart/release identity and supervision status. Old
   receipts do not inherit new authority merely because the worker is running;
   establish fresh terminal proof using the ordinary supported prompt path.
4. Run M0 smoke and M1 UAT, then M2 faults and soak. Record which server, browser,
   plugin and observer revisions each result covers. Stop promotion on a failure.
5. Roll back by stopping candidate wmux observers, restoring the prior release,
   matching plugin/unit and pre-upgrade state snapshot, then restarting only
   wmux components. Re-establish terminal proof and verify independent pins.

No unpin, exit-cleanup or soak acceptance is implied by this procedure.
