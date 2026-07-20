# Agent profiles

wmux can distribute a small, explicit layer of agent instructions, Agent Skills, and selected settings to its machines. It is intentionally additive: a plan is read-only, apply backs up existing files and writes atomically, and unmanaged or locally changed values become conflicts instead of being overwritten.

Set `WMUX_AGENT_PROFILE_PATH` to a profile directory. Without it, wmux looks for `../wmux-agent-profile` beside the wmux checkout and then `~/.wmux/agent-profile`. Keeping a personal profile in a peer directory avoids publishing personal configuration with wmux.

```bash
cp -R examples/wmux-agent-profile ../wmux-agent-profile
scripts/wmux-agent-profile plan --profile ../wmux-agent-profile
scripts/wmux-agent-profile apply --profile ../wmux-agent-profile
```

When a profile exists, each newly started pane stages `wmux-agent-profile` and applies the authenticated profile before entering the shell. Existing panes are not retroactively changed. Automatic runs append a summary to `~/.wmux/logs/agent-profile.log`; inspect ownership with `wmux-agent-profile status`.

Dynamically registered hosts still receive no broad wmux API token. Their automatic startup quietly skips a profile when the endpoint returns `401`; a separately provisioned valid `~/.wmux/token` enables the normal apply path. Manual `wmux-agent-profile` commands continue to report authorization failures so a stale or missing credential remains diagnosable.

Add a skill through the validated profile workflow rather than copying it by hand:

```bash
scripts/wmux-agent-profile add-skill /path/to/skill --profile ../wmux-agent-profile
```

The command validates `SKILL.md`, rejects symlinks, common secret files, private-key material, and generated dependency/cache trees, then records source, revision, license, and content hash in `skills.lock.json`. It refuses to replace a changed profile copy unless `--replace` is supplied after review. It never commits or pushes the profile repository.

Profiles may also declare version- and checksum-pinned tool prerequisites. Dependent items report `blocked` and remain untouched when a tool is missing or has the wrong version. Installation is always explicit:

```bash
scripts/wmux-agent-profile bootstrap --tool rtk --profile ../wmux-agent-profile
```

Bootstrap accepts fixed HTTPS artifacts, verifies SHA-256 before extracting, installs atomically under the declared user path, and verifies the resulting version. Workspace creation only runs `apply`; it never downloads tools. New POSIX panes include `~/.local/bin` in `PATH`, making user-level installs portable without requiring root. Windows bootstrap is intentionally deferred until its PowerShell and agent-command behavior can be modeled explicitly.

The authenticated `GET /api/agent-profile` endpoint serves the current profile as a hash-verified bundle. This makes the server checkout the source of truth without requiring a Git credential on every target. A target without wmux API authorization cannot fetch the profile.

Do not put secrets, OAuth state, host trust, histories, caches, or complete `~/.claude.json`/`~/.codex/config.toml` files in a profile. Use narrowly scoped merge fragments and keep secret injection machine-local. See the bundled [`wmux-agent-profile` skill](../skills/wmux-agent-profile/SKILL.md) and its [format reference](../skills/wmux-agent-profile/references/profile-format.md).
