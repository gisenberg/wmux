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

- Optimize for fast local iteration in the current checkout, and do not create a worktree, topic branch, push, or pull request unless the user asks for one, isolation is materially useful, or the change is ready to integrate into `main`.
- Keep related work on the current task branch and preserve unrelated changes already present in the checkout.
- The local dogfood service may run from an unmerged branch during iteration, but report when a deployment is unmerged or depends on a dirty working tree.
- Commit and push completed work before calling a deployment durable or handing it off for remote verification.
- Run checks proportionate to the change before deployment or integration, and use `npm run check` for changes that affect runtime behavior or cross-project boundaries.
- When integrating into `main`, prefer one focused pull request unless the user explicitly requests a direct push or authorizes an urgent operational hotfix.
- Create a draft pull request only when sharing incomplete work is useful, and do not create one merely to park local iteration.
- Before merging, incorporate current base-branch changes, review the final diff, and confirm required checks are green.
- A request to fix, ship, deploy, land, integrate, or merge a change authorizes the normal pull-request and merge workflow once the work is complete and verified, without a separate merge-confirmation round trip.
- A request limited to review, diagnosis, explanation, or status does not authorize merging or other external mutations.
- Follow a direct-to-`main` hotfix with the same verification and durable documentation expected of a normal pull request.

## Commands

- `npm install` installs dependencies.
- `npm run dev -- --host 127.0.0.1 --port 3478` starts the app in development mode with Vite middleware.
- `npm run typecheck` runs client and server TypeScript checks.
- `npm run build` builds the client and server.
- `npm run check` runs tests, TypeScript checks, script validation, and the production build.
- `npm run test:e2e` runs the isolated desktop and mobile Playwright suite.
- `npm run test:e2e:server` runs specs that require the Playwright driver and fixture service to share a checkout and filesystem.
- `npm run test:e2e:browser` runs the complementary browser-only group, which can use a fixture service on another trusted private-network host.
- `npm run test:e2e:browser:chromium` runs the browser-only Chromium projects for cross-host execution on win-ci.
- `npm run test:e2e:browser:webkit` runs the browser-only WebKit project on homelab, where its networking is reliable.
- `npm run test:e2e:serve` starts an authenticated isolated standard-suite service on the explicit private IP in `WMUX_E2E_SERVER_HOST`; server and browser-only runner must share a strong per-run `WMUX_E2E_TOKEN`, and the runner also sets `WMUX_E2E_BASE_URL`.
- Run concurrent E2E groups against separate fixture-service instances so their state mutations remain isolated.
- `npm run docs:screenshots` regenerates the tracked desktop and mobile README screenshots from the isolated Playwright fixture.
- `npm run start -- --host 127.0.0.1 --port 3478` runs the built service.
- `npm run audit:sessions` audits local wmux-managed durable `tmux`/`screen` sessions.
- `npm run audit:sessions -- --json` emits the same audit as JSON.
- `scripts/install-user-service.sh` installs or updates the systemd user service. It picks a Tailscale IPv4 address when available; override with `WMUX_HOST` and `WMUX_PORT`.
- `scripts/install-tailscale-cert-service.sh` obtains a Tailscale certificate and installs a daily user timer that renews it near expiry without restarting wmux on no-op checks.

Operational incident work should default to the durable repair: restore service, identify why supervision or recovery failed, and remove that recurrence path. Do not stop at a manual restart unless the user explicitly asks for diagnosis or temporary recovery only.

Restarting `wmux.service` is normally safe for durable panes: browsers disconnect briefly and reconnect, while local/SSH `tmux` or `screen` sessions and Windows agent-owned sessions survive and reattach. Check the live pane/backend mix before restarting when practical. Raw PTY panes, custom-command panes, legacy PowerShell sessions, and `auto` sessions that fell back because neither `tmux` nor `screen` was available are not restart-durable and will be terminated. Do not characterize a routine restart as pane-disruptive unless one of those non-durable cases is present.

- `scripts/install-heartbeat-service.sh` installs the dynamic-host heartbeat systemd user timer after its URL, token, and machine descriptor are provisioned.
- `scripts/install-session-agent-service.sh` installs the native POSIX session agent under systemd user services on Linux or launchd on macOS and retires the standalone heartbeat timer.

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
- Registered-pane, configured remote durable-multiplexer, and configured session-agent disposal endpoints live in the server-only `~/.wmux/session-endpoints.json` ledger unless `WMUX_SESSION_ENDPOINT_PATH` is set.
  The schema-versioned, owner-only atomic store retains old endpoint snapshots across dynamic ID reassignment so session audit and explicit cleanup cannot be redirected to the replacement host.
  Never expose stored agent tokens or other disposal credentials through bootstrap, audit, helper, or browser payloads.
- Durable agent turn history lives in `~/.wmux/agent-timelines.json` unless `WMUX_AGENT_TIMELINE_PATH` is set.
  It uses a separate schema-versioned, owner-only atomic store with a validated rolling backup.
  Repository snapshots linked from a timeline are immutable owner-only archives under the adjacent `repository-snapshots/` directory.
- Server-backed UI settings live in `~/.wmux/settings.json` unless `WMUX_SETTINGS_PATH` is set.
- State and settings use explicit schema versions, atomic owner-only writes, validated rolling backups, and downgrade refusal. Add a migration before changing a persisted shape.
- Browser/server wire contracts live in `src/shared/protocol.ts`, including pane and event WebSocket unions. Keep credentials and other server-only configuration in `src/server/types.ts`; do not reintroduce parallel client/server wire shapes.
- HTTP endpoints are declarative `HttpRoute` entries under `src/server/routes/`, and each route owns its stable id, exact method/path matcher, body policy, authorization policy, and handler.
  Keep request dispatch in `request-dispatch.ts`, static delivery in `static-files.ts`, event publication in `event-broadcast.ts`, and WebSocket upgrades in `ws-upgrade.ts`.
  Every dispatched route must remain covered by the real-server route-policy guard.
- `AgentSessionService` in `src/server/agent-sessions.ts` owns delegation transitions, exact-once terminal outcomes, notification/title side effects, persistence backfill, and retention.
  `AgentTimelineStore` owns session turns, prompts, lifecycle entries, and archived review links; mobile Chat must render this durable history without requiring a terminal attachment.
  Delegations retain the pane-local machine ID so the fleet remains intelligible after workspace removal.
  Approval, login, blocked, and input-required transitions are explicit attention reasons; keep their notifications exact-once and sort them above ordinary running work.
  `stateChangedAt` is the authoritative state-age clock.
  Budget notifications must persist their exact-once marker, include the transition timeline entry, and run within the 15-second agent-notification heartbeat.
  Runtime-specific argv, structured output, and TUI marker behavior belong in the Codex, Claude, and OpenCode adapters under `src/server/agent-runtimes/`.
  Keep `delegation.preferHeadless` defaulting to `false`; interactive requests always use TUI adapters.
- `SessionBackend` is the pane execution contract.
  Keep raw PTY, durable tmux/screen, and Windows agent behavior behind the adapters in `src/server/backends/`, and extend the shared conformance suite when changing backend semantics.
- TypeScript is the source of truth for the cross-language agent contracts.
  `scripts/wmux_agent_contract.py` and `scripts/windows/wmux_windows_agent_protocol.py` are generated by `scripts/generate-agent-contract.mjs`; update the TypeScript contract and run `npm run generate:contracts` instead of editing either generated Python file.
- `src/server/machines.ts` is a compatibility facade. Keep spawn construction in `spawn-backends.ts`, health/version probes in `machine-health.ts`, and async tmux/screen lifecycle operations in `durable-session.ts`; do not add blocking child-process calls to request or pane-attach paths.
- Machine definitions are read from ignored `./wmux.config.json` first, then `~/.wmux/config.json`; `WMUX_CONFIG_PATH` selects one explicit file and disables fallback. `wmux.config.example.json` is the tracked template.
- Dynamic SSH and PowerShell-over-SSH machines register through `POST /api/registry/hosts` and persist in `~/.wmux/host-registry.json`. The shared registration token is trusted catalog-write authority for every dynamic ID, not per-host identity; it must not authorize registry reads, deletion, helper bundles, or any other endpoint.
- The host registry has its own schema version, owner-only atomic writes, legacy migration, and downgrade refusal. Bump/migrate its envelope before changing persisted record shapes; never rewrite a future version.
- Dynamic registrations always dial the validated private/internal heartbeat source address. Keep their schema narrower than static `MachineConfig`: no commands, local/service kinds, agent URLs, stream gateway configuration, or static-only PowerShell profile preference. Native session-agent backends require explicit `agentPort` and `agentToken`; each owning base agent injects its live values into the in-process registration heartbeat, while Windows adjacent-port rollout generations must keep heartbeat disabled. The token must stay server-only and redacted from registry/status/helper/browser payloads.
- Registered panes never receive the broad wmux API token and must not overwrite a pre-existing remote `~/.wmux/token`. Dynamic Windows SSH bootstrap uses a rotating per-machine capability for an inline redacted bundle. API-posting helpers on registered panes require separately provisioned auth and otherwise fail with `401`.
- Browser authentication defaults to compatibility-preserving `shared-or-login`.
  Opt-in `login-only` requires password-issued browser sessions plus distinct header-only automation and helper credentials, enforced through the exact REST method/path and WebSocket policy.
  Login-only browser sessions use opaque HttpOnly SameSite cookies backed by owner-only server records; browser WebSockets authenticate through the cookie and must not receive credentials in query parameters or local storage.
  Browser-session records include bounded client metadata, and revocation must synchronously terminate every WebSocket mapped to the revoked session.
  Automation and helper credentials have persisted issue/expiry metadata and file-backed atomic rotation; authentication must consult the live credential store so old values fail immediately without changing exact-route authority.
- Expired registered hosts remain visible offline and are retained past the normal seven-day window while a pane references them. A referenced ID pins kind/user/port/shell/backend/agent port/token while permitting address-only roaming; a live agent pane pins its address too. Do not dial an offline registration for new attach/refresh. Live pane sessions retain their original machine snapshot so address churn cannot redirect later cleanup.
- Keep remote-machine behavior explicit in `MachineConfig`; do not hide durable/session behavior in UI-only state.
- The `local` and SSH machines default to durable `tmux`/`screen` sessions via `sessionBackend: "auto"`.
- Use `kind: "powershell-ssh"` for Windows hosts reached from non-Windows wmux servers. It uses local `ssh -tt` to launch remote `pwsh`; static machines can opt into the standard PowerShell profile chain with `loadPowerShellProfile: true`, while probes and maintenance commands remain profile-free. Follow [docs/WINDOWS_NODE_REGISTRATION.md](docs/WINDOWS_NODE_REGISTRATION.md) for setup and validation. Legacy `kind: "powershell"` means WSMan `Enter-PSSession -ComputerName`; do not mark it online from a non-Windows wmux host by TCP probe alone.
- `powershell-ssh` host status runs a short encoded PowerShell health probe over SSH, cached for about 15 seconds. It reports helper readiness, wmux reachability through `/api/health`, FFmpeg/Python availability, and native-agent capture supervision state. Agent-backed hosts report the platform-suffixed wmux release separately from their protocol version.
- `sessionBackend: "agent"` on a `powershell-ssh` machine opts into the experimental Windows session agent at `agentUrl` or `http://host:agentPort`. This is restart-durable across wmux server restarts because the Windows agent owns the pane process and replay buffer; wmux shutdown must detach, while explicit pane closure deletes the agent session. New panes automatically stage an outdated agent. An idle base agent restarts safely in place before the pane attaches; a base agent with existing panes starts a side-by-side Scheduled Task generation on an unused adjacent port instead. Existing panes stay on their owning generation; persist each pane's selected `agentPort` so wmux restarts route it correctly. Update-pending state must accept panes until it transitions atomically to a hard drain at idle. Never replace either path with a forced restart that kills existing panes. Managed agent configs default to `backend: "auto"`, which prefers ConPTY and falls back to stdio when pywinpty is unavailable; explicit `"conpty"` and `"stdio"` values remain available for enforcement and debugging.
- `sessionBackend: "agent"` on a local or SSH Linux/macOS machine uses the supervised POSIX session agent. It owns a real PTY, bounded replay, resize history, paste staging, optional dynamic-registration heartbeat, and on-demand capture supervision independently of the wmux server. Explicit pane closure deletes the session, while wmux shutdown only detaches. The agent token and listener must remain restricted to the wmux server across the private network.
- Windows agent firewall setup must reserve the configured base port plus eight adjacent generation ports and restrict them to exact internal wmux server addresses. Keep `wmux-windows-setup configure-agent-firewall` and its status report aligned with the server's bounded generation scan.
- Same-machine workspace/tab/split creation should preserve the source pane cwd. The primary source is tmux `#{pane_current_path}`; OSC 7 cwd reports from wmux-managed zsh/bash prompt hooks are the fallback state update path.
- A pane maps to one long-lived server PTY client while the wmux service process is alive. Closing or refreshing the browser disconnects the WebSocket but does not kill the pane process.
- Restarting the wmux service restores layout metadata and reattaches local/SSH durable sessions when the target has `tmux` or `screen`; POSIX and Windows agent-owned panes also survive and reattach. Raw PTY and legacy PowerShell panes still cannot preserve live process state across service restart.
- Multiple browsers may attach to the same pane. Only one socket at a time owns PTY resize for that pane; passive viewers do not resize it. Input from a passive viewer promotes that viewer to resize owner and applies that viewer's latest dimensions.
- Browser image paste uses a separate bounded binary endpoint and stages an expiring owner-only file in the live pane's pinned target namespace before pasting only its quoted path. It never reuses persistent mobile attachments or workspace persistence. POSIX and PowerShell SSH panes use a private per-pane SSH control socket; current Windows-agent panes use the agent's binary staging capability. Legacy WSMan, service, custom-command, stale, and exited panes fail closed.
- Raw browser reconnect replay is bounded in memory. Each live PTY also maintains a server-side `ghostty-web` VT checkpoint; alternate-screen panes and panes whose raw replay was truncated attach from that authoritative screen instead of replaying an arbitrary ANSI tail. Untruncated normal-shell replay still preserves scrollback. Bounded screen-state checkpoints persist under the pane state directory and restore the attach shield after a wmux restart for backends that declare the capability; raw processes and full scrollback transcripts remain unpersisted, while durable sessions redraw from `tmux`/`screen`. The current Windows agent additionally records terminal resize boundaries in its bounded replay so wmux can rebuild a top-anchored ConPTY checkpoint before attaching a browser; preserve those byte-exact boundaries when changing the agent protocol.
- SSH panes stage `wmux-media`, `wmux-copy`, its `wmux-clip`/`wclip`/`wmclip` aliases, `wmux-notify`, `wmux-title`, `wmux-agent-event`, `wmux-hooks`, `wmux-run`, and the internal `wmux-shell-run-event` reporter into `~/.cache/wmux/bin` and try to place shims in common user bin directories such as `~/.local/bin`, `~/.cargo/bin`, and `~/bin`.
- Windows `powershell-ssh` panes fetch helper scripts from `/api/helpers/windows/:machineId`, stage them into `%LOCALAPPDATA%\wmux\bin`, prepend that directory to `PATH`, and install a temporary PowerShell prompt function for OSC 7 cwd reporting. When profile loading is enabled, the wrapper must delegate to the profile-defined prompt after emitting cwd metadata.
- New panes receive `WMUX_COLOR_SCHEME` and `WMUX_COLOR_MODE`; the wmux server answers bounded OSC 4/10/11 queries from the live selected palette even before a browser attaches.
  Windows PowerShell bootstraps seed the isolated ConPTY console color table from the shared terminal palette, and server-side VT checkpoints must use the same foreground, background, and ANSI palette so size-aware replay does not flatten semantic defaults to black/white.
  Checkpoint snapshots emit SGR 39/49 for default-colored cells so a restored screen still follows a later color-scheme change.
  `TerminalCheckpoint.snapshot()` starts with RIS and is only for freshly cleared terminals and persistence; live repaints of an attached browser use `repaint()` through the browser-only `screen` backend event, which must never reset the terminal, re-enter the alternate screen, or reach textual output watchers.
  Windows agent output is decoded through one `StringDecoder` per session because polls and resize boundaries split UTF-8 at arbitrary byte offsets, and the checkpoint holds back a trailing partial escape sequence across reframes for the same reason.
  Reframes keep the cursor row visible when the viewport shrinks, seed only history into scrollback (never the visible viewport), and resize in place while the alternate screen is active so the inactive primary screen survives.
  Keep replay display-only and never let a partial replay query consume live output or send a stale response.
- POSIX SSH helper staging must run under POSIX `sh`; do not rely on zsh/bash-specific word splitting in `src/server/machines.ts`.
- Keep POSIX SSH spawn arguments bounded. Helper, profile, shell-integration, and credential payloads must be staged through a permission-restricted runtime file rather than embedded in the `ssh` command line.
- Session audit cleanup must remain limited to local `wmux_` tmux/screen sessions that the audit marks duplicate or orphan. Never add automatic cleanup of active sessions or non-wmux multiplexer sessions.
- Machine screen streams are machine-local or gateway-local captures, not browser captures. The native session agent supervises the active host's `wmux-stream-agent`, which publishes its pixels to MediaMTX on the wmux server, and wmux viewers embed MediaMTX's WebRTC path. The Moonlight gateway is reserved for the browser-native Moonlight/Sunshine use case. Do not replace either path with `getDisplayMedia` from the viewing browser.
- MediaMTX capture must remain on-demand. The browser requests/releases a short stream lease through the existing `/ws/events` socket, while the native agent supervises `wmux-stream-agent` and the worker only runs `screencapture`/ffmpeg while a lease is active. Base agents own supervision; Windows adjacent rollout generations must set `streamOwner: false`.
- MediaMTX should bind RTSP/WebRTC only to the Tailscale/internal interface and keep its API on loopback. Use `scripts/install-stream-service.sh` for repeatable setup.
- `wmux-moonlight-gateway` should bind only to loopback, Tailscale, or RFC1918/internal addresses. It is a clean process boundary around browser-native Moonlight bridges such as Moonlight Web Stream; do not vendor or copy GPL implementation code into wmux without an explicit license decision. Its setup API may automate the supported pairing flow by generating the Moonlight Web PIN and submitting it to Sunshine's `/api/pin`, but it should not edit Sunshine's paired-client state directly. The Sunshine PIN device name must match the upstream Moonlight bridge's pair device name; Moonlight Web Stream v2.10.0 currently hardcodes this as `roth`. Browser autologin should use gateway environment credentials to mint a Moonlight Web session cookie; do not commit raw Moonlight Web credentials into `wmux.config.json`.

## UI And Interaction Notes

- The terminal canvas/content area should remain visually untreated. Product styling belongs in surrounding chrome, overlays, sidebars, shelves, and toolbars.
- The application chrome uses the wmux-owned Canvas 2D cell-grid renderer in `src/client/src/opentui-grid.ts`. The former `?legacy=1` desktop React fallback has been retired. Keep editable controls, semantic accessibility overlays, mobile navigation, and browser-API surfaces DOM-backed where their interaction requires it.
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
- The event socket publishes ordered domain deltas for workspaces, delegations/timelines, notifications, runs, and settings. Keep `eventRevision` gap detection and bootstrap resync intact, preserve collection ordering explicitly, and do not regress ordinary state changes to full bootstrap broadcasts.
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
- Local text prediction lives in `src/client/src/terminal-input-prediction.ts` and arms only after an authoritative echo probe verifies the cursor and cell at the typed position.
  `inputSequence` on pane output is the newest input the server had forwarded on that socket, so it is an upper bound: settle predictions by confirming the longest acknowledged prefix the terminal actually shows, keep the remainder pending under the expiry timers, and disarm only when no prefix explains the cursor.
  Settle synchronously after each Ghostty write rather than on the next render so keystrokes typed between an echo's write and its paint stay predicted.
  A hidden cursor holds the overlay instead of disarming, because ConPTY brackets every frame with cursor hide/show and a chunk boundary can land between them.
  Predict only single-cell printable codepoints from the narrow allowlist plus backspace; never predict wide, combining, zero-width, or multi-character input.

## Helpers And Integrations

- Agent events are handled by `POST /api/agent-events`; this updates auto-owned workspace titles/descriptors and creates terminal notifications for attention and terminal transitions.
- `wmux-title` updates generated or manual workspace/tab titles. Generated titles must not overwrite user-owned titles.
- `wmux-notify` creates browser/terminal notifications through the wmux API.
- Run metadata is handled by `POST /api/run-events`; `scripts/wmux-run` wraps a command and records start/completion state without changing terminal canvas output.
  The opt-in `shellCommandTracking` config adds best-effort preexec/precmd reporting only to wmux-managed bash and zsh sessions.
  Preserve existing shell traps, keep unsupported and non-wmux-managed shells untouched, and never let an asynchronously late start event regress a terminal run.
- Browser clipboard handoff is handled by `POST /api/clipboard`; `scripts/wmux-copy` reads stdin or a file and lets the browser attempt the OS clipboard write with a top-bar fallback button. `wmux-clip`, `wclip`, and `wmclip` are aliases.
- Browser media handoff is handled by `wmux-media`. Images prefer `kitten icat --transfer-mode=stream --passthrough=tmux --align=left --engine=builtin --stdin=no`; audio/video render in browser media controls; `--mode http` forces the media shelf and `--mode kitty` fails instead of falling back.
- `wmux-sunshine-setup` is the macOS SSH-host Sunshine setup helper. It installs the official macOS DMG by default, can use the official LizardByte Homebrew tap with `WMUX_SUNSHINE_INSTALL_METHOD=brew`, configures `sunshine --creds`, and runs Sunshine through a per-user GUI LaunchAgent. It cannot bypass macOS Screen Recording, Accessibility/Input Monitoring, or Local Network approval prompts.
- Windows helper scripts live under `scripts/windows` and are served as a Base64 helper bundle instead of being embedded in the SSH command line. Keep the launch command small; Windows OpenSSH rejects large encoded commands.
- `wmux-heartbeat` refreshes a dynamic host registration. POSIX hosts without the native session agent can use the shipped systemd user timer. The POSIX and Windows base session agents own the periodic heartbeat whenever `url`, `registration-token`, and `heartbeat.json` are provisioned; `wmux-heartbeat` remains a one-shot diagnostic and agent installation removes the legacy standalone heartbeat task. Registration token distribution remains an explicit manual step.
- `wmux-windows-setup` is the Windows self-check/setup entry point. It validates helper state, can persist the helper directory to the user PATH, can install FFmpeg/Python with `winget`, installs `pywinpty` for ConPTY, and installs or reports the single per-user native-agent Scheduled Task that owns sessions, heartbeat, and capture supervision. It must work both inside a bootstrapped wmux pane and from plain SSH where `%LOCALAPPDATA%\wmux\bin` is not yet on `PATH`.
- `wmux-windows-agent` is served as `wmux-windows-agent.py` plus a CMD shim. Its HTTP API owns sessions keyed by wmux pane id: create/attach, input, pywinpty-backed ConPTY resize, output long-poll, list, health, and delete. The base agent also owns registration heartbeat and on-demand stream-worker supervision, while rollout generations own neither. It must bind only loopback, Tailscale, or RFC1918/internal hosts. Its Scheduled Task uses both logon and once-per-minute triggers with `MultipleInstances: IgnoreNew`; this is intentional supervision for unexpected termination. Explicit `stop` must disable the base and generation tasks so they remain stopped.
- Windows PowerShell bootstraps disable PSReadLine predictions to avoid inline history suggestions painting ghost text into browser terminal output, and switch the console input/output encoding to UTF-8 so native tools do not emit OEM-code-page mojibake. Keep both copies of `wmux-cwd-prompt.ps1` (the helper file and the agent's embedded string) byte-identical.
- Terminal-native image rendering is owned by Ghostty's Kitty image storage and Canvas compositor.
  Keep product styling out of the terminal canvas/content area.
  File and shared-memory source normalization must stay pane-scoped, bounded, and tied to the live immutable machine snapshot.
- `wmux-hooks install claude` mutates `~/.claude/settings.json` outside the repo. Merge hooks idempotently and preserve user settings.
- The Claude hook installer also owns `~/.claude/skills/wmux/SKILL.md` only when it contains the wmux generated marker. Preserve any unmanaged skill at that path.
- `wmux-hooks install codex` mutates `~/.codex/hooks.json` outside the repo. Codex command hooks require the user to review/trust them with `/hooks` before they run.
- `wmux-hooks install opencode` writes an auto-loaded global plugin under `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins` without mutating OpenCode JSON configuration. POSIX is supported; Windows installer parity is not included.
- `wmux-hooks install prime-agent` writes an auto-loaded managed extension under `~/.prime/agent/extensions` and preserves an unmanaged extension at the managed path.
  It reports a pane as running while either the root turn or any nested RLM descendant is active; an idle pane with any active Prime heartbeat schedule uses distinct scheduler-presence metadata and a red heart pulse, while delivered heartbeat turns use the ordinary working state.
  Prime 0.7.1 exposes no extension catalog event, so the managed extension reconciles its owner-only per-session `scheduled-jobs.json` artifact with a directory watcher and polling fallback, and must retain the last known state on transient or unknown data.
  Root completion is deferred until the last descendant becomes idle, and queued or post-compaction continuations remain on the same running lifecycle without a completion flicker.
  Provider-error ends are provisional because Prime classifies automatic retries only after extension `agent_end`; retain the binding through a guarded grace period, cancel it on retry `agent_start`, and use a fresh run if an unusually late retry arrives after terminalization.
  Prime's internal session name is canonical for auto-owned wmux workspace/tab titles. Because Prime exposes no extension event for `/name`, reconcile `getSessionName()` on lifecycle hooks plus a lightweight idle poll; never overwrite user-owned wmux titles. Contextual auto-naming updates Prime first through `setSessionName()`, then mirrors the accepted canonical value to wmux. Auto-title requests carry the complete pane identity: the first layout pane owns its tab title, the first tab's first layout pane owns the workspace title, non-owner splits cannot overwrite either, and ownership transfers only when the owner pane or tab closes.
  The pane-wide descendant registry is process-shared because daemon-hosted children evaluate separate extension modules; delegated worker processes remain suppressed.
  Waiting is reserved for a positively identified explicit input request, never inferred from idle completion.
  New POSIX pane processes export `HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`/`HERDR_PANE_ID` compatibility aliases because Prime Agent 0.8.0 forwards that allowlist into daemon session scopes; `HERDR_ENV` and a Herdr socket are deliberately not set.
  Prime Agent 0.8.0 scopes the forwarded HERDR tuple while each daemon session loads extensions. The extension captures only one complete validated tuple during that scope and fails closed when it is absent or malformed. Non-daemon processes may fall back to one complete `WMUX_*` tuple only when no HERDR field is present.
  Prime Agent 0.8.0 does not pin the scoped client environment into an already-created persistent IPython kernel. The extension must not inspect durable worker descriptors; it pins its captured tuple into each Python or `%%bash` tool call and clears stale W/T/P variables when no complete tuple was captured.
  On older Prime versions, a resident session remains bound to its creator pane; reopening a nonresident saved session can bind it to the new pane.
  When foreground client context snapshots are available, capture one validated generation per callback and preserve immutable turn bindings across lifecycle, questionnaires, idle recovery, titles, and heartbeat work.
  Reject malformed, stale, conflicting, and retired callbacks without changing the accepted generation's state.
- `wmuxctl delegate` uses the POSIX staged `wmux-agent-run` helper for visible one-shot OpenCode, Codex, Claude, or Prime Agent work.
  `wmuxctl tui` uses its prompt-free supervisor mode: the helper resolves the executable before `chdir`, blocks on the unique launch ACK before starting the child, and quarantines input after an exact exit marker until Ctrl-C or the exact release line.
  The controller requires fresh child output plus a bounded safety-gate observation interval, sends any prompt as one bracketed paste followed by separate Enter, and never closes the workspace.
  Keep write access separate from unattended approval, keep prompts out of shell arguments and launch JSON, fail closed on unrecognized first-run/login gates, and leave failed/stopped/timed-out workspaces open for inspection.
  Prime Agent one-shots require explicit write-access and unattended acknowledgements because its CLI exposes neither a read-only sandbox nor approval prompts; do not map `--unattended` to Prime Agent's unrelated `--autonomous` continuation mode.
  Prime Agent TUI and one-shot launches use `--no-session` so the supervised pane owns the process.
- `wmux-stream-agent` publishes the local display with ffmpeg to the machine's `WMUX_STREAM_RTSP_URL`. The native POSIX or Windows agent supervises it with `onDemand: true`; the worker polls wmux and starts actual capture only while a stream dialog is open. It must run in the graphical login session of the machine being captured. On macOS, `WmuxStreamAgent.app` remains the Screen Recording identity but runs as a worker owned by the native agent. On Windows, the validated path is `wmux-windows-setup install-agent`; `install-stream` is only a compatibility alias.
- Remote hooks/helpers are not auto-installed retroactively into already-running shell sessions. Start a new wmux pane or ensure the staged helper directory is on `PATH` on the remote host.
- The Codex skill lives under `skills/wmux` and should stay aligned with wmux API routes, helper behavior, and config shape. Keep public examples generic and discover live machine IDs from `/api/bootstrap`. Install it through a symlink to this repo copy rather than maintaining a separate personal copy.

## Current Gaps To Preserve In Docs

- Dynamically registered panes stage helper commands but intentionally receive no broad shared or helper token; API-posting helpers need a separately provisioned `WMUX_HELPER_TOKEN` and otherwise fail with `401`.
- Native session agents are restart-durable only while the owning supervised process remains alive. Linux/macOS agents use a PTY, while Windows uses experimental ConPTY or normalized stdio. Unexpected or forced agent restarts still terminate owned pane processes.
- Windows SSH PowerShell is validated on dogfood Windows hosts. The experimental Windows session agent prefers pywinpty-backed ConPTY, falls back to terminal-normalized stdio when pywinpty is unavailable, contains each pane in a kill-on-close Windows Job Object, supports staged-update draining, and records size-aware replay. Legacy agents require a best-effort 80x24 replay fallback after a wmux restart. Broad full-screen app validation and process preservation across unexpected/forced Windows-agent restarts are still pending.
  The stdio fallback is line-oriented with no keystroke echo, no key-sequence interpretation, and no resize, so local prediction cannot arm there; legacy WSMan `powershell` machines receive no bootstrap at all.
  The agent does not record per-input replay markers, so output `inputSequence` tags stay an upper bound and exact echo attribution is deferred to a future protocol bump.
  PSReadLine syntax colors are left untouched, so a predicted glyph may change color when the real echo lands.
- Static machine management is available through the settings editor and persists to `~/.wmux/config.json` with atomic validation and owner-only permissions.
  Machine IDs remain immutable, aliases are mutable, and registration, agent, and stream tokens stay outside the browser editor.
- Optional login-only authentication separates browser, automation, helper, registration, and registered-host credentials, and browser sessions use server-backed HttpOnly SameSite cookies.
  The settings security panel inventories and revokes browser sessions and rotates expiring file-backed automation/helper credentials.
  Finer per-client capability grants are not implemented.
- Dynamic host presence follows the host user's service lifecycle: the POSIX systemd user timer needs lingering to run while logged out, while Windows presence follows the supervised agent task and its selected `Interactive` or `S4U` logon mode.
- Full cmux-style transcript auto-naming is heuristic. Claude, Codex, and POSIX OpenCode hook paths exist; Windows OpenCode installer parity is not implemented.
- Kitty graphics supports file, temporary-file, and POSIX shared-memory transfer plus native z-index and scrollback-persistent placement.
  Animation frames, Windows named shared memory, Sixel, and iTerm2 image protocols remain unsupported and must fail with a visible diagnostic rather than silence.
- Opt-in managed bash/zsh command tracking is best-effort and does not cover unsupported or non-wmux-managed shells.
  Use `wmux-run` when exact command boundaries are required.
- Cwd preservation is best-effort outside tmux and wmux-managed shell bootstraps.
- Canvas-grid chrome parity is tracked in [docs/CANVAS_CHROME_PARITY.md](docs/CANVAS_CHROME_PARITY.md). DOM remains only for interactions that require semantic or editable browser controls.
- View-only pixel streaming uses native-agent-supervised MediaMTX capture, while the Moonlight gateway remains for Moonlight-native interaction. Wayland, locked or logged-out Windows capture, macOS permission automation, Sunshine app-launch automation, and broad full-screen Windows capture remain gaps.
- Document newly discovered or intentionally deferred limitations in the relevant `README.md` section (or a `docs/` runbook) so they stay near the feature they qualify.

## Code Style

- Keep server-only code under `src/server` and browser code under `src/client/src`.
- Prefer structured JSON APIs over ad hoc message strings.
- Use `apply_patch` for manual edits.
- Keep durable project documentation in `README.md`, `AGENTS.md`, and `docs/`; avoid committing one-off planning or handoff markdown unless it remains actively maintained.
- Do not commit generated runtime output such as `dist/`, `node_modules/`, or `test-results/`.
- Avoid broad refactors when making focused fixes; follow existing state/API patterns.
- Keep comments sparse and useful, especially around protocol parsing, terminal lifecycle, and remote helper staging.
