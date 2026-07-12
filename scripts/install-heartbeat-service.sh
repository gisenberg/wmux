#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${HOME}/.wmux"
UNIT_DIR="${HOME}/.config/systemd/user"

mkdir -p "${STATE_DIR}" "${UNIT_DIR}" "${HOME}/.local/bin"

if [[ -n "${WMUX_URL:-}" ]]; then
  printf '%s\n' "${WMUX_URL}" > "${STATE_DIR}/url"
  chmod 600 "${STATE_DIR}/url"
fi
if [[ -n "${WMUX_REGISTRATION_TOKEN:-}" ]]; then
  printf '%s\n' "${WMUX_REGISTRATION_TOKEN}" > "${STATE_DIR}/registration-token"
  chmod 600 "${STATE_DIR}/registration-token"
fi

for required in heartbeat.json registration-token url; do
  if [[ ! -s "${STATE_DIR}/${required}" ]]; then
    echo "missing ${STATE_DIR}/${required}; provision it before installing the timer" >&2
    exit 1
  fi
done
chmod 600 "${STATE_DIR}/heartbeat.json" "${STATE_DIR}/registration-token" "${STATE_DIR}/url"

ln -sf "${ROOT_DIR}/scripts/wmux-heartbeat" "${HOME}/.local/bin/wmux-heartbeat"
cp "${ROOT_DIR}/deploy/wmux-heartbeat.service.example" "${UNIT_DIR}/wmux-heartbeat.service"
cp "${ROOT_DIR}/deploy/wmux-heartbeat.timer.example" "${UNIT_DIR}/wmux-heartbeat.timer"

systemctl --user daemon-reload
systemctl --user enable --now wmux-heartbeat.timer
systemctl --user start wmux-heartbeat.service

echo "wmux-heartbeat.timer installed for ${STATE_DIR}/heartbeat.json"
