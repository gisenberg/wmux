# Native Codex task catalog and CLI views

This wmux-owned integration adds a read-only task catalog, display associations
and explicit fresh CLI views through existing native endpoints. Open **Codex
tasks** from the desktop command palette or mobile **Chat → Actions**. The
receipt-bound naming plugin remains separate: browsing or associating a task
does not give it title ownership, send input, or establish a terminal binding.

The initial candidate transport target is Linux, locally and over SSH to another
configured Linux host. Other POSIX combinations require their own qualification.
Windows native observation is unavailable. No Codex source, configuration,
database or App Server lifecycle changes are required.

## Explicit endpoint configuration

Set `WMUX_CODEX_CATALOG_CONFIG` for the wmux server to an absolute path to a
private JSON file. Its parent and file must be owned by the wmux account, with
permissions `0700` and `0600`; symbolic links are rejected. An absent variable
disables endpoint discovery. Configuration is loaded on server startup.

```json
{
  "schemaVersion": 1,
  "endpoints": [
    {
      "id": "native-local",
      "label": "Local Codex",
      "machineId": "local",
      "transport": "local",
      "socketPath": "/run/codex/app-server.sock",
      "allowFreshLaunch": false,
      "managedLaunch": {
        "launcherPath": "/home/operator/.local/bin/codex-guard",
        "deploymentPath": "/home/operator/.local/share/codex-usage-guard/releases/qualified"
      }
    },
    {
      "id": "native-remote",
      "label": "Remote Codex",
      "machineId": "linux-host",
      "transport": "ssh",
      "socketPath": "/run/codex/app-server.sock",
      "nodePath": "/usr/bin/node",
      "bridgePath": "/srv/wmux/scripts/codex-catalog-bridge.mjs",
      "allowFreshLaunch": false
    }
  ]
}
```

Machine IDs must match existing static local/SSH wmux hosts. Dynamic registered
hosts are not accepted for catalog endpoints. The SSH route uses the existing
account, host key and authentication configuration with batch mode and strict
host-key checking. Build the wmux checkout on the remote host so the bridge can
import its matching `dist/server/codex-catalog-rpc.js`. The bridge accepts one
bounded JSON request on stdin, permits only list/read/turn-history operations,
and bounded loaded-owner inventory operations, and connects only to an existing
private, owned Unix socket. It is not a general
RPC proxy and never starts an App Server.

At most eight endpoints may be configured. A query returns at most forty tasks
or eight turns, with a two-MiB transport response limit. Local requests have a
four-second overall deadline; SSH requests have an eight-second outer deadline.
At most four queries run concurrently. Failed endpoints back off; cached data
is explicitly stale. Refresh and pagination never resume or subscribe to tasks.
The native schema was checked against CLI/App Server 0.154.0; repeat capability
checks after native upgrades rather than assuming every endpoint supports
history. Model/provider fields are configuration metadata, not per-turn proof.

## Display associations and activity

Tasks are keyed by endpoint identity and exact native thread ID. Equal names or
working directories do not merge tasks. An endpoint's transport/configuration
and static host identity form its fingerprint; replacing the host or endpoint
invalidates prior associations instead of transferring them.

Choose an exact workspace/tab/pane in the catalog to add a display association.
Each association can be moved or removed independently. Missing or replaced
targets remain unresolved after reload. Native names stay read-only, and manual
workspace/tab pins are unaffected. Use existing native clients to rename tasks.

wmux samples associated tasks independently of browser viewers, with bounded
polling, and labels their activity as native task activity. It does not adopt
successor turns into a prompt-bound terminal receipt. Initial completed history
does not generate notifications. Subsequent terminal outcomes use a deterministic
outbox to deduplicate across display associations and restarts. This catalog
outbox is separate from existing receipt-bound lifecycle reporting.

## CLI view eligibility

Fresh views require explicit `allowFreshLaunch: true` for an endpoint with a
compatible installed CLI and the existing guarded wmux TUI helper. wmux must
have a local HTTP listener for its authenticated controller; direct TLS-only
listeners are currently unsupported by this launcher. Configure fresh launch
only after verifying that environment. The server uses its existing automation
or shared credential internally; catalog and launch routes themselves accept
only normal user/browser authority, never plugin/helper/automation credentials.

**Start new task** requires an absolute working directory and opens a new,
explicitly selected endpoint through `codex --remote unix:///…`. It submits no
prompt and passes no sandbox, approval, trust-acceptance, model or naming
override. Existing native trust and approval prompts remain interactive.
The default generated wmux title remains eligible for native name mirroring.

Each click gets a persisted request UUID before any process launch. Duplicate
requests with the same input reuse the attempt; conflicting input is rejected.
A lost response or interrupted controller becomes **unknown**, never an
automatic retry. Refresh/reopen the catalog to reconcile recorded attempts and
open a known pane. `opened` means the guarded view returned its exact pane;
it does not prove a native turn ran or attribute a discovered task to that view.
Only ordinary trusted terminal proof may establish a native binding.

If native trust or login stops the controller, an exact pane returned by the
helper remains available through **Open target**, while the outcome stays
unknown. After inspecting it, explicitly acknowledge that attempt to allow a
separate fresh view. Acknowledgement neither cancels the existing view nor
retries its request, and the original attempt remains in the ledger.

## Existing-task CLI access

The primary task action is **Open in CLI** when the server has attested an
eligible exact task and no live wmux terminal is verified. If it has a verified
terminal target, the action is **Open terminal**. Both actions submit the same
attachment request first; the server revalidates it and returns the target to
focus. A display association is optional activity monitoring and never replaces
that check.

The request contains the exact endpoint identity, loaded native thread UUID and
an opaque server-issued `generation` attestation. The server accepts only the
same-server loaded UUID with an empty native input queue. It fails closed for a
stale attestation, a replaced endpoint, an active queue, a different server, or
any unavailable launcher condition. The browser never supplies a trust answer.
Browsing and display associations do not grant title ownership.

Once a new view has verified its native identity, wmux seeds its automatic
workspace and tab titles from that task's current native name. Independent
manual pins are preserved; an unnamed task retains its existing fallback title.
Reusing or inspecting an existing view does not reseed its titles or transfer
the original pane's naming receipt. This is an initial name, not a claim of
continuous name synchronization after arbitrary CLI input.

Owner checking is deliberately strict and bounded: every configured endpoint,
including an SSH endpoint, must be checked. An unavailable or incomplete owner
scan is unknown and disables attachment rather than selecting a likely server.
SSH peers use their configured read-only bridge for a complete loaded-owner
inventory; they do not need a managed launcher to establish absence. A loaded
copy on another server blocks attachment. Deploy the matching wmux bridge/build
on remote catalog hosts before enabling this check.

The managed route is configured with `managedLaunch`:
`launcherPath` identifies the guarded installed launcher and `deploymentPath`
identifies its matching deployment. Existing-task attach is Linux-local only;
SSH and other platform routes remain disabled. It uses only the helper paired
with that source deployment. A managed launcher must preserve native trust and
approval prompts without injecting responses.

Active clients share the original task. Native input from any of those clients
affects that same task; wmux does not claim exclusive ownership. Display
associations, cwd matches, title matches and preview markers do not establish
an attachment route.

Each attachment has a persisted request UUID. A lost response is retried only
with that same UUID and the same attestation; reload restores it for explicit
retry or reconciliation. The browser never silently creates another attachment
attempt after an unknown result. Server-provided disabled reasons are rendered
verbatim enough to explain why the primary action is unavailable.

The recent-launch list is a ledger, not terminal proof. An `opened` attachment
in that list does not expose **Open terminal**. Use **Inspect attachment** to
perform the individual reconciliation; only that check may return a verified
terminal target, and task detail uses the same verified result. If inspection
reports `terminal_identity_unverified` (for example, because CLI input changed
the terminal identity), inspect the terminal, explicitly acknowledge the
unknown attachment, then choose **Open in CLI** for a deliberate new request.
The receipt is conservative: CLI input invalidates it because `resume` can
switch the task behind a terminal. Acknowledgement does not retry or focus
anything, and the browser never makes that new request automatically.

## Persistence, disable and rollback

Two additional versioned owner-only ledgers sit next to wmux's main state file:
`codex-task-associations.json` and `codex-task-launches.json`. Both use atomic
writes and backups; future schema versions are refused. The main state schema
is unchanged. Associations are capped at 200. Launch attempts are also capped at
200 and are not silently evicted, because eviction could allow request replay.

Before deployment, back up the main state, settings, endpoint configuration and
both new ledgers. Disable catalog endpoints by removing its environment variable
from the wmux service configuration; retain the private ledgers for review or
later re-enablement. A base schema-1 runtime refuses a schema-2 launch ledger;
it does not ignore it. To roll back, restore the pre-upgrade ledger backup with
the previous release, or move the schema-2 ledger out of that runtime before
starting it. Preserve the moved ledger as an archive and preserve fresh-launch
receipts for later reconciliation. Never feed a future ledger schema into an
older implementation or alter native task stores to undo a wmux deployment.
Normal wmux restart durability rules still apply to panes; review the actual
backend mix before maintenance.

When deploying through an active-release symlink, ensure the installed local
`wmux-*` helper links resolve through that symlink too. A login shell can prefer
the installed helper over the service's prepended PATH; a stale helper may
reject a new launch field even when the browser/server were updated. Verify
the resolved `wmux-agent-run` source and an actual local launch. Preserve
unmanaged commands and retain helper-link provenance with the deployment
backup. Rollback must select matching helpers as well as matching server code.

Remote Codex views pass the validated directory through native `--cd`, in
addition to setting the launcher process cwd. Changing only the wrapper cwd
does not establish the remote App Server task's working directory. Trust and
approval policy remain native; wmux sends no automatic trust response.

## Combined M6 acceptance

Use disposable tasks and panes for functional qualification. The following
cases can be automated; the [current acceptance ledger](CODEX_M6_UAT.md)
separates completed engineering evidence from the remaining human decisions
and physical-device usability checks:

1. Find Desktop, CLI and stored tasks across configured hosts; inspect duplicate
   titles, parent IDs, stale labels, pagination and explicit history loading.
   Confirm browsing creates no task/turn and leaves native work usable.
2. Associate, move and remove a task without starting it. Set independent manual
   workspace/tab pins; refresh two browsers and restart the isolated wmux
   candidate. Verify pins, associations and exact identities survive correctly.
3. Trigger a later native turn through its normal client. Confirm task activity
   updates without claiming terminal origin, and notifications do not multiply
   across display associations. Repeat with short turns and endpoint failure.
4. Start a new task and open an eligible existing task, inspect native
   trust/approval behavior and exact host/cwd, then submit work explicitly from
   that native view if desired. Double-click and uncertain-delivery fixtures
   must show one request UUID per attempt and retry only that UUID.
5. Check desktop and mobile layout, full Unicode names, diagnostics, component
   disable, backup/restore and rollback on an isolated candidate.
6. Complete the actual mixed-task overnight soak using
   `node scripts/codex-integration-soak.mjs --out /absolute/private/fresh-dir`.
   A shortened/source-module run is engineering evidence only. Accept the
   24-hour gate only when the final report and successful process exit agree.
7. After automated connection proof passes, run the smallest direct catalog UAT:
   open the catalog, inspect one eligible loaded task, open its managed view,
   and verify the returned terminal before entering input. Earlier user UAT is
   context only; it is not acceptance for this route.

Record source/build identity, native versions, tested hosts and user acceptance
in the [conformance ledger](CODEX_CONFORMANCE.md). M0–M2 acceptance remains scoped
to its previously qualified release until the combined candidate is accepted.
