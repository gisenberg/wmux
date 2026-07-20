#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${WMUX_HOST:-}"
PORT="${WMUX_PORT:-3478}"
CERT_FILE="${WMUX_CERT_FILE:-}"
KEY_FILE="${WMUX_KEY_FILE:-}"
PUBLIC_URL="${WMUX_PUBLIC_URL:-}"
HELPER_URL="${WMUX_HELPER_URL:-}"
ALLOWED_BIND_RANGES="${WMUX_ALLOWED_BIND_RANGES:-}"
BROWSER_AUTH_MODE="${WMUX_BROWSER_AUTH_MODE:-shared-or-login}"
AUTOMATION_TOKEN_PATH="${WMUX_AUTOMATION_TOKEN_PATH:-}"
HELPER_TOKEN_PATH="${WMUX_HELPER_TOKEN_PATH:-}"
HELPER_URL="${HELPER_URL#"${HELPER_URL%%[![:space:]]*}"}"
HELPER_URL="${HELPER_URL%"${HELPER_URL##*[![:space:]]}"}"

if [[ -z "${HOST}" ]] && command -v tailscale >/dev/null 2>&1; then
  HOST="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "${HOST}" ]]; then
  HOST="127.0.0.1"
fi

PROTOCOL="http"
if [[ -n "${CERT_FILE}" || -n "${KEY_FILE}" ]]; then
  if [[ -z "${CERT_FILE}" || -z "${KEY_FILE}" ]]; then
    echo "WMUX_CERT_FILE and WMUX_KEY_FILE must both be set for HTTPS" >&2
    exit 1
  fi
  PROTOCOL="https"
fi

if [[ -z "${PUBLIC_URL}" ]]; then
  PUBLIC_URL="${PROTOCOL}://${HOST}:${PORT}"
fi
if [[ -z "${HELPER_URL}" ]]; then
  HELPER_URL="${PUBLIC_URL}"
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
  "wmuxUrl": "${HELPER_URL}",
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
  -e "s#Environment=WMUX_CERT_FILE=.*#Environment=WMUX_CERT_FILE=${CERT_FILE}#" \
  -e "s#Environment=WMUX_KEY_FILE=.*#Environment=WMUX_KEY_FILE=${KEY_FILE}#" \
  -e "s#Environment=WMUX_PUBLIC_URL=.*#Environment=WMUX_PUBLIC_URL=${PUBLIC_URL}#" \
  -e "s#Environment=WMUX_HELPER_URL=.*#Environment=WMUX_HELPER_URL=${HELPER_URL}#" \
  -e "s#Environment=WMUX_ALLOWED_BIND_RANGES=.*#Environment=WMUX_ALLOWED_BIND_RANGES=${ALLOWED_BIND_RANGES}#" \
  -e "s#Environment=WMUX_BROWSER_AUTH_MODE=.*#Environment=WMUX_BROWSER_AUTH_MODE=${BROWSER_AUTH_MODE}#" \
  -e "s#Environment=WMUX_AUTOMATION_TOKEN_PATH=.*#Environment=WMUX_AUTOMATION_TOKEN_PATH=${AUTOMATION_TOKEN_PATH}#" \
  -e "s#Environment=WMUX_HELPER_TOKEN_PATH=.*#Environment=WMUX_HELPER_TOKEN_PATH=${HELPER_TOKEN_PATH}#" \
  "${ROOT_DIR}/deploy/wmux.service.example" > "${HOME}/.config/systemd/user/wmux.service"

systemctl --user daemon-reload
systemctl --user enable wmux.service
systemctl --user restart wmux.service

echo "wmux.service installed and started on ${PUBLIC_URL}"
echo "wmux helper shims installed in ${HOME}/.local/bin"
