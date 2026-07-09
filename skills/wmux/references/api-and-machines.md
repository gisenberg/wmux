# wmux API And Machines

## Live Service

- Repo: `/home/gisenberg/git/gisenberg/wmux`
- Live config: `/home/gisenberg/git/gisenberg/wmux/wmux.config.json`
- User service: `wmux.service`
- Usual URL: `https://homelab.tail2fcc57.ts.net:3478`
- Token sources: `WMUX_TOKEN`, `WMUX_TOKEN_PATH`, or `~/.wmux/token`
- URL sources used by helpers: `WMUX_URL`, `~/.wmux/url`, then default URL

All `/api/*` endpoints except `/api/health`, `/api/auth-info`, and `/api/login` require `Authorization: Bearer <token>`.

Never print or commit the token. Prefer environment variables or local token files.

## Current Machines

Confirm with `wmux.config.json` or `/api/bootstrap` before use.

| id | kind | host/user | notes |
| --- | --- | --- | --- |
| `local` | `local` | homelab | `sessionBackend: "auto"`; durable via tmux/screen when available; Moonlight gateway at `https://homelab.tail2fcc57.ts.net:3492`. |
| `away-team` | `ssh` | `gisenberg@100.110.71.73` | `sessionBackend: "auto"`; Moonlight gateway at `https://homelab.tail2fcc57.ts.net:3490`. |
| `9800x3d` | `powershell-ssh` | `gisen@100.68.206.111` | `sessionBackend: "agent"`; Windows session agent on port `3481`. |
| `2080ti` | `powershell-ssh` | `gisenberg@100.101.81.42` | Helpers are staged in repo docs, but live bootstrap may report this host down; validate before scheduling work. FFmpeg, pywinpty, stream task, and Windows session agent may still be pending. |
| `win-ci` | `powershell-ssh` | `gisenberg@100.124.2.7` | Windows VM on the tailnet; Moonlight gateway at `https://homelab.tail2fcc57.ts.net:3491`; live bootstrap may report helpers ready while stream, session-agent, and Sunshine tasks are missing. Consult `homelab/win-ci/README.md` for VM details. |

## Common Checks

Use the skill helper:

```bash
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py machines
```

Equivalent raw API:

```bash
WMUX_URL=${WMUX_URL:-https://homelab.tail2fcc57.ts.net:3478}
WMUX_TOKEN=$(cat ~/.wmux/token)
curl -fsS -H "authorization: Bearer $WMUX_TOKEN" "$WMUX_URL/api/bootstrap" |
  jq '.machines[] | {id, kind, reachable, endpoint, backendDetail, reason}'
```

For service status on homelab:

```bash
systemctl --user status wmux.service
journalctl --user -u wmux.service -n 100 --no-pager
```

## Create A Visible Workspace

Raw API:

```bash
WMUX_URL=${WMUX_URL:-https://homelab.tail2fcc57.ts.net:3478}
WMUX_TOKEN=$(cat ~/.wmux/token)
curl -fsS -X POST "$WMUX_URL/api/workspaces" \
  -H "authorization: Bearer $WMUX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"machineId":"away-team"}' | jq '.workspace'
```

The returned workspace has `id`, `activeTabId`, and the active pane under `tabs[].panes[]`. A browser URL has this shape:

```text
https://homelab.tail2fcc57.ts.net:3478/workspaces/<workspaceId>/tabs/<tabId>
```

Set a manual title when the workspace is for a user-visible task:

```bash
curl -fsS -X POST "$WMUX_URL/api/workspaces/$WORKSPACE_ID/title" \
  -H "authorization: Bearer $WMUX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"title":"Windows smoke"}'
```

## Send Terminal Input

Posting input starts the pane process if it is not already running.

```bash
curl -fsS -X POST "$WMUX_URL/api/panes/$PANE_ID/input" \
  -H "authorization: Bearer $WMUX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"data":"wmux-run -- npm test\r","cols":120,"rows":36}'
```

Use `\r` for Enter. Keep each input payload under 256 KiB.

Use `scripts/wmuxctl.py run <machine> --line '<shell line>'` to create a workspace and send one line in a single step. The `--line` value is sent exactly as terminal input; write the line for the target shell:

- POSIX hosts: `wmux-run -- bash -lc 'cd ~/repo && npm test'`
- Windows PowerShell hosts: `wmux-run -- pwsh -NoLogo -NoProfile -Command "Get-ComputerInfo | Select-Object CsName,WindowsVersion"`

Give automated work a descriptive `--title`. `wmuxctl open`, `run`, and `ps` reuse the latest workspace with the same machine/title by default, which prevents a diagnostic loop from creating many generic `win-ci N` workspaces. Pass `--new` only for intentionally separate sessions.

For a newly created workspace, `run` and `ps` wait until the shell prompt is visible before sending input. This avoids losing or duplicating input during SSH/PowerShell bootstrap. Use `--no-wait-ready` only when deliberately testing that startup path.

When a reused workspace has multiple tabs, `run` and `ps` require an explicit `--tab` or `--pane`. Inspect and manage tabs without raw API calls:

```bash
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tabs --machine win-ci --title "Runner repair"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tab-open --workspace ws_abc123 --target-machine win-ci --tab-title "Codex"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tab-title --workspace ws_abc123 --tab tab_abc123 --tab-title "Codex - Repair"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tab-close --workspace ws_abc123 --tab tab_unused
```

For multi-step Windows work, prefer the PowerShell helper:

```bash
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py ps win-ci \
  --title "Runner repair" \
  --summary "Check runner task and toolchain" \
  --script "Get-ScheduledTask -TaskName gitea-act-runner | Select-Object TaskName,State" \
  --wait
```

`wmuxctl ps` sends a child `pwsh -EncodedCommand` and appends a completion sentinel. `--wait` confirms that the unique sentinel reached pane output; without it, the JSON response only confirms input delivery. Keep encoded scripts short: Windows Defender may reject encoded commands, and long prompts should be bracketed-pasted into an already-running agent TUI instead.

`wmuxctl run` and `wmuxctl ps` intentionally do not create a `running` agent event unless `--agent-event` is passed. For spawned process progress, wrap the pane command with `wmux-run -- ...`; that records start/completion/exit status and clears when the process exits. Use `--agent-event` only for agent-level work that will call `wmuxctl finish` or post a final `wmux-agent-event completed|failed|stopped`.

Inspect or wait for pane output through the authenticated output-only websocket:

```bash
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py output pane_abc123 --tail-chars 8000
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py wait pane_abc123 --pattern "Do you trust|task_complete" --timeout 30 --show-output
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py send pane_abc123 --line "npm test" --wait-for "Tests passed" --timeout 120
```

Treat `sentBytes`, a process id, and a `running` event as delivery/lifecycle metadata, not proof of active work. Verify the current pane output or agent transcript, and remember that an interactive agent process can remain alive and idle after its latest turn reports `task_complete`.

When an agent-created, one-shot workspace completes successfully and no user inspection is needed, record the final event and close it:

```bash
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py finish \
  --workspace "$WORKSPACE_ID" \
  --status completed \
  --summary "Task completed; results are in ~/repo/output.json" \
  --close
```

For failed runs, debugging sessions, interactive work, or long-running processes the user should monitor, omit `--close` so the terminal remains available.

## Other Useful Endpoints

- `GET /api/bootstrap`: machines, workspaces, notifications, agent events, runs, settings, streams.
- `POST /api/workspaces`: body `{ "machineId": "away-team" }`.
- `DELETE /api/workspaces/:workspaceId`: close a workspace and kill its pane sessions.
- `POST /api/workspaces/:workspaceId/tabs`: body `{ "machineId": "local" }`.
- `POST /api/tabs/:tabId/split`: body `{ "paneId": "...", "direction": "horizontal"|"vertical", "machineId": "..." }`.
- `POST /api/panes/:paneId/input`: body `{ "data": "...", "cols": 120, "rows": 36 }`.
- `POST /api/agent-events`: body may include `workspaceId`, `tabId`, `paneId`, `agent`, `status`, `title`, `summary`, `body`.
- `POST /api/run-events`: used by `wmux-run` for activity tracking.
- `POST /api/streams/:machineId/request`: request a screen stream lease.
- `DELETE /api/streams/:machineId/request/:requestId`: release a stream lease.

## Helper Commands Inside Panes

New local panes have the wmux repo `scripts/` directory on `PATH`. New SSH panes stage helpers under `~/.cache/wmux/bin` and common user bin dirs. New Windows panes stage scripts and shims under `%LOCALAPPDATA%\wmux\bin`.

Use:

- `wmux-run -- <command>` to record command start/completion.
- `wmux-agent-event --agent codex --status running|completed|failed --title ... --summary ...` for sidebar activity and completion notifications.
- `wmux-notify --title ... --subtitle ... --body ...` for browser notifications.
- `wmux-copy`/`wclip` to hand text to the browser clipboard.
- `wmux-media <file>` for browser-aware images/audio/video.
- `wmux-title --title ... --descriptor ...` for workspace/tab labeling.

Helpers fall back to `~/.wmux/token` and `~/.wmux/url` when pane environment variables are unavailable.

## Windows Notes

Use `powershell-ssh` from homelab. It launches local `ssh -tt` and starts remote `pwsh -NoLogo -NoProfile`; it is not WSMan remoting.

Windows helper setup commands from a fresh wmux pane:

```powershell
wmux-windows-setup validate
wmux-windows-setup persist-path
wmux-windows-setup install-deps
wmux-windows-setup install-stream
wmux-windows-setup stream-status
wmux-windows-setup install-agent
wmux-windows-setup agent-status
```

If the helper is not on `PATH`, call it by path:

```powershell
& "$env:LOCALAPPDATA\wmux\bin\wmux-windows-setup.ps1" validate
```

Windows panes are durable across wmux service restarts only when the machine has `sessionBackend: "agent"` and the Windows agent is healthy. The `9800x3d` config currently opts into this; `2080ti` and `win-ci` may not.

When auditing Windows processes from wmux, avoid full `CommandLine` output unless the user asks for it. wmux-managed shells can include encoded bootstrap URLs or tokens in their process command line; prefer `ProcessId`, `Name`, `CreationDate`, service state, scheduled-task state, and explicit version commands.
