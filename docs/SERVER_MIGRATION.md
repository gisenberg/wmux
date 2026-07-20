# Moving wmux to another server

A wmux machine catalog is not entirely portable. Remote machine definitions
describe their targets, but `kind: "local"` describes the computer currently
running the wmux service.

## Before the cutover

1. Build and start wmux on the new private-network host.
2. Bind it to loopback, Tailscale, or another supported internal address.
3. Install HTTPS with `scripts/install-tailscale-cert-service.sh` when using a
   Tailscale MagicDNS name, then pass its certificate paths and public URL to
   `scripts/install-user-service.sh`.
4. Confirm the new service health endpoint before moving machine inventory.
5. Back up the ignored config and `~/.wmux` state without committing either.

Authentication migration is phased: first run with `WMUX_BROWSER_AUTH_MODE`
omitted (or `shared-or-login`), then provision distinct scoped credentials
with `node scripts/wmux-provision-scoped-auth.mjs`, update controllers and
staged helpers, and run scoped-only preflight. Confirm browser login and pane
durability, then set `login-only` and restart. Roll back by setting
`shared-or-login` (or removing the variable), restarting, and verifying the
retained legacy token. Keep legacy material through acceptance; this documents
a procedure, not a claim about any live deployment.

Do not casually copy `~/.wmux/token`, `registration-token`, `auth.json`, or
`session-secret`. Copying them preserves broad credentials; omitting them lets
the new service create an independent trust boundary. If a credential appears
in terminal or diagnostic output, rotate it before continuing.

## Rebase the local machine

Suppose the old server was named `homelab` and the new server is named `wmux`.
This entry remains local even though its label says otherwise:

```json
{
  "id": "local",
  "name": "homelab",
  "kind": "local",
  "cwd": "/home/old-user"
}
```

Replace it with a server-local entry plus a distinct SSH target:

```json
{
  "id": "local",
  "name": "wmux",
  "kind": "local",
  "cwd": "/home/wmux",
  "sessionBackend": "auto"
},
{
  "id": "homelab",
  "name": "homelab",
  "kind": "ssh",
  "platform": "linux",
  "host": "100.x.y.z",
  "user": "operator",
  "port": 22,
  "cwd": "/home/operator",
  "sessionBackend": "auto"
}
```

Keep the semantic `local` ID for the new server. Existing state that references
`local` will continue to mean server-local execution. A configured local `cwd`
that is missing or not a directory is reported as an unreachable machine
before pane creation. SSH `cwd` values belong to the remote filesystem.

Move each `stream` block with the machine that owns the captured pixels. A
stream attached to the new server's `local` entry does not capture the old
server merely because its gateway URL points there.

## Session behavior

- Copying layout state does not move local PTYs or local tmux/screen sessions.
- Existing sessions on the old server remain alive until explicitly closed or
  their owning multiplexer is stopped.
- SSH-backed durable panes can reconnect only when their machine ID, remote
  account, endpoint, pane ID, and remote tmux/screen session still correspond.
- Existing panes keep their recorded machine ID; adding a new SSH machine is
  additive and does not move them automatically.
- Restarting the new wmux service detaches from durable panes and reattaches on
  demand. Raw PTY panes are not restart-durable.

## SSH and helper cutover

Before opening the first pane, verify the target's SSH host fingerprint against
trusted Tailscale metadata or another trusted channel. Tailscale SSH may also
require an interactive re-authentication check from the new server.

The first static SSH pane stages current helpers and writes the new server's
authenticated URL and appropriate helper credential on the target. In
compatibility mode this may be the legacy token; scoped mode must not stage
controller auth. Existing shells
on the old wmux server keep running, but their file-fallback hooks and helpers
will then post to the new server. Drain old agent-event work first when that
cutover would be disruptive.

## Validate

1. Confirm the catalog shows distinct `local` and old-server SSH entries.
2. Open a titled test workspace on the SSH entry.
3. Run `hostname` and `pwd`; verify both belong to the intended target.
4. Confirm the HTTPS health endpoint and certificate hostname.
5. Check `wmux-cert-renew.timer` and `wmux.service` are active.
6. Close only the test workspace. Closing a real pane, tab, or workspace kills
   its matching durable session.
