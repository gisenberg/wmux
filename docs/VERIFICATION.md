# Verification

Use focused unit tests and typechecks in the editing checkout.
Run full checks on a fast external POSIX host through a visible wmux workspace.
Hosted CI remains the final merge gate.

## One-time runner setup

Create an owner-only `~/.wmux/verification.json` from this example, replacing the machine IDs and checkout paths with values from live wmux discovery.
The file is deployment-local and must not enter the repository.
Each checkout must already exist, have Node, npm, Git, Python and the required browser/system dependencies, and have a remote pointing to `gisenberg/wmux` on GitHub.

```json
{
  "runners": {
    "posix": {
      "machine": "linux-runner",
      "shell": "posix",
      "checkout": "/srv/wmux-verification"
    }
  }
}
```

The controller uses the checked-in `skills/wmux/scripts/wmuxctl.py` and its normal scoped automation authentication.
It never forwards the controller's credentials to a runner.
`WMUX_VERIFICATION_CONFIG` or `--config` selects a different local configuration file.

## Fast full checks

Commit and push the task branch before requesting remote verification.
A remote commit cannot verify uncommitted local changes, so the controller refuses a dirty editing checkout.

```bash
npm run verify:remote
npm run verify:remote -- --commit HEAD --suite check
```

The command resolves a full SHA, discovers current reachability, opens a visible workspace, and leases the remote checkout through preparation and execution.
It refuses unexpected runner changes, fetches from the owner repository, switches to the exact detached commit, and checks `HEAD` again after testing.
Dependencies are installed with `npm ci` only when the manifests changed or `node_modules` is missing.
It never resets, cleans, or discards runner files.
Expected untracked `logs/` files on Windows are preserved.

The command reports the workspace URL and writes the commit, runner, duration, exit status, and bounded terminal evidence under ignored `test-results/remote/<run-id>/`.
A completion marker includes a per-run nonce and exact SHA and is assembled inside the runner, so echoed shell input cannot be mistaken for completion.
Successful workspaces close after evidence is saved.
Failures and observer timeouts retain the workspace for diagnosis and do not cancel the worker.
Inspect that workspace before retrying.
If a controller or runner is killed, inspect the task before removing its stale `.git/wmux-verification.lock` directory; never automatically steal a lease.

## Browser matrix

Use the semantic split concurrently by default, following the `wmux-testing` skill when installed.

| Lane | Host | Command |
| --- | --- | --- |
| Server-coupled | Fast POSIX runner | `npm run test:e2e:server` |
| Browser Chromium | Windows runner | `npm run test:e2e:browser:chromium` |
| Browser WebKit | Fast POSIX runner | `npm run test:e2e:browser:webkit` |
| Login-only | Fast POSIX runner | `npm run test:e2e:auth` |

Prepare both checkouts at the same full SHA before starting any lane.
The Chromium lane uses a separate authenticated `npm run test:e2e:serve` fixture on the POSIX host, with `WMUX_E2E_SERVER_HOST` set to its explicit private address and an unused `WMUX_E2E_SERVER_PORT`.
Provision a fresh strong per-run `WMUX_E2E_TOKEN` on the fixture and browser runner without putting it in terminal input, logs, or committed files.
Wait for the fixture's listening URL before setting `WMUX_E2E_BASE_URL` on Windows.
Run the other three lanes without `WMUX_E2E_BASE_URL`, so each owns an isolated fixture service.
Use visible wmux panes, preserve every workspace ID, and do not change either checkout while any lane is active.
Stop the external fixture when Chromium finishes and close successful or superseded task-owned workspaces after collecting evidence.

`verify:remote` automates a single exclusive checkout lane, not the multi-host fixture/token coordination above.
Its `server`, `webkit`, and `auth` suite selectors support focused reruns.
Concurrent lanes require the skill workflow or separate runner checkouts; the controller deliberately refuses simultaneous checkout leases.
For its Windows browser selector, provision an owner-only JSON environment file on the runner and set that runner's `environmentFile` configuration to its absolute path.
The file must contain the ephemeral `WMUX_E2E_BASE_URL` and `WMUX_E2E_TOKEN`; its contents are not embedded in terminal input or controller reports.
Only the four documented `WMUX_E2E_BASE_URL`, `WMUX_E2E_TOKEN`, `WMUX_E2E_SERVER_HOST`, and `WMUX_E2E_SERVER_PORT` fields are accepted.
Delete the task-owned environment file after the fixture has stopped.

If Windows is unavailable, or split infrastructure fails independently of the product, run the complete authoritative fallback on the POSIX runner:

```bash
npm run verify:remote -- --suite e2e
```

Use local full E2E only when the external POSIX host is unavailable or the task specifically requires the local environment.
Report every fallback and its reason.
Do not use retries to hide product failures or flakiness.
Inspect the first failure and repair its cause before rerunning affected lanes at the replacement SHA.
CI rejects flaky outcomes and retains standard browser failure artifacts for seven days.
Keep artifacts private to the verification environment because traces can contain fixture credentials.

## Integration source generation

The managed OpenCode and Prime integrations live in `src/integrations/` and participate in the strict TypeScript check.
Their installer source lives in `src/integrations/hooks-installer.mjs`.
After editing either, run `npm run generate:hooks` to update the self-contained `scripts/wmux-hooks` artifact.
Never edit that generated artifact directly.
`npm run check:scripts` rejects stale generated integrations.
