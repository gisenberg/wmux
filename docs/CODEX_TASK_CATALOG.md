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
      "socketPath": "/home/operator/.codex/app-server-control/app-server-control.sock",
      "allowFreshLaunch": false
    },
    {
      "id": "native-remote",
      "label": "Remote Codex",
      "machineId": "linux-host",
      "transport": "ssh",
      "socketPath": "/home/operator/.codex/app-server-control/app-server-control.sock",
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
and connects only to an existing private, owned Unix socket. It is not a general
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

## Fresh CLI view eligibility

Fresh views require explicit `allowFreshLaunch: true` for an endpoint with a
compatible installed CLI and the existing guarded wmux TUI helper. wmux must
have a local HTTP listener for its authenticated controller; direct TLS-only
listeners are currently unsupported by this launcher. Configure fresh launch
only after verifying that environment. The server uses its existing automation
or shared credential internally; catalog and launch routes themselves accept
only normal user/browser authority, never plugin/helper/automation credentials.

**New CLI view** requires an absolute working directory and opens a new,
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

**Resume stays disabled in this profile.** Native loaded/idle metadata cannot
prove exclusive client ownership or prevent another client from submitting work
between checks. No association, cwd match, title match or preview marker grants
resume authority. Use the native client when the catalog explains this limit.

## Persistence, disable and rollback

Two additional versioned owner-only ledgers sit next to wmux's main state file:
`codex-task-associations.json` and `codex-task-launches.json`. Both use atomic
writes and backups; future schema versions are refused. The main state schema
is unchanged. Associations are capped at 200. Launch attempts are also capped at
200 and are not silently evicted, because eviction could allow request replay.

Before deployment, back up the main state, settings, endpoint configuration and
both new ledgers. Disable catalog endpoints by removing its environment variable
from the wmux service configuration; retain the private ledgers for review or
later re-enablement. To roll back, restore the previous wmux release and its
matching backup if necessary; an older release ignores these separate files.
Never feed a future ledger schema into an older implementation or alter native
task stores to undo a wmux deployment. Normal wmux restart durability rules still
apply to panes; review the actual backend mix before maintenance.

## Combined M6 acceptance

Engineering tests and native metadata probes do not replace direct UAT. Use
disposable tasks and panes for this checkpoint:

1. Find Desktop, CLI and stored tasks across configured hosts; inspect duplicate
   titles, parent IDs, stale labels, pagination and explicit history loading.
   Confirm browsing creates no task/turn and leaves native work usable.
2. Associate, move and remove a task without starting it. Set independent manual
   workspace/tab pins; refresh two browsers and restart the isolated wmux
   candidate. Verify pins, associations and exact identities survive correctly.
3. Trigger a later native turn through its normal client. Confirm task activity
   updates without claiming terminal origin, and notifications do not multiply
   across display associations. Repeat with short turns and endpoint failure.
4. Open a fresh CLI view, inspect its native trust/approval behavior and exact
   host/cwd, then submit work explicitly from that native view if desired.
   Double-click and uncertain-delivery fixtures must show one launch attempt.
   Verify resume remains disabled with a specific reason.
5. Check desktop and mobile layout, full Unicode names, diagnostics, component
   disable, backup/restore and rollback on an isolated candidate.
6. Complete the actual mixed-task overnight soak using
   `node scripts/codex-integration-soak.mjs --out /absolute/private/fresh-dir`.
   A shortened/source-module run is engineering evidence only. Accept the
   24-hour gate only when the final report and successful process exit agree.

Record source/build identity, native versions, tested hosts and user acceptance
in the [conformance ledger](CODEX_CONFORMANCE.md). M0–M2 acceptance remains scoped
to its previously qualified release until the combined candidate is accepted.
