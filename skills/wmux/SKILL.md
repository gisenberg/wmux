---
name: wmux
description: "Use when Codex needs to orchestrate visible or durable work through the user's wmux browser terminal multiplexer on homelab: inspecting configured machines, starting workspaces or tabs on specific hosts, sending terminal input to local/SSH/Windows panes, tracking remote commands, using wmux helper commands, validating reachability, or updating wmux machine configuration in ../wmux."
---

# wmux

## Purpose

Use wmux when a task should run on a specific homelab/Tailscale machine with a visible browser terminal surface, durable local/SSH panes, wmux activity metadata, or helper commands such as `wmux-run`, `wmux-notify`, `wmux-copy`, and `wmux-agent-event`.

Prefer direct local tools or SSH only for quick invisible checks. Prefer wmux when the user asks to orchestrate remote work, wants to monitor the task in the browser, the task spans machines, or the command should remain attached to a wmux workspace.

## First Steps

1. Read live machine state before acting. The source config is `/home/gisenberg/git/gisenberg/wmux/wmux.config.json`; the live API usually runs at `https://homelab.tail2fcc57.ts.net:3478`.
2. Use `references/api-and-machines.md` when you need exact endpoints, machine ids, or setup caveats.
3. Use `scripts/wmuxctl.py` for common API actions:

```bash
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py machines
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py open away-team --title "Build check"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tabs --machine win-ci --title "Runner repair"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py output pane_abc123 --tail-chars 8000
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py wait pane_abc123 --pattern "ready|task_complete" --timeout 30
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py run 9800x3d --title "Windows smoke" --line "wmux-run -- pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion'"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py ps win-ci --title "Runner repair" --script "Get-ScheduledTask -TaskName gitea-act-runner" --wait
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py finish --machine win-ci --title "Runner repair" --status completed --summary "Runner repaired" --close
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py send pane_abc123 --line "wmux-agent-event --agent codex --status completed --title Done --summary 'Remote step finished'"
```

The helper reads `WMUX_URL`/`~/.wmux/url` and `WMUX_TOKEN`/`~/.wmux/token`; environment variables take precedence and it never prints the token. If the saved URL still points at the old HTTP service, update `~/.wmux/url` or pass the current HTTPS URL explicitly.

## Operating Rules

- Treat wmux as live infrastructure. Creating workspaces is usually safe; closing panes, tabs, or workspaces kills the matching session and must be intentional.
- Do not expose bearer tokens in final answers, logs, code, or committed files.
- Honor current repo and host instructions. In the homelab repo, shell commands are expected to be prefixed with `rtk`.
- Do not weaken wmux bind, Host/Origin, token, CORS, or helper-staging protections.
- For Windows machines from homelab, use `kind: "powershell-ssh"` behavior. Do not switch to legacy WSMan `powershell` unless explicitly debugging that path.
- Check `/api/bootstrap` for `reachable`, `reason`, and `backendDetail` before assuming a machine is ready. Windows status includes helper, stream, Python/FFmpeg, and agent health probes.
- Use exact machine ids from the current config. Do not rely on stale docs if `wmux.config.json` or `/api/bootstrap` differs.
- Always give automated work a descriptive `--title`; `wmuxctl open`, `run`, and `ps` reuse an existing workspace with that exact title by default. Use `--new` only when a genuinely separate workspace is wanted.
- Treat visibility as a contract. If the user asked for visible work, start substantive and long-lived processes in the wmux pane, not through direct SSH. Direct SSH remains appropriate for quick diagnostics only.
- A successful input POST, `sentBytes`, process existence, or a `running` event proves neither that a command was submitted nor that an agent is still working. Confirm pane output with `wmuxctl output`/`wait` and distinguish the latest agent turn from a persistent idle TUI process.
- Reused workspaces with multiple tabs require `--tab` or `--pane` for `run` and `ps`. Name support tabs when creating them, close task-owned abandoned tabs, and hand off the direct URL for the actual agent tab.
- `wmuxctl run` and `ps` wait for a newly created shell prompt before sending input. Keep that guard enabled unless intentionally testing startup behavior; `--no-wait-ready` can reproduce the raw race.
- Prefer `wmuxctl ps` for short Windows multi-step scripts, with `--wait` for one-shot work. Windows Defender can reject `pwsh -EncodedCommand`; do not use it for large scripts or as a transport for long agent prompts. Use a checked-in/staged script or start the TUI with a short command and bracketed-paste the prompt after it is ready.
- `wmuxctl run` and `wmuxctl ps` do not create a running agent event by default. Use `wmux-run -- ...` inside the command for spawned process progress. Add `--agent-event` only when the agent will later call `wmuxctl finish`; otherwise the workspace spinner can stay running after the process exits.
- For one-shot automated work that the agent created and completed successfully, record a final event and close the workspace with `wmuxctl finish --status completed --close` if an agent event was opened. Keep the workspace open when the task failed, needs user inspection, is interactive, or leaves a long-running process that the user should monitor.
- Do not dump full process command lines from wmux-managed Windows shells. They can contain encoded wmux bootstrap URLs or tokens. Select safe fields such as `ProcessId`, `Name`, `CreationDate`, and service/task state unless the user explicitly needs command-line debugging.

## Workflow

1. Identify the target machine id and verify it is reachable.
2. Create or reuse one titled workspace for the task. Keep reusing the returned `paneId`; do not create a new workspace for each diagnostic command.
3. If the workspace has multiple tabs, run `wmuxctl tabs` and select the intended `--tab` or `--pane`. Do not rely on the server's last active tab.
4. Send commands with `wmuxctl run` for simple shell lines or `wmuxctl ps --wait` for short Windows PowerShell scripts.
5. Verify submission and progress from pane replay. Use a unique `--wait-for`/sentinel when possible; otherwise inspect `wmuxctl output` for the actual prompt, tool calls, completion, or failure.
6. Wrap substantive commands in `wmux-run -- ...` from inside the pane so process progress and exit status come from run metadata instead of an agent spinner.
7. Use `wmuxctl run --agent-event`, `wmuxctl ps --agent-event`, or `wmux-agent-event` only for agent-level work that will end with `wmuxctl finish` or a final `wmux-agent-event completed|failed|stopped`.
8. For successful, non-interactive task-owned workspaces, run `wmuxctl finish --workspace <workspaceId> --status completed --summary "..." --close` after recording the result. For failures, debugging sessions, or user-visible long-running sessions, use `finish` without `--close` and leave the workspace open.
9. Report the direct URL for the exact agent tab, pane id, machine id, current turn status, and whether the workspace was closed.

## Visible Agent Sessions

For an interactive Codex or Claude TUI:

1. Create or reuse one clearly named agent tab and record its exact pane id.
2. Preflight authentication and every required MCP server by actually starting or calling it. A config/listing command only proves registration, not readiness; missing environment variables can still make startup fail.
3. Start the TUI with a short command. Inspect pane output for repository-trust or first-run prompts and answer them deliberately.
4. Send long prompts as bracketed paste after the TUI is ready instead of embedding them in a shell command or PowerShell encoded command.
5. Confirm real activity from recent pane output or agent transcript events. A persistent TUI PID after `task_complete` is idle, not actively iterating.
6. Keep agent events aligned with turn lifecycle, preferably through reviewed/trusted hooks. Never leave a manual `running` event behind after the turn completes.

## References

- `references/api-and-machines.md`: live endpoint, auth paths, current machine table, common API calls, and platform caveats.
- `/home/gisenberg/git/gisenberg/wmux/README.md`: authoritative wmux user/service docs.
- `/home/gisenberg/git/gisenberg/wmux/AGENTS.md`: project-specific engineering constraints.
- `/home/gisenberg/git/gisenberg/homelab/README.md`: homelab inventory snapshot.
