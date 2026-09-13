#!/usr/bin/env bash
set -euo pipefail

# Install only a wmux-owned user unit. This does not alter Codex, its App
# Server, hooks, or any native service. Start it separately after review.
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
command -v flock >/dev/null 2>&1 || { printf '%s\n' 'wmux Codex observer requires the POSIX flock utility.' >&2; exit 1; }
node_bin=${NODE_BIN:-$(command -v node)}
observer="$root/plugins/wmux/scripts/wmux-observer.mjs"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/wmux-codex-observer.service"
mkdir -p "$unit_dir"
# Escape both sed metacharacters and systemd's percent specifiers before this
# repo-owned unit is rendered. Quotes in the template preserve paths with spaces.
escape_unit() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]] || return 1
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g' | sed -e 's/[\\&|]/\\&/g'
}
node_escaped=$(escape_unit "$node_bin")
observer_escaped=$(escape_unit "$observer")
sed -e "s|@WMUX_NODE@|$node_escaped|g" -e "s|@WMUX_OBSERVER@|$observer_escaped|g" "$root/deploy/wmux-codex-observer.service.example" > "$unit"
chmod 600 "$unit"
systemctl --user daemon-reload
printf 'Installed %s. Review then run: systemctl --user start wmux-codex-observer.service\n' "$unit"
