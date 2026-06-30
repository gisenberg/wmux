# Windows Node Registration

This runbook is for registering a Windows machine, such as `9800x3d`, as a wmux node from the homelab Ubuntu wmux server.

wmux should use `kind: "powershell-ssh"` for Windows nodes reached from non-Windows servers. This transport starts local `ssh -tt` on the wmux server and launches `pwsh -NoLogo -NoProfile` on the Windows host. Do not use the legacy `kind: "powershell"` WSMan transport from homelab.

For parallel host-local validation work, see [WINDOWS_HOST_HANDOFF.md](../WINDOWS_HOST_HANDOFF.md).

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
- `install-deps` uses `winget` to install `Gyan.FFmpeg` and `Python.Python.3.12` when missing, then installs `pywinpty` with pip.
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
  "version": "0.1",
  "machine": "9800x3d",
  "backend": "conpty",
  "conptyAvailable": true,
  "pywinptyAvailable": true
}
```

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

## Definition Of Done

- homelab can SSH to the Windows user on `100.68.206.111:22` without a password prompt.
- `ssh -tt gisen@100.68.206.111 pwsh -NoLogo -NoProfile` opens an interactive prompt from homelab.
- Windows firewall exposes SSH only to Tailscale/internal clients.
- `wmux.config.json` uses `kind: "powershell-ssh"`, not legacy `kind: "powershell"`.
- `/api/bootstrap` reports `9800x3d` as reachable.
- Creating a wmux workspace on `9800x3d` opens an interactive PowerShell session.
- New Windows panes stage helper scripts into `%LOCALAPPDATA%\wmux\bin`.
- `wmux-notify`, `wmux-title`, `wmux-agent-event`, `wmux-run`, `wmux-media`, `wmux-copy`, `wmux-hooks`, `wmux-stream-agent-service`, and `wmux-windows-setup` resolve inside new Windows panes.
- `wmux-windows-setup validate` reports `wmuxApi.reachable: true`, helper scripts present, FFmpeg/Python/pywinpty available, and the stream task running.
- A short `/api/streams/9800x3d/request` lease causes the Windows stream agent to publish `wmux-9800x3d`, then return idle after release.
- `wmux-windows-setup validate` reports the `wmux-windows-agent` helper and agent config present.
- `curl http://100.68.206.111:3481/health` reports the Windows session agent as healthy.
- A direct `/sessions/:id` create/input/output/delete smoke test returns command output.

## Known Limits

- Legacy Windows SSH PowerShell panes are not durable. Agent-backed Windows panes are owned by `wmux-windows-agent` and can survive `wmux.service` restarts.
- Windows helper staging and cwd reporting require a new pane after the wmux service has been updated.
- Windows screen streaming is validated on 9800x3d through FFmpeg/gdigrab and the supervised per-user Scheduled Task. Locked/logged-out behavior and a fuller Windows wmux agent are still not implemented.
- The Windows session agent uses pywinpty-backed ConPTY by default. It is restart-durable across `wmux.service` restarts while the Windows agent keeps running, but Windows-agent restarts still kill the owned ConPTY processes and broad full-screen app validation is still pending.
