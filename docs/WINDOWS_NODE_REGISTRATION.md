# Windows Node Registration

This runbook registers a Windows machine, such as `windows-box`, as a wmux node from a Linux server.

Windows helper staging follows the same rules as POSIX staging: static panes receive only helper authorization, never controller credentials; registered panes retain bootstrap isolation and need separately provisioned helper auth.
In login-only mode use `WMUX_HELPER_TOKEN` or its configured path and send it in an authorization header only.
Do not place scoped credentials in URLs, query strings, PowerShell arguments, or logs.
Registration and per-host bootstrap capabilities remain separate principals.

wmux should use `kind: "powershell-ssh"` for Windows nodes reached from non-Windows servers. This transport starts local `ssh -tt` on the wmux server and launches `pwsh -NoLogo -NoProfile` on the Windows host by default. A static machine may opt into PowerShell's standard profile chain with `"loadPowerShellProfile": true`. Do not use the legacy `kind: "powershell"` WSMan transport from the wmux server.

References:

- Microsoft OpenSSH Server setup for Windows: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse
- Microsoft OpenSSH Server configuration for Windows: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration
- Microsoft OpenSSH key management for Windows: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement

## Inputs

Collect these values before changing either host:

```text
wmux server host: 100.64.0.10
windows node id: windows-box
windows node host: 100.64.0.30
windows ssh user: operator
windows ssh port: 22
```

If the Tailscale IP or Windows username differs, update the commands and `wmux.config.json` accordingly.

## 1. Prepare The wmux Server

Run on the wmux server.

1. Confirm the Windows node is reachable over Tailscale:

```bash
tailscale ping --timeout=3s --c 1 100.64.0.30
timeout 3 bash -lc '</dev/tcp/100.64.0.30/22' && echo 'ssh reachable'
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
ssh-keygen -t ed25519 -C 'wmux server'
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

6. Install the wmux server public key for the Windows user.

For a non-administrator user, append the public key from the wmux server to:

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

## 3. Validate From The wmux Server

Run on the wmux server.

1. Validate plain SSH:

```bash
ssh operator@100.64.0.30 hostname
```

2. Validate that PowerShell can run through SSH:

```bash
ssh operator@100.64.0.30 pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion'
```

3. Validate an interactive PowerShell session through forced-PTY SSH:

```bash
ssh -tt operator@100.64.0.30 pwsh -NoLogo -NoProfile
```

If this prompts for a password, complete the first validation interactively, then fix key authentication before expecting wmux to open panes without manual prompts.

## 4. Register In wmux

Update `wmux.config.json` or `~/.wmux/config.json`:

```json
{
  "id": "windows-box",
  "name": "Windows Box",
  "kind": "powershell-ssh",
  "host": "100.64.0.30",
  "user": "operator",
  "port": 22,
  "agentPort": 3481,
  "agentToken": "replace-with-a-long-random-token",
  "loadPowerShellProfile": true
}
```

Generate the agent token on the wmux server with `openssl rand -hex 32`.
Add the port and token before opening the first Windows pane so bootstrap stages a protected agent config, but leave `sessionBackend` unset until the agent and firewall have been validated.
Never commit this runtime-local token.

The Windows agent currently binds an IPv4 literal by design.
If SSH uses a DNS name, keep that name in `host` and add an explicit private IPv4 endpoint for the agent:

```json
{
  "host": "windows-box.lan",
  "agentUrl": "http://100.64.0.30:3481",
  "agentPort": 3481
}
```

`agentUrl` must be an `http://` origin with an explicit port and no credentials, path, query, or fragment.
`agentPort` and the port in `agentUrl` must match.
wmux rejects public, hostname-based, IPv6, and structurally ambiguous agent URLs before startup instead of staging an agent task that cannot pass its private-bind check.

Profile loading is disabled when the field is omitted and applies to both
plain SSH and `sessionBackend: "agent"` panes. wmux preserves a profile-defined
prompt behind its OSC 7 cwd wrapper, but still disables PSReadLine predictions
to avoid ghost text and applies the pane's requested starting directory after
the profile runs. Only new pane processes load the profile. Health probes,
helper invocations, update commands, dynamic heartbeat registrations, and the
legacy WSMan transport continue to use `-NoProfile`.

Build and restart the service if code changed; restart is enough for config-only changes:

```bash
npm run build
systemctl --user restart wmux.service
```

Check wmux status:

```bash
curl -fsS http://100.64.0.10:3478/api/bootstrap |
  jq '.machines[] | select(.id == "windows-box")'
```

The node is registered correctly when wmux reports:

```json
{
  "id": "windows-box",
  "kind": "powershell-ssh",
  "reachable": true,
  "endpoint": "100.64.0.30:22",
  "backendDetail": "SSH-launched PowerShell; pwsh 7.6.1; helpers ready; stream supervisor Running; ffmpeg+python"
}
```

For `powershell-ssh`, `/api/bootstrap` does more than a TCP check.
It runs a short encoded PowerShell health probe over SSH and reports helper readiness, `WMUX_URL` reachability through `/api/health`, FFmpeg/Python availability, and native-agent capture supervision state.

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
Windows-agent registration descriptor looks like this:

```json
{
  "machine": {
    "id": "windows-box",
    "name": "Windows Box",
    "kind": "powershell-ssh",
    "user": "operator"
  },
  "ttlMs": 90000,
  "metadata": { "os": "windows" }
}
```

`host` may remain in an older heartbeat file for compatibility, but wmux ignores
it and dials the validated private source address. The base agent injects
`sessionBackend: "agent"` plus its live port and token from
`~\.wmux\windows-agent.json` before each registration POST. This makes the
running listener authoritative and prevents credential drift between config
files. The token stays in the owner-only registry and is redacted from browser,
status, registry, and helper responses.

The staged `wmux-heartbeat` command remains a one-shot diagnostic that performs
the same port/token injection. Validate one POST with:

```powershell
& "$env:LOCALAPPDATA\wmux\bin\wmux-heartbeat.ps1" -Once
```

After a pane has staged the helper bundle through SSH bootstrap or the Windows
agent, install and inspect the single per-user agent task:

```powershell
wmux-windows-setup install-agent
wmux-windows-setup agent-status
wmux-windows-setup agent-logs
```

When rotating the registration token, update `~\.wmux\registration-token`; the
running agent reloads it on the next heartbeat. Address changes are accepted for
idle persisted panes, but any referenced pane pins the connection descriptor and
agent token until it is closed. A live Windows-agent pane also pins its callback
address. Close referenced panes before changing those pinned values, then run a
one-shot heartbeat or wait for the agent's next interval.

Rotating `agentToken` is a coordinated agent update: drain/close active panes
without forcing an agent restart, update the token in
`~\.wmux\windows-agent.json`, and safely restart the agent. Its next heartbeat
automatically advertises the new token. Use the
`wmux-windows-agent-service activate-update` drain flow described below when
the rotation is part of a staged agent update.

Registered panes stage the same helper commands as static panes but receive no
broad `WMUX_TOKEN` and never overwrite an existing `~\.wmux\token`. API-posting
helpers therefore return `401` unless normal or scoped auth is provisioned
separately. A token left from an earlier static setup continues to work; keep it
only when that trusted-host access is intentional, otherwise remove or rotate it.

## 5. Finish Windows Helper Setup

Open a fresh wmux pane on the Windows node. The pane bootstrap fetches the helper bundle from the wmux server and stages scripts plus CMD shims into:

```text
%LOCALAPPDATA%\wmux\bin
```

Bootstrap also creates `~\.wmux\windows-agent.json`.
It fills a missing agent token from the server-only machine configuration and repairs an older hostname-based bind value when the newly staged `agentUrl` supplies an explicit IP.
It does not overwrite an existing token, private bind IP, or backend choice.
Inspect the non-secret fields before installation:

```powershell
$AgentConfig = Get-Content "$HOME\.wmux\windows-agent.json" -Raw | ConvertFrom-Json
[pscustomobject]@{
  machine = $AgentConfig.machine
  host = $AgentConfig.host
  port = $AgentConfig.port
  backend = $AgentConfig.backend
  tokenPresent = [bool]$AgentConfig.token
}
```

`host` must be the Windows node's own private/internal IP, not its DNS name, and `tokenPresent` must be `True`.

Then run:

```powershell
wmux-windows-setup validate
wmux-windows-setup persist-path
wmux-windows-setup install-deps
wmux-windows-setup install-agent
wmux-windows-setup configure-agent-firewall <wmux-server-internal-ip>
wmux-windows-setup agent-status
```

For unattended startup before a console or RDP login, with the user's authenticated network credentials available to pane processes, install the agent in explicit password mode from an interactive private shell:

```powershell
wmux-windows-setup install-agent --logon-type Password
```

The prompt never accepts a password from an argument or environment variable.
Enter the account password, not a Windows Hello PIN; an interactive SSH PowerShell prompt is sufficient and no desktop login is required.
The task uses the hidden PowerShell launcher, so it does not create a visible terminal window.
The password crosses the Windows Task Scheduler registration API in memory and is retained only by Task Scheduler.
wmux pre-registers the base task, the eight adjacent rollout task slots, and the update watcher during that prompt; later headless rollouts only activate those fixed slots.
If the Windows account password changes, close active agent panes and refresh all task credentials:

```powershell
wmux-windows-setup refresh-agent-credentials
```

Notes:

- `validate` prints a JSON report for helper state, wmux API reachability, FFmpeg/Python/pywinpty/winget availability, hook config files, and native-agent capture supervision state.
- `persist-path` adds `%LOCALAPPDATA%\wmux\bin` to the persistent user PATH for future non-wmux shells.
- `install-deps` uses `winget` to install `Gyan.FFmpeg` and `Python.Python.3.12` when missing, then installs `pywinpty` with pip. It executes Python during detection so the Microsoft Store app-execution alias is not mistaken for an installed runtime.
- `install-agent` installs and starts the per-user `wmux-windows-agent` Scheduled Task for restart-durable sessions, in-process dynamic registration, and view-only capture supervision.
  It removes legacy standalone `wmux-heartbeat` and `wmux-stream-agent` tasks during migration.
- `install-agent --logon-type Password` prompts locally and installs a fixed password-backed task pool.
  It refuses to replace the pool while a reachable generation owns panes; `--force` is reserved for cases where terminating unverifiable or active panes is explicitly acceptable.
- `refresh-agent-credentials` re-prompts after an account-password change.
  It never reads the old Task Scheduler credential and does not persist the new password in wmux-owned files.
- `install-stream` remains a compatibility alias for `install-agent`, and `stream-status` reports the native agent.
- `configure-agent-firewall` must run from an elevated PowerShell session. It allows the configured base `agentPort` and eight adjacent rollout ports only from the exact Tailscale/RFC1918/IPv6 ULA wmux server addresses passed on the command line. For the default base port, the bounded range is `3481-3489`. `install-agent` warns when this managed rule is absent or stale.
- While an SSH pane is connected, `Get-NetTCPConnection -LocalPort 22 -State Established | Select-Object -ExpandProperty RemoteAddress -Unique` shows candidate source addresses for the exact wmux-server firewall argument.
  Confirm the address on the server before installing the rule.
- `agent-firewall-status` prints the expected range and current managed-rule state as JSON. If you manage Windows Firewall separately, create an equivalent exact-source rule for the same nine-port range; opening only the base port prevents safe side-by-side updates.
- The Windows agent task has user-logon and once-per-minute triggers, starts when available, restarts after failure, has no fixed execution-time cutoff, and launches through a hidden PowerShell wrapper instead of a visible `cmd.exe` window.
  `S4U` and `Password` modes can therefore start without a UI login.

If you are running setup from plain SSH before the helper directory is on PATH, invoke the staged script by path:

```powershell
& "$env:LOCALAPPDATA\wmux\bin\wmux-windows-setup.ps1" validate
```

## 6. Validate Screen Streaming

Direct capture probes from plain SSH can fail with Windows desktop access errors because the SSH process does not necessarily own the interactive desktop session:

```powershell
wmux-stream-agent --probe-capture
```

The intended Windows streaming path is the base native-agent Scheduled Task.
Validate that its capture supervisor is configured and running:

```powershell
wmux-windows-setup agent-status
wmux-windows-setup agent-logs
```

From the wmux server, request a short stream lease:

```bash
curl -fsS -X POST http://100.64.0.10:3478/api/streams/windows-box/request \
  -H 'content-type: application/json' \
  -d '{"requestId":"windows-smoke","ttlMs":12000}' | jq .
```

The Windows logs should show:

```text
wmux-stream-agent: stream requested for windows-box
wmux-stream-agent: publishing windows-box to rtsp://100.64.0.10:8554/wmux-windows-box
```

MediaMTX/wmux should report the stream as live while the lease is active:

```bash
curl -fsS http://100.64.0.10:3478/api/streams |
  jq '.streams[] | select(.machineId == "windows-box")'
```

Release the smoke lease when done:

```bash
curl -fsS -X DELETE http://100.64.0.10:3478/api/streams/windows-box/request/windows-smoke
```

## 7. Validate The Windows Session Agent

The experimental session agent listens on the configured Tailscale/internal host, defaulting to port `3481`. Automatic upgrades use one of the next eight ports, so all nine ports must be reachable from the wmux server:

```bash
curl -fsS http://100.64.0.30:3481/health | jq .
```

Expected:

```json
{
  "ok": true,
  "releaseVersion": "v0.1.2-win",
  "protocolVersion": 6,
  "machine": "windows-box",
  "backend": "conpty",
  "conptyAvailable": true,
  "pywinptyAvailable": true
}
```

New managed configs use `backend: "auto"`. Bootstrap merges preserve an existing `backend` value, so hosts previously staged with `"conpty"` remain pinned until `%USERPROFILE%\.wmux\windows-agent.json` is changed to `"auto"` and the agent is safely restarted with `wmux-windows-agent-service activate-update`.

Run a direct lifecycle smoke test:

```bash
agent_token='replace-with-the-existing-agent-token'
session="windows-agent-smoke"
curl -fsS -X POST "http://100.64.0.30:3481/sessions/$session" \
  -H "authorization: Bearer $agent_token" \
  -H 'content-type: application/json' \
  -d '{"cols":120,"rows":30,"cwd":"C:\\Users\\operator"}'
da=$(printf '\033[?64;1;2;6;9;15;18;21;22c' | base64 -w0)
curl -fsS -X POST "http://100.64.0.30:3481/sessions/$session/input" \
  -H "authorization: Bearer $agent_token" \
  -H 'content-type: application/json' \
  -d "{\"dataBase64\":\"$da\"}"
curl -fsS -X POST "http://100.64.0.30:3481/sessions/$session/input" \
  -H "authorization: Bearer $agent_token" \
  -H 'content-type: application/json' \
  -d '{"dataBase64":"V3JpdGUtT3V0cHV0ICJoZWxsby1mcm9tLWFnZW50Ig0="}'
curl -fsS -H "authorization: Bearer $agent_token" "http://100.64.0.30:3481/sessions/$session/output?cursor=0&timeoutMs=1000" |
  jq -r '.dataBase64' | base64 -d
curl -fsS -X DELETE -H "authorization: Bearer $agent_token" "http://100.64.0.30:3481/sessions/$session"
unset agent_token
```

To make wmux use the agent for new panes, opt in explicitly:

```json
{
  "id": "windows-box",
  "name": "Windows Box",
  "kind": "powershell-ssh",
  "host": "100.64.0.30",
  "user": "operator",
  "port": 22,
  "sessionBackend": "agent",
  "agentPort": 3481,
  "agentToken": "replace-with-the-existing-agent-token"
}
```

If `host` is a DNS name, retain the matching private-IP `agentUrl` added in step 4.
Restart `wmux.service` after setting `sessionBackend`; existing panes keep their original backend, while newly created panes use the agent.

Keep the legacy `powershell-ssh` path available as a fallback while the ConPTY agent is still being validated.

The agent task uses `Interactive` logon when a desktop user is logged in and falls back to `S4U` on a headless host.
S4U avoids a stored password and does not require a live desktop session, but Windows does not make delegated network credentials available to S4U processes.
Override automatic selection before installation with `--logon-type Interactive`, `--logon-type S4U`, or the corresponding `WMUX_WINDOWS_AGENT_LOGON_TYPE` value.
Explicit `Password` mode also starts without a desktop login and supplies network credentials, but account-password rotation requires `refresh-agent-credentials`.
Password mode is accepted only through the private local prompt; `--password` and `WMUX_WINDOWS_AGENT_PASSWORD` are rejected.
Logon and once-per-minute triggers supervise the task; `MultipleInstances: IgnoreNew` prevents duplicate agents, while `wmux-windows-agent-service stop` disables the task so an intentional stop remains stopped.

## Definition Of Done

- The wmux server can SSH to the Windows user on `100.64.0.30:22` without a password prompt.
- `ssh -tt operator@100.64.0.30 pwsh -NoLogo -NoProfile` opens an interactive prompt from the wmux server.
- Windows firewall exposes SSH only to Tailscale/internal clients.
- Windows firewall exposes the agent's base-through-eight rollout range only to the wmux server's exact internal address.
- `wmux.config.json` uses `kind: "powershell-ssh"`, not legacy `kind: "powershell"`.
- `/api/bootstrap` reports `windows-box` as reachable.
- Creating a wmux workspace on `windows-box` opens an interactive PowerShell session.
- New Windows panes stage helper scripts into `%LOCALAPPDATA%\wmux\bin`.
- `wmux-notify`, `wmux-title`, `wmux-agent-event`, `wmux-run`, `wmux-media`, `wmux-copy`, `wmux-clip`, `wclip`, `wmclip`, `wmux-hooks`, `wmux-stream-agent-service`, and `wmux-windows-setup` resolve inside new Windows panes.
- `wmux-windows-setup validate` reports `wmuxApi.reachable: true`, helper scripts present, FFmpeg/Python/pywinpty available, and native-agent capture supervision running.
- A short `/api/streams/windows-box/request` lease causes the Windows stream agent to publish `wmux-windows-box`, then return idle after release.
- `wmux-windows-setup validate` reports the `wmux-windows-agent` helper and agent config present.
- `wmux-windows-setup agent-status` reports the authenticated Windows session agent as healthy.
- A direct `/sessions/:id` create/input/output/delete smoke test returns command output.
- Creating a new pane against an outdated agent stages the current release and starts a side-by-side Scheduled Task generation on an unused adjacent port. The new pane moves to that generation, existing panes remain pinned to their owning generation, and wmux persists the selected port for restart-safe routing.
- `wmux-windows-setup agent-firewall-status` reports the configured base-through-eight agent port range as allowed from the wmux server.
- In Password mode, `wmux-windows-setup validate` reports `agentStartsWithoutLogin: true`, `agentNetworkCredentialsAvailable: true`, and `agentGenerationSlotsReady: true`; after a reboot with no UI login, `/health`, pane creation, and an authenticated network-resource smoke test succeed.
- `wmux-windows-agent-service activate-update` remains the manual in-place restart-when-idle flow; `cancel-update` cancels it. `rollout-update --port PORT` is the lower-level generation launcher used by wmux.
- `wmux-windows-setup install-hooks` reports Claude and Codex hooks installed; `/hooks` in a new Codex session shows the direct PowerShell command ready for review/trust.
- Changing directories in PowerShell updates the pane cwd, and a same-host split starts in that directory.
- With `loadPowerShellProfile` enabled, a profile-defined function and prompt are available in each new direct or agent-backed pane while cwd tracking still works.

## Known Limits

- Legacy Windows SSH PowerShell panes are not durable. Agent-backed Windows panes are owned by `wmux-windows-agent`; wmux service shutdown detaches its client while explicit pane closure deletes the owned pane process and its Windows Job Object, terminating detached descendants.
- Windows helper staging and cwd reporting require a new pane after the wmux service has been updated. For agent-backed hosts, that pane also activates a staged agent update when it is safe.
- `wmuxctl run` and `wmuxctl ps` automatically recognize the standard `PS ...>` readiness prompt. An arbitrary profile-defined prompt may not match; after confirming the custom prompt is visible, use `--no-wait-ready` or target the pane with `wmuxctl send`.
- Windows screen streaming is validated on a dogfood Windows host through FFmpeg/gdigrab and native-agent supervision.
  Locked and logged-out behavior is still not implemented.
- The managed Windows session agent uses `backend: "auto"`, preferring pywinpty-backed ConPTY and falling back to terminal-normalized stdio when pywinpty is unavailable. It is restart-durable across `wmux.service` restarts while the owning Windows agent generation keeps running. Agent releases use the same platform-suffixed wmux version shown by the UI (for example, `v0.1.2-win`); the HTTP protocol version is reported separately. Automatic rollout is side-by-side; protocol v2 separates update-pending from hard-drain state, protocol v3 refreshes durable callback state on attach, protocol v5 carries the per-session PowerShell profile preference, and protocol v7 switches the session console to UTF-8 and maps CRLF input onto the line-oriented stdio fallback. It supports terminal-safe stdio newlines and byte-exact resize boundaries. Legacy agents use a compatibility watcher plus a best-effort 80x24 replay fallback. A forced Windows-agent restart still kills owned pane processes, so process preservation across an unexpected agent crash and broad full-screen app validation remain pending.
- A Windows host reboot necessarily terminates its ConPTY processes.
  When the restarted agent reports `unknown_session` for a pane that wmux still owns, wmux clears the stale screen and recreates the same pane ID as a fresh shell at its last known cwd and dimensions.
  Pane navigation therefore recovers, but the pre-reboot process and its in-memory state do not.
