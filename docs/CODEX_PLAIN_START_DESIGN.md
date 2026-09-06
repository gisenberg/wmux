# Codex plain-start integration: design and acceptance evidence

Status: implemented and tested locally on Linux with Codex 0.153.4 on
2026-09-06. This is not a claim that the user's normal installation or live wmux
service has been updated. The plugin requires the matching wmux server changes.

## Constraints and implementation

- The interactive startup command is exactly `codex`, without a wrapper,
  replacement binary, extra flags, or a special startup sequence.
- All authored implementation changes belong to wmux. Codex source, its normal
  installation, and the user's normal profile are untouched.
- The root agent chooses a semantic task name. Follow-ups preserve that name;
  a material task change can replace it. A hook supplies the naming instruction,
  not a title copied from the user's prompt.
- Codex's saved name is canonical. The plugin calls supported `thread/name/set`
  and `thread/read` APIs, then mirrors the read-back value to the automatic
  **sidebar workspace** title. User-owned wmux titles are preserved.

Daemon-backed Codex does not reliably forward the launching pane's identity to
plugins. A trusted prompt hook therefore issues a challenge and displays a short
public marker. wmux observes it on the current live backend, binds it to its own
pane tuple, and requires a separate private receipt for resolution and title
writes. Neither browser focus nor process timing selects the target. The marker
is visible; there is no silent environment-forwarding dependency.

The plugin's short-lived `codex app-server --stdio` subprocess only reads/sets
the explicit saved name. It does not replace the user's TUI or start a model turn.
Normal plugin installation, hook trust, and tool approval are still required.
See [installation and behavior](CODEX_PLUGIN.md) for operational details.

## Real plugin acceptance tests

Disposable, authenticated loopback wmux services and private Codex profiles were
created inside ignored repository test directories. The actual source plugin was
installed with `codex plugin add` through a local marketplace. Repository trust,
hook trust, and MCP approvals used Codex's normal UI. These tests did not patch
Codex, manually supply a pane tuple, or invoke the naming modules in place of the
agent's real MCP calls.

Two runtime modes were exercised. `/status` confirmed embedded mode in the first
fixture and a local Unix-socket App Server in the second. The second fixture's
harness provisioned a daemon to reproduce an already-running daemon environment;
this is test setup, **not** an additional product startup requirement. The command
typed into both interactive wmux panes was simply `codex`.

| Scenario | Observed result |
| --- | --- |
| Embedded: first substantive task, no request to name wmux | Agent chose “Binary Search Ordering Requirement”; saved name and automatic workspace title matched; `workspaceApplied: true`. |
| Embedded: ordinary follow-up | Semantic title remained unchanged. |
| Embedded: major shift to transaction atomicity | Agent chose “Database Transaction Atomicity Rationale”; saved name and sidebar matched. |
| Embedded: manually pinned workspace, then cache/database task | Saved name and tab changed to “Cache and Database Roles”; sidebar stayed “Pinned By User” with user ownership. |
| Daemon: first task and ordinary follow-up | Same binary-search semantic title; follow-up preserved it. |
| Daemon: major task shift | Saved name and sidebar became “Database Transaction Atomicity Explained”. |
| Daemon: native `/rename Atomic Transaction Notes`, then follow-up | Next prompt synced “Atomic Transaction Notes” from Codex's saved name to the workspace. |
| Daemon: pinned sidebar, then different task | Agent selected “Cache and Database Roles”; sidebar stayed user-owned “Pinned By User”; result reported `workspaceApplied: false`. |
| Daemon: exit, plain `codex`, native `/resume`, follow-up | Agent called sync with the resumed thread and fresh binding; read “Cache and Database Roles”, reported `codexNameSet: false`, and preserved the pinned sidebar. |

Evidence was the live terminal's actual MCP calls/results, explicit saved-name
reads, and the fixture server's authoritative workspace title/ownership fields.
No browser screenshot or visual UI acceptance claim is made. Model-generated
wording is an observation, not a deterministic expected test string.

## Automated and fresh-context verification

The focused suite covers the supported name adapter, plugin MCP, private binding
records, terminal parser/registry, backend lifecycle, and a real authenticated
wmux HTTP + SessionManager + PTY + plugin integration. Only the Codex name API is
faked in that automated end-to-end integration; the separate live tests above use
the actual Codex executable and saved names.

Checks include chunked markers, unknown/expired receipts, delayed human approval,
idempotent redraw, cross-pane conflicts (including separate receipts for the same
session), stale backend output, pane invalidation, supersession, exact-session
locking, partial failures, canonical read-back, and preservation of manual titles.
Route inventory and authorization tests include all three binding endpoints.

Final local results: 26/26 focused tests passed. `npm run check` passed with
1,029 tests passing, four skipped, and no failures, followed by successful
TypeScript, script/contract validation, and production builds. Plugin and skill
validators also passed. The final fresh-context review found no blocking issues.

Fresh-context implementation reviews resulted in per-session serialization,
auto-only naming, lifecycle regression tests, cross-pane ambiguity rejection,
and narrower title responses. The acceptance commands are:

```sh
node --import tsx --test test/codex-name.test.ts test/wmux-plugin-mcp.test.ts \
  test/wmux-binding-store.test.ts test/codex-terminal-binding.test.ts \
  test/codex-binding-lifecycle.test.ts test/codex-plugin-terminal-integration.test.ts
npm run check
```

## Boundaries and limitations

- The visible hook marker is the cost of reliable pane binding without changing
  Codex or its startup command. Unobserved challenges expire after 60 seconds;
  observed leases have a fixed 24-hour ceiling. A server restart requires a new
  prompt to bind again.
- Use one TUI per saved conversation. Known cross-pane ambiguity invalidates
  both bindings rather than guessing; moving to a new pane while the old pane
  remains live may require closing it and submitting a new prompt.
- Agent instructions govern semantic naming and task-shift detection; this is
  not a deterministic classifier. Native Codex name ownership is not exposed by
  the API. Manual **wmux** title ownership is enforced by the server.
- Native `/rename` is mirrored on the next eligible prompt/tool sync, not
  necessarily while idle. Stop reconciliation runs only with an exact matching
  turn ID; absent or ambiguous metadata is ignored.
- Linux/POSIX runtime and privacy checks were tested. Native Windows execution,
  Windows ACL confidentiality, remote App Servers with a different thread store,
  and a full macOS/SSH deployment matrix are not verified by these tests.
- This is a trusted single-user integration, not an isolation boundary against
  another process with that user's file access or terminal-output authority.

## References

- [Codex hooks](https://learn.chatgpt.com/docs/hooks): explicit session metadata,
  visible hook messages, additional context, and hook-specific timeouts.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): explicit
  `thread/read` and `thread/name/set` APIs.
