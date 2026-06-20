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

9. Terminal-native graphics protocol support is partial.

   `wmux-media` now prefers `kitten icat --transfer-mode=stream --passthrough=tmux --align=left --engine=builtin --stdin=no` for image files, and falls back to `/api/media` for the browser media shelf. wmux parses the common direct Kitty graphics stream form (`ESC _G ... ; base64 ESC \`) for PNG/RGB/RGBA payloads, chunked transfers, zlib-compressed payloads, and Kitty Unicode virtual placements. Virtual placements render as active-screen overlays at the placeholder cell rectangle instead of in the media shelf. This is not yet a full Kitty graphics implementation: file/shared-memory transfer, animation frames, z-index layering, scrollback-persistent image placement, and Sixel/iTerm2 image protocols are still not implemented.

10. Terminal run metadata is explicit, not automatic.

   wmux now stores recent command run records, shows them in the activity drawer, and surfaces the latest tracked run in pane chrome with copy/rerun controls. Capture currently requires wrapping a command with `wmux-run`. wmux does not yet automatically detect arbitrary shell command boundaries from bash/zsh/fish integration sequences or infer safe rerun commands from raw terminal input.

11. Browser clipboard writes can require a user gesture.

   `wmux-copy` posts clipboard text to the wmux browser event stream. The open browser attempts `navigator.clipboard.writeText` immediately and keeps the text in a top-bar fallback buffer. Some browsers block clipboard writes that are not triggered by a user gesture, especially on plain HTTP origins, so the user may need to click the fallback clipboard button.

12. Cwd preservation is best-effort outside tmux and common POSIX shells.

   Same-machine workspaces, tabs, and splits preserve cwd by querying tmux `pane_current_path` for the source pane. When tmux is unavailable, wmux-launched zsh and bash panes emit OSC 7 cwd reports through temporary prompt hooks, but some backends such as macOS screen may not pass those sequences through. PowerShell, fish, custom command machines, and shells launched outside wmux can only preserve cwd if they emit OSC 7 themselves or if a stored/configured cwd is available.

13. The empty-state shader is not a native ghostty-web shader.

   Desktop Ghostty supports `custom-shader`, but `ghostty-web@0.4.0` exposes a 2D canvas renderer and no public shader hook. wmux renders the zero-workspace idle effect with a sibling WebGL fragment shader. Moving this into the Ghostty renderer requires upstream ghostty-web shader support or a local renderer fork.

14. The OpenTUI web UI migration is vendored, experimental, and partial.

   `rbbydotdev/opentui-web` currently describes itself as a proof of concept, its `opentui-browser` package is private/unpublished, and the repository has no license file. wmux vendors a local snapshot under `vendor/opentui-browser` with provenance in `vendor/opentui-browser/UPSTREAM.md`. The default sidebar now renders through the vendored `CanvasPainter` cell-grid path, while the topbar, command palette, and activity drawer still use wmux's earlier canvas implementation. `?legacy=1` remains available for the older React chrome. Settings remains a DOM form because it has editable controls and session-audit actions. Wider migration needs either a published/licensed upstream API or a deliberate decision to keep maintaining the vendored snapshot.
