# Native Windows host

Native Windows hosting is experimental. The server runs as a Windows Node
process; Git for Windows supplies Bash and SSH, and node-pty supplies ConPTY.
WSL is not required. Windows machines used as remote session-agent targets
remain a separate feature; see [Windows node registration](WINDOWS_NODE_REGISTRATION.md).

## Start

Install Node.js 22+ and Git for Windows, then run from the checkout:

```powershell
npm install
npm run build
./scripts/start-windows.ps1
```

The launcher defaults to loopback port 3478. To allow private-network clients,
pass `-BindAddress` with this machine's exact Tailscale or internal address.
The existing bind, Host, Origin, and authentication checks remain enforced.
The access token is stored in the Windows user's `~/.wmux/token`.
The launcher is foreground-only; automatic startup and service supervision
are not installed by this script.

Git is discovered in its standard system or per-user installation directory.
Set `WMUX_GIT_BASH` to the full `Git/bin/bash.exe` path for another installation.
The server uses the adjacent Git SSH tools for remote probes and staging.

Configure the ignored `wmux.config.json`, using the existing SSH usernames,
keys, and trusted host keys. For example:

```json
{
  "machines": [
    {
      "id": "local", "name": "Local Git Bash", "kind": "local",
      "shell": "C:/Program Files/Git/bin/bash.exe", "sessionBackend": "pty"
    },
    {
      "id": "linux", "name": "Linux", "kind": "ssh",
      "host": "linux.internal", "user": "operator", "sessionBackend": "auto"
    }
  ]
}
```

Git Bash starts with its login profile. Without an explicit shell, Windows
PowerShell is used with the existing cwd prompt integration. `pwsh.exe` and
`cmd.exe` can also be selected. Local `auto` uses a raw PTY; explicit local
`tmux`/`screen` preferences fail. An MSYS2 tmux installation is not yet a
supported local durable backend. Local shells survive browser reconnects,
but terminate when the server stops. Linux SSH panes use remote tmux/screen
when available and otherwise fall back to a non-durable shell.

## Permissions and limitations

Startup protects the default `~/.wmux` directory with an inheritable, current-user-only Windows ACL.
Existing directory ownership and symlink checks must pass.
Credential and endpoint validation reads live ACLs through Koffi and Win32 APIs instead of trusting Windows' synthetic POSIX mode bits.
Owners and grants are restricted to the current user, SYSTEM, and Administrators; other ordinary accounts and groups are rejected.
Windows can assign Administrators ownership to files created by an elevated token, so those files retain the same ACL validation as user-owned files.
See Microsoft's [object ownership rules](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object).
Do not broaden the state ACL for automation sandboxes.
Custom state paths need equivalently private parents.

File contents are flushed before atomic replacement. Windows cannot perform
the POSIX directory fsync used by the agent-input stores, so sudden-power-loss
durability of directory metadata is weaker and needs separate validation.

SSH staging uses Git Bash and permission-restricted runtime payload files.
Credentials remain outside process arguments. Windows SSH control sockets are
disabled because the tested Git SSH control master resets the connection.
Consequently pane-bound SSH image paste and Kitty file transfers are unavailable;
they fail closed instead of reconnecting to an unpinned target. Native local
image paste is also disabled. Session-agent file staging is separate.

Git Bash cwd prompt integration, automatic Windows service startup, and broad helper/agent integration parity remain incomplete.
Node-pty can emit `AttachConsole failed` from its cleanup helper after an exited console; this upstream diagnostic remains unresolved.
The complete POSIX-oriented test suite is not green on native Windows, so this is a local trial path, not release parity.

## Verification

```powershell
node --import tsx --test test/private-permissions.test.ts test/windows-host.test.ts test/windows-host-smoke.test.ts test/backend-conformance/backends.test.ts
npm run typecheck
npm run build
```

The ACL test checks private inheritance and detects a later Everyone grant.
The server smoke test uses isolated state and checks authentication, app
delivery, and a Git Bash WebSocket command round trip. Backend conformance
covers PowerShell input, resize, replay, checkpoint restoration, and disposal.
Remote hosts must additionally be tested through actual wmux panes.
