# AGENTS.md

## Project

wmux is a browser terminal multiplexer for one user's Tailscale or internal network. It combines:

- localterm-style PTY-over-WebSocket service ownership,
- cmux-style workspaces, tabs, split panes, activity, generated titles, and agent notifications,
- `ghostty-web` terminal rendering in the browser,
- durable `tmux`/`screen` backing for local and SSH panes,
- browser-aware media, clipboard, and mobile ergonomics.

This is intentionally not a multi-tenant SaaS app. Authentication currently relies on the private network boundary plus bind/Host/Origin checks.

## Commands

- `npm install` installs dependencies.
- `npm run dev -- --host 127.0.0.1 --port 3478` starts the app in development mode with Vite middleware.
- `npm run typecheck` runs client and server TypeScript checks.
- `npm run build` builds the client and server.
- `npm run start -- --host 127.0.0.1 --port 3478` runs the built service.
- `npm run audit:sessions` audits local wmux-managed durable `tmux`/`screen` sessions.
- `npm run audit:sessions -- --json` emits the same audit as JSON.
- `scripts/install-user-service.sh` installs or updates the systemd user service. It picks a Tailscale IPv4 address when available; override with `WMUX_HOST` and `WMUX_PORT`.

Useful service commands:

- `systemctl --user status wmux.service`
- `systemctl --user restart wmux.service`
- `journalctl --user -u wmux.service -f`

## Network Safety

The service must only bind to loopback, Tailscale `100.64.0.0/10`, or RFC1918/internal addresses. Do not weaken the bind checks in `src/server/bind.ts` without adding a replacement control that still prevents public internet exposure. The current dogfood service is expected to bind to the host's Tailscale IP, not `0.0.0.0`.

For MagicDNS names or reverse-proxy hostnames, set `WMUX_ALLOWED_HOSTS` to a comma-separated allowlist. `*.ts.net` is allowed for Tailscale host headers.

Keep websocket, media, clipboard, hook, and run endpoints behind the same network boundary. Do not add CORS broadening or public callback endpoints without also adding an auth story.

## Architecture Notes

- Server state lives in `~/.wmux/state.json` unless `WMUX_STATE_PATH` is set.
- Server-backed UI settings live in `~/.wmux/settings.json` unless `WMUX_SETTINGS_PATH` is set.
- Machine definitions are read from `./wmux.config.json` first, then `~/.wmux/config.json`.
- Keep remote-machine behavior explicit in `MachineConfig`; do not hide durable/session behavior in UI-only state.
- The `local` and SSH machines default to durable `tmux`/`screen` sessions via `sessionBackend: "auto"`.
- Use `kind: "powershell-ssh"` for Windows hosts reached from non-Windows wmux servers. It uses local `ssh -tt` to launch remote `pwsh`; follow [docs/WINDOWS_NODE_REGISTRATION.md](docs/WINDOWS_NODE_REGISTRATION.md) for setup and validation. Legacy `kind: "powershell"` means WSMan `Enter-PSSession -ComputerName`; do not mark it online from a non-Windows wmux host by TCP probe alone.
- `powershell-ssh` host status runs a short encoded PowerShell health probe over SSH, cached for about 15 seconds. It reports helper readiness, wmux reachability through `/api/health`, FFmpeg/Python availability, and the `wmux-stream-agent` Scheduled Task state.
- `sessionBackend: "agent"` on a `powershell-ssh` machine opts into the experimental Windows session agent at `agentUrl` or `http://host:agentPort`. This is restart-durable across wmux server restarts because the Windows agent owns the pane process and replay buffer. The default Windows agent backend is ConPTY; `backend: "stdio"` remains an explicit debug fallback.
- Same-machine workspace/tab/split creation should preserve the source pane cwd. The primary source is tmux `#{pane_current_path}`; OSC 7 cwd reports from wmux-managed zsh/bash prompt hooks are the fallback state update path.
- A pane maps to one long-lived server PTY client while the wmux service process is alive. Closing or refreshing the browser disconnects the WebSocket but does not kill the pane process.
- Restarting the wmux service restores layout metadata and reattaches local/SSH durable sessions when the target has `tmux` or `screen`. Raw PTY and PowerShell panes still cannot preserve live process state across service restart.
- Multiple browsers may attach to the same pane. Only one socket at a time owns PTY resize for that pane; passive viewers do not resize it. Input from a passive viewer promotes that viewer to resize owner and applies that viewer's latest dimensions.
- Browser reconnect replay is bounded in memory. After service restart, durable sessions redraw from `tmux`/`screen`; wmux does not persist a full terminal transcript.
- SSH panes stage `wmux-media`, `wmux-copy`, its `wmux-clip`/`wclip`/`wmclip` aliases, `wmux-notify`, `wmux-title`, `wmux-agent-event`, and `wmux-run` into `~/.cache/wmux/bin` on the remote host and try to place shims in common user bin directories such as `~/.local/bin`, `~/.cargo/bin`, and `~/bin`.
- Windows `powershell-ssh` panes fetch helper scripts from `/api/helpers/windows/:machineId`, stage them into `%LOCALAPPDATA%\wmux\bin`, prepend that directory to `PATH`, and install a temporary PowerShell prompt function for OSC 7 cwd reporting.
- POSIX SSH helper staging must run under POSIX `sh`; do not rely on zsh/bash-specific word splitting in `src/server/machines.ts`.
- Session audit cleanup must remain limited to local `wmux_` tmux/screen sessions that the audit marks duplicate or orphan. Never add automatic cleanup of active sessions or non-wmux multiplexer sessions.
- Machine screen streams are machine-local or gateway-local captures, not browser captures. The MediaMTX helper path has the active host publish its own pixels to the MediaMTX service on homelab, and wmux viewers embed the active machine's WebRTC path. The Moonlight gateway path proxies a browser-native Moonlight/Sunshine bridge. Do not replace either path with `getDisplayMedia` from the viewing browser.
- MediaMTX helper capture should remain on-demand. The browser requests/releases a short stream lease through the existing `/ws/events` socket, while `wmux-stream-agent` polls the wmux lease endpoint and only runs `screencapture`/ffmpeg while a lease is active.
- MediaMTX should bind RTSP/WebRTC only to the Tailscale/internal interface and keep its API on loopback. Use `scripts/install-stream-service.sh` for repeatable setup.
- `wmux-moonlight-gateway` should bind only to loopback, Tailscale, or RFC1918/internal addresses. It is a clean process boundary around browser-native Moonlight bridges such as Moonlight Web Stream; do not vendor or copy GPL implementation code into wmux without an explicit license decision. Its setup API may automate the supported pairing flow by generating the Moonlight Web PIN and submitting it to Sunshine's `/api/pin`, but it should not edit Sunshine's paired-client state directly. The Sunshine PIN device name must match the upstream Moonlight bridge's pair device name; Moonlight Web Stream v2.10.0 currently hardcodes this as `roth`. Browser autologin should use gateway environment credentials to mint a Moonlight Web session cookie; do not commit raw Moonlight Web credentials into `wmux.config.json`.

## UI And Interaction Notes

- The terminal canvas/content area should remain visually untreated. Product styling belongs in surrounding chrome, overlays, sidebars, shelves, and toolbars.
- The default chrome is the OpenTUI-inspired path. `?legacy=1` keeps the older React chrome available.
- OpenTUI chrome surfaces use the vendored `opentui-browser` package under `vendor/opentui-browser`; upstream is private/unpublished and currently treated as an experimental snapshot. Preserve provenance in `vendor/opentui-browser/UPSTREAM.md`.
- The empty-workspace view is a sibling WebGL shader, not a ghostty-web shader. It renders a Game-of-Life/metal light-panel cube field with mobile-adjusted projection and click-to-toggle cells.
- Settings remains a DOM modal because it contains editable controls and destructive session-audit actions.
- Machine aliases are user-facing labels only. Underlying machine IDs and hosts must remain stable for links, state, and helper environment.
- Host status should show useful network identity. Respect the current alias/IP display convention when adjusting host labels.
- Workspace rows should show title, trimmed descriptor, and host context without overlapping. Use tooltips for longer descriptors.
- Workspace rows and tab pills are real links. Preserve `/workspaces/:workspaceId/tabs/:tabId` direct-link behavior.
- The command palette is opened by `Cmd/Ctrl+K` and should remain the preferred entry point for actions that do not need permanent top-level controls.
- The host filter in the workspace rail narrows navigation. The target host for creating new workspaces/tabs is controlled by explicit host selection. Splits default to the host of the pane being split.
- Mobile layout uses the VisualViewport API plus `--wmux-viewport-height`. When the software keyboard is open, hide chrome by collapsing dimensions while keeping terminal components mounted.
- The mobile sidebar is a drawer and should default collapsed on narrow viewports.
- On mobile, split panes collapse to the active pane instead of trying to show every split at once.
- Do not rely on iOS Safari letting a web app remove all keyboard/browser accessory UI. The hidden terminal textarea should keep `autocomplete="off"`, `autocorrect="off"`, `autocapitalize="none"`, `spellcheck="false"`, and related assist-disabling attributes.

## Terminal And Pane Behavior

- Use `ghostty-web` for terminal rendering. Avoid swapping in DOM terminal rendering without a deliberate migration plan.
- `TerminalPane` configures Option/Alt word movement, cmux-style split/close shortcuts, and mobile focus behavior. Be careful when changing key handling because browsers reserve some combos.
- `Cmd/Ctrl+D` splits to the right; `Cmd/Ctrl+Shift+D` splits below.
- Split dividers are draggable and ratios persist in the tab layout.
- Closing a split pane removes it and collapses the layout. Exiting a shell in a split pane should remove that pane.
- Exiting the last pane in a tab closes the tab. Exiting the last tab in a workspace closes the workspace. If all workspaces are closed, wmux creates or shows the idle empty state.
- Explicitly closing a pane/tab/workspace should kill the matching durable session.
- When adding terminal protocol support, make sure replay, resize, scrollback, and multiplexer passthrough behavior are considered.

## Helpers And Integrations

- Agent events are handled by `POST /api/agent-events`; this updates auto-owned workspace titles/descriptors and creates terminal notifications for completed/failed/stopped states.
- `wmux-title` updates generated or manual workspace/tab titles. Generated titles must not overwrite user-owned titles.
- `wmux-notify` creates browser/terminal notifications through the wmux API.
- Run metadata is handled by `POST /api/run-events`; `scripts/wmux-run` wraps a command and records start/completion state without changing terminal canvas output.
- Browser clipboard handoff is handled by `POST /api/clipboard`; `scripts/wmux-copy` reads stdin or a file and lets the browser attempt the OS clipboard write with a top-bar fallback button. `wmux-clip`, `wclip`, and `wmclip` are aliases.
- Browser media handoff is handled by `wmux-media`. Images prefer `kitten icat --transfer-mode=stream --passthrough=tmux --align=left --engine=builtin --stdin=no`; audio/video render in browser media controls; `--mode http` forces the media shelf and `--mode kitty` fails instead of falling back.
- `wmux-sunshine-setup` is the macOS SSH-host Sunshine setup helper. It installs the official macOS DMG by default, can use the official LizardByte Homebrew tap with `WMUX_SUNSHINE_INSTALL_METHOD=brew`, configures `sunshine --creds`, and runs Sunshine through a per-user GUI LaunchAgent. It cannot bypass macOS Screen Recording, Accessibility/Input Monitoring, or Local Network approval prompts.
- Windows helper scripts live under `scripts/windows` and are served as a Base64 helper bundle instead of being embedded in the SSH command line. Keep the launch command small; Windows OpenSSH rejects large encoded commands.
- `wmux-windows-setup` is the Windows self-check/setup entry point. It validates helper state, can persist the helper directory to the user PATH, can install FFmpeg/Python with `winget`, installs `pywinpty` for ConPTY, and can install/status the per-user stream and session-agent Scheduled Tasks. It must work both inside a bootstrapped wmux pane and from plain SSH where `%LOCALAPPDATA%\wmux\bin` is not yet on `PATH`.
- `wmux-windows-agent` is served as `wmux-windows-agent.py` plus a CMD shim. Its HTTP API owns sessions keyed by wmux pane id: create/attach, input, pywinpty-backed ConPTY resize, output long-poll, list, health, and delete. It must bind only loopback, Tailscale, or RFC1918/internal hosts.
- Windows PowerShell bootstraps disable PSReadLine predictions to avoid inline history suggestions painting ghost text into browser terminal output.
- Terminal-native image rendering is intentionally implemented around the terminal viewport as Kitty placeholder overlays. Keep product styling out of the terminal canvas/content area.
- `wmux-hooks install claude` mutates `~/.claude/settings.json` outside the repo. Merge hooks idempotently and preserve user settings.
- `wmux-hooks install codex` mutates `~/.codex/hooks.json` outside the repo. Codex command hooks require the user to review/trust them with `/hooks` before they run.
- `wmux-stream-agent` publishes the local display with ffmpeg to the machine's `WMUX_STREAM_RTSP_URL`. It should normally run as a service with `onDemand: true`, polling wmux and starting actual capture only while a stream dialog is open. It must run in the graphical login session of the machine being captured. On macOS, the owning app needs System Settings -> Privacy & Security -> Screen Recording permission. On Windows, the validated path is `wmux-windows-setup install-stream`, which creates a per-user Scheduled Task that runs under the logged-in user session.
- Remote hooks/helpers are not auto-installed retroactively into already-running shell sessions. Start a new wmux pane or ensure the staged helper directory is on `PATH` on the remote host.

## Current Gaps To Preserve In Docs

- Remote per-platform wmux agents are partial. Windows has an experimental ConPTY session agent; Linux/macOS agents are not implemented.
- Windows SSH PowerShell is validated on 9800x3d. The experimental Windows session agent now uses pywinpty-backed ConPTY by default, but broad full-screen app validation, graceful process-tree shutdown, and Windows-agent-restart durability are still pending.
- Machine management is file-based; there is no in-app editor.
- There is no login/token gate beyond private-network assumptions and request validation.
- Full cmux-style transcript auto-naming is heuristic. Claude and Codex hook paths exist; OpenCode installation is not implemented.
- Kitty graphics support is partial. File/shared-memory transfer, animation frames, z-index layering, scrollback-persistent placement, Sixel, and iTerm2 image protocols are not complete.
- Command run tracking is explicit through `wmux-run`; arbitrary shell command detection is not implemented.
- Cwd preservation is best-effort outside tmux and wmux-managed shell bootstraps.
- OpenTUI migration is partial and vendored.
- Pixel streaming has the legacy MediaMTX helper path and an early Moonlight gateway path. Wayland, locked/logged-out Windows capture behavior, macOS permission automation, Sunshine app-launch automation, reconnect supervision, and a full wmux native agent remain gaps.
- Document newly discovered or intentionally deferred limitations in the relevant `README.md` section (or a `docs/` runbook) so they stay near the feature they qualify.

## Code Style

- Keep server-only code under `src/server` and browser code under `src/client/src`.
- Prefer structured JSON APIs over ad hoc message strings.
- Use `apply_patch` for manual edits.
- Keep durable project documentation in `README.md`, `AGENTS.md`, and `docs/`; avoid committing one-off planning or handoff markdown unless it remains actively maintained.
- Do not commit generated runtime output such as `dist/`, `node_modules/`, or `test-results/`.
- Avoid broad refactors when making focused fixes; follow existing state/API patterns.
- Keep comments sparse and useful, especially around protocol parsing, terminal lifecycle, and remote helper staging.
