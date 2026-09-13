# Codex wmux plugin

For reproducible candidate identification and the next native-client acceptance
gate, use the [M0 UAT procedure](CODEX_M0_UAT.md). The collector can inspect a
separate naming candidate without modifying its checkout or native configuration.

`plugins/wmux` mirrors Codex conversation names **one way into wmux**. Native
automatic names and subsequent desktop or CLI renames are canonical. The plugin
never writes native names, starts or resumes a Codex thread, patches a database
or transcript, or launches another App Server. Ordinary terminal startup remains
`codex`.

The selected profile is `native-name-mirror` (2026-09-11). This replaces the
previous independent wmux semantic-name mode. There is no agent-generated wmux
name and no local name cache to become a competing authority. Existing
`wmux-session-names-v1.json` files are ignored and left untouched. Native
ownership provenance and compare-and-set remain blockers for **native writes**;
they are unnecessary for this read-only mirror.

## Exact binding

1. The trusted root `UserPromptSubmit` hook requests a challenge for its exact
   `session_id` from `POST /api/codex-bindings`.
2. The hook displays a short `[[WMUX:...]]` marker through the supported hook
   message channel. A separate private receipt stays in the plugin runtime.
3. A live wmux backend must observe the marker to establish its server-owned
   workspace/tab/pane tuple. Hook output alone is not a binding.
4. Every name sample resolves that receipt before reading Codex. The title
   endpoint resolves it again and checks automatic ownership and manual pins
   atomically when applying the result.

No inherited pane variables, browser focus, cwd, latest-thread search, process
timing or transcript inspection selects a target. Browser replay/checkpoints
are not parsed. wmux backend replacement or exit, pane disposal and server
shutdown invalidate bindings. A supported root `SessionEnd` hook also removes its captured
local receipts and revokes those exact receipts through
`POST /api/codex-bindings/revoke`. When Codex delivers that event, cleanup can
stop name mirroring even when the containing shell stays alive. Delayed revocation of an
old receipt cannot revoke a later prompt's new receipt. Repeated markers in the same pane are idempotent; another
pane observing the same marker invalidates it. Separate receipts for one native
conversation in different live panes also fail closed. Different conversations
in different tabs keep separate bindings.

The first layout pane owns its tab's automatic title; the first pane of the
first tab owns the workspace title. Other splits cannot overwrite those shared
surfaces. Manual workspace and tab pins are independent and persist until an
explicit wmux unpin. The next successful sample applies the current native
name after unpinning, even if Codex has not renamed it again. In the command
palette, **Use automatic workspace name** and **Use automatic tab name** reset
only the selected surface. The workspace rename dialog also offers reset.
Controls show their target/ownership and acknowledge the change. Until a valid
sample arrives, default ownership means automatic eligibility/awaiting sync.
Both existing title routes accept explicit `{ "clear": true }`; ambiguous
reset/title bodies are rejected, and existing route grants are unchanged.
Native-client acceptance is recorded separately from browser fixture success.

There are at most 512 memory-only challenges. Unobserved challenges expire after
60 seconds; observed leases expire within 24 hours of issuance. API calls and
replays do not renew leases. A new observed prompt replaces the previous binding.
A wmux restart needs a fresh prompt. Immediate cleanup on shared-client `/quit`
or disconnect is **outside this PR's scope**. Detaching a client does not
immediately emit native `SessionEnd`; an idle native session may still exist.
The observer and receipt can therefore remain until a delivered `SessionEnd`,
a replacement prompt/backend, pane closure, or the 24-hour lease expiry. The same
bounds apply to a crash without `SessionEnd`. Close the old pane before repurposing
it if no new Codex prompt will replace its binding. This plugin does not infer
client exit from process timing or archive a native conversation to force cleanup. Reconnecting a browser to the same live
durable backend retains its binding; replacing the backend does not.

Do not print another task's raw hook marker in a live wmux terminal during
diagnosis: that creates a cross-pane conflict. A marker is not an authorization
boundary against another process running as the same trusted user.

## Native metadata and desktop boundaries

The name observer polls `thread/read` with the exact thread ID and
`includeTurns: false` on a nominal two-second cadence after successful binding.
It accepts only that root's printable, nonempty name, bounded by both 512 grapheme
clusters and 4,096 UTF-16 code units. Accepted native whitespace/punctuation is
preserved exactly. Larger/invalid names are skipped with a diagnostic; missing
names retain the current title. Presentation uses shorter grapheme-safe labels
with accessible full names. State schema 10 migrates prior names/pins unchanged;
an older server requires its pre-upgrade snapshot for rollback.

Polling continues after turn completion until SessionEnd, revocation or expiry.
An unavailable native socket closes that connection; subsequent samples reconnect
and read fresh metadata. No cached name is replayed through an outage.
Observer and MCP reads/writes serialize through the same per-thread lock so a
slower old sample cannot overwrite a later sample from this plugin.

`thread/read` does not subscribe to thread events. The installed protocol
includes `thread/name/updated`, but has no observation-only thread subscription
used here. The implementation does not resume a thread to receive notifications.
It therefore supports bounded idle **polling**, not an event subscription.
See the [official App Server documentation](https://learn.chatgpt.com/docs/app-server).

By default, the existing private socket is
`$CODEX_HOME/app-server-control/app-server-control.sock`, with
`$CODEX_HOME` defaulting to `~/.codex`.
For a managed backend with a different socket, set
`WMUX_CODEX_SOCKET_PATH` to its absolute path in the hook and MCP environments.
The socket and its immediate directory must be owner-only, owned by the current
user, and not symlinks. There is no endpoint discovery, TCP fallback, proxy
startup or automatic service management.

Desktop, standalone and daemon clients need not share a process or store.
Verify that the configured endpoint returns the **exact thread ID and name**.
A stored desktop thread may be readable with `status: notLoaded`; that is
sufficient for its name, not evidence that this server owns its active turn.
A desktop rename becomes visible to wmux once this metadata endpoint exposes it.

A desktop-only task has no implicit wmux target. Its marker must actually reach a
live bound wmux terminal for automatic mirroring. If it does not, binding remains
pending and expires; the plugin does not attach an arbitrary existing tab. Opening
or attaching the conversation in the intended supported terminal and submitting
a fresh prompt establishes the ordinary binding. Concurrent views that produce
ambiguous markers remain unsupported. A daemon-global environment tuple cannot
replace this proof.

## Tools and results

Every tool takes the exact current `sessionId` and public `bindingId` from the
trusted prompt hook; receipts and credentials never enter model arguments.

- `get_current_wmux_session` resolves the exact tuple without broad inventory
  access.
- `sync_current_wmux_session` reads the native name and applies it to eligible
  bound wmux surfaces.
- `name_current_wmux_session` is a compatibility alias for older callers. Its
  `title` is ignored; it cannot create an independent semantic name. Only
  `mode: "auto"` is accepted.

Results report `namingMode: "native-name-mirror"`, `nativeNameRead`,
`nativeNameSet: false`, the representable `nativeName`, actual workspace/tab
titles and sources, and separate application flags. A matching no-op or manual
pin can report `workspaceApplied: false`. A successful tab update alone is not
a sidebar update. Missing names produce a skipped result; failures retain the
current titles and identify `sync_current_wmux_session` as the retry. A stale
binding needs a fresh prompt in the actual terminal.

The prompt hook starts the observer independently of model tool calls. It never
asks the model to invent another name. Stop may perform a final sync only when
its exact `turn_id` identifies one prompt receipt; absent or ambiguous IDs are
not guessed. Name polling does not require a native turn ID.

## Installation and operations

Install the updated source plugin through Codex's normal marketplace workflow,
reload its MCP configuration, and review/trust its prompt, Stop and SessionEnd hooks through
`/hooks`. Node.js must be available. The updated wmux server must include the receipt-revocation
endpoint; older releases cannot revoke server receipts from SessionEnd. The packaged MCP command uses a
plugin-relative script and `cwd: "."`; `$PLUGIN_ROOT` is not an MCP argument
substitution. Matching wmux binding/title endpoints and separately provisioned
helper credentials are required.

Deploy/reinstall the plugin on each executing host and configure that host's
verified metadata endpoint. Do not assume updating the wmux service updates
already cached Codex plugins or existing hook processes. No service restart is
performed by this implementation.

The supported profile uses the plugin alone for Codex naming and lifecycle.
After installing and trusting the plugin, run `wmux-hooks uninstall codex` on
each executing host. This removes only the old generated `wmux-agent-event
--agent codex --codex-hook` handlers, including `--no-title` variants, and
preserves unrelated hooks. Start a fresh Codex session after migration.
Do not run `wmux-hooks install codex` alongside this plugin: the old prompt,
PreToolUse and Stop reporters are a separate legacy profile, not an automatic
fallback. Missing native lifecycle metadata must remain visibly unknown rather
than being masked by a second reporter. Manual pins are never reset during upgrades.

Credentials retain existing private-network, scoped-helper, file-rotation and
no-redirect rules. An empty/missing configured helper credential does not fall
back to broad authority. Receipt records are private, schema-validated, atomic
and bounded under `~/.wmux/codex-plugin`. Version 3 receipts capture their native
socket selection and persist lifecycle sequence numbers. Legacy version 2
receipts lack an endpoint and are excluded from unattended supervision; obtain
fresh terminal proof after upgrade. Explicit legacy MCP operations remain
compatible. Linux `flock` on parent-held descriptors releases serialization when
an observer dies. Lock inodes are retained; do not delete a live lock file.
Malformed legacy lock files fail closed and require an operator to verify that
the old wmux observer is stopped before retiring the incompatible artifact.

Lifecycle authority remains separate: it requires the hook's exact native
`turn_id`, reads bounded metadata and reports active/aggregate attention/terminal
states without native control. Once a terminal outcome is accepted, continued
name sampling does not create another outcome. Missing authoritative activity becomes
status unknown. This is not a scheduler or a browser question-answer bridge.

### Linux observation supervision and diagnostics

`scripts/install-codex-observer-service.sh` stages the wmux-owned
`wmux-codex-observer.service` user unit, without starting it. Start/enable it as
part of the authorized wmux rollout. Node.js 22+, Linux `flock`, existing wmux
helper authorization and readable private native sockets are prerequisites.
The unit restarts failed workers and scans while idle; hooks also start a
singleton fallback worker, whose crash recovery requires the supervised profile.
No native service/configuration is installed or modified by the script.

The sampler considers at most 512 private receipts, selecting up to twenty
roots per cycle with four concurrent sampling jobs. Connections are scoped to
the exact selected roots of each recorded endpoint; unused connections close.
Larger inventories rotate fairly with correspondingly slower per-task cadence.
Endpoint failures back off independently, capped at thirty seconds plus jitter.
Healthy cycles retain the nominal two-second interval plus bounded request time;
the server's thirty-second activity confidence limit is unchanged. This does
not qualify an overloaded/failing twenty-task deployment as meeting a latency SLO.

Receipt-scoped observation reports feed `/api/doctor` and the on-demand session
inspector. They distinguish naming, activity, native transport, terminal proof,
manual ownership, age, expiry and bounded counters. Compatibility is explicitly
unverified when no matching native version evidence exists. Diagnostics reveal
neither receipts nor native endpoint paths and never grant native control.
An expired/unavailable binding requires fresh terminal proof; socket recovery
alone is sufficient only while the binding remains live.

See [M1–M2 UAT and rollout](CODEX_M1_M2_UAT.md) for fault injection, the actual
24-hour soak and rollback. These acceptance rows remain open until recorded.

## Validation and limits

Focused tests exercise the production plugin, authenticated HTTP routes, real
PTY/tmux marker binding, native metadata socket fixtures, idle renames, manual
pins and fixture-level pin clearing, stale receipts, outages and connection
recovery. They assert that no native name write, resume, start or approval response
is sent. SessionEnd tests explicitly deliver a fixture hook event, keep the shell
alive and verify that later native name changes no longer apply. They prove the
cleanup handler, not native event emission after a real client's `/quit`.

```sh
node --import tsx --test test/wmux-plugin-mcp.test.ts test/codex-name-observer.test.ts \
  test/codex-rpc.test.ts test/codex-observer.test.ts \
  test/codex-observer-integration.test.ts test/codex-plugin-terminal-integration.test.ts
npm run check
```

Read-only native checks on 2026-09-11 found an active desktop task with a name
through one existing daemon and a different desktop task's stored name through
another host's explicitly configured managed socket. The first daemon could not
read the second task; the second host had no default daemon socket. CLI schema
0.154.0 and live server 0.153.4 were inspected. These establish metadata visibility,
not live rename propagation or desktop-to-pane binding acceptance.

A bounded Linux test deployment on 2026-09-12 verified the installed plugin on
two executing hosts. Live terminal acceptance covered idle native `/rename`
mirroring, independent workspace-pin preservation, blocking input returning to
running/completed with one completion notification, browser refresh during work,
and user-confirmed image clipboard paste. The audited name was already mirrored
before the agent's explicit sync calls, which were no-ops.

The exit investigation is closed by scope: immediate shared-client `/quit`
cleanup is excluded, not a passing acceptance result. Native SessionEnd emission
has not been live-certified; the receipt cleanup handler has fixture coverage.
User-facing unpin controls have engineering fixtures; native-client UAT remains
pending. Linux supervised observation is the M2 target; macOS/Windows acceptance
and arbitrary desktop pairing are unclaimed. Windows Unix-socket observation is
unsupported.
The [conformance ledger](CODEX_CONFORMANCE.md) retains the older native-write and
wmux-owned experiments as historical evidence; they do not certify this profile.
