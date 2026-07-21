---
name: wmux
description: "Use when Codex needs to orchestrate visible or durable work through a wmux browser terminal multiplexer: inspecting configured machines, starting workspaces or tabs, sending terminal input to local/SSH/Windows panes, tracking remote commands, using wmux helpers, or validating reachability."
---

# wmux

## Purpose

Use wmux when a task should run on a specific private-network machine with a visible browser terminal surface, durable local/SSH panes, wmux activity metadata, or helper commands such as `wmux-run`, `wmux-notify`, `wmux-copy`, and `wmux-agent-event`.

Prefer direct local tools or SSH only for quick invisible checks. Prefer wmux when the user asks to orchestrate remote work, wants to monitor the task in the browser, the task spans machines, or the command should remain attached to a wmux workspace.

## Capabilities

- Discover configured and dynamically registered machines, including reachability and backend health.
- Create or reuse visible agent-generated workspaces and tabs on local, SSH, or Windows targets. These persist with `createdBy: "agent"`, appear with an `AI` badge, and can be handed to the user with a direct URL.
- Send shell input, run short PowerShell scripts, inspect replay, and wait for output or completion sentinels.
- Record command and agent lifecycle metadata, post browser notifications, and close successful one-shot workspaces when inspection is no longer needed.

## First Steps

1. Read live machine state from `/api/bootstrap` before acting. Static machines come from the configured `wmux.config.json`; dynamic hosts come from the heartbeat registry. `WMUX_URL`, `~/.wmux/url`, and finally `http://127.0.0.1:3478` select the API.
2. Use `references/api-and-machines.md` when you need exact endpoints, machine ids, or setup caveats.
3. Use `scripts/wmuxctl.py` for common API actions:

```bash
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py machines
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py open linux-box --title "Build check"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tabs --machine windows-box --title "Runner repair"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py output pane_abc123 --tail-chars 8000
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py wait pane_abc123 --pattern "ready|task_complete" --timeout 30
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py run windows-box --title "Windows smoke" --line "wmux-run -- pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion'"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py delegate codex linux-box --directory /srv/project --prompt-file /tmp/task.md --title "Review auth"
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tui codex linux-box --directory /srv/project --prompt-file /tmp/task.md
printf '%s' 'Review auth.' | python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tui claude linux-box --directory /srv/project
cat /tmp/task.md | python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tui codex linux-box --directory /srv/project --prompt-file -
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py tui opencode linux-box --directory /srv/project --no-prompt --accept-trust
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py ps windows-box --title "Runner repair" --script "Get-ScheduledTask -TaskName build-runner" --wait
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py finish --machine windows-box --title "Runner repair" --status completed --summary "Runner repaired" --close
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py send pane_abc123 --line "wmux-agent-event --agent codex --status completed --title Done --summary 'Remote step finished'"
```

The helper reads `WMUX_URL`/`~/.wmux/url` and prefers `WMUX_AUTOMATION_TOKEN`/`WMUX_AUTOMATION_TOKEN_PATH`; compatibility mode may use `WMUX_TOKEN`/`~/.wmux/token`.
Scoped credentials are header-only, never printed or placed in query parameters, and are never retried with the legacy token after rejection.
If the saved URL still points at the old HTTP service, update `~/.wmux/url` or pass the current HTTPS URL explicitly.

## Operating Rules

- Treat wmux as live infrastructure. Creating workspaces is usually safe; closing panes, tabs, or workspaces kills the matching session and must be intentional.
- Do not expose bearer tokens in final answers, logs, code, or committed files.
- Honor the current repository and host instructions.
- Do not weaken wmux bind, Host/Origin, token, CORS, or helper-staging protections.
- For Windows machines reached from a non-Windows wmux server, use `kind: "powershell-ssh"` behavior. Do not switch to legacy WSMan `powershell` unless explicitly debugging that path.
- Let normal pane creation roll outdated Windows agents onto a side-by-side generation; existing panes remain pinned to their owning generation. Use `wmux-windows-agent-service activate-update` only for a manual in-place restart at idle, and never use `restart --force` unless terminating every active agent-owned pane is explicitly intended.
- Check `/api/bootstrap` for `reachable`, `reason`, and `backendDetail` before assuming a machine is ready. Windows status includes helper, stream, Python/FFmpeg, and agent health probes.
- Use exact machine ids from `/api/bootstrap`; it merges static config with the dynamic heartbeat registry. Do not rely on stale docs if the live API differs.
- Registered panes intentionally lack the broad `WMUX_TOKEN`. Before relying on `wmux-notify`, `wmux-run`, media, clipboard, or agent hooks there, verify that separate normal/scoped helper auth was provisioned; otherwise those helpers return `401`.
- Helpers prefer `WMUX_HELPER_TOKEN`/`WMUX_HELPER_TOKEN_PATH`; POSIX and Windows staging follow the same rule. Never use automation auth as helper fallback.
- Always give automated work a descriptive `--title`; `wmuxctl open`, `run`, and `ps` reuse an existing workspace with that exact title by default. Use `--new` only when a genuinely separate workspace is wanted.
- Treat visibility as a contract. If the user asked for visible work, start substantive and long-lived processes in the wmux pane, not through direct SSH. Direct SSH remains appropriate for quick diagnostics only.
- Prefer `wmuxctl delegate` for a visible one-shot OpenCode, Codex, or Claude task, or add `--session` for a durable Codex conversation on POSIX or Windows.
  Pass the prompt through `--prompt-file` or stdin, never as a shell argument.
  One-shot POSIX delegation creates a fresh agent-owned workspace and waits for the staged runner.
  Session mode starts a normal Codex TUI and returns its workspace ID; pass that ID with `--session-workspace` for every later turn.
  Each session turn gets a distinct lifecycle run ID, and a busy session rejects concurrent delegation.
  Session mode returns the native assistant response and therefore rejects `--structured-outcome` and `--close-on-success`.
  The helper returns the direct URL and bounded final result on both paths.
- Delegation completion races terminal replay against the durable lifecycle ledger. Treat `failureKind: observer` as loss of controller visibility rather than proof that the delegated agent failed, and inspect the retained workspace or `GET /api/delegations/:runId` before retrying destructive work.
- Use `wmuxctl tui` for an interactive POSIX OpenCode, Codex, or Claude session. It starts the real terminal-attached TUI through the staged foreground supervisor, keeps the workspace open, and does not create manual lifecycle events. Use `--prompt-file PATH`, `--prompt-file -`, piped stdin, or deliberate `--no-prompt`; prompts are bracketed-pasted only after the launch ACK, fresh child output, and the bounded `--gate-timeout` observation (five seconds by default). Repository trust fails closed unless the reviewed invocation adds `--accept-trust`, which answers only a recognized numbered `1` yes/trust/continue choice using separate text and Enter requests, then repeats the observation. Login, credentials, generic onboarding, and unknown first-run screens are never automated. If the runtime exits early, input is quarantined; manual Ctrl-C returns to the shell. `localUrl` uses the caller's API base; `url` prefers the configured `publicUrl`, which otherwise falls back to local.
- Keep write access and unattended approval separate. Omit `--write-access` for Codex read-only or Claude plan mode; add it only when repository edits are intended. OpenCode has no enforceable read-only adapter and therefore requires explicit `--write-access`. Add `--unattended` only when the user authorized bypassing approval prompts.
- Delegations stay open by default. Use `--close-on-success` only for disposable successful work. Failed, stopped, timed-out, and close-failed workspaces must remain available for inspection.
- A successful input POST, `sentBytes`, process existence, or a `running` event proves neither that a command was submitted nor that an agent is still working. Confirm pane output with `wmuxctl output`/`wait` and distinguish the latest agent turn from a persistent idle TUI process.
- Reused workspaces with multiple tabs require `--tab` or `--pane` for `run` and `ps`. Name support tabs when creating them, close task-owned abandoned tabs, and hand off the direct URL for the actual agent tab.
- `wmuxctl run` and `ps` wait for a newly created shell prompt before sending input. Keep that guard enabled unless intentionally testing startup behavior; `--no-wait-ready` can reproduce the raw race.
- `wmuxctl run`, `send`, and `ps` submit Enter separately from the command text so PSReadLine can consume the final pasted bytes. Keep this behavior when extending the helper; combining a long Windows line and `\r` in one input request can truncate the tail or leave the command unsubmitted.
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

For a delegated task, prefer the structured command:

```bash
python3 ~/.codex/skills/wmux/scripts/wmuxctl.py delegate codex MACHINE \
  --directory /absolute/project \
  --prompt-file /private/path/task.md \
  --title "Descriptive task" \
  --session --accept-trust
```

On Windows, use a drive-absolute or home-relative directory and the Codex runtime.
Record the returned `workspaceId` and pass it as `--session-workspace` for every follow-up in the same workstream.
Replace `codex` with `claude` as requested on POSIX targets.
Add `--write-access` for edits and `--unattended` only with explicit authorization.
Use `--sandbox danger-full-access` only when the operator explicitly requests no Codex sandboxing; it does not enable unattended approval.
Omit `--session` and add `--structured-outcome` only for an atomic Codex task whose caller requires a machine-shaped blocked/completed result.
OpenCode additionally requires `--write-access` because its adapter cannot enforce read-only execution.

For an interactive Codex or Claude TUI:

1. Create or reuse one clearly named agent tab and record its exact pane id.
2. Preflight authentication and every required MCP server by actually starting or calling it. A config/listing command only proves registration, not readiness; missing environment variables can still make startup fail.
3. Start the TUI with a short command. Inspect pane output for repository-trust or first-run prompts and answer them deliberately.
4. Send long prompts as bracketed paste after the TUI is ready instead of embedding them in a shell command or PowerShell encoded command.
5. Confirm real activity from recent pane output or agent transcript events. A persistent TUI PID after `task_complete` is idle, not actively iterating.
6. Keep agent events aligned with turn lifecycle, preferably through reviewed/trusted hooks. Never leave a manual `running` event behind after the turn completes.

## References

- `references/api-and-machines.md`: auth paths, API calls, discovery workflow, and platform caveats.
- The checkout's `README.md`: authoritative wmux user/service documentation.
- The checkout's `AGENTS.md`: project-specific engineering constraints.
