# Windows Node Registration

This runbook is for registering a Windows machine, such as `9800x3d`, as a wmux node from the rtx6000 Ubuntu wmux server.

wmux should use `kind: "powershell-ssh"` for Windows nodes reached from non-Windows servers. This transport starts local `ssh -tt` on the wmux server and launches `pwsh -NoLogo -NoProfile` on the Windows host. Do not use the legacy `kind: "powershell"` WSMan transport from rtx6000.

For parallel host-local validation work, see [WINDOWS_HOST_HANDOFF.md](../WINDOWS_HOST_HANDOFF.md).

References:

- Microsoft OpenSSH Server setup for Windows: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse
- Microsoft OpenSSH Server configuration for Windows: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration
- Microsoft OpenSSH key management for Windows: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement

## Inputs

Collect these values before changing either host:

```text
wmux server: rtx6000
windows node id: 9800x3d
windows node host: 100.68.206.111
windows ssh user: gisen
windows ssh port: 22
```

If the Tailscale IP or Windows username differs, update the commands and `wmux.config.json` accordingly.

## 1. Prepare The wmux Server

Run on rtx6000.

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
ssh-keygen -t ed25519 -C 'wmux rtx6000'
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

6. Install the rtx6000 public key for the Windows user.

For a non-administrator user, append the public key from rtx6000 to:

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

## 3. Validate From rtx6000

Run on rtx6000.

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

Open a fresh wmux pane on the Windows node. The pane bootstrap fetches the helper bundle from rtx6000 and stages scripts plus CMD shims into:

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
```

Notes:

- `validate` prints a JSON report for helper state, wmux API reachability, FFmpeg/Python/winget availability, hook config files, and stream Scheduled Task state.
- `persist-path` adds `%LOCALAPPDATA%\wmux\bin` to the persistent user PATH for future non-wmux shells.
- `install-deps` uses `winget` to install `Gyan.FFmpeg` and `Python.Python.3.12` when missing.
- `install-stream` installs and starts the per-user `wmux-stream-agent` Scheduled Task.

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

From rtx6000, request a short stream lease:

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

## Definition Of Done

- rtx6000 can SSH to the Windows user on `100.68.206.111:22` without a password prompt.
- `ssh -tt gisen@100.68.206.111 pwsh -NoLogo -NoProfile` opens an interactive prompt from rtx6000.
- Windows firewall exposes SSH only to Tailscale/internal clients.
- `wmux.config.json` uses `kind: "powershell-ssh"`, not legacy `kind: "powershell"`.
- `/api/bootstrap` reports `9800x3d` as reachable.
- Creating a wmux workspace on `9800x3d` opens an interactive PowerShell session.
- New Windows panes stage helper scripts into `%LOCALAPPDATA%\wmux\bin`.
- `wmux-notify`, `wmux-title`, `wmux-agent-event`, `wmux-run`, `wmux-media`, `wmux-copy`, `wmux-hooks`, `wmux-stream-agent-service`, and `wmux-windows-setup` resolve inside new Windows panes.
- `wmux-windows-setup validate` reports `wmuxApi.reachable: true`, helper scripts present, FFmpeg/Python available, and the stream task running.
- A short `/api/streams/9800x3d/request` lease causes the Windows stream agent to publish `wmux-9800x3d`, then return idle after release.

## Known Limits

- Windows SSH PowerShell panes are not durable yet. They are killed when `wmux.service` restarts.
- Windows helper staging and cwd reporting require a new pane after the wmux service has been updated.
- Windows screen streaming is validated on 9800x3d through FFmpeg/gdigrab and the per-user Scheduled Task. Locked/logged-out behavior, reconnect supervision, and a native Windows wmux agent are still not implemented.
