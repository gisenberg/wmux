# Codex plain-start integration: current scope and historical evidence

The ordinary interactive command remains `codex`. The approved 2026-09-11
profile is **native-name-mirror**: poll the exact native conversation name through
a supported existing private App Server, then mirror it to its live receipt-bound
wmux tab/workspace. No native write, separate wmux semantic title, database patch,
transcript edit, wrapper or replacement server participates.

See [CODEX_PLUGIN.md](CODEX_PLUGIN.md) for the maintained implementation contract,
socket selection, desktop binding boundary, manual pins, failure handling and
tests. [CODEX_NATIVE_API_GAPS.md](CODEX_NATIVE_API_GAPS.md) records the read-only
native audit. Bounded Linux test deployment and live acceptance are recorded in
[CODEX_CONFORMANCE.md](CODEX_CONFORMANCE.md). Immediate shared-client `/quit`
cleanup and user-facing unpin controls are outside this PR's scope.

Name polling continues while idle within the terminal binding lease. Missing
names and inaccessible endpoints leave wmux unchanged. Native turn ID is needed
for lifecycle observation, not for reading a name. A desktop-only task with no
marker observed on a wmux backend is unbound; readable metadata alone cannot
identify a pane.

The experiments below used superseded naming designs. They preserve historical
evidence and must not be read as acceptance tests of today's mirror.

## Historical native-canonical evidence

Earlier local Linux tests used a different design: the plugin set a Codex saved
name through `thread/name/set`, read it back, and mirrored it to wmux. They
included embedded/daemon naming, follow-up, task-shift, pinned-surface, native
`/rename`, and resume scenarios. That design is superseded and its observed
native writes/mirroring are not current behavior or acceptance evidence for the
current read-only mirror.

Its later native acceptance also failed when Codex-generated names could not be
distinguished from manual names. Those failures remain historical failures of
the superseded design; changing scope does not convert them into passes.

## Historical wmux-owned native acceptance

An ignored, local-only record at
`test-results/codex-wmux-owned-native-evidence.json` captures a plain-`codex`,
isolated-HOME, Codex 0.153.4 daemon fixture. Its companion local-only resumed
and input records verify a same-pane native `/resume` and aggregate input
attention. The fixture verified first-task semantic naming, a fresh-binding follow-up
sync, material objective shift, a nested child workspace, manual workspace pin
with automatic tab update, and independence from native UI `/rename`. Native
names remained untouched throughout; the child did not alter its parent.

The initial four parent turns, same-pane resumed follow-up, and final input
question all completed. The final local record
`test-results/codex-wmux-owned-native-final.json` contains six parent completion,
six approval, and one input notifications; the child has one approval and one
completion notification. The native question answer returned input-waiting to
running and then completed. Local desktop/mobile captures show the waiting, working, and completed
indicators; they are not publishable or animation proof because they contain a
fixture host label. A separate browser fixture supplies the dynamic-animation
assertion. This native slice verifies same-pane resume only; it does not certify
restart/reconnect, deployment, other platforms, cross-pane handoff, request identities, a browser
answer bridge, or full conformance.

The final pre-base-integration full check passed (1,075 passing tests, four
skipped), and the desktop/mobile lifecycle browser fixture passed 2/2.
The temporary native fixture and copied test credentials were removed afterward;
the normal services were not deployed or restarted.

## Remaining boundaries

- Native name writes and ownership provenance remain unsupported; read-only
  mirroring is described in [CODEX_NATIVE_API_GAPS.md](CODEX_NATIVE_API_GAPS.md).
- Linux/POSIX evidence does not certify Windows ACLs/native plugin execution,
  remote App Servers with another thread store, macOS/SSH, or a deployed service.
- This is a trusted single-user integration, not isolation from another process
  with the same user's terminal or file access.
