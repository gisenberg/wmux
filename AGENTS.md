# AGENTS.md

## Project

wmux is a browser terminal multiplexer for one user's Tailscale or internal network. It combines:

- localterm-style PTY-over-WebSocket service ownership,
- cmux-style workspaces, tabs, split panes, activity, generated titles, and agent notifications,
- `ghostty-web` terminal rendering in the browser,
- durable `tmux`/`screen` backing for local and SSH panes,
- browser-aware media, clipboard, and mobile ergonomics.

This is intentionally not a multi-tenant SaaS app. Bearer authentication is defense-in-depth on top of the required private-network boundary and bind/Host/Origin checks; it does not make a public-Internet deployment supported.

## Git Workflow

- Use a focused topic branch and pull request for changes by default. Push the branch, open a PR with a concise summary and verification notes, and keep unrelated work out of it.
- Run checks proportionate to the change before opening the PR; use `npm run check` for changes that affect runtime behavior or cross project boundaries.
- Keep incomplete work in a draft PR. Before merging, incorporate current base-branch changes and confirm required checks are green.
- Do not push directly to `main` unless the user explicitly requests a direct push or authorizes an urgent operational hotfix. Follow the hotfix with the same verification and durable documentation expected of a normal PR.
- Do not merge a PR merely because it is green. Merge only when the user requests it or the task explicitly includes merging.

## Commands

- `npm install` installs dependencies.
- `npm run dev -- --host 127.0.0.1 --port 3478` starts the app in development mode with Vite middleware.
- `npm run typecheck` runs client and server TypeScript checks.
- `npm run build` builds the client and server.
- `npm run check` runs tests, TypeScript checks, script validation, and the production build.
- `npm run test:e2e` runs the isolated desktop and mobile Playwright suite.
- `npm run docs:screenshots` regenerates the tracked desktop and mobile README screenshots from the isolated Playwright fixture.
- `npm run start -- --host 127.0.0.1 --port 3478` runs the built service.
- `npm run audit:sessions` audits local wmux-managed durable `tmux`/`screen` sessions.
- `npm run audit:sessions -- --json` emits the same audit as JSON.
- `scripts/install-user-service.sh` installs or updates the systemd user service. It picks a Tailscale IPv4 address when available; override with `WMUX_HOST` and `WMUX_PORT`.
- `scripts/install-tailscale-cert-service.sh` obtains a Tailscale certificate and installs a daily user timer that renews it near expiry without restarting wmux on no-op checks.

Operational incident work should default to the durable repair: restore service, identify why supervision or recovery failed, and remove that recurrence path. Do not stop at a manual restart unless the user explicitly asks for diagnosis or temporary recovery only.

Restarting `wmux.service` is normally safe for durable panes: browsers disconnect briefly and reconnect, while local/SSH `tmux` or `screen` sessions and Windows agent-owned sessions survive and reattach. Check the live pane/backend mix before restarting when practical. Raw PTY panes, custom-command panes, legacy PowerShell sessions, and `auto` sessions that fell back because neither `tmux` nor `screen` was available are not restart-durable and will be terminated. Do not characterize a routine restart as pane-disruptive unless one of those non-durable cases is present.

- `scripts/install-heartbeat-service.sh` installs the dynamic-host heartbeat systemd user timer after its URL, token, and machine descriptor are provisioned.

Useful service commands:

- `systemctl --user status wmux.service`
- `systemctl --user restart wmux.service`
- `journalctl --user -u wmux.service -f`

## Network Safety

The service must only bind to loopback, Tailscale `100.64.0.0/10`, RFC1918, IPv6 ULA, or an unusual internal IP/CIDR explicitly listed in `WMUX_ALLOWED_BIND_RANGES`. Keep that override IP-only and narrowly scoped; it must not become a hostname, wildcard, or public-network escape hatch. Do not weaken the bind checks in `src/server/bind.ts` without adding a replacement control that still prevents public internet exposure. The current dogfood service is expected to bind to the host's Tailscale IP, not `0.0.0.0`.

For MagicDNS names or reverse-proxy hostnames, set `WMUX_ALLOWED_HOSTS` to a comma-separated allowlist. `*.ts.net` is allowed for Tailscale host headers.

`WMUX_TRUSTED_PROXIES` accepts exact IP literals only. Never trust forwarded address headers from an unlisted peer or accept hostnames/CIDRs without an equivalent validated proxy-chain control.

Keep websocket, media, clipboard, hook, and run endpoints behind the same network boundary. Do not add CORS broadening or public callback endpoints without also adding an auth story.

## Public Repository Hygiene

- `wmux.config.json` is runtime-local and ignored. Keep reusable examples in `wmux.config.example.json`; never commit live inventories, usernames tied to a private deployment, tokens, credentials, private-key paths, or personal service URLs.
- wmux-owned code and artwork are MIT-licensed. Third-party dependencies and assets retain their own terms; keep `THIRD_PARTY_NOTICES.md` and the provenance files beside assets accurate.
- Do not add code or assets without clear redistribution terms. A dependency being public on GitHub is not a license.
- Damien Guard's ZX Origins font files are included and used by wmux with his permission; preserve their credit and third-party notices.
- The retained Amiga Workbench screenshot has no identified source-redistribution license and remains outside MIT; preserve its provenance and explicit notice.
- Keep the architecture diagram in `README.md` synchronized when changing process boundaries, persistence ownership, session backends, or streaming paths.
- Keep README screenshots reproducible through `npm run docs:screenshots`; do not capture private machine names, hosts, usernames, tokens, or terminal history.

## Architecture Notes

- Server state lives in `~/.wmux/state.json` unless `WMUX_STATE_PATH` is set.
- Server-backed UI settings live in `~/.wmux/settings.json` unless `WMUX_SETTINGS_PATH` is set.
- State and settings use explicit schema versions, atomic owner-only writes, validated rolling backups, and downgrade refusal. Add a migration before changing a persisted shape.
- Browser/server wire contracts live in `src/shared/protocol.ts`, including pane and event WebSocket unions. Keep credentials and other server-only configuration in `src/server/types.ts`; do not reintroduce parallel client/server wire shapes.
- `src/server/machines.ts` is a compatibility facade. Keep spawn construction in `spawn-backends.ts`, health/version probes in `machine-health.ts`, and async tmux/screen lifecycle operations in `durable-session.ts`; do not add blocking child-process calls to request or pane-attach paths.
- Machine definitions are read from ignored `./wmux.config.json` first, then `~/.wmux/config.json`; `WMUX_CONFIG_PATH` selects one explicit file and disables fallback. `wmux.config.example.json` is the tracked template.
- Dynamic SSH and PowerShell-over-SSH machines register through `POST /api/registry/hosts` and persist in `~/.wmux/host-registry.json`. The shared registration token is trusted catalog-write authority for every dynamic ID, not per-host identity; it must not authorize registry reads, deletion, helper bundles, or any other endpoint.
- The host registry has its own schema version, owner-only atomic writes, legacy migration, and downgrade refusal. Bump/migrate its envelope before changing persisted record shapes; never rewrite a future version.
- Dynamic registrations always dial the validated private/internal heartbeat source address. Keep their schema narrower than static `MachineConfig`: no commands, local/service kinds, agent URLs, stream gateway configuration, or static-only PowerShell profile preference. The Windows agent backend requires explicit `agentPort` and `agentToken`; the base Windows agent injects its live values into each in-process registration heartbeat, while adjacent-port rollout generations must keep heartbeat disabled. The token must stay server-only and redacted from registry/status/helper/browser payloads.
- Registered panes never receive the broad wmux API token and must not overwrite a pre-existing remote `~/.wmux/token`. Dynamic Windows SSH bootstrap uses a rotating per-machine capability for an inline redacted bundle. API-posting helpers on registered panes require separately provisioned auth and otherwise fail with `401`.
- Browser authentication defaults to compatibility-preserving `shared-or-login`.
  Opt-in `login-only` requires password-issued browser sessions plus distinct header-only automation and helper credentials, enforced through the exact REST method/path and WebSocket policy.
  The MVP still stores browser sessions in local storage and uses their query transport for browser WebSockets.
- Expired registered hosts remain visible offline and are retained past the normal seven-day window while a pane references them. A referenced ID pins kind/user/port/shell/backend/agent port/token while permitting address-only roaming; a live agent pane pins its address too. Do not dial an offline registration for new attach/refresh. Live pane sessions retain their original machine snapshot so address churn cannot redirect later cleanup.
- Keep remote-machine behavior explicit in `MachineConfig`; do not hide durable/session behavior in UI-only state.
- The `local` and SSH machines default to durable `tmux`/`screen` sessions via `sessionBackend: "auto"`.
- Use `kind: "powershell-ssh"` for Windows hosts reached from non-Windows wmux servers. It uses local `ssh -tt` to launch remote `pwsh`; static machines can opt into the standard PowerShell profile chain with `loadPowerShellProfile: true`, while probes and maintenance commands remain profile-free. Follow [docs/WINDOWS_NODE_REGISTRATION.md](docs/WINDOWS_NODE_REGISTRATION.md) for setup and validation. Legacy `kind: "powershell"` means WSMan `Enter-PSSession -ComputerName`; do not mark it online from a non-Windows wmux host by TCP probe alone.
- `powershell-ssh` host status runs a short encoded PowerShell health probe over SSH, cached for about 15 seconds. It reports helper readiness, wmux reachability through `/api/health`, FFmpeg/Python availability, and the `wmux-stream-agent` Scheduled Task state. Agent-backed hosts report the platform-suffixed wmux release separately from their protocol version.
- `sessionBackend: "agent"` on a `powershell-ssh` machine opts into the experimental Windows session agent at `agentUrl` or `http://host:agentPort`. This is restart-durable across wmux server restarts because the Windows agent owns the pane process and replay buffer; wmux shutdown must detach, while explicit pane closure deletes the agent session. New panes automatically stage an outdated agent. An idle base agent restarts safely in place before the pane attaches; a base agent with existing panes starts a side-by-side Scheduled Task generation on an unused adjacent port instead. Existing panes stay on their owning generation; persist each pane's selected `agentPort` so wmux restarts route it correctly. Update-pending state must accept panes until it transitions atomically to a hard drain at idle. Never replace either path with a forced restart that kills existing panes. Managed agent configs default to `backend: "auto"`, which prefers ConPTY and falls back to stdio when pywinpty is unavailable; explicit `"conpty"` and `"stdio"` values remain available for enforcement and debugging.
- Windows agent firewall setup must reserve the configured base port plus eight adjacent generation ports and restrict them to exact internal wmux server addresses. Keep `wmux-windows-setup configure-agent-firewall` and its status report aligned with the server's bounded generation scan.
- Same-machine workspace/tab/split creation should preserve the source pane cwd. The primary source is tmux `#{pane_current_path}`; OSC 7 cwd reports from wmux-managed zsh/bash prompt hooks are the fallback state update path.
- A pane maps to one long-lived server PTY client while the wmux service process is alive. Closing or refreshing the browser disconnects the WebSocket but does not kill the pane process.
- Restarting the wmux service restores layout metadata and reattaches local/SSH durable sessions when the target has `tmux` or `screen`; Windows agent-owned panes also survive and reattach. Raw PTY and legacy PowerShell panes still cannot preserve live process state across service restart.
- Multiple browsers may attach to the same pane.
  Only one socket at a time owns PTY resize for that pane, and every viewer renders the owner's authoritative grid dimensions.
  An inactive owner retains the canonical grid until another foreground viewer activates, while input from any passive viewer promotes it to resize owner and applies its latest dimensions.
- Browser image paste uses a separate bounded binary endpoint and stages an expiring owner-only file in the live pane's pinned target namespace before pasting only its quoted path. It never reuses persistent mobile attachments or workspace persistence. POSIX and PowerShell SSH panes use a private per-pane SSH control socket; current Windows-agent panes use the agent's binary staging capability. Legacy WSMan, service, custom-command, stale, and exited panes fail closed.
- Raw browser reconnect replay is bounded in memory. Each live PTY also maintains a server-side `ghostty-web` VT checkpoint; alternate-screen panes and panes whose raw replay was truncated attach from that authoritative screen instead of replaying an arbitrary ANSI tail. Untruncated normal-shell replay still preserves scrollback. Checkpoints are not persisted across a wmux service restart; durable sessions redraw from `tmux`/`screen`, and wmux does not persist a full terminal transcript. The current Windows agent additionally records terminal resize boundaries in its bounded replay so wmux can rebuild a top-anchored ConPTY checkpoint before attaching a browser; preserve those byte-exact boundaries when changing the agent protocol.
- SSH panes stage `wmux-media`, `wmux-copy`, its `wmux-clip`/`wclip`/`wmclip` aliases, `wmux-notify`, `wmux-title`, `wmux-agent-event`, `wmux-hooks`, and `wmux-run` into `~/.cache/wmux/bin` on the remote host and try to place shims in common user bin directories such as `~/.local/bin`, `~/.cargo/bin`, and `~/bin`.
- Windows `powershell-ssh` panes fetch helper scripts from `/api/helpers/windows/:machineId`, stage them into `%LOCALAPPDATA%\wmux\bin`, prepend that directory to `PATH`, and install a temporary PowerShell prompt function for OSC 7 cwd reporting. When profile loading is enabled, the wrapper must delegate to the profile-defined prompt after emitting cwd metadata.
- New panes receive `WMUX_COLOR_SCHEME` and `WMUX_COLOR_MODE`; browser terminals answer bounded OSC 4/10/11 queries from the live selected palette. Windows PowerShell bootstraps seed the isolated ConPTY console color table from the shared terminal palette, and server-side VT checkpoints must use the same foreground, background, and ANSI palette so size-aware replay does not flatten semantic defaults to black/white. Keep replay display-only and never let a partial replay query consume live output or send a stale response.
- POSIX SSH helper staging must run under POSIX `sh`; do not rely on zsh/bash-specific word splitting in `src/server/machines.ts`.
- Keep POSIX SSH spawn arguments bounded. Helper, profile, shell-integration, and credential payloads must be staged through a permission-restricted runtime file rather than embedded in the `ssh` command line.
- Session audit cleanup must remain limited to local `wmux_` tmux/screen sessions that the audit marks duplicate or orphan. Never add automatic cleanup of active sessions or non-wmux multiplexer sessions.
- Machine screen streams are machine-local or gateway-local captures, not browser captures. The MediaMTX helper path has the active host publish its own pixels to the MediaMTX service on the wmux server, and wmux viewers embed the active machine's WebRTC path. The Moonlight gateway path proxies a browser-native Moonlight/Sunshine bridge. Do not replace either path with `getDisplayMedia` from the viewing browser.
- MediaMTX helper capture should remain on-demand. The browser requests/releases a short stream lease through the existing `/ws/events` socket, while `wmux-stream-agent` polls the wmux lease endpoint and only runs `screencapture`/ffmpeg while a lease is active.
- MediaMTX should bind RTSP/WebRTC only to the Tailscale/internal interface and keep its API on loopback. Use `scripts/install-stream-service.sh` for repeatable setup.
- `wmux-moonlight-gateway` should bind only to loopback, Tailscale, or RFC1918/internal addresses. It is a clean process boundary around browser-native Moonlight bridges such as Moonlight Web Stream; do not vendor or copy GPL implementation code into wmux without an explicit license decision. Its setup API may automate the supported pairing flow by generating the Moonlight Web PIN and submitting it to Sunshine's `/api/pin`, but it should not edit Sunshine's paired-client state directly. The Sunshine PIN device name must match the upstream Moonlight bridge's pair device name; Moonlight Web Stream v2.10.0 currently hardcodes this as `roth`. Browser autologin should use gateway environment credentials to mint a Moonlight Web session cookie; do not commit raw Moonlight Web credentials into `wmux.config.json`.

## UI And Interaction Notes

- The terminal canvas/content area should remain visually untreated. Product styling belongs in surrounding chrome, overlays, sidebars, shelves, and toolbars.
- The default chrome uses the wmux-owned Canvas 2D cell-grid renderer in `src/client/src/opentui-grid.ts`. `?legacy=1` keeps the older DOM-heavy React chrome available.
- Treat the console/TUI aesthetic as wmux's project-wide design language wherever the interaction permits it. Prefer monospaced cell rhythm, flat rectangular regions, one-pixel rules, compact uppercase labels, tabular values, explicit status tokens such as `[OK]`/`[WARN]`, and bracketed text actions such as `[R] REFRESH`. Avoid generic dashboard cards, pill-shaped controls, soft rounded surfaces, ornamental gradients, and icon-only actions unless the platform interaction or content materially benefits from them.
- DOM surfaces that remain necessary for accessibility, editable controls, semantic links, or browser APIs should still visually align with the cell-grid chrome. Keep their hierarchy text-first and console-like, preserve visible keyboard/focus behavior, and use the shared terminal/chrome palette and `--wmux-mono-font` rather than introducing a separate application style.
- Do not reintroduce the former unlicensed `opentui-browser` vendor snapshot. Keep the local renderer limited to the cell-grid surface wmux actually uses.
- The empty-workspace view is a sibling WebGL shader, not a ghostty-web shader. It renders a Game-of-Life/metal light-panel cube field with mobile-adjusted projection and click-to-toggle cells.
- Settings remains a DOM modal because it contains editable controls and destructive session-audit actions.
- Machine aliases are user-facing labels only. Underlying machine IDs and hosts must remain stable for links, state, and helper environment.
- Host status should show useful network identity. Respect the current alias/IP display convention when adjusting host labels.
- Workspace rows should show title, trimmed descriptor, and host context without overlapping. Use tooltips for longer descriptors.
- Host labels use `MachineStatus.releaseVersion` (`v<wmux-version>-linux`, `-mac`, or `-win`). Keep that release/platform identity separate from the structured actual/expected runtime and helper fields used for update detection. Workspace indicators aggregate every pane host in a mixed-host workspace and remain exception-only for confirmed outdated states; current/unknown details belong in tooltips. Do not infer freshness by parsing `backendDetail` text.
- Workspace rows and tab pills are real links. Preserve `/workspaces/:workspaceId/tabs/:tabId` direct-link behavior.
- The command palette is opened by `Cmd/Ctrl+K` and should remain the preferred entry point for actions that do not need permanent top-level controls.
- The host filter in the workspace rail narrows navigation. The target host for creating new workspaces/tabs is controlled by explicit host selection. Splits default to the host of the pane being split.
- Mobile layout uses the VisualViewport API plus `--wmux-viewport-height`. When the software keyboard is open, hide chrome by collapsing dimensions while keeping terminal components mounted.
- Browser wake and network transitions can briefly fail `/api/bootstrap` after the event socket reconnects. Keep an already-loaded workspace mounted, retry bootstrap/resync with bounded backoff, and reserve the login surface for explicit authentication failures; do not promote a transient fetch failure to a permanent fatal overlay.
- The mobile sidebar is a drawer and should default collapsed on narrow viewports.
- On mobile, split panes collapse to the active pane instead of trying to show every split at once.
- On mobile, touch swipes over the terminal scroll Ghostty scrollback and become wheel input while an application has terminal mouse tracking enabled; a tap still focuses the terminal and opens the keyboard.
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
- When a suspended pane resumes, keep its terminal-colored shield visible until reconnect replay has been applied; do not expose the intermediate terminal redraw or let stale pixels flash first.

## Helpers And Integrations

- Agent events are handled by `POST /api/agent-events`; this updates auto-owned workspace titles/descriptors and creates terminal notifications for completed/failed/stopped states.
- `wmux-title` updates generated or manual workspace/tab titles. Generated titles must not overwrite user-owned titles.
- `wmux-notify` creates browser/terminal notifications through the wmux API.
- Run metadata is handled by `POST /api/run-events`; `scripts/wmux-run` wraps a command and records start/completion state without changing terminal canvas output.
- Browser clipboard handoff is handled by `POST /api/clipboard`; `scripts/wmux-copy` reads stdin or a file and lets the browser attempt the OS clipboard write with a top-bar fallback button. `wmux-clip`, `wclip`, and `wmclip` are aliases.
- Browser media handoff is handled by `wmux-media`. Images prefer `kitten icat --transfer-mode=stream --passthrough=tmux --align=left --engine=builtin --stdin=no`; audio/video render in browser media controls; `--mode http` forces the media shelf and `--mode kitty` fails instead of falling back.
- `wmux-sunshine-setup` is the macOS SSH-host Sunshine setup helper. It installs the official macOS DMG by default, can use the official LizardByte Homebrew tap with `WMUX_SUNSHINE_INSTALL_METHOD=brew`, configures `sunshine --creds`, and runs Sunshine through a per-user GUI LaunchAgent. It cannot bypass macOS Screen Recording, Accessibility/Input Monitoring, or Local Network approval prompts.
- Windows helper scripts live under `scripts/windows` and are served as a Base64 helper bundle instead of being embedded in the SSH command line. Keep the launch command small; Windows OpenSSH rejects large encoded commands.
- `wmux-heartbeat` refreshes a dynamic host registration. POSIX hosts can use the shipped systemd user timer. On Windows, the base `wmux-windows-agent` process owns the periodic heartbeat whenever `url`, `registration-token`, and `heartbeat.json` are provisioned; `wmux-heartbeat` remains a one-shot diagnostic and `install-agent` removes the legacy standalone heartbeat task. Registration token distribution remains an explicit manual step.
- `wmux-windows-setup` is the Windows self-check/setup entry point. It validates helper state, can persist the helper directory to the user PATH, can install FFmpeg/Python with `winget`, installs `pywinpty` for ConPTY, and can install/status the per-user stream and session-agent Scheduled Tasks. It must work both inside a bootstrapped wmux pane and from plain SSH where `%LOCALAPPDATA%\wmux\bin` is not yet on `PATH`.
- `wmux-windows-agent` is served as `wmux-windows-agent.py` plus a CMD shim. Its HTTP API owns sessions keyed by wmux pane id: create/attach, input, pywinpty-backed ConPTY resize, output long-poll, list, health, and delete. It must bind only loopback, Tailscale, or RFC1918/internal hosts. Its Scheduled Task uses both logon and once-per-minute triggers with `MultipleInstances: IgnoreNew`; this is intentional supervision for unexpected termination. Explicit `stop` must disable the base and generation tasks so they remain stopped.
- Windows PowerShell bootstraps disable PSReadLine predictions to avoid inline history suggestions painting ghost text into browser terminal output.
- Terminal-native image rendering is intentionally implemented around the terminal viewport as Kitty placeholder overlays. Keep product styling out of the terminal canvas/content area.
- `wmux-hooks install claude` mutates `~/.claude/settings.json` outside the repo. Merge hooks idempotently and preserve user settings.
- The Claude hook installer also owns `~/.claude/skills/wmux/SKILL.md` only when it contains the wmux generated marker. Preserve any unmanaged skill at that path.
- `wmux-hooks install codex` mutates `~/.codex/hooks.json` outside the repo. Codex command hooks require the user to review/trust them with `/hooks` before they run.
- `wmux-hooks install opencode` writes an auto-loaded global plugin under `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins` without mutating OpenCode JSON configuration. POSIX is supported; Windows installer parity is not included.
- `wmuxctl delegate` uses the POSIX staged `wmux-agent-run` helper for visible one-shot OpenCode, Codex, or Claude work. `wmuxctl tui` uses its prompt-free supervisor mode: the helper resolves the executable before `chdir`, blocks on the unique launch ACK before starting the child, and quarantines input after an exact exit marker until Ctrl-C or the exact release line. The controller requires fresh child output plus a bounded safety-gate observation interval, sends any prompt as one bracketed paste followed by separate Enter, and never closes the workspace. Keep write access separate from unattended approval, keep prompts out of shell arguments and launch JSON, fail closed on unrecognized first-run/login gates, and leave failed/stopped/timed-out workspaces open for inspection.
- `wmux-stream-agent` publishes the local display with ffmpeg to the machine's `WMUX_STREAM_RTSP_URL`. It should normally run as a service with `onDemand: true`, polling wmux and starting actual capture only while a stream dialog is open. It must run in the graphical login session of the machine being captured. On macOS, the owning app needs System Settings -> Privacy & Security -> Screen Recording permission. On Windows, the validated path is `wmux-windows-setup install-stream`, which creates a per-user Scheduled Task that runs under the logged-in user session.
- Remote hooks/helpers are not auto-installed retroactively into already-running shell sessions. Start a new wmux pane or ensure the staged helper directory is on `PATH` on the remote host.
- `wmux-agent-profile` fetches the authenticated profile exposed by the server and applies it before a newly created pane enters its shell. Profiles are additive and ownership-tracked: never turn conflicts into automatic overwrites, never distribute secrets/trust/history, and keep personal profiles outside this public repository. Tool prerequisites must remain explicit, version/checksum-pinned, and blocked rather than silently installed during workspace creation. Use `add-skill` so skill provenance is recorded. The sanitized example is under `examples/wmux-agent-profile`.
- The Codex skill lives under `skills/wmux` and should stay aligned with wmux API routes, helper behavior, and config shape. Keep public examples generic and discover live machine IDs from `/api/bootstrap`. Install it through a symlink to this repo copy rather than maintaining a separate personal copy.

## Current Gaps To Preserve In Docs

- Dynamically registered panes stage helper commands but intentionally receive no broad shared or helper token; API-posting helpers need a separately provisioned `WMUX_HELPER_TOKEN` and otherwise fail with `401`.
- Dynamic live-pane endpoint snapshots are in-memory only; a wmux restart followed by dynamic ID reassignment can leave the old remote durable session requiring manual cleanup.
- Remote per-platform wmux agents are partial. Windows has an experimental ConPTY session agent; Linux/macOS agents are not implemented.
- Windows SSH PowerShell is validated on dogfood Windows hosts. The experimental Windows session agent prefers pywinpty-backed ConPTY, falls back to terminal-normalized stdio when pywinpty is unavailable, contains each pane in a kill-on-close Windows Job Object, supports staged-update draining, and records size-aware replay. Legacy agents require a best-effort 80x24 replay fallback after a wmux restart. Broad full-screen app validation and process preservation across unexpected/forced Windows-agent restarts are still pending.
- Static machine management is file-based and the dynamic registry has no in-app editor.
- Optional login-only authentication separates browser, automation, helper, registration, and registered-host credentials, but browser sessions remain in local storage/WebSocket query parameters and the scoped automation/helper credentials are still long-lived within their exact route authorities.
  Cookie-backed sessions, revocation, and finer per-client capabilities are not implemented.
- Dynamic host presence follows the host user's service lifecycle: the POSIX systemd user timer needs lingering to run while logged out, while Windows presence follows the supervised agent task and its selected `Interactive` or `S4U` logon mode.
- Full cmux-style transcript auto-naming is heuristic. Claude, Codex, and POSIX OpenCode hook paths exist; Windows OpenCode installer parity is not implemented.
- Kitty graphics support is partial. File/shared-memory transfer, animation frames, z-index layering, scrollback-persistent placement, Sixel, and iTerm2 image protocols are not complete.
- Command run tracking is explicit through `wmux-run`; arbitrary shell command detection is not implemented.
- Cwd preservation is best-effort outside tmux and wmux-managed shell bootstraps.
- The canvas-grid and legacy DOM chrome paths coexist; avoid behavior drift between them while the fallback remains supported.
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
