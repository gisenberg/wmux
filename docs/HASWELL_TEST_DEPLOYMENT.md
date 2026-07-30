# Haswell testing deployment (active)

This runbook documents the active haswell testing deployment only. It is for local, private-network operators and for recovery playbooks; keep it concise and reproducible.

> [!CAUTION] This deployment is testing-only. OpenCode structured questions are still in test mode, `HARD SERVER PROOF` is not passed, and rollback/validation workflows for this path are feature-only with `WMUX_AGENT_INPUT_ENABLED=0`.

## 1) Top-level layout and release discovery

Deployment root:

`/mnt/storage/sw_projects/wmux-deployments/haswell`

Observed layout in this deployment:

- `active` — symlink to the current release directory.
- `ACTIVE` — release directory name/path for operational logs.
- `PREVIOUS` — previous release directory name/path for rollback.
- `DEPLOYMENT-MANIFEST.json` — generated per release under each release dir.
- `service-unit.before` — historical evidence snapshot for reference only.
- `service-unit.candidate` — generated candidate unit whose `WorkingDirectory` points to `active`.
- `service-unit.rollback` — generated rollback unit whose `WorkingDirectory` points to the `PREVIOUS` release directory.

The deployment root also contains an executable `rollback.sh` that performs the documented rollback flow end-to-end; fresh agents should prefer that helper.

> [!NOTE] The exact current release is **not hardcoded** in docs. Use `readlink`/`cat` to resolve it.

```bash
cd /mnt/storage/sw_projects/wmux-deployments/haswell
readlink -f active
cat ACTIVE
cat PREVIOUS

CURRENT_DIR=$(readlink -f active)
cat "$CURRENT_DIR/DEPLOYMENT-MANIFEST.json"
```

If your manifest fields differ, read the JSON directly and do not assume a fixed schema.

## 2) Fixed systemd unit location and required invariants

Active user unit:

`/home/iceparrot/.config/systemd/user/wmux.service`

Required invariants for the haswell active deployment:

- `WorkingDirectory=/mnt/storage/sw_projects/wmux-deployments/haswell/active`
- Existing host/auth/public URL env settings remain as-is (except deployment-local changes in that existing unit file).
- `ExecStart=... npm run dev` must remain the start mode.

```bash
systemctl --user cat wmux.service | sed -n '/\[Service\]/,/^\[/p'
```

If unit drift is suspected, compare with `service-unit.before` and `service-unit.candidate` in the deployment root.

`service-unit.rollback` is generated for immediate fallback and keeps the exact `PREVIOUS` path in `WorkingDirectory`.

## 3) Inspect commands for deployment state

Run these read-only checks before touching service control:

```bash
cd /mnt/storage/sw_projects/wmux-deployments/haswell

ls -alF

systemctl --user status wmux.service
systemctl --user list-units --type=service 'wmux.service' --all

readlink -f "$(systemctl --user show -p FragmentPath --value wmux.service)"

systemctl --user show wmux.service -p ActiveState -p SubState -p MainPID -p ExecMainStatus

journalctl --user -u wmux.service --no-pager --since '15 min ago'
```

## 4) Health and authenticated bootstrap checks (no token output)

Use loopback by default. Fall back to another endpoint only if loopback is unavailable. Never print token values.

```bash
BASE_URL="${WMUX_BASE_URL:-http://127.0.0.1:3478}"
curl -fsS "$BASE_URL/api/health"

# Bearer-authenticated bootstrap
curl -fsS --config <(
  printf 'url = "%s/api/bootstrap"\n' "$BASE_URL"
  printf 'header = "Authorization: Bearer %s"\n' "$(cat "$HOME/.wmux/token")"
)

# Token-safe alternative for login-session workflows (if your deployment is session-cookie-based):
curl -fsS --cookie /tmp/wmux-session.cookie "$BASE_URL/api/bootstrap"
```

Avoid `echo`/`printf` of token-bearing variables. Never pass tokens on command line in shared logs; read auth from `~/.wmux/token` via temporary curl config/process substitution.

> [!NOTE] When using SSH tool invocations from agent tooling in this environment, pass `connectionName: haswell` explicitly.

## 5) Journal inspection pattern for startup regressions

The rollout controller treats these as rollback conditions:

- service not active
- `/api/health` failure
- authenticated `/api/bootstrap` failure
- startup fatal traces in recent journal

```bash
journalctl --user -u wmux.service --no-pager --since '10 min ago' --priority=info
journalctl --user -u wmux.service --no-pager --since '2 hour ago' --priority=err
journalctl --user -u wmux.service --no-pager --since '2 hour ago' | grep -iE 'fatal|startup|uncaught|Unhandled|EACCES|address already in use|bind'
```

## 6) Atomic rollback (candidate/release rollback)

Use this sequence for feature-only rollback. Prefer `./rollback.sh` on fresh agents; this is the same control flow with local guardrails.

```bash
set -euo pipefail

DEPLOY_ROOT="/mnt/storage/sw_projects/wmux-deployments/haswell"
cd "$DEPLOY_ROOT"

PREV=$(cat PREVIOUS)
if [ -d "$PREV" ]; then
  PREV_DIR="$PREV"
elif [ -d "$DEPLOY_ROOT/$PREV" ]; then
  PREV_DIR="$DEPLOY_ROOT/$PREV"
else
  echo "PREVIOUS path is not a directory: $PREV" >&2
  exit 1
fi

# Step 1: make active point at exact previous release.
tmp_link=".active.rollback.$$"
ln -sfn "$PREV_DIR" "$tmp_link"
mv -Tf "$tmp_link" active

# Step 2: install candidate unit (stable candidate pointing at active) as the live service unit.
install -m 0644 service-unit.candidate "$HOME/.config/systemd/user/wmux.service"

systemctl --user daemon-reload
systemctl --user restart wmux.service

# Step 3: verify loopback health and bootstrap after restart.
systemctl --user is-active --quiet wmux.service

BASE_URL="${WMUX_BASE_URL:-http://127.0.0.1:3478}"
curl -fsS "$BASE_URL/api/health"
curl -fsS --config <(
  printf 'url = "%s/api/bootstrap"\n' "$BASE_URL"
  printf 'header = "Authorization: Bearer %s"\n' "$(cat "$HOME/.wmux/token")"
)
```

### Fallback for broken symlink or bad candidate

If restart or bootstrap immediately fails after rollback:

```bash
install -m 0644 service-unit.rollback "$HOME/.config/systemd/user/wmux.service"
systemctl --user daemon-reload
systemctl --user restart wmux.service
```

Then rerun Section 4 health/bootstrap checks and inspect the journal for startup errors.

`service-unit.before` remains historical evidence and is not treated as executable rollback logic, because it may reflect an older or newer working tree than the current failure point.

## 7) Safety posture and restart expectations

- `~/.wmux` contains durable state and **must not be deleted** during recovery.
- Pre-feature rollback ignores newly written `agent-input` files.
- Restart is generally safe for observed SSH `sessionBackend=auto` (tmux-backed) panes in this deployment.
- Before restarting, confirm live backend mix from bootstrap/session state and avoid restart if live panes include raw PTY/custom-command/legacy PowerShell-style non-durable backends.
- Keep an eye on pane durability expectation for active workspaces after rollback.

## 8) Deployment auto-rollback expectation

The haswell deployment update process is expected to auto-rollback on:

- `wmux.service` not active after swap
- `/api/health` failure
- authenticated `/api/bootstrap` failure
- fresh startup fatal entries in journald

If this happens, confirm the rollback decision trail, then resume with a clean candidate build and re-run this runbook from Section 2.
