# Codex wmux plugin

The [harness integration behavior contract](HARNESS_INTEGRATION_SPEC.md) defines
the expected user experience and shared regression cases. This guide describes
the current Codex implementation, not complete conformance. See the contract's
[current conformance record](HARNESS_INTEGRATION_SPEC.md#current-conformance-record)
for known gaps, including daemon-backed lifecycle/activity reporting.
The detailed [Codex conformance matrix](CODEX_CONFORMANCE.md) tracks all 45
requirements and R01–R38, including source changes not yet deployed.

`plugins/wmux` adds task-aware naming to ordinary `codex` sessions. It does not
wrap the command, replace its binary, patch Codex, or edit its database or
transcripts. **wmux owns the automatic semantic title**: after the server
atomically accepts the bound automatic workspace/tab write, the plugin persists
it in private wmux state. Codex's saved conversation name is intentionally untouched;
native `/rename` is independent and is neither imported nor overwritten.

This is an explicit, achievable scope decision, not a claim of native-name
parity. The prior native-canonical implementation failed native acceptance
because Codex exposes no ownership/provenance or compare-and-set signal for a
saved name. Those failures remain historical evidence pending a rerun of the
wmux-owned implementation; they do not become passes merely because the scope
changed. See [native acceptance evidence](CODEX_CONFORMANCE.md) and the
[native API gaps](CODEX_NATIVE_API_GAPS.md).

The plugin and matching wmux server changes must be installed together. Older
wmux servers lack the binding endpoints and the plugin fails without naming.

## How the pane binding works

Daemon-backed Codex may omit `WMUX_WORKSPACE_ID`, `WMUX_TAB_ID`, and
`WMUX_PANE_ID` from hooks, MCP servers, and tools. This integration does not
require those variables or a special Codex startup mode.

1. A trusted root `UserPromptSubmit` hook uses its explicit `session_id` to request
   a challenge from `POST /api/codex-bindings`.
2. The hook displays a short `[[WMUX:...]]` marker through Codex's supported hook
   message channel. This is intentionally visible; it is not a terminal escape.
3. wmux observes that marker on the live backend stream and binds it to its
   server-owned workspace/tab/pane tuple. A separate random receipt stays in a
   private plugin runtime record, never in model context or terminal output.
4. MCP resolves the receipt through `POST /api/codex-bindings/resolve` before
   storing or synchronizing the wmux-owned semantic title. `POST
   /api/codex-bindings/title` revalidates the binding before applying the
   automatic title.

There is no browser-focus, cwd, process-timing, latest-prompt, transcript, or
recent-session lookup. Browser replay/checkpoints are not parsed. The backend
listener checks its session incarnation; replacement, exit, recycle, disposal,
and shutdown invalidate the corresponding bindings. Duplicate output in the same
pane is idempotent; a known cross-pane marker conflict fails closed. Separate
receipts for the same Codex session observed in different panes also invalidate
both bindings. A newer observed challenge supersedes the old pane binding,
and old markers cannot
reactivate it. Terminal text is not an authentication boundary against other
programs already running as the same trusted local user.

The server holds at most 512 challenges in memory. Unobserved markers expire
after 60 seconds. Observed leases expire no later than 24 hours after issuance;
replays and API calls do not extend them. Server restart forgets all receipts;
the next prompt establishes a new binding. No binding persistence migration is
needed. Concurrent TUI clients rendering the same hook marker are ambiguous and
may disable naming for that challenge rather than selecting the first client.
Use one TUI per saved conversation. Moving a conversation to another pane while
its previous pane remains live can also fail closed; close the old pane and
submit a new prompt to establish a fresh binding.

When inspecting another session, redact live hook markers before displaying its
terminal output in the observing wmux pane. Echoing a marker into a second live
pane can invalidate the observed session's binding; it does not grant the
observer naming authority. Retry with a new prompt and uncontaminated capture.

## Tools and naming policy

Every tool takes the exact `sessionId` and public `bindingId` supplied by the
current trusted prompt hook. The receipt is not a tool argument.

- `get_current_wmux_session(sessionId, bindingId)` reports only the resolved
  tuple. It does not request broad wmux read access.
- `name_current_wmux_session(sessionId, bindingId, title, mode="auto")`
  resolves and preflights its private store, asks the server to atomically
  accept the automatic bound title (including manual-pin checks), then persists
  the semantic title only after acceptance. It never calls Codex's name API.
- `sync_current_wmux_session(sessionId, bindingId)` reuses and mirrors the
  wmux-stored title without changing it. It never reads a native saved name.

Only **automatic** naming is supported. The server rejects `manual` mode, so
the naming tools cannot bypass a user-owned workspace or tab title. Use wmux's
UI for manual names.

The prompt hook asks the root agent to choose a concise 3–7 word title for the
first substantive objective, not a copy or truncation of the latest prompt.
Follow-ups, clarifications, status requests, and testing preserve it. A material
objective change calls for a new semantic title; other turns call sync with the
new prompt binding. The hook itself never generates a title from prompt text.
This is an agent instruction, not a deterministic guarantee that a model will
follow the policy. Root-only behavior is instructional; it is not a separate
authorization boundary against a child with access to the same private files.

The Stop hook reconciles only when Codex supplies a `turn_id` matching exactly
one recorded prompt binding. If that field is absent or ambiguous, Stop does not
guess. It can only resync wmux's stored title; it never treats native `/rename`
as a title update.

Manual wmux workspace and tab titles remain independently user-owned. Automatic
wmux writes do not clear those pins, and clearing a pin remains an explicit wmux
UI action. Results report `namingMode: "wmux-owned-name"`, `wmuxName`,
`nativeNameRead: false`, `nativeNameSet: false`, `wmuxNameSaved`,
`workspaceApplied`, and `tabApplied`. A successful tab update alone is not proof
of a sidebar update. There is deliberately no `codexName` or `codexNameSet`
result because no native name operation occurred. If the server rejects the
title (including a `409` pin/binding race), `wmuxNameSaved` is false and the
user/model must retry `name_current_wmux_session`, not sync. If the server
accepted the title but the subsequent store write failed, report the actual
`workspaceApplied`/`tabApplied` values with `wmuxNameSaved: false` and retry
`name_current_wmux_session`. A later mirror of an already saved title retries
with `sync_current_wmux_session`.

## Installation and dependencies

Install the source plugin from a Codex local marketplace using the normal plugin
installation workflow. Start a fresh conversation, review/trust the two plugin
hooks through `/hooks`, and approve the narrowly scoped MCP tools through Codex's
normal approval UI. No hand-edited Codex settings or startup flags are required.
After this normal setup, launch with just `codex` inside wmux.

Node.js and the ordinary Codex executable must be available to the hook/MCP
process. The packaged MCP command uses `cwd: "."` and a plugin-relative script
path; `$PLUGIN_ROOT` is available to hooks, not an MCP argv substitution.

For a root prompt with a native `turn_id`, the hook now starts a plugin-owned
read-only observer automatically, independently of model naming calls. It uses
the existing local App Server's owner-only Unix socket; it does not start a
daemon, require another user command, resume a thread, or answer approvals.
Every sample resolves the same private binding and native turn. The two-second
poll maps native active/attention/exact terminal states through
`POST /api/codex-bindings/lifecycle`; sequence ordering prevents replay from
refreshing liveness. Uncertainty does not refresh the last authoritative sample.
If the first bound sample is unavailable, wmux shows one static status-unknown
diagnostic without inventing a native running state or sending a notification.
The server checks every five seconds and displays `! status unknown` after
30 seconds without authoritative activity. An actual terminal outcome ends that
observer. This is integration liveness, **not** a scheduled-heartbeat feature.
Exact-turn recovery reads at most four pages of eight metadata-only turns;
an older turn beyond that bound or inconsistent pagination remains unknown.

Unrelated activity cannot age a pane's current status out of the sidebar. wmux
retains its recent 300 activity events plus one current event per extant layout
pane, without re-emitting diagnostics or renewing observation confidence. A new
current event replaces the retained old state, and removing the pane releases
it. This retention applies to every harness, not only Codex.

This path has production-wiring and desktop/mobile browser fixture tests.
Isolated real plain-`codex` parent/child sessions using the updated source also
demonstrated running, native approval attention, completion, and separate
parent/child state, with desktop/mobile sidebar captures. The superseded
native-canonical design had naming failures. The fresh wmux-owned daemon fixture
now verifies first-task, follow-up, objective-shift, child, manual-pin, and
native-`/rename` independence with native names untouched. Its static local
captures are not publishable or proof of animation; the separate browser fixture
has the dynamic assertion. The isolated profile is not acceptance for resume,
the ordinary installed profile, other platforms, uninterrupted animation timing,
or restart/reconnect behavior. Nothing has been deployed. Missing
prompt `turn_id` produces a capability diagnostic, not a guessed turn. Embedded
mode, automatic continuations without a new prompt hook, and exact native
pending-request identities remain unresolved; see the conformance matrix.

The plugin uses existing wmux URL and helper credentials. Refreshed credential
files take precedence over inherited values; a configured but missing or invalid
helper credential never downgrades to a broad token. Login-only mode requires
scoped helper authority. Requests remain behind wmux's private-network and exact
route authentication policies, use Authorization headers, and reject redirects.
The URL is restricted to allowed private/Tailscale/loopback destinations or
explicitly allowlisted hosts.

If legacy wmux Codex lifecycle hooks are installed, their existing `--no-title`
opt-in must remain enabled so prompt/Stop telemetry does not overwrite semantic
titles. The plugin does not rewrite unrelated lifecycle configuration; do not
install duplicate legacy hooks as a prerequisite for the new observer.

This preserves title ownership but does not make legacy lifecycle reporting
daemon-safe. Those hooks still require pane identity environment variables. Live
testing found missing activity events when Codex omitted them, even though the
naming plugin worked. The new observer routes activity through naming's trusted
binding, but coexistence with legacy lifecycle events still needs acceptance.

Receipt records live under `~/.wmux/codex-plugin`, not in Codex's thread store.
They are schema-validated, owner-private, atomically written, capped, and expired
after 24 hours. The name store uses bounded atomic writes; a per-Codex-session
lock serializes title acceptance and persistence across different receipts. A
hard-killed process can leave a lock: verify no operation
is running before removing that exact lock; there is no unsafe stale-lock unlink.
Private ownership/mode checks and live acceptance testing currently target POSIX
hosts. Windows ACL confidentiality and native Windows plugin execution have not
been verified; do not treat POSIX mode checks as equivalent Windows protection.

Naming does not invoke `codex app-server --stdio`, `thread/read`, or
`thread/name/set`. The separate lifecycle observer uses only its documented
read-only App Server surface; it never resumes, forks, starts a model turn, or
replaces the user's TUI. The observer remains experimental and version-bounded;
an unrelated remote App Server is unsupported.

## Verification

```sh
node --import tsx --test test/wmux-plugin-mcp.test.ts test/codex-name-ownership.test.ts \
  test/codex-rpc.test.ts test/codex-lifecycle.test.ts \
  test/codex-observer.test.ts test/codex-observer-integration.test.ts test/codex-lifecycle-server.test.ts \
  test/wmux-binding-store.test.ts test/codex-terminal-binding.test.ts \
  test/codex-binding-lifecycle.test.ts test/codex-plugin-terminal-integration.test.ts
npm run check
```

The integration test must exercise the production plugin, authenticated HTTP
routes, SessionManager, live PTY output, wmux-owned title persistence, and title
ownership together. Historical native-name fixtures and live tests belong to the
superseded design; they are not verification of this mode. The separate revised
native tests are recorded in [plain-start evidence](CODEX_PLAIN_START_DESIGN.md), with the
precise evidence boundary and remaining limitations.

The focused wmux-owned fixture log at
`test-results/codex-wmux-owned-focused.log` records 19 passing checks covering
`409` title rejection, `503` title-delivery/acceptance uncertainty, and injected
post-acceptance local-store failure. It is fixture evidence, separate from the
isolated native acceptance record, and neither is deployment evidence.

Protocol references: [Codex hooks](https://learn.chatgpt.com/docs/hooks) and
[Codex App Server](https://learn.chatgpt.com/docs/app-server).
