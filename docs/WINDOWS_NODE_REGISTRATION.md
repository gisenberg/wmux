# Windows Node Registration

This runbook is for registering a Windows machine, such as `9800x3d`, as a wmux node from the homelab Ubuntu wmux server.

wmux should use `kind: "powershell-ssh"` for Windows nodes reached from non-Windows servers. This transport starts local `ssh -tt` on the wmux server and launches `pwsh -NoLogo -NoProfile` on the Windows host. Do not use the legacy `kind: "powershell"` WSMan transport from homelab.

References:

- Microsoft OpenSSH Server setup for Windows: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse
- Microsoft OpenSSH Server configuration for Windows: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration
- Microsoft OpenSSH key management for Windows: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement

## Inputs

Collect these values before changing either host:

```text
wmux server: homelab
windows node id: 9800x3d
windows node host: 100.68.206.111
windows ssh user: gisen
windows ssh port: 22
```

If the Tailscale IP or Windows username differs, update the commands and `wmux.config.json` accordingly.

## 1. Prepare The wmux Server

Run on homelab.

1. Confirm the Windows node is reachable over Tailscale:

```bash
tailscale ping --timeout=3s --c 1 100.68.206.111
timeout 3 bash -lc '</dev/tcp/100.68.206.111/22' && echo 'ssh reachable'
```

2. Confirm the local SSH client exists. `kind: "powershell-ssh"` is marked offline when this is missing:

```bash
command -v ssh
```

3. Confirm the SSH key that wmux should use:

```bash
test -f ~/.ssh/id_ed25519.pub && cat ~/.ssh/id_ed25519.pub
```

If no key exists, create one:

```bash
ssh-keygen -t ed25519 -C 'wmux homelab'
```

## 2. Prepare The Windows Node

Run on the Windows node as Administrator.

1. Confirm PowerShell 7 is installed:

```powershell
pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion'
```

Install PowerShell 7 if this command fails.

2. Install and start OpenSSH Server:

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

3. Scope inbound SSH to the Tailnet. Disable the broad default OpenSSH rule if it exists, then add a Tailnet-scoped rule:

```powershell
Disable-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue
New-NetFirewallRule `
  -Name 'wmux-sshd-tailscale' `
  -DisplayName 'wmux OpenSSH over Tailscale' `
  -Enabled True `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 22 `
  -RemoteAddress 100.64.0.0/10 `
  -Action Allow
```

4. Ensure public-key authentication is enabled in `C:\ProgramData\ssh\sshd_config`.

These lines should exist:

```text
PubkeyAuthentication yes
PasswordAuthentication yes
```

`PasswordAuthentication yes` is acceptable for initial validation. Prefer disabling it after key authentication works.

5. Ensure `pwsh.exe` is available to SSH login sessions.

For the current user, this should return a path:

```powershell
Get-Command pwsh.exe
```

If `pwsh.exe` is not on the login-session `PATH`, add the PowerShell 7 install directory to the system PATH or set `"shell"` in the wmux machine config to a command path that OpenSSH can execute.

6. Install the homelab public key for the Windows user.

For a non-administrator user, append the public key from homelab to:

```text
$env:USERPROFILE\.ssh\authorized_keys
```

For an administrator user, append it to:

```text
C:\ProgramData\ssh\administrators_authorized_keys
```

Then lock down the administrator key file permissions:

```powershell
icacls.exe 'C:\ProgramData\ssh\administrators_authorized_keys' /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'
```

7. Restart SSH:

```powershell
Restart-Service sshd
```

## 3. Validate From homelab

Run on homelab.

1. Validate plain SSH:

```bash
ssh gisen@100.68.206.111 hostname
```

2. Validate that PowerShell can run through SSH:

```bash
ssh gisen@100.68.206.111 pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion'
```

3. Validate an interactive PowerShell session through forced-PTY SSH:

```bash
ssh -tt gisen@100.68.206.111 pwsh -NoLogo -NoProfile
```

If this prompts for a password, complete the first validation interactively, then fix key authentication before expecting wmux to open panes without manual prompts.

## 4. Register In wmux

Update `wmux.config.json` or `~/.wmux/config.json`:

```json
{
  "id": "9800x3d",
  "name": "9800x3d",
  "kind": "powershell-ssh",
  "host": "100.68.206.111",
  "user": "gisen",
  "port": 22
}
```

Build and restart the service if code changed; restart is enough for config-only changes:

```bash
npm run build
systemctl --user restart wmux.service
```

Check wmux status:

```bash
curl -fsS http://100.107.241.79:3478/api/bootstrap |
  jq '.machines[] | select(.id == "9800x3d")'
```

The node is registered correctly when wmux reports:

```json
{
  "id": "9800x3d",
  "kind": "powershell-ssh",
  "reachable": true,
  "endpoint": "100.68.206.111:22",
  "backendDetail": "SSH-launched PowerShell; pwsh 7.6.1; helpers ready; stream task Running; ffmpeg+python"
}
```

For `powershell-ssh`, `/api/bootstrap` does more than a TCP check. It runs a short encoded PowerShell health probe over SSH and reports helper readiness, `WMUX_URL` reachability through `/api/health`, FFmpeg/Python availability, and the `wmux-stream-agent` Scheduled Task state.

## Optional: Dynamic Registration And Heartbeats

Use dynamic registration when the Windows node should enroll itself instead of
keeping its address in `wmux.config.json`. The wmux server's shared
`~/.wmux/registration-token` is trusted catalog-write authority for every
dynamic ID, so transfer it only over an already trusted channel. It cannot read
or delete registry entries and is not a substitute for normal wmux API auth.

Provision three owner-only files on the Windows node:

```text
~\.wmux\url
~\.wmux\registration-token
~\.wmux\heartbeat.json
```

The URL file contains the externally reachable wmux base URL. A restart-durable
Windows-agent registration looks like this; use the same `agentToken` already
configured for the local `wmux-windows-agent` service:

```json
{
  "machine": {
    "id": "9800x3d",
    "name": "9800x3d",
    "kind": "powershell-ssh",
    "user": "gisen",
    "sessionBackend": "agent",
    "agentPort": 3481,
    "agentToken": "replace-with-the-agent-token"
  },
  "ttlMs": 90000,
  "metadata": { "os": "windows" }
}
```

`host` may remain in an older heartbeat file for compatibility, but wmux ignores
it and dials the validated private source address. The agent backend requires an
explicit port and printable token. The agent token stays in the owner-only
registry and is redacted from browser, status, registry, and helper responses.

Copy `scripts/windows/wmux-heartbeat.ps1` to the node and validate one POST:

```powershell
& "$env:LOCALAPPDATA\wmux\bin\wmux-heartbeat.ps1" -Once
```

After a pane has staged the helper bundle through SSH bootstrap or the Windows
agent, install and inspect the per-user at-logon task:

```powershell
wmux-windows-setup install-heartbeat
wmux-windows-setup heartbeat-status
wmux-windows-setup heartbeat-logs
```

When rotating the registration token, update `~\.wmux\registration-token` and
run `wmux-heartbeat-service restart`. Address changes are accepted for idle
persisted panes, but any referenced pane pins the connection descriptor and
agent token until it is closed. A live Windows-agent pane also pins its callback
address. Close referenced panes before changing those pinned values, then run a
one-shot heartbeat. The task runs only after this user logs on.

Rotating `agentToken` is a coordinated agent update: drain/close active panes
without forcing an agent restart, update the token in both
`~\.wmux\heartbeat.json` and `~\.wmux\windows-agent.json`, restart the agent
task, and only then send `wmux-heartbeat -Once`. Updating only the heartbeat
would make wmux authenticate with a token the agent does not accept. Use the
`wmux-windows-agent-service activate-update` drain flow described below when
the rotation is part of a staged agent update.

Registered panes stage the same helper commands as static panes but receive no
broad `WMUX_TOKEN` and never overwrite an existing `~\.wmux\token`. API-posting
helpers therefore return `401` unless normal or scoped auth is provisioned
separately. A token left from an earlier static setup continues to work; keep it
only when that trusted-host access is intentional, otherwise remove or rotate it.

## 5. Finish Windows Helper Setup

Open a fresh wmux pane on the Windows node. The pane bootstrap fetches the helper bundle from homelab and stages scripts plus CMD shims into:

```text
%LOCALAPPDATA%\wmux\bin
```

Then run:

```powershell
wmux-windows-setup validate
wmux-windows-setup persist-path
wmux-windows-setup install-deps
wmux-windows-setup install-stream
wmux-windows-setup stream-status
wmux-windows-setup install-agent
wmux-windows-setup agent-status
```

Notes:

- `validate` prints a JSON report for helper state, wmux API reachability, FFmpeg/Python/pywinpty/winget availability, hook config files, and stream Scheduled Task state.
- `persist-path` adds `%LOCALAPPDATA%\wmux\bin` to the persistent user PATH for future non-wmux shells.
- `install-deps` uses `winget` to install `Gyan.FFmpeg` and `Python.Python.3.12` when missing, then installs `pywinpty` with pip. It executes Python during detection so the Microsoft Store app-execution alias is not mistaken for an installed runtime.
- `install-stream` installs and starts the per-user `wmux-stream-agent` Scheduled Task.
- `install-agent` installs and starts the per-user `wmux-windows-agent` Scheduled Task for experimental restart-durable sessions.
- Both Windows Scheduled Tasks start at user logon, start when available, restart after failure, have no fixed execution-time cutoff, and launch through hidden PowerShell wrappers instead of visible `cmd.exe` windows.

If you are running setup from plain SSH before the helper directory is on PATH, invoke the staged script by path:

```powershell
& "$env:LOCALAPPDATA\wmux\bin\wmux-windows-setup.ps1" validate
```

## 6. Validate Screen Streaming

Direct capture probes from plain SSH can fail with Windows desktop access errors because the SSH process does not necessarily own the interactive desktop session:

```powershell
wmux-stream-agent --probe-capture
```

The intended Windows streaming path is the per-user Scheduled Task. Validate that the task is idle and waiting:

```powershell
wmux-stream-agent-service logs
```

From homelab, request a short stream lease:

```bash
curl -fsS -X POST http://100.107.241.79:3478/api/streams/9800x3d/request \
  -H 'content-type: application/json' \
  -d '{"requestId":"windows-smoke","ttlMs":12000}' | jq .
```

The Windows logs should show:

```text
wmux-stream-agent: stream requested for 9800x3d
wmux-stream-agent: publishing 9800x3d to rtsp://100.107.241.79:8554/wmux-9800x3d
```

MediaMTX/wmux should report the stream as live while the lease is active:

```bash
curl -fsS http://100.107.241.79:3478/api/streams |
  jq '.streams[] | select(.machineId == "9800x3d")'
```

Release the smoke lease when done:

```bash
curl -fsS -X DELETE http://100.107.241.79:3478/api/streams/9800x3d/request/windows-smoke
```

## 7. Validate The Windows Session Agent

The experimental session agent listens on the configured Tailscale/internal host, defaulting to port `3481`:

```bash
curl -fsS http://100.68.206.111:3481/health | jq .
```

Expected:

```json
{
  "ok": true,
  "version": "0.8",
  "machine": "9800x3d",
  "backend": "conpty",
  "conptyAvailable": true,
  "pywinptyAvailable": true
}
```

New managed configs use `backend: "auto"`. Bootstrap merges preserve an existing `backend` value, so hosts previously staged with `"conpty"` remain pinned until `%USERPROFILE%\.wmux\windows-agent.json` is changed to `"auto"` and the agent is safely restarted with `wmux-windows-agent-service activate-update`.

Run a direct lifecycle smoke test:

```bash
session="windows-agent-smoke"
curl -fsS -X POST "http://100.68.206.111:3481/sessions/$session" \
  -H 'content-type: application/json' \
  -d '{"cols":120,"rows":30,"cwd":"C:\\Users\\gisen"}'
da=$(printf '\033[?64;1;2;6;9;15;18;21;22c' | base64 -w0)
curl -fsS -X POST "http://100.68.206.111:3481/sessions/$session/input" \
  -H 'content-type: application/json' \
  -d "{\"dataBase64\":\"$da\"}"
curl -fsS -X POST "http://100.68.206.111:3481/sessions/$session/input" \
  -H 'content-type: application/json' \
  -d '{"dataBase64":"V3JpdGUtT3V0cHV0ICJoZWxsby1mcm9tLWFnZW50Ig0="}'
curl -fsS "http://100.68.206.111:3481/sessions/$session/output?cursor=0&timeoutMs=1000" |
  jq -r '.dataBase64' | base64 -d
curl -fsS -X DELETE "http://100.68.206.111:3481/sessions/$session"
```

To make wmux use the agent for new panes, opt in explicitly:

```json
{
  "id": "9800x3d",
  "name": "9800x3d",
  "kind": "powershell-ssh",
  "host": "100.68.206.111",
  "user": "gisen",
  "port": 22,
  "sessionBackend": "agent",
  "agentPort": 3481
}
```

Keep the legacy `powershell-ssh` path available as a fallback while the ConPTY agent is still being validated.

The agent task uses `Interactive` logon when a desktop user is logged in and falls back to `S4U` on a headless host. S4U avoids a stored password and does not require a live desktop session, but Windows does not make delegated network credentials available to S4U processes. Override automatic selection before installation with `WMUX_WINDOWS_AGENT_LOGON_TYPE=Interactive` or `WMUX_WINDOWS_AGENT_LOGON_TYPE=S4U`.

## Definition Of Done

- homelab can SSH to the Windows user on `100.68.206.111:22` without a password prompt.
- `ssh -tt gisen@100.68.206.111 pwsh -NoLogo -NoProfile` opens an interactive prompt from homelab.
- Windows firewall exposes SSH only to Tailscale/internal clients.
- `wmux.config.json` uses `kind: "powershell-ssh"`, not legacy `kind: "powershell"`.
- `/api/bootstrap` reports `9800x3d` as reachable.
- Creating a wmux workspace on `9800x3d` opens an interactive PowerShell session.
- New Windows panes stage helper scripts into `%LOCALAPPDATA%\wmux\bin`.
- `wmux-notify`, `wmux-title`, `wmux-agent-event`, `wmux-run`, `wmux-media`, `wmux-copy`, `wmux-clip`, `wclip`, `wmclip`, `wmux-hooks`, `wmux-stream-agent-service`, and `wmux-windows-setup` resolve inside new Windows panes.
- `wmux-windows-setup validate` reports `wmuxApi.reachable: true`, helper scripts present, FFmpeg/Python/pywinpty available, and the stream task running.
- A short `/api/streams/9800x3d/request` lease causes the Windows stream agent to publish `wmux-9800x3d`, then return idle after release.
- `wmux-windows-setup validate` reports the `wmux-windows-agent` helper and agent config present.
- `curl http://100.68.206.111:3481/health` reports the Windows session agent as healthy.
- A direct `/sessions/:id` create/input/output/delete smoke test returns command output.
- `wmux-windows-agent-service activate-update` drains existing sessions and automatically restarts only after the last pane closes; `cancel-update` cancels the drain.
- `wmux-windows-setup install-hooks` reports Claude and Codex hooks installed; `/hooks` in a new Codex session shows the direct PowerShell command ready for review/trust.
- Changing directories in PowerShell updates the pane cwd, and a same-host split starts in that directory.

## Known Limits

- Legacy Windows SSH PowerShell panes are not durable. Agent-backed Windows panes are owned by `wmux-windows-agent`; wmux service shutdown detaches its client while explicit pane closure deletes the owned pane process and its Windows Job Object, terminating detached descendants.
- Windows helper staging and cwd reporting require a new pane after the wmux service has been updated.
- Windows screen streaming is validated on 9800x3d through FFmpeg/gdigrab and the supervised per-user Scheduled Task. Locked/logged-out behavior and a fuller Windows wmux agent are still not implemented.
- The managed Windows session agent uses `backend: "auto"`, preferring pywinpty-backed ConPTY and falling back to terminal-normalized stdio when pywinpty is unavailable. It is restart-durable across `wmux.service` restarts while the Windows agent keeps running. Agent 0.7 added non-destructive staged-update draining; agent 0.8 adds terminal-safe stdio newline handling. A forced Windows-agent restart still kills owned pane processes, so process preservation across an unexpected agent crash and broad full-screen app validation remain pending.
