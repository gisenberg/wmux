# wmux UX Inspiration Plan

wmux should keep terminal rendering visually neutral and put product UX in the surrounding chrome: command surfaces, navigation, host status, settings, notifications, and audit views.

## Phase 1: Command Center

Status: implemented.

Inspired by Raycast, Superhuman, VS Code, and Linear.

- Add a global command palette on `Cmd+K` / `Ctrl+K`.
- Make common actions searchable: new workspace, new tab, split pane, close tab/workspace, copy link, mark notifications read, open settings, run session audit.
- Include workspace and tab navigation commands.
- Include host-aware creation commands for reachable machines.
- Show shortcut hints alongside actions.

## Phase 2: Host Operations

Status: implemented.

Inspired by Tailscale and Linear.

- Keep host aliases and reachability visible in workspace rows.
- Add richer host status detail: reason, last checked, service route, and backend support.
- Add host filtering for the workspace rail.

## Phase 3: Agent Threads

Status: implemented.

Inspired by Zed and cmux.

- Keep agent-generated workspace names and descriptors.
- Add lifecycle indicators for running/completed/failed agent sessions.
- Add a compact global activity timeline with workspace and host context.
- Add transcript-aware summaries when agent hook data is available.

## Phase 4: Terminal Run Metadata

Status: implemented with helper-based capture.

Inspired by Warp.

- Capture command metadata with `wmux-run`.
- Attach optional metadata to a pane: last command, duration, exit code, copy command, rerun action.
- Keep metadata outside the terminal rendering area.

## Phase 5: Session Audit And History

Status: implemented.

Inspired by Teleport.

- Keep the read-only durable session audit.
- Add explicit cleanup flows with confirmation for duplicate/orphan local durable sessions.
- Keep recent agent and run history in the server state file.
