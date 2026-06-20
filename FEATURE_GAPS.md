# FEATURE_GAPS.md

## Current Gaps

1. Remote per-platform agents are not implemented.

   The first implementation supports machine affinity by spawning a local PTY for this box, or by launching `ssh` / PowerShell remoting clients from this box. It does not yet install a wmux agent on Linux, macOS, or Windows hosts and proxy PTY streams back over a machine-local service.

2. PowerShell remoting is scaffolded but not validated.

   `kind: "powershell"` starts `pwsh` or `powershell.exe` with `Enter-PSSession`. Authentication, TrustedHosts, WinRM transport, and interactive terminal behavior vary by environment and need validation on the target Windows host.
   On this box, `9800x3d` is currently disabled in the UI because WinRM is reachable but the local `pwsh` client is not installed.

3. PowerShell session process checkpointing does not survive service restart.

   Layout, tabs, pane metadata, and machine affinity are persisted. Local and SSH panes can now survive wmux service restarts when the target has `tmux` or `screen`, because wmux reattaches to a durable per-pane multiplexer session. PowerShell remoting still needs a Windows-side durable agent/service; raw `Enter-PSSession` clients are killed with the wmux service.

4. Machine management is file-based.

   Machines are loaded from `wmux.config.json` or `~/.wmux/config.json`. There is no in-app editor yet.

5. Authentication relies on network boundary.

   The service refuses public bind hosts and checks Host/Origin headers, but there is no user login or token gate. This matches the Tailscale/internal-network assumption and should be revisited before any broader exposure.

6. Terminal replay is bounded.

   Reconnect replay keeps the last 2 MiB of PTY output per pane while the wmux service is running. After a service restart, durable `tmux`/`screen` panes redraw from the multiplexer state, but wmux does not persist its own full scrollback transcript.

7. Agent hook installers are partial.

   wmux now has a normalized `wmux-agent-event` helper, `/api/agent-events`, and Claude Code plus Codex hook installers. Codex hooks still require a manual `/hooks` trust review inside Codex. OpenCode hook installation is not implemented because wmux has not verified a stable hook configuration surface for that tool yet.

8. Full cmux-style transcript auto-naming is heuristic.

   wmux now has the state model, API contract, and Claude/Codex hook paths needed for generated workspace names. The first implementation derives titles/descriptors from hook input and the latest user/assistant transcript text. It does not yet call an agent/LLM summarizer, throttle by transcript growth, or support OpenCode transcript discovery automatically.

9. Terminal-native graphics protocols are not implemented.

   wmux supports browser media through the `wmux-media` helper and `/api/media`, which renders images/audio/video in the originating pane. Raw binary output such as `cat image.png`, Sixel, Kitty graphics, and iTerm2 inline image escape sequences are not currently parsed from the PTY stream.

10. Terminal run metadata is explicit, not automatic.

   wmux now stores recent command run records, shows them in the activity drawer, and surfaces the latest tracked run in pane chrome with copy/rerun controls. Capture currently requires wrapping a command with `wmux-run`. wmux does not yet automatically detect arbitrary shell command boundaries from bash/zsh/fish integration sequences or infer safe rerun commands from raw terminal input.
