# Prime Agent 0.8 daemon sessions lose wmux lifecycle integration

Date: 2026-08-25
Status: Fixed and verified
Affected integration: generated Prime Agent extension installed by `scripts/wmux-hooks`

## Summary

After upgrading Prime Agent from 0.7.4 to 0.8.0, Prime sessions launched in wmux still open and accept prompts, but wmux no longer receives the normal Prime lifecycle signals.
The visible effects are:

- the Prime session name does not propagate to the bound wmux workspace/tab;
- the wmux working animation does not start during a turn;
- related start, stop, interruption, and status behavior is absent.

This is not a general pane or prompt-delivery failure.
Safe live smoke tests confirmed that wmux can create a durable pane, run `prime-agent --version`, launch the Prime TUI, submit a prompt, and receive an assistant response.

## Confirmed root cause

Prime Agent 0.8 writes durable daemon worker descriptors with schema `version: 2`.
Those descriptors deliberately omit the session client environment from `createCommand`.

The currently deployed generated wmux extension still implements `daemonDescriptorIdentity()` for the old descriptor contract.
It requires all of the following before binding lifecycle events to a pane:

```text
parsed.version === 1
parsed.pid === process.pid
parsed.rootActiveSessionId === activeSessionId
parsed.createCommand.type === "create"
parsed.createCommand.env.HERDR_{WORKSPACE,TAB,PANE}_ID
```

On a real Prime Agent 0.8 worker, the descriptor instead has this relevant shape:

```json
{
  "version": 2,
  "rootActiveSessionId": "<active-session-id>",
  "createCommand": {
    "type": "create",
    "sessionPath": "<session-file>"
  }
}
```

There is no `createCommand.env`, so merely permitting descriptor version 2 would not repair identity binding.
The generated extension returns no `boundIdentity`.
Its `session_start`, `before_agent_start`, `agent_start`, `agent_end`, and `session_shutdown` handlers then return before publishing wmux events or titles.
This explains the naming and working-animation failures with one cause.

## Prime Agent 0.8 integration contract

Prime Agent 0.8 scopes the allowlisted per-client `HERDR_*` environment around each daemon session's extension load.
The wmux extension should capture and validate the complete `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID` tuple at module initialization.
It should not recover session identity from the durable worker descriptor.

Fail closed when the tuple is missing, partial, or malformed.
Do not fall back to an ambient `WMUX_*` tuple inside a daemon worker, because a worker can host or adopt a session whose client pane differs from the worker's launch environment.

## Resolution

The generated Prime extension now captures one complete, validated `HERDR_*` tuple at module evaluation while Prime Agent 0.8 has the session client environment scoped over the extension load.
Daemon sessions no longer inspect worker descriptors or migration sidecars and never fall back to ambient `WMUX_*` values.
Missing, partial, or malformed daemon identities remain unbound and clear stale pane variables from supported persistent IPython Python and shell cells.

Standalone non-daemon Prime processes accept a complete `HERDR_*` tuple.
They fall back to one complete `WMUX_*` tuple only when no `HERDR_*` field is present.
Any partial or malformed higher-priority tuple fails closed.

Persistent IPython repair covers plain Python, `%%bash`, `%%sh`, and standard Python-body cell magics (`%%capture`, `%%prun`, `%%time`, and `%%timeit`).
It preserves module docstrings and legal `__future__` import placement.

Focused coverage evaluates separate extension instances in one process with different pane tuples.
It verifies independent naming and running/completed routing, missing, partial, and malformed identities, standalone fallback rules, stale Python and shell environment repair, Python cell magics, normal completion, provider retry, explicit abort, and session-shutdown interruption.

## Final verification

Completed on 2026-08-25:

```bash
node --import tsx --test --test-concurrency=1 test/hooks-installer.test.ts
npm run check
scripts/wmux-hooks install prime-agent
scripts/wmux-hooks status
```

Evidence:

- focused hook suite: 9 passed, 0 failed;
- full check: 987 tests, 983 passed, 4 platform skips, 0 failed, followed by successful client/server TypeScript checks, script and generated-contract checks, and production client/server builds;
- the managed extension installed successfully and reported `primeAgent: installed`;
- two fresh auto-owned local dogfood workspaces each received a complete scoped `HERDR_*` tuple under Prime Agent 0.8.0;
- both sessions auto-named only their own wmux workspace and tab, recorded distinct `running` and `completed` lifecycle events, and finished normally;
- each persistent IPython kernel asserted equality of its captured `WMUX_PANE_ID` and `HERDR_PANE_ID` without printing either value, emitted only its own marker, and did not cross-route to the other session;
- only the disposable workspaces created for this verification were closed.

## Separate findings

The local Prime Agent deployment contains additional patches beyond the `v0.8.0` tag, including clipboard relay and idle-kernel retention repairs.
Those changes do not fix this lifecycle identity regression, which belongs in the wmux hook integration.
