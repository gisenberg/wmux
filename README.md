# wmux

[![CI](https://github.com/gisenberg/wmux/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gisenberg/wmux/actions/workflows/ci.yml)

A single-user browser terminal multiplexer for Tailscale and private networks.

wmux provides:

- local, SSH, PowerShell-over-SSH, and experimental Windows-agent terminals,
- durable workspaces, tabs, splits, activity, and direct links,
- `ghostty-web` terminal rendering with desktop and mobile controls,
- browser-aware clipboard, media, notifications, and screen streaming,
- static machine configuration or dynamic host registration.

Terminal settings include a full-screen redraw cap at 15 FPS by default, 30 FPS,
or 60 FPS and scrolling mode: Performance
(batched, default) or Smooth (immediate). Normal shell output remains low-latency;
the redraw cap applies only while an alternate-screen application is active.

> [!CAUTION]
> wmux grants terminal access to its machines. It is designed for one trusted
> user behind loopback, Tailscale, or another private network boundary—not the
> public Internet. Do not expose it through a public bind or unrestricted proxy.

## Screenshots

### Desktop

![wmux desktop workspace running a live Codex session](docs/images/wmux-live-session.png)

### Mobile

<p>
  <img src="docs/images/wmux-live-mobile.png" width="320" alt="wmux mobile terminal view running the same live Codex workspace">
  <img src="docs/images/wmux-live-mobile-chat.png" width="320" alt="wmux mobile Chat view showing the live Codex task history and composer">
</p>

The desktop view and both mobile surfaces show the same live Codex workspace.

## Architecture

| Component | Responsibility |
| --- | --- |
| Browser client | React chrome, `ghostty-web` terminals, mobile controls, media, text/image clipboard handling, and stream views |
| Node.js service | Private-network boundary, bearer authentication, bounded REST uploads, event WebSocket, and canonical workspace state |
| Session manager | One live client per pane, pinned backend snapshots, temporary image staging, bounded replay, VT checkpoints, resize ownership, and backend lifecycle |
| Machine catalog | Merges static `wmux.config.json` machines with dynamically registered heartbeat hosts |
| Execution backends | Local PTYs, SSH with `tmux`/`screen` and per-pane control sockets, PowerShell over SSH, and the experimental Windows agent, which owns pane processes, replay, and dynamic-registration heartbeat |
| Persistent state | Workspace layout, settings, persistent mobile attachments, and metadata under `~/.wmux`; expiring paste-image stages are not workspace state |
| Optional streaming | Machine-local MediaMTX capture or a Moonlight/Sunshine gateway, requested by the browser |

The server owns canonical workspace state and one live session client per
pane. Browsers are attachable views: refreshing or closing a browser does not
kill a pane, while explicitly closing a pane, tab, or workspace does. Execution
and capture remain on the target machine; the viewing browser does not provide
the terminal process or screen pixels.

## Quick Start

Server requirements: Linux or macOS, Node.js 22+, npm, and `/bin/sh` with a
supported local PTY environment. Windows is supported as a remote
`powershell-ssh` target, but not as the wmux server host. Running the complete
development check (`npm run check`) additionally requires Bash and Python 3;
individual TypeScript and client build commands may work elsewhere, but the
full development workflow is supported on Linux and macOS.

```bash
npm install
npm run build
npm run start -- --host 127.0.0.1 --port 3478
```

For development with Vite HMR:

```bash
npm run dev -- --host 127.0.0.1 --port 3478
```

To listen on Tailscale, use the machine's Tailscale IPv4 address:

```bash
npm run start -- --host 100.x.y.z --port 3478
```

wmux refuses wildcard and public bind addresses by default. It accepts
loopback, Tailscale `100.64.0.0/10`, RFC1918, and IPv6 ULA addresses. If an
internal network uses another range, explicitly allow only that exact IP or
CIDR with `WMUX_ALLOWED_BIND_RANGES`:

```bash
WMUX_ALLOWED_BIND_RANGES=198.18.20.0/24 npm run start -- --host 198.18.20.44 --port 3478
```

This variable is a security-boundary override; do not use it to expose wmux on
a public address or with a wildcard CIDR.

For HTTPS, set both certificate paths and the browser-facing URL:

```bash
WMUX_CERT_FILE=~/.wmux/certs/wmux-host.tailnet.ts.net.crt \
WMUX_KEY_FILE=~/.wmux/certs/wmux-host.tailnet.ts.net.key \
WMUX_PUBLIC_URL=https://wmux-host.tailnet.ts.net:3478 \
npm run start -- --host 100.x.y.z --port 3478
```

For a Tailscale MagicDNS host, install the certificate and a daily renewal
timer with:

```bash
sudo tailscale set --operator="$USER"
WMUX_CERT_DOMAIN=wmux-host.tailnet.ts.net \
  scripts/install-tailscale-cert-service.sh
```

The installer writes owner-protected material under `~/.wmux/certs` and
enables `wmux-cert-renew.timer`. The timer renews within 30 days of expiry and
restarts `wmux.service` only after a certificate was replaced. Pass the paths
printed by the installer to `scripts/install-user-service.sh` through
`WMUX_CERT_FILE`, `WMUX_KEY_FILE`, and `WMUX_PUBLIC_URL`.

HTTPS is required for browser secure-context APIs such as Moonlight/WebCodecs.
If managed SSH hosts cannot reach the browser-facing URL, set `WMUX_HELPER_URL`
to their private callback URL. It affects staged helpers and agent callbacks
only; browser links continue to use `WMUX_PUBLIC_URL`.

### User service and containers

Install or refresh the systemd user service with:

```bash
scripts/install-user-service.sh
```

It chooses the first Tailscale IPv4 address when available. Override it with
`WMUX_HOST`, `WMUX_PORT`, `WMUX_CERT_FILE`, `WMUX_KEY_FILE`,
`WMUX_PUBLIC_URL`, and `WMUX_ALLOWED_BIND_RANGES`, and (when helper callbacks
need a different private route) `WMUX_HELPER_URL`.

```bash
systemctl --user status wmux.service
systemctl --user restart wmux.service
journalctl --user -u wmux.service -f
```

For the non-root Compose deployment, see
[deploy/docker/README.md](deploy/docker/README.md).

## Machines

The checkout-local `wmux.config.json` is ignored by Git. Copy the public
template or use `~/.wmux/config.json`:

```bash
cp wmux.config.example.json wmux.config.json
```

```json
{
  "machines": [
    {
      "id": "linux-box",
      "name": "Linux Box",
      "kind": "ssh",
      "platform": "linux",
      "host": "linux-box.tailnet-name.ts.net",
      "user": "operator"
    },
    {
      "id": "windows-box",
      "name": "Windows Box",
      "kind": "powershell-ssh",
      "platform": "win",
      "host": "windows-box",
      "user": "operator",
      "loadPowerShellProfile": true
    }
  ]
}
```

- `WMUX_CONFIG_PATH` selects one explicit file and disables fallback.
- wmux adds the local machine unless `"localMachine": false` is set.
- `kind: "local"` always executes on the current wmux server. Its display
  name does not make it a remote target, and its `cwd` must exist on that
  server.

- Local and POSIX SSH machines default to `sessionBackend: "auto"`, preferring
  `tmux`, then `screen`; use `"pty"` to force a raw session.
- Use `kind: "powershell-ssh"` for Windows hosts reached from Linux or macOS.
  It requires OpenSSH Server and PowerShell 7 on Windows.
- Static `powershell-ssh` machines may set `"loadPowerShellProfile": true` to
  load PowerShell's standard profile chain in new direct and agent-backed
  panes. It defaults to disabled. wmux wraps a profile-defined prompt to retain
  cwd reporting, continues to disable PSReadLine predictions, and does not load
  profiles for health probes or other maintenance commands. Dynamic heartbeat
  registrations and legacy WSMan `powershell` machines do not support the flag.
- Host release labels use `v<wmux-version>-<platform>`, such as
  `v0.1.1-linux`, `v0.1.1-mac`, and `v0.1.1-win`. Local and Windows platforms
  are inferred; POSIX SSH defaults to `linux`, so set `"platform": "mac"` for
  a Mac SSH host.
- Set `WMUX_ALLOWED_HOSTS` for non-`*.ts.net` MagicDNS or proxy request
  hostnames. This does not expand the bind-address policy; use the narrowly
  scoped `WMUX_ALLOWED_BIND_RANGES` override for an unusual internal IP range.

Never commit machine inventories, credentials, tokens, private-key paths, or
personal service URLs. Windows setup is covered in
[docs/WINDOWS_NODE_REGISTRATION.md](docs/WINDOWS_NODE_REGISTRATION.md).

When moving the service to another computer, do not copy a server-relative
`local` entry unchanged. Keep `local` for the new server and add the old server
as an explicit SSH machine if it should remain a target. See
[docs/SERVER_MIGRATION.md](docs/SERVER_MIGRATION.md) for the state, session,
stream, helper-credential, SSH host-key, and HTTPS cutover checklist.

### Keybindings

Keybindings are configured only in `wmux.config.json`. They are loaded when
wmux starts, so restart the service after changing them. If `keybindings` is
missing or empty, every current default remains active. A partial map replaces
only the named actions; omitted actions keep their defaults. Use an empty array
to disable one action:

```json
{
  "keybindings": {
    "commandPalette.open": ["Ctrl+Shift+KeyP"],
    "sidebar.toggle": []
  }
}
```

Each chord uses exact modifiers followed by a layout-independent browser key
code. Supported modifiers are `Primary`, `Ctrl`, `Alt`, `Shift`, and `Meta`;
`Primary` resolves to Command on Apple clients and Ctrl elsewhere. Common key
codes include `KeyK`, `Digit1`, `BracketLeft`, `Comma`, `Tab`, and
`ArrowLeft`. Extra modifiers do not match. Invalid chords, unknown actions,
duplicates, and bindings that collide in an active context prevent wmux from
starting instead of silently changing behavior.

Available actions are:

- System: `commandPalette.open`, `settings.open`, `settings.save`, and
  `sidebar.toggle`.
- Workspaces: `workspace.new`, `workspace.close`, `workspace.previous`,
  `workspace.next`, and `workspace.select1` through `workspace.select9`.
- Tabs: `tab.new`, `tab.close`, `tab.previous`, `tab.next`, and `tab.select1`
  through `tab.select9`.
- Panes and activity: `pane.splitRight`, `pane.splitDown`,
  `pane.focusPrevious`, `pane.focusNext`, and `notification.latestUnread`.
- Terminal handling: `terminal.insertNewline`, `terminal.wordPrevious`, and
  `terminal.wordNext`.

`settings.open` has no default because the former `Cmd+,` command-palette
label was not backed by an operative shortcut. Widget navigation such as Tab,
Enter, arrows, and Escape remains standard dialog behavior, and rectangular
selection remains an `Alt/Option+drag` mouse gesture.
Terminal copy and paste retain their fixed browser-aware shortcuts because
their clipboard event handling is not exposed as a configurable action.

### Dynamic host registration

Remote hosts can register by heartbeat instead of appearing in static config.
The server creates a separate catalog-write credential at
`~/.wmux/registration-token`. Provision these files on the remote host with
mode `0600`:

```text
~/.wmux/url
~/.wmux/registration-token
~/.wmux/heartbeat.json
```

```json
{
  "machine": {
    "id": "linux-box",
    "name": "Linux Box",
    "kind": "ssh",
    "user": "operator",
    "sessionBackend": "auto"
  },
  "ttlMs": 90000
}
```

```bash
scripts/wmux-heartbeat --once
scripts/install-heartbeat-service.sh
```

Windows agent hosts send the same registration heartbeat from inside the
`wmux-windows-agent` process. Provision the three files above, configure
`~/.wmux/windows-agent.json`, and run `wmux-windows-setup install-agent`; there
is no separate Windows heartbeat task. Installing the agent retires a legacy
`wmux-heartbeat` task if one exists. wmux always dials the validated heartbeat
source address and removes agent credentials from browser/status responses.
Registered panes do not receive the broad wmux API token, so API-posting helpers
need separately provisioned authorization.

## Authentication and Network Safety

> [!WARNING]
> Private binding, Host/Origin checks, and token authentication control access;
> they do not encrypt transport. Plain `http://` or `ws://` over an ordinary
> LAN can expose login passwords, bearer/session/registration/agent tokens,
> terminal input and output, clipboard contents, and media to an on-path
> observer, who may also be able to modify that traffic. Use HTTPS/WSS for
> browser-facing and cross-host traffic, or ensure every non-TLS leg is
> loopback or inside an encrypted tunnel. Direct traffic between Tailscale
> nodes is WireGuard-encrypted even when the application URL uses HTTP, but a
> subnet-routed leg may be plaintext after it leaves the Tailscale endpoint.

Within the private Host/Origin/bind boundary, only `/api/health`, auth metadata,
password login, and the static login shell are public; all other application APIs
and wmux WebSockets remain credential-gated.

- On first start, wmux creates `~/.wmux/token` and prints a one-time browser URL
  containing that token. Set `WMUX_TOKEN` or `WMUX_TOKEN_PATH` to supply one.
- Configure browser password login with
  `scripts/wmux-set-password --username you`. Login sessions last 30 days and
  survive restarts through `~/.wmux/session-secret`. Restart a running service
  with `systemctl --user restart wmux.service` after changing credentials; the
  helper prints this reminder after updating the credential file.
- `WMUX_DISABLE_AUTH=1` disables token checks only for deliberately isolated
  environments; it does not make public deployment supported.
- `WMUX_BROWSER_AUTH_MODE` defaults to `shared-or-login`, preserving existing
  shared-token URLs, `wmuxctl`, helpers, registration, and WebSockets. Upgrades
  create no scoped-token files and add no startup requirement. Set
  `WMUX_BROWSER_AUTH_MODE=login-only` only after provisioning valid password
  login credentials, a persistent session secret, and distinct automation and
  helper credentials; missing, malformed, unsafe, or duplicate credentials
  fail startup rather than downgrading.
- Provision scoped credentials without displaying them with
  `node scripts/wmux-provision-scoped-auth.mjs`. Provide
  `WMUX_AUTOMATION_TOKEN` / `WMUX_AUTOMATION_TOKEN_PATH` and
  `WMUX_HELPER_TOKEN` / `WMUX_HELPER_TOKEN_PATH` (file form preferred). Use
  owner-only token files at the configured paths and never put credentials in
  arguments, logs, documentation, or URLs.
- Automation and helper credentials are distinct typed principals. Automation
  is limited to reviewed controller actions and pane-output WebSocket access;
  helper is limited to reviewed event, title, notification, media, clipboard,
  stream, and profile operations. Both use authorization headers only; scoped
  credentials are forbidden in query parameters and never fall back or retry
  across scopes. Registration remains separate.
- The browser must pass the password-session gate before bootstrap or browser
  WebSockets. The MVP still retains browser session material in localStorage
  and browser WebSocket query transport; cookie sessions, CSRF protection,
  revocation, and finer capabilities remain deferred. wmux is not a
  public-Internet deployment.
- Use HTTPS away from loopback and treat every token as a password.
- Keep helper, clipboard, media, agent, and streaming endpoints behind the same
  private boundary. The Windows agent and Moonlight gateway use separate tokens.

Browser session tokens currently live in `localStorage` and WebSocket auth uses
a query parameter. wmux is not a hardened multi-user service.

## Workspaces and Interaction

- Workspaces contain linked tabs and draggable split panes.
- The sidebar presents workspaces as nested branches. Branches can be collapsed
  or expanded, and their collapse state is synchronized by the server. Desktop,
  keyboard, and mobile controls support moving a workspace before, after, into,
  or out of another branch. Nesting is limited to four levels.
- Host filtering retains the ancestor context needed to understand matching
  workspaces; moves that would leave the active filter context are disabled.
  Workspace-number shortcuts follow the saved tree order, and newly created
  workspaces start at the top level.
- Closing a parent workspace promotes its children rather than killing their
  panes. Tree nesting is sidebar workspace metadata; tmux/screen durability
  remains owned by each pane.
- Agents using the bundled skill can create or reuse visible workspaces. These
  persist like user-created workspaces, appear with an `AI` badge, and retain
  direct links for monitoring or handoff.
- `/workspaces/:workspaceId/tabs/:tabId` opens a specific session directly.
- Workspace, tab, and pane selection are browser-local; terminal processes and
  notification read state remain server-owned.
- New same-host workspaces, tabs, and splits preserve the source pane's current
  directory through `tmux` metadata or OSC 7 reports.
- `wmux-title` updates generated titles without overwriting a manual title.
- Host labels show the wmux release and platform consistently. Update
  indicators stay hidden unless an underlying runtime or helper update is
  needed.
- Settings persist in `~/.wmux/settings.json` and include an app-wide color
  scheme shared by terminal, canvas and DOM chrome, dialogs, and browser chrome;
  terminal size, scrollback, user-facing host aliases,
  inactive-tab streaming, and terminal scroll mode. Hidden cached tabs suspend
  terminal sockets by default while preserving their mounted terminal views;
  choose live streaming to retain the previous behavior.
- New local, SSH, and Windows panes receive the selected scheme as
  `WMUX_COLOR_SCHEME` plus `WMUX_COLOR_MODE=dark|light`. Browser terminals
  answer OSC 4/10/11 palette queries from the live scheme, including after a
  settings change. Programs that render explicit RGB colors still own those
  colors and are not recolored by the terminal palette. Windows panes also
  seed their isolated ConPTY color table from the selected scheme. The
  server-side VT checkpoint uses that same palette, so size-aware Windows
  replay preserves semantic default colors instead of repainting them black.
- Pasting a PNG, JPEG, WebP, or GIF into a connected terminal stages a private
  temporary file in that pane's target filesystem and pastes its quoted native
  path. Local, POSIX SSH, PowerShell-over-SSH, and current Windows-agent panes
  are supported; legacy WSMan, service, and custom-command targets fail closed.
  Images are limited to 8 MiB and expire after about one hour. Explicit pane
  close and discarded asynchronous pastes clean them up when the target remains
  reachable. A server or remote-host crash can leave a private file until the
  next opportunistic sweep (or manual cleanup under the per-user wmux runtime
  directory); stage paths are not persisted in workspace state.

Open the command palette with `Cmd/Ctrl+K` for navigation, host-scoped session
creation, splits, settings, diagnostics, activity, and session audit actions.

### Keyboard shortcuts

These are the defaults. Override individual actions through the `keybindings`
map above without redefining the rest.

| Action | Shortcut |
| --- | --- |
| Command palette | `Cmd/Ctrl+K` |
| New workspace | `Cmd/Ctrl+N` |
| New tab | `Cmd/Ctrl+T` |
| Toggle sidebar | `Cmd/Ctrl+B` |
| Split right | `Cmd/Ctrl+D` |
| Split down | `Cmd/Ctrl+Shift+D` |
| Close tab | `Cmd/Ctrl+W` |
| Close workspace | `Cmd/Ctrl+Shift+W` |
| Workspace 1–8 / last | `Cmd/Ctrl+1–8` / `Cmd/Ctrl+9` |
| Tab 1–8 / last | `Alt+1–8` / `Alt+9` |
| Previous/next workspace | `Cmd+Ctrl+[` / `Cmd+Ctrl+]`; also `Ctrl+Alt+[` / `Ctrl+Alt+]` |
| Previous/next tab | `Cmd/Ctrl+Shift+[` / `Cmd/Ctrl+Shift+]`; also `Ctrl+Shift+Tab` / `Ctrl+Tab` |
| Previous/next word | `Option/Alt+Left/Right` |
| Insert terminal newline | `Shift+Enter` (sends `Ctrl+J` / LF) |
| Copy selected terminal text | `Cmd/Ctrl+C` or `Cmd/Ctrl+Shift+C` |
| Paste terminal text/image | `Cmd/Ctrl+V` or `Cmd/Ctrl+Shift+V` |
| Rectangular terminal selection | `Alt/Option+drag`; use `Ctrl+Alt+drag` when a Linux window manager reserves `Alt+drag` |
| Focus neighboring pane | `Option+Cmd+Arrow` / `Alt+Ctrl+Arrow` |
| Latest unread notification | `Cmd/Ctrl+Shift+U` |

Browser- or OS-reserved shortcuts may not reach wmux on every platform.

## Helpers and Integrations

Local panes receive the repository's `scripts/` directory on `PATH`. SSH and
Windows panes stage matching helpers when a new pane starts.

| Helper | Purpose |
| --- | --- |
| `wmux-title` | Set generated or manual workspace/tab titles |
| `wmux-notify` | Create browser and terminal notifications |
| `wmux-agent-event` | Record agent lifecycle and response metadata |
| `wmux-run` | Track a command, duration, and exit status in Activity |
| `wmux-media` | Render images, audio, or video through the browser |
| `wmux-copy` / `wclip` | Hand text to the browser clipboard |
| `wmux-hooks` | Install Claude, Codex, or OpenCode lifecycle hooks |
| `wmuxctl delegate` | Run a visible one-shot OpenCode, Codex, or Claude task on a POSIX target |
| `wmux-agent-run` | Internal POSIX staged runner used by agent delegation |
| `wmux-agent-profile` | Plan/apply agent profiles, add skills, and bootstrap pinned tools |
| `wmux-doctor` | Report host, pane, and durability health |

Examples:

```bash
wmux-title --title "Auth Refactor" --descriptor "codex completed"
wmux-notify --title "Build" --body "Completed"
wmux-run -- npm test
wmux-media ./image.png
git diff | wmux-copy
wmux-agent-profile plan
wmux-agent-profile status
```

### Agent lifecycle hooks

Staging the `wmux-hooks` and `wmux-agent-event` helper commands does not enable
agent integration by itself. Install hooks for each agent, on each host and user
account where that agent runs:

```bash
wmux-hooks install claude
wmux-hooks install codex
wmux-hooks install opencode
wmux-hooks status
```

Installed harness hooks silently no-op when the agent is launched outside a
wmux pane, so one global hook configuration can be shared across environments.

The Claude installer merges lifecycle commands into `~/.claude/settings.json`
and installs a small generated delegation skill at
`~/.claude/skills/wmux/SKILL.md`. An existing skill not marked as wmux-managed is
preserved instead of overwritten.
The Codex installer merges commands into `~/.codex/hooks.json`; start a new
Codex session, run `/hooks`, and review and trust the wmux command before
expecting events. Codex sandbox or approval settings do not replace this hook
trust step.

`wmux-hooks install opencode` writes an auto-loaded global TypeScript plugin to
`${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/wmux.ts`; it does not modify
`opencode.json`. POSIX installation is supported; OpenCode's Windows installer
parity is not included.

`wmuxctl delegate` provides the same visible one-shot delegation path for
OpenCode, Codex, and Claude on POSIX local/SSH targets. It accepts the prompt
from a file or stdin, creates a fresh durable agent workspace, starts the staged
`wmux-agent-run` transport, records lifecycle events, and returns a bounded
result plus the direct workspace URL. When `WMUX_PANE_ID` is available, the new
agent workspace is nested beneath the invoking wmux workspace; this uses the
explicit pane context rather than title heuristics. Delegations started outside
wmux remain root workspaces. For example:

```bash
wmuxctl delegate codex linux-box --directory /srv/project \
  --prompt-file /tmp/task.md --title "Review authentication"
wmuxctl delegate claude linux-box --directory /srv/project \
  --prompt-file /tmp/fix.md --title "Fix authentication" --write-access
```

Codex defaults to its read-only sandbox and Claude defaults to plan permission
mode. `--write-access` opts into Codex workspace writes or Claude accepted edits;
it does not bypass approval prompts. OpenCode cannot enforce a comparable
read-only mode, so its delegation requires explicit `--write-access`.
`--unattended` separately opts into the runtime's non-interactive approval
bypass and should only be used for work explicitly authorized on a trusted
target. For OpenCode, the staged runner probes the installed CLI and uses its
advertised `--auto` or `--dangerously-skip-permissions` option, failing closed
if neither is available. Prompts are sent through pane stdin rather than shell
arguments and are redacted from returned terminal output.

Delegations leave their durable workspace open by default;
`--close-on-success` (`close_on_success` in the OpenCode tool) closes only after
a successful result and completed lifecycle event. Failed, stopped, and
timed-out workspaces remain available for inspection.
The permission-gated `wmux_close` tool accepts `workspace_id` to explicitly
close a workspace later, but refuses anything not recorded as agent-created.
The generated plugin defaults both `wmux_delegate` and `wmux_close` permissions
to `ask` in memory without rewriting `opencode.json`; an explicit per-tool
OpenCode permission of `allow`, `ask`, or `deny` takes precedence.
Cancellation sends Ctrl-C, but a disconnected or wedged remote pane may require
manual recovery. Restart OpenCode after installing or updating the plugin so it
loads the generated tools.

The older `wmux-opencode-run` helper remains staged for compatibility with
existing integrations; new callers should use `wmux-agent-run` through
`wmuxctl delegate`.

On Windows, run `wmux-windows-setup install-hooks`, then review and trust the
command with `/hooks` in a new Codex session. Dynamically registered hosts do
not receive broad wmux API credentials; lifecycle hooks on those hosts require
separately provisioned API authentication or event posts fail with `401`.

OpenCode's semantic Copy action and Codex's `/copy` command can write through OSC 52. wmux accepts
canonical UTF-8 writes to the `c` clipboard selection (`ESC ] 52 ; c ; base64`) and tmux's empty
default selection (`ESC ] 52 ; ; base64`) up to 1 MiB, removes every OSC 52 request from terminal
rendering, and never sends or persists its payload. Reconnect replay never writes the clipboard. Live
requests write automatically only in the focused foreground pane during a browser user activation;
otherwise the newest request is available as **Copy terminal request** in that pane's toolbar for 60 seconds.

The bundled Codex skill lives in `skills/wmux`:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -sfnT "$(pwd)/skills/wmux" "${CODEX_HOME:-$HOME/.codex}/skills/wmux"
```

Personal agent instructions and skills can live in a private
`../wmux-agent-profile` peer directory and be applied conservatively when a new
pane starts. See [Agent profiles](docs/AGENT_PROFILES.md) and the sanitized
[`examples/wmux-agent-profile`](examples/wmux-agent-profile).

Remote helper commands are staged when a new pane starts; existing shells are
not retrofitted automatically, and agent hooks still require the explicit setup
above.

## Experimental Windows Session Agent

Plain PowerShell-over-SSH panes do not survive a wmux service restart. The
optional Windows agent owns pane processes and replay independently:

```powershell
wmux-windows-setup install-deps
wmux-windows-setup install-agent
wmux-windows-setup configure-agent-firewall <wmux-server-internal-ip>
wmux-windows-setup agent-status
```

When `~/.wmux/url`, `registration-token`, and `heartbeat.json` are present, the
base agent heartbeats automatically and reports its last success/failure in
`/health`. Adjacent-port rollout generations never heartbeat, preventing two
agent processes from racing the same registry record.

Opt in from the machine's untracked config:

```json
{
  "id": "windows-box",
  "kind": "powershell-ssh",
  "host": "100.64.0.30",
  "user": "operator",
  "sessionBackend": "agent",
  "agentPort": 3481,
  "agentToken": "replace-with-a-long-random-token",
  "loadPowerShellProfile": true
}
```

Managed configs use `backend: "auto"`: ConPTY is preferred and terminal-safe
stdio is the fallback when `pywinpty` is unavailable. Existing explicit
`"conpty"` or `"stdio"` values remain pinned. When the base agent is outdated
and idle, new pane creation stages the update and safely restarts that base
before attaching. If the base still owns panes, wmux instead starts a
side-by-side agent generation; existing panes remain pinned to the agent that
owns them, and generation ports are persisted so wmux restarts reconnect each
pane correctly. The Windows firewall must allow the configured `agentPort` and
the next eight ports from the wmux server (for the default, `3481-3489`);
`configure-agent-firewall` installs that exact-source, bounded rule and requires
an elevated PowerShell session. A pane shows rollout progress while its
generation starts.
Changing `loadPowerShellProfile` affects only newly created pane processes;
reattaching an existing agent-owned pane does not rerun its profile.

For a manual in-place restart after the agent becomes idle, use:

```powershell
wmux-windows-agent-service activate-update
```

The in-place path accepts sessions while the update is pending, enters a brief
hard drain only after it becomes idle, and then restarts. A forced agent
restart still terminates its pane processes. See the
[Windows registration runbook](docs/WINDOWS_NODE_REGISTRATION.md) for setup and
validation.

An unused side-by-side generation can be retired without risking live panes:

```powershell
wmux-windows-agent-service retire-generation --port 3482
```

The helper refuses the base port, unreachable generations, and generations
with active sessions. It enters a hard drain and rechecks the session count
before removing the generation's Scheduled Task, process, config, and wrapper.

## Persistence

wmux stores workspace layout in `~/.wmux/state.json` using versioned, atomic,
owner-only writes with a rolling validated backup.

| Backend | Survives browser refresh | Survives wmux restart |
| --- | --- | --- |
| Local/SSH `auto`, `tmux`, or `screen` | Yes | Yes |
| Raw PTY | Yes | No |
| Plain PowerShell-over-SSH | Yes | No |
| Windows session agent | Yes | Yes, while the agent remains running |

Each live pane also has bounded raw replay and an in-memory terminal checkpoint
for alternate-screen or truncated-history reconnects. The current Windows
agent records resize boundaries with its replay, allowing wmux to rebuild a
correctly sized checkpoint after a service restart. Other checkpoints remain
in-memory only; durable multiplexers redraw when wmux reattaches.

Explicitly closing a pane, tab, or workspace kills its backing session. Audit
local wmux-owned multiplexer sessions with:

```bash
npm run audit:sessions
npm run audit:sessions -- --json
```

The Settings audit can remove confirmed duplicate or orphan wmux sessions but
never active or non-wmux sessions.

## Screen Streaming

wmux supports two machine-local streaming paths:

- MediaMTX plus `wmux-stream-agent` for on-demand, view-only WebRTC capture.
- A Moonlight/Sunshine gateway for browser-native interactive streaming.

```bash
scripts/install-stream-service.sh
wmux-stream-agent-service install
wmux-stream-agent-service status
```

Capture runs only while a browser holds a stream lease. macOS requires Screen
Recording permission; Windows capture should run through the per-user Scheduled
Task in the interactive desktop session. Keep RTSP, WebRTC, and gateway ports on
the private interface. See [docs/MOONLIGHT_GATEWAY.md](docs/MOONLIGHT_GATEWAY.md)
for Moonlight/Sunshine setup and security notes.

## Mobile

Phone-sized and short touch viewports use dedicated controls for navigation,
Chat, Term, and commands. The workspace drawer includes tabs and split panes;
only the active split is shown in the terminal area. Mobile overlays use
scrollable semantic controls, safe-area insets, and 44px touch targets. Chrome
collapses while the software keyboard is open without destroying the active
terminal session.

The Chat surface displays trusted structured agent events, not parsed PTY
output. Live terminal progress remains in Term view.

## Development

```bash
npm run typecheck
npm test
npm run check
npm run test:e2e
```

- `npm run check` runs unit/integration tests, both TypeScript checks, helper
  syntax validation, and the production build.
- `npm run test:e2e` exercises desktop Chromium plus phone-sized Chromium and
  WebKit against an isolated loopback-only service.
- `npm run test:e2e:chromium` is the faster browser subset.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[AGENTS.md](AGENTS.md) for engineering constraints and the complete list of
known implementation gaps. Report vulnerabilities privately according to the
[security policy](SECURITY.md).

## Current Limitations

- wmux is single-user and private-network only.
- Machine management remains file-based; dynamic registrations have no UI.
- Linux and macOS session agents are not implemented. The Windows agent is
  experimental and does not preserve processes across its own unexpected or
  forced restart. Automatic staged updates wait for active panes to close.
- Dynamic registered panes need separately provisioned auth for helpers that
  post back to wmux.
- Kitty graphics support is partial; Sixel and iTerm2 image protocols are not
  implemented.
- Full-screen Windows app coverage and pixel-streaming automation remain works
  in progress.

## License

wmux-owned source code and artwork are available under the [MIT License](LICENSE).
Dependencies and historical assets retain their own terms; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the provenance files beside
the assets.

Font files from Damien Guard's ZX Origins Micropack are used with permission
from Damien Guard and remain outside the MIT license. This attribution applies
to the font files, not the historical bitmap letterforms they represent.
