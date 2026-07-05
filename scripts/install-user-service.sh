#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${WMUX_HOST:-}"
PORT="${WMUX_PORT:-3478}"

if [[ -z "${HOST}" ]] && command -v tailscale >/dev/null 2>&1; then
  HOST="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "${HOST}" ]]; then
  HOST="127.0.0.1"
fi

mkdir -p "${HOME}/.config/systemd/user"
mkdir -p "${HOME}/.local/bin"
mkdir -p "${HOME}/.wmux"

for helper in "${ROOT_DIR}"/scripts/wmux-* "${ROOT_DIR}"/scripts/wclip "${ROOT_DIR}"/scripts/wmclip; do
  [[ -f "${helper}" && -x "${helper}" ]] || continue
  ln -sf "${helper}" "${HOME}/.local/bin/$(basename "${helper}")"
done

cat > "${HOME}/.wmux/stream-agent.defaults.json" <<EOF
{
  "machine": "local",
  "server": "${HOST}",
  "wmuxUrl": "http://${HOST}:${PORT}",
  "rtspUrl": "rtsp://${HOST}:8554/wmux-local",
  "onDemand": true,
  "pollInterval": 2
}
EOF

if [[ ! -f "${HOME}/.wmux/stream-agent.json" ]]; then
  cp "${HOME}/.wmux/stream-agent.defaults.json" "${HOME}/.wmux/stream-agent.json"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "${HOME}/.wmux/stream-agent.json" "${HOME}/.wmux/stream-agent.defaults.json" <<'PY'
import json
import sys

config_path, defaults_path = sys.argv[1], sys.argv[2]
with open(defaults_path, "r", encoding="utf-8") as handle:
    defaults = json.load(handle)
try:
    with open(config_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
except Exception:
    config = {}
if not isinstance(config, dict):
    config = {}
changed = False
for key in ("machine", "server", "wmuxUrl", "rtspUrl", "onDemand", "pollInterval"):
    if key not in config:
        config[key] = defaults[key]
        changed = True
if changed:
    with open(config_path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")
PY
fi

sed \
  -e "s#WorkingDirectory=.*#WorkingDirectory=${ROOT_DIR}#" \
  -e "s#Environment=WMUX_HOST=.*#Environment=WMUX_HOST=${HOST}#" \
  -e "s#Environment=WMUX_PORT=.*#Environment=WMUX_PORT=${PORT}#" \
  "${ROOT_DIR}/deploy/wmux.service.example" > "${HOME}/.config/systemd/user/wmux.service"

systemctl --user daemon-reload
systemctl --user enable wmux.service
systemctl --user restart wmux.service

echo "wmux.service installed and started on http://${HOST}:${PORT}"
echo "wmux helper shims installed in ${HOME}/.local/bin"
