# Console session flow

The empty workspace is a static session launcher.
Select an explicit target host, create a workspace, find an existing session, or manage hosts.
It does not initialize WebGL or run idle animation loops.

The sidebar distinguishes HOSTS from WORKSPACES.
Its workspace links support arrow keys, Home, End, and hierarchical expansion.
These keys apply while the navigation tree has focus, not while typing into a terminal.
Host selection for creation remains independent of workspace navigation.
Selected and offline hosts show secondary details; other reachable hosts use compact rows.

Open the command palette with Cmd/Ctrl+K.
Session commands accept combined filters such as `host:local state:waiting runtime:claude`.
The palette also provides next-attention and next-unseen-completion actions, host inspection, directional pane focus, and pane zoom.
Zoom preserves the mounted terminal tree and restores the existing split ratios.

Fleet combines managed delegations, hook-observed agents, and ordinary shells.
Provenance is shown explicitly and observed hooks never acquire delegation control authority.
Independent active delegations sharing one pane remain individually visible.
Host reachability and agent lifecycle are separate facts.
Completion is not reported as running merely because an agent TUI process remains open.
Unread notifications identify unseen completions.
The desktop Fleet can dock alongside the terminal; mobile keeps the dialog presentation.

Host inspection uses already reported identity, connectivity, runtime, helper, and release information.
Session search includes reported working directories.
Branch and ahead/behind indicators remain unavailable until an authoritative cached metadata source exists; rendering never triggers SSH or git probes.

Editable controls, mobile navigation, browser integrations, and semantic links remain DOM-backed.
The console renderer remains responsible for surrounding chrome, while Ghostty terminal pixels and retro boot artwork are unchanged.
