# Codex wmux plugin

The `plugins/wmux` plugin adds wmux MCP tools to an ordinary `codex` session.
It works with the normal Codex binary using supported plugin and hook settings.
It does not modify Codex source, binaries, session databases, transcripts, or
conversation names.

The packaged MCP command runs with its plugin root as its working directory and
uses a plugin-relative script path. Do not replace it with `${PLUGIN_ROOT}`:
that variable is supplied to plugin hooks, not expanded inside MCP command
arguments. Its stdio server explicitly negotiates the supported MCP protocol
revisions rather than accepting an arbitrary client-supplied revision.

When Codex runs inside a wmux pane, the MCP server receives its existing
`WMUX_WORKSPACE_ID`, `WMUX_TAB_ID`, and `WMUX_PANE_ID` binding. It exposes:

- `get_current_wmux_session` to inspect that exact workspace, tab, and pane. It
  does not request broader wmux read authority merely to fetch titles.
- `name_current_wmux_session` to name that exact session.

The naming tool defaults to `auto`. It uses wmux's existing automatic-title
route, which preserves user-owned workspace/tab titles and validates that the
bound pane belongs to the supplied workspace and tab. Split panes therefore
cannot rename the focused browser tab or another workspace by accident. The
`manual` mode is available only when the user explicitly asks for a manual,
persistent wmux workspace title.

The bundled `hooks/hooks.json` supplies a short naming instruction on each
`UserPromptSubmit`. The agent uses its understanding of the conversation to
choose a semantic 3–7 word title for the sidebar workspace and calls the MCP
naming tool. It keeps that title for follow-ups, testing, clarifications, and
status requests, and renames only for a materially different objective or a
substantial correction to its understanding. The hook itself does not generate
titles or copy prompt text. The bundled skill reinforces the same policy.

If wmux's legacy Codex lifecycle hooks are installed, run
`wmux-hooks install codex --agent-titles` with the updated wmux helper. This
opts those hooks into `--no-title`: they retain activity and completion reporting
without overwriting the agent's title with the latest prompt, including delayed
Stop reconciliation. Without this setting the two title producers conflict.
Ordinary reinstalls preserve this opt-in; users without it keep legacy behavior.

The tools use existing wmux helper credentials and the usual local URL sources.
Before reading or sending a credential, they restrict the target to loopback,
RFC1918/Tailscale/IPv6-ULA addresses, `.ts.net`, or an exact/wildcard host in
`WMUX_ALLOWED_HOSTS`.
Codex receives only the binding and wmux connection/auth variables required by
these two tools. Codex keeps MCP approval policy in the user's configuration;
for unattended automatic naming, set the wmux plugin's two-tool policy to
`approve` as shown below.
In login-only mode they require scoped helper credentials. Credentials are sent
only in the normal Authorization header and never returned in tool output.
They return an error without making an HTTP request when no complete pane binding
is available.

## Install

Register `plugins/wmux` in a local Codex marketplace and install `wmux` from
that marketplace. The plugin requires Node.js and no third-party npm packages,
and works with the normal `codex` command. Start a new Codex conversation after
installation so Codex discovers its MCP server, skill, and prompt hook.
Use `/hooks` to review and trust the plugin prompt hook and any updated wmux
lifecycle commands. Plugin installation does not automatically trust hooks.
The [Codex hooks documentation](https://learn.chatgpt.com/fr-FR/docs/hooks)
describes plugin hook discovery, trust, and additional developer context.

For automatic task naming without a confirmation prompt, add this local policy
to `~/.codex/config.toml`:

```toml
[plugins."wmux@personal".mcp_servers.wmux]
default_tools_approval_mode = "approve"
```

This affects only the wmux plugin's two title tools.

An agent can then inspect or name the session when a user asks for it. For
example: “Name this wmux session Fix title ownership.” It uses the MCP tool;
there is no `wmux-codex` launcher or alternate TUI to invoke. With the prompt
hook trusted, naming also happens without a naming request in the user's task.

## Limits

The plugin names wmux surfaces; it deliberately does not set Codex's own saved
conversation name. Codex's current plugin/hook interfaces do not expose a
reliable canonical session-name event suitable for unattended title mirroring.
The existing wmux Codex lifecycle hooks still provide their normal prompt and
completion activity reporting.
Automatic naming is an agent instruction, not a deterministic name generator;
it requires a working model and MCP server. An explicitly manual wmux workspace
title is preserved. Launching `wmuxctl tui` without `--title` leaves the new
workspace eligible for automatic naming. No global title-ownership reset is
performed for existing workspaces.
The root-only rule is an agent instruction: MCP enforces the bound pane and
wmux title ownership, but cannot distinguish a child that inherits the same
pane binding. It is not a separate root-versus-subagent authorization boundary.

## Verification

```sh
node --import tsx --test test/wmux-plugin-mcp.test.ts
npm run check
```

The MCP test verifies protocol initialization, the tool inventory, exact pane
binding, authenticated automatic naming, and failure without a binding.

The live Codex TUI check on 2026-09-05 used three ordinary prompts with no naming
requests. Server workspace state was checked after each completed turn (including
Stop reporting), not just the tab title or the agent's claim:

| Task | Sidebar workspace title observed |
| --- | --- |
| Onboard a maintainer on package validation commands | `Explain project validation commands` |
| Follow-up asking which command to run first | Unchanged: `Explain project validation commands` |
| Different objective: explain terminal persistence from the README | `Explain terminal persistence boundaries` |

The first and third turns made an actual `wmux.name_current_wmux_session` call
with `workspaceApplied: true`; all three ended with `nameSource: auto`.
The prompt hook and status-only lifecycle hooks were reviewed and trusted through
Codex's `/hooks` interface. Automated tests additionally cover immediate and
deferred telemetry, mixed-config repair, and preservation of unrelated hooks.
