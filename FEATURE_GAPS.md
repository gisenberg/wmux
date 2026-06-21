# FEATURE_GAPS.md

## Current Gaps

1. Remote per-platform agents are only partially implemented.

   The default implementation supports machine affinity by spawning a local PTY for this box or by launching client processes such as `ssh` from this box. Windows now has an experimental machine-local pywinpty-backed ConPTY session agent, but Linux/macOS agents are not implemented.

2. Windows SSH PowerShell is validated on 9800x3d; the Windows agent is experimental.

   `kind: "powershell-ssh"` now starts local `ssh -tt` and launches `pwsh -NoLogo -NoProfile` on the Windows host. This avoids the `Enter-PSSession -HostName` interactive hang seen from wmux's PTY path and does not require the PowerShell SSH remoting subsystem. `sessionBackend: "agent"` opts into the Windows-side agent, which owns pywinpty-backed ConPTY processes and replay buffers across wmux server restarts. `kind: "powershell"` remains the legacy WSMan path through `Enter-PSSession -ComputerName`; Microsoft documents WSMan remoting as unsupported from non-Windows PowerShell hosts.

3. Windows agent lifecycle control still needs hardening.

   Layout, tabs, pane metadata, and machine affinity are persisted. Local and SSH panes can survive wmux service restarts when the target has `tmux` or `screen`, because wmux reattaches to a durable per-pane multiplexer session. Windows panes launched through the experimental pywinpty/ConPTY agent can survive wmux server restarts while the Windows agent remains running, but restarting the Windows agent still kills those processes. Graceful process-tree shutdown, recovery after agent restart, and broader full-screen terminal app validation are still pending.

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

12. Cwd preservation is best-effort outside tmux and wmux-managed shell bootstraps.

   Same-machine workspaces, tabs, and splits preserve cwd by querying tmux `pane_current_path` for the source pane. When tmux is unavailable, wmux-launched zsh/bash panes and Windows `powershell-ssh` panes emit OSC 7 cwd reports through temporary prompt hooks. Some backends such as macOS screen may not pass those sequences through. Fish, custom command machines, and shells launched outside wmux can only preserve cwd if they emit OSC 7 themselves or if a stored/configured cwd is available.

13. The empty-state shader is not a native ghostty-web shader.

   Desktop Ghostty supports `custom-shader`, but `ghostty-web@0.4.0` exposes a 2D canvas renderer and no public shader hook. wmux renders the zero-workspace idle effect with a sibling WebGL fragment shader. Moving this into the Ghostty renderer requires upstream ghostty-web shader support or a local renderer fork.

14. The OpenTUI web UI migration is vendored, experimental, and partial.

   `rbbydotdev/opentui-web` currently describes itself as a proof of concept, its `opentui-browser` package is private/unpublished, and the repository has no license file. wmux vendors a local snapshot under `vendor/opentui-browser` with provenance in `vendor/opentui-browser/UPSTREAM.md`. The default sidebar now renders through the vendored `CanvasPainter` cell-grid path, while the topbar, command palette, and activity drawer still use wmux's earlier canvas implementation. `?legacy=1` remains available for the older React chrome. Settings remains a DOM form because it has editable controls and session-audit actions. Wider migration needs either a published/licensed upstream API or a deliberate decision to keep maintaining the vendored snapshot.

15. Machine pixel streams are helper-based, not a full wmux native agent yet.

   rtx6000 now runs a local MediaMTX WebRTC/RTSP router, and wmux can show per-machine stream paths from the Stream button. `wmux-stream-agent` can run as a long-lived helper and only starts capture while wmux has an active stream-viewer lease, but this is still a helper process that must run in the graphical login session of each participating machine. Windows FFmpeg/gdigrab publishing through the per-user Scheduled Task is validated on 9800x3d, including on-demand start/idle behavior. macOS still requires Screen Recording permission for the app/process that owns capture, Wayland capture is not implemented, and locked/logged-out Windows behavior still needs explicit validation. A complete per-platform wmux agent should manage permissions, richer reconnect/status reporting, and platform-specific display APIs.
