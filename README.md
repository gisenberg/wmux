# wmux

A browser-based terminal multiplexer for a Tailscale or internal network.

wmux combines:

- a localterm-style PTY-over-WebSocket service,
- a cmux-style left workspace rail with tabs and split panes,
- ghostty-web canvas terminal rendering in the browser.

## Run

```bash
npm install
npm run build
npm run start -- --host 127.0.0.1 --port 3478
```

To expose on Tailscale, bind to this machine's Tailscale IP:

```bash
npm run start -- --host 100.x.y.z --port 3478
```

The server refuses public bind hosts. Use loopback, Tailscale `100.64.0.0/10`, or an RFC1918/internal address.

## Run As A User Service

Install and start the systemd user service:

```bash
scripts/install-user-service.sh
```

This chooses the first Tailscale IPv4 address when available. Override it with:

```bash
WMUX_HOST=100.x.y.z WMUX_PORT=3478 scripts/install-user-service.sh
```

Useful service commands:

```bash
systemctl --user status wmux.service
systemctl --user restart wmux.service
journalctl --user -u wmux.service -f
```

## Configure Machines

Put machine definitions in `wmux.config.json` or `~/.wmux/config.json`:

```json
{
  "machines": [
    {
      "id": "away-team",
      "name": "Away-Team",
      "kind": "ssh",
      "host": "away-team.tailnet-name.ts.net",
      "user": "gisenberg"
    },
    {
      "id": "9800x3d",
      "name": "9800x3d",
      "kind": "powershell-ssh",
      "host": "9800x3d",
      "user": "gisen"
    }
  ]
}
```

If the browser accesses wmux through a MagicDNS or reverse-proxy name that is not under `*.ts.net`, set `WMUX_ALLOWED_HOSTS` to a comma-separated allowlist.

Unix-like local and SSH machines default to `"sessionBackend": "auto"`, which attaches panes to a durable `tmux` session when available, or `screen` when `tmux` is not installed. Use `"sessionBackend": "pty"` to force the original raw PTY behavior for a machine.

Use `kind: "powershell-ssh"` for Windows hosts reachable from a non-Windows wmux server. It starts the local `ssh` client with a forced TTY and launches `pwsh -NoLogo -NoProfile` on the Windows host, so the Windows host must have PowerShell 7 and OpenSSH Server configured for the target user. Reachability for this kind requires a local `ssh` client, a TCP response on SSH port 22, and a short PowerShell health probe that reports helper and stream readiness. This path does not use WSMan or the PowerShell SSH remoting subsystem.

Legacy `kind: "powershell"` still uses `Enter-PSSession -ComputerName`, which uses WSMan remoting. Microsoft documents WSMan remoting as unsupported from non-Windows PowerShell hosts, so an Ubuntu wmux server such as homelab cannot reliably drive a Windows host that way even if `pwsh` is installed and WinRM answers on TCP 5985. PowerShell panes are currently non-durable; they do not survive a wmux service restart the way local/SSH `tmux` or `screen` panes do. Durable Windows process persistence needs a Windows-side wmux agent/service.

For the full Windows registration checklist, see [docs/WINDOWS_NODE_REGISTRATION.md](docs/WINDOWS_NODE_REGISTRATION.md).

## Settings

The settings modal writes to `~/.wmux/settings.json` on the wmux server. Current settings cover terminal font size and host display aliases, so aliases follow you across browsers without changing the underlying machine IDs used for connections.

## Notifications

Each pane receives these environment variables:

```bash
WMUX_URL
WMUX_WORKSPACE_ID
WMUX_WORKSPACE_NAME
WMUX_TAB_ID
WMUX_TAB_TITLE
WMUX_PANE_ID
```

Local panes also have this repo's `scripts/` directory prepended to `PATH`, so a command or agent hook can notify wmux with:

```bash
wmux-notify --title "Codex" --subtitle "Completed" --body "Run finished"
```

The same endpoint works from remote machines on the Tailnet:

```bash
curl -fsS \
  -H 'content-type: application/json' \
  -d "{\"paneId\":\"$WMUX_PANE_ID\",\"title\":\"Codex\",\"subtitle\":\"Completed\",\"body\":\"Run finished\"}" \
  "$WMUX_URL/api/notifications"
```

Unread notifications light the workspace, tab, and pane. The browser notification button in the top bar requests browser notification permission.

SSH panes stage remote helper commands into `~/.cache/wmux/bin` when the pane process starts. That makes `wmux-notify`, `wmux-title`, `wmux-agent-event`, `wmux-run`, `wmux-media`, `wmux-copy`, its `wmux-clip`/`wclip`/`wmclip` aliases, and `wmux-stream-agent` available on hosts like Away-Team without manually copying this repo there.

Windows `powershell-ssh` panes fetch a helper bundle from wmux when the pane starts and stage PowerShell/CMD shims into `%LOCALAPPDATA%\wmux\bin`. New Windows panes get the same helper command names plus `wmux-hooks`, `wmux-stream-agent-service`, and `wmux-windows-setup`.

On Windows, use the setup helper to validate and finish host-local setup:

```powershell
wmux-windows-setup validate
wmux-windows-setup persist-path
wmux-windows-setup install-deps
wmux-windows-setup install-stream
wmux-windows-setup install-agent
```

`install-deps` uses `winget` to install FFmpeg and Python when missing, then installs `pywinpty` for the Windows session agent's ConPTY backend. `install-stream` creates the per-user Scheduled Task that runs the on-demand screen stream agent. `install-agent` creates a per-user Scheduled Task for the experimental Windows session agent, which uses ConPTY by default. Both Scheduled Tasks are registered to start at user logon, start when available, restart after failure, run without the default 72-hour execution cutoff, and launch through hidden PowerShell wrappers instead of visible `cmd.exe` windows.

## Agent Events

wmux can update workspace names/descriptors and send completion notifications from agent hooks:

```bash
wmux-agent-event --agent codex --status completed --title "Remote helpers" --summary "Fixed Away-Team helper staging"
```

The helper posts to `POST /api/agent-events`. It uses the pane environment variables when available and exits without changing state if it is run outside a wmux pane.

Install agent hooks on this machine with:

```bash
wmux-hooks install claude
wmux-hooks install codex
```

This merges `Stop` and `Notification` hooks into `~/.claude/settings.json`. Claude Stop hooks read the transcript path from hook input, derive a short workspace title from the latest user prompt, derive the descriptor from the latest assistant text, and create a completion notification. Restart Claude Code after installing hooks.

The Codex installer merges `UserPromptSubmit` and `Stop` hooks into `~/.codex/hooks.json`. Codex requires you to run `/hooks` inside Codex and trust the new command hook before it will run. Start a new Codex session after installing or trusting hooks if an existing session does not pick up the config.

OpenCode wrappers can call `wmux-agent-event` manually until wmux has verified a stable hook config surface for that tool.

## Activity And Run Metadata

The activity drawer in the top bar shows recent agent events and tracked command runs with workspace, tab, host, duration, and exit status context. Use `wmux-run` when you want a command to appear there:

```bash
wmux-run -- npm test
wmux-run -- ./scripts/deploy-staging.sh
```

The originating pane toolbar shows the latest tracked run outside the terminal canvas, with copy and rerun controls. SSH panes stage `wmux-run` on new launches the same way they stage the other helpers.

## Browser Media

Raw `cat image.png` still writes binary bytes to the terminal. To hand wmux media in a browser-aware way, use:

```bash
wmux-media ./image.png
wmux-media ./sound.wav
```

Images prefer Kitty inline rendering through `kitten icat --transfer-mode=stream --passthrough=tmux --align=left --engine=builtin --stdin=no` and fall back to the wmux media shelf if `kitten` is unavailable. Audio and video render with browser-native controls, so playback starts from a user click instead of autoplay. Use `wmux-media --mode http ./image.png` to force the shelf or `wmux-media --mode kitty ./image.png` to fail instead of falling back.

## Browser Clipboard

Pipe text to the browser-side clipboard buffer with:

```bash
git diff | wmux-copy
wmux-copy ./notes.txt
git show | wclip
```

`wmux-clip`, `wclip`, and `wmclip` are aliases for `wmux-copy`.

wmux asks the open browser to write the text to the OS clipboard immediately. If the browser blocks the write because it requires a user gesture, the top-bar clipboard button turns attention-colored; click it to copy the buffered text.

## Machine Screen Streams

wmux can show a machine-local pixel stream for the active workspace host. The media router is a user-level MediaMTX service on the wmux server:

```bash
scripts/install-stream-service.sh
```

This binds RTSP and WebRTC to the Tailscale IP and keeps the MediaMTX API on loopback. Each participating machine runs a lightweight stream agent for its own screen:

```bash
wmux-stream-agent-service install
wmux-stream-agent-service status
```

The Stream button in the top right opens the WebRTC stream for the active workspace machine on desktop viewports. Opening the dialog requests a short-lived stream lease over the wmux WebSocket; closing it releases the lease. `wmux-stream-agent` polls that lease endpoint and starts `screencapture`/ffmpeg only while at least one browser is actively requesting the stream.

New wmux panes expose `WMUX_STREAM_RTSP_URL` and `WMUX_STREAM_WHIP_URL` so custom publishers know where to publish. The default `~/.wmux/stream-agent.json` also includes `wmuxUrl`, `onDemand: true`, and `pollInterval`.

On macOS, the terminal app that launches `wmux-stream-agent` needs Screen Recording permission: System Settings -> Privacy & Security -> Screen Recording. Enable your terminal app, SSH service wrapper, or whichever app owns the process, then restart that app/session.

For macOS hosts, prefer running the capture helper as a GUI LaunchAgent so it can access the active WindowServer display:

```bash
wmux-stream-agent-service status
wmux-stream-agent-service logs
```

On Windows hosts, `wmux-stream-agent-service install` creates a supervised per-user Scheduled Task at logon. The task runs in the logged-in user's desktop session but launches through a hidden PowerShell wrapper, so normal operation should not leave an empty console window on screen. `wmux-windows-setup install-deps` can install FFmpeg and Python with `winget`, installs `pywinpty`, and `wmux-stream-agent --probe-capture` can test a direct one-frame FFmpeg capture. Direct SSH capture may fail with Windows desktop access errors; the scheduled task is the intended path because it runs in the logged-in interactive user context.

## Experimental Windows Session Agent

Windows hosts can run `wmux-windows-agent` as a per-user Scheduled Task:

```powershell
wmux-windows-setup install-agent
wmux-windows-setup agent-status
```

The agent listens on the configured Tailscale/internal host and owns pane processes outside the wmux server process. To opt a Windows machine into it, set:

```json
{
  "id": "9800x3d",
  "kind": "powershell-ssh",
  "host": "100.68.206.111",
  "user": "gisen",
  "sessionBackend": "agent",
  "agentPort": 3481
}
```

The Windows agent uses `pywinpty` with its native ConPTY backend by default, so pane input, resize, rich line editing, and full-screen terminal applications go through Windows' pseudo console API instead of redirected PowerShell stdio. A `backend: "stdio"` config value remains available as an explicit fallback for debugging older hosts.

## Workspace Titles

wmux has cmux-inspired generated title support. Generated titles are tracked separately from user-owned titles, so an auto update cannot overwrite a workspace or tab you manually named.

From inside a pane:

```bash
wmux-title --title "Auth Refactor" --descriptor "codex completed"
```

To intentionally claim a manual workspace name:

```bash
wmux-title --manual --title "Production Logs"
```

The API endpoint behind this is `POST /api/workspaces/:workspaceId/auto-title` with `title`, optional `descriptor`, optional `tabId`, and optional `tabOnlyIfMultiple`.

## Direct Links

Workspace rows and tab pills are real navigation links. A specific workspace and tab can be opened directly with:

```text
/workspaces/:workspaceId/tabs/:tabId
```

The link button in the top bar copies the active workspace/tab URL when the browser allows clipboard access.

## Current Directory Preservation

When you create a new workspace, tab, or split on the same host as the source pane, wmux starts the new pane in that source pane's current working directory. With the default durable backend this is resolved from tmux's live `pane_current_path`, so it follows normal `cd` usage without requiring a shell helper. If tmux is unavailable, wmux falls back to the last cwd reported by OSC 7. Local and SSH panes launched through wmux install a temporary zsh/bash prompt hook for this when the backend passes OSC 7 through. Windows `powershell-ssh` panes install a temporary PowerShell prompt function that emits OSC 7 for filesystem locations.

## Command Palette

Open the command palette with `Cmd+K` or `Ctrl+K`, or use the command icon in the top bar. It searches common actions, workspace and tab navigation, host-scoped session creation, pane splits, settings, and session audit entry points.

The workspace rail has a host filter for narrowing the left navigation without changing the target host used for new workspaces and tabs. Splits open on the host of the pane being split.

## Durable Session Audit

wmux durable sessions are named from pane ids, for example `wmux_pane_804cafba`. If a backend changes from `screen` to `tmux`, or a service restart loses track of a pane, old multiplexer sessions can remain alive.

Check local wmux-managed `tmux` and `screen` sessions with:

```bash
npm run audit:sessions
```

The audit reports:

- `active`: a multiplexer session matching a pane in `~/.wmux/state.json`.
- `duplicate`: more than one backend exists for the same active pane, usually an old fallback session after switching to tmux.
- `orphan`: a wmux-named multiplexer session whose pane id is no longer in state.
- `missing`: a pane in state without a local durable multiplexer session.

Use `npm run audit:sessions -- --json` for machine-readable output.

The settings modal can quit local duplicate/orphan `tmux` or `screen` sessions after confirmation. It refuses to quit active sessions and refuses non-`wmux_` session names.

## Splits

- `Cmd+D` / `Ctrl+D` splits the active pane to the right.
- `Cmd+Shift+D` / `Ctrl+Shift+D` splits the active pane below.
- Drag the divider between split panes to resize the split. Ratios persist with the tab layout.
- The close button on a split pane removes that pane and collapses the layout.
- Exiting a shell in a split pane removes that pane.
- Exiting the last pane in a tab closes the tab.
- Exiting the last tab in a workspace closes the workspace. If it was the final workspace, wmux creates a fresh idle local workspace.

## Restart Persistence

wmux persists workspace/tab/pane metadata in `~/.wmux/state.json`. For local and SSH machines using the default durable backend, each pane also maps to a stable `tmux`/`screen` session named from the pane ID. After a wmux service restart, reopening the pane attaches to that durable session instead of starting a fresh shell.

Explicitly closing a pane, tab, or workspace from wmux kills the matching durable session. Windows SSH PowerShell panes do not yet have an equivalent durable backend.

## Keyboard Shortcuts

wmux implements the cmux shortcuts that fit a browser app. Use `Cmd` on macOS and `Ctrl` on Windows/Linux unless a shortcut explicitly says otherwise.

- `Cmd/Ctrl+N`: new workspace
- `Cmd/Ctrl+1` through `Cmd/Ctrl+8`: jump to workspace 1 through 8
- `Cmd/Ctrl+9`: jump to the last workspace
- `Ctrl+Cmd+]` / `Ctrl+Cmd+[`: next / previous workspace on macOS
- `Ctrl+Alt+]` / `Ctrl+Alt+[`: next / previous workspace on Windows/Linux
- `Cmd/Ctrl+T`: new tab
- `Alt+1` through `Alt+8`: jump to tab 1 through 8
- `Alt+9`: jump to the last tab
- `Cmd/Ctrl+Shift+]` / `Cmd/Ctrl+Shift+[`: next / previous tab
- `Ctrl+Tab` / `Ctrl+Shift+Tab`: next / previous tab, when the browser allows it
- `Cmd/Ctrl+W`: close tab, when the browser allows it
- `Cmd/Ctrl+Shift+W`: close workspace, when the browser allows it
- `Cmd/Ctrl+B`: toggle sidebar
- `Cmd/Ctrl+D`: split right
- `Cmd/Ctrl+Shift+D`: split down
- `Option/Alt+Left` / `Option/Alt+Right`: move cursor to previous / next word in the active shell
- `Option+Cmd+Arrow` / `Alt+Ctrl+Arrow`: focus neighboring pane in layout order
- `Cmd/Ctrl+Shift+U`: jump to latest unread notification

Some browser or OS-reserved shortcuts may not reach wmux on every platform.

## Design Direction

The terminal viewport should stay visually neutral. Product styling belongs in surrounding chrome: workspace rail, tab strip, pane toolbar, settings, activity, notifications, and audit views. Current chrome uses dense cmux-inspired navigation with dark surfaces, thin borders, compact uppercase labels, clipped corners, gold focus accents, and small reachability/status indicators.
