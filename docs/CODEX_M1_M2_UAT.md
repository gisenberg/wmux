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
