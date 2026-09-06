# Codex wmux plugin

`plugins/wmux` adds task-aware naming to ordinary `codex` sessions. It does not
wrap the command, replace its binary, patch Codex, or edit its database or
transcripts. **Codex's saved conversation name is canonical**: the agent chooses
a semantic title, the plugin sets it through the supported App Server API,
reads it back, and mirrors the accepted value to wmux's sidebar workspace title.

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
   reading or setting the Codex name. `POST /api/codex-bindings/title` revalidates
   the binding before applying the automatic title.

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

## Tools and naming policy

Every tool takes the exact `sessionId` and public `bindingId` supplied by the
current trusted prompt hook. The receipt is not a tool argument.

- `get_current_wmux_session(sessionId, bindingId)` reports only the resolved
  tuple. It does not request broad wmux read access.
- `name_current_wmux_session(sessionId, bindingId, title, mode="auto")` sets the
  saved Codex name, reads it back, and mirrors it.
- `sync_current_wmux_session(sessionId, bindingId)` reads and mirrors the saved
  name without changing it; this also retries a partial synchronization failure.

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
guess. Native `/rename` is therefore mirrored by the next eligible prompt/tool
sync, not necessarily while the TUI is idle. Codex does not expose title ownership
through this name API; preservation of an explicitly chosen native name also
relies on the agent's instructions and conversation context.

Results distinguish `codexNameSet` (true, false, or `"unknown"` if the set
acknowledgement was lost), `codexName`, `workspaceApplied`, `tabApplied`, and
`error`. A successful tab update alone is not proof of a sidebar update. A
failed wmux write does not undo a saved Codex name: retry sync, not another set.

## Installation and dependencies

Install the source plugin from a Codex local marketplace using the normal plugin
installation workflow. Start a fresh conversation, review/trust the two plugin
hooks through `/hooks`, and approve the narrowly scoped MCP tools through Codex's
normal approval UI. No hand-edited Codex settings or startup flags are required.
After this normal setup, launch with just `codex` inside wmux.

Node.js and the ordinary Codex executable must be available to the hook/MCP
process. The packaged MCP command uses `cwd: "."` and a plugin-relative script
path; `$PLUGIN_ROOT` is available to hooks, not an MCP argv substitution.

The plugin uses existing wmux URL and helper credentials. Refreshed credential
files take precedence over inherited values; a configured but missing or invalid
helper credential never downgrades to a broad token. Login-only mode requires
scoped helper authority. Requests remain behind wmux's private-network and exact
route authentication policies, use Authorization headers, and reject redirects.
The URL is restricted to allowed private/Tailscale/loopback destinations or
explicitly allowlisted hosts.

If legacy wmux Codex lifecycle hooks are installed, their existing `--no-title`
opt-in must remain enabled so prompt/Stop telemetry does not overwrite semantic
titles. For a new setup, `wmux-hooks install codex --agent-titles` installs that
wmux integration setting. Installing the naming plugin alone does not rewrite
unrelated lifecycle configuration.

Receipt records live under `~/.wmux/codex-plugin`, not in Codex's thread store.
They are schema-validated, owner-private, atomically written, capped, and expired
after 24 hours. A per-Codex-session lock serializes read/set/read/mirror across
different receipts. A hard-killed process can leave a lock: verify no operation
is running before removing that exact lock; there is no unsafe stale-lock unlink.
Private ownership/mode checks and live acceptance testing currently target POSIX
hosts. Windows ACL confidentiality and native Windows plugin execution have not
been verified; do not treat POSIX mode checks as equivalent Windows protection.

The short-lived `codex app-server --stdio` subprocess uses only initialization,
`thread/read` with `includeTurns: false`, and `thread/name/set`. It never resumes,
forks, subscribes, starts a model turn, or replaces the user's TUI. Calls have a
six-second deadline and bounded protocol input. The local helper must share the
TUI's Codex profile/thread store; an unrelated remote App Server is unsupported.
The App Server API is experimental and incompatible versions fail closed. An
already-open TUI may retain an older name in its exit hint until resume even when
the saved name and sidebar are correct.

## Verification

```sh
node --import tsx --test test/codex-name.test.ts test/wmux-plugin-mcp.test.ts \
  test/wmux-binding-store.test.ts test/codex-terminal-binding.test.ts \
  test/codex-binding-lifecycle.test.ts test/codex-plugin-terminal-integration.test.ts
npm run check
```

The integration test exercises the production plugin, authenticated HTTP routes,
SessionManager, live PTY output, and title ownership together; only Codex's name
API is a fixture there. Separate live tests use the real installed Codex plugin
and binary. See [plain-start evidence](CODEX_PLAIN_START_DESIGN.md) for the precise
live acceptance status, including runtime mode and remaining limitations.

Protocol references: [Codex hooks](https://learn.chatgpt.com/docs/hooks) and
[Codex App Server](https://learn.chatgpt.com/docs/app-server).
