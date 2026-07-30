# Haswell testing deployment (active)

This runbook documents the active haswell testing deployment only. It is for local, private-network operators and for recovery playbooks; keep it concise and reproducible.

> [!CAUTION] This deployment is testing-only. OpenCode structured questions are still in test mode, `HARD SERVER PROOF` is not passed, and rollback/validation workflows for this path are feature-only with `WMUX_AGENT_INPUT_ENABLED=0` when the schema-compatible rollback path is used.

## 1) Top-level layout and release discovery

Deployment root:

`/mnt/storage/sw_projects/wmux-deployments/haswell`

Observed layout in this deployment (authoritative list):

- `active` — symlink to the current release directory.
- `ACTIVE` — release directory name/path for operational logs.
- `PREVIOUS` — previous release directory name/path.
- `DEPLOYMENT-MANIFEST.json` — generated per release under each release dir.
- `service-unit.before` — historical reference snapshot for root-level evidence.
- `service-unit.candidate` — live candidate unit used when the candidate schema is running (schema 7); points to `active`.
- `service-unit.rollback` — fallback-safe candidate unit with `WMUX_AGENT_INPUT_ENABLED=0`, kept in step-one rollback flow.
- `service-unit.legacy` — legacy fallback unit that targets `c0ceb73` for schema-6 recovery.
- `service-unit.legacy` and `ROLLBACK_MODE` may be written by rollback tooling for state signaling.
- `rollback.sh` — preferred rollback helper.
- `rollforward.sh` — revert rollback to feature-enabled candidate behavior.
- `deploy-candidate.sh` — candidate release path installer/build trigger.
- `PREDEPLOY_STATE_BACKUP` — deployment-time marker indicating where schema-6 state was captured before candidate swap.
- `~/.wmux/deploy-backups/` — backup area used by emergency legacy fallback.

The deployment root also contains executable `rollback.sh` and `rollforward.sh`; fresh agents should prefer those helpers and then inspect `ROLLBACK_MODE` for branch outcome.

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

Current candidate expectation:

- Candidate build deployed here is schema **7** and must only be started against schema-7 state.
- The server-challenge runtime-attestation candidate uses agent-input credential schema **4** and broker schema **10**. Schema-3 source credentials survive only as refresh authority and must reattest; schema-2 credentials and pre-schema-9 broker files remain deliberately disabled during migration.
- Legacy commit `c0ceb73` is schema **6** and **must not** be selected against live schema-7 state.

After deploying the runtime-attestation candidate, run `wmux-hooks install
opencode` on each OpenCode host/account, verify `wmux-hooks status` reports
`opencodeParity: true`, and open a fresh wmux pane. Existing panes do not have a
usable post-migration registration capability. Start OpenCode in the fresh pane
and inspect the owner-only `~/.wmux/agent-input/<pane>.json.status.json` sibling
for `runtime_ready` before attempting HARD SERVER PROOF. A failed status contains
only a stable diagnostic code; do not bypass it with the broker `refresh`
command, which now returns `attestation_required`.

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

If unit drift is suspected, compare with `service-unit.before`, `service-unit.candidate`, and `service-unit.rollback` in the deployment root.

`service-unit.rollback` is generated for immediate schema-compatible rollback while preserving the active candidate code path.

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

## 6) Schema-aware rollback flow

Use this section for documented recovery order after a failed deploy or startup check:

### 6.1 Preferred `./rollback.sh`

`rollback.sh` performs this tested sequence first:

1. Preserve the active candidate release path (do not symlink `active` to `PREVIOUS`).
2. Install `service-unit.rollback` (candidate code path with `WMUX_AGENT_INPUT_ENABLED=0`).
3. `daemon-reload` + `restart`.
4. Verify `wmux.service` active, `/api/health`, and authenticated `/api/bootstrap`.

This path is **schema-compatible** for schema-7 state and has been live-tested successfully.

```bash
cd /mnt/storage/sw_projects/wmux-deployments/haswell
./rollback.sh

# Capture which branch the script chose:
cat ROLLBACK_MODE
```

### 6.2 Manual fallback branch (only if schema-compatible rollback cannot start)

Only when the feature-disabled candidate path above cannot start (or restart+bootstrap still fails) should emergency recovery run:

- Preserve current schema-7 state under `~/.wmux/deploy-backups`.
- Restore `PREDEPLOY_STATE_BACKUP` (schema-6 record).
- Point `active` at legacy `c0ceb73`.
- Install `service-unit.legacy` and restart.

This path is a **full emergency schema fallback**; it is expected to revert wmux to deployment-time state and must never run schema-6 code (`c0ceb73`) against live schema-7 state.

```bash
cd /mnt/storage/sw_projects/wmux-deployments/haswell
cat ROLLBACK_MODE  # should indicate the emergency branch if activated
cat PREDEPLOY_STATE_BACKUP
```

`service-unit.before` remains historical reference evidence and is not treated as executable rollback logic.

## 7) Rollforward after successful feature-disabled candidate validation

After `./rollback.sh` succeeds and canary checks pass, re-enable the feature path with:

```bash
cd /mnt/storage/sw_projects/wmux-deployments/haswell
./rollforward.sh
```

`rollforward.sh` restores `service-unit.candidate`, replaces the unit to remove `WMUX_AGENT_INPUT_ENABLED=0`, restarts, and runs the same service/health/bootstrap checks. This behavior was live-tested successfully.

## 8) Incident evidence (recorded)

During legacy rollback validation, the first boot used legacy code and looped with:

`state schema 7 is newer than what this code supports and supports only 6`

`rollback.sh` then restored candidate flow; loopback/public health recovered and service remained usable. This is retained as operational evidence, not an unresolved outage.

## 9) Safety posture and restart expectations

- `~/.wmux` contains durable state and **must not be deleted** during recovery.
- Pre-feature rollback ignores newly written `agent-input` files.
- Restart is generally safe for observed SSH `sessionBackend=auto` (tmux-backed) panes in this deployment.
- Before restarting, confirm live backend mix from bootstrap/session state and avoid restart if live panes include raw PTY/custom-command/legacy PowerShell-style non-durable backends.
- Keep an eye on pane durability expectation for active workspaces after rollback.

## 10) Deployment auto-rollback expectation

The haswell deployment update process is expected to auto-rollback on:

- `wmux.service` not active after swap
- `/api/health` failure
- authenticated `/api/bootstrap` failure
- fresh startup fatal entries in journald

If this happens, confirm the rollback decision trail, then resume with a clean candidate build and re-run this runbook from Section 2.
