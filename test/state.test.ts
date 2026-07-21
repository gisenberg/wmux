import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StateIdConflictError, StateStore } from "../src/server/state.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/server/state-schema.js";
import type { MachineConfig } from "../src/server/types.js";

const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];

const withTempState = (run: (filePath: string, dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-state-"));
  try {
    run(path.join(dir, "state.json"), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("fresh store creates one workspace and persists atomically", () => {
  withTempState((filePath, dir) => {
    const store = new StateStore(machines, filePath);
    const snapshot = store.snapshot();
    assert.equal(snapshot.workspaces.length, 1);
    assert.ok(snapshot.revision >= 1);
    assert.equal(snapshot.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
    assert.ok(fs.existsSync(filePath));
    // No temp file should be left behind after an atomic write.
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
    JSON.parse(fs.readFileSync(filePath, "utf8")); // valid JSON
  });
});

test("legacy state is migrated and rewritten with an explicit schema version", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const legacy = store.snapshot() as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    fs.writeFileSync(filePath, JSON.stringify(legacy));

    const migrated = new StateStore(machines, filePath);
    assert.equal(migrated.snapshot().schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  });
});

test("legacy terminal pane kinds are removed during migration", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const legacy = store.snapshot() as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    const workspaces = legacy.workspaces as Array<{
      tabs: Array<{ panes: Array<Record<string, unknown>> }>;
    }>;
    workspaces[0].tabs[0].panes[0].kind = "terminal";
    fs.writeFileSync(filePath, JSON.stringify(legacy));

    const migrated = new StateStore(machines, filePath);
    assert.equal(migrated.snapshot().workspaces.length, 1);
    const persisted = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(persisted, /"kind"\s*:\s*"terminal"/);
    assert.equal(JSON.parse(persisted).schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  });
});

test("version 2 state migrates to delegation-aware schema", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({
      paneId,
      runId: "run-version-2",
      agent: "codex",
      status: "completed",
      summary: "Legacy result",
      message: "Recovered while migrating",
    });
    const previous = store.snapshot() as unknown as Record<string, unknown>;
    previous.schemaVersion = 2;
    delete previous.delegations;
    fs.writeFileSync(filePath, JSON.stringify(previous));

    const migrated = new StateStore(machines, filePath);
    assert.equal(migrated.snapshot().schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
    assert.equal(migrated.delegationForRun("run-version-2")?.result, "Recovered while migrating");
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  });
});

test("state recovers from the last validated backup", () => {
  withTempState((filePath, dir) => {
    const store = new StateStore(machines, filePath);
    store.createWorkspace("local");
    store.flush();
    assert.ok(fs.existsSync(`${filePath}.bak`));
    fs.writeFileSync(filePath, "{broken");

    const recovered = new StateStore(machines, filePath);
    assert.ok(recovered.snapshot().workspaces.length >= 1);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("state.json.corrupt-")));
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  });
});

test("newer state schemas refuse downgrade without moving or overwriting the file", () => {
  withTempState((filePath, dir) => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: CURRENT_STATE_SCHEMA_VERSION + 1 }));
    assert.throws(() => new StateStore(machines, filePath), /newer than this wmux build supports/);
    assert.ok(fs.existsSync(filePath));
    assert.equal(fs.readdirSync(dir).some((name) => name.includes(".corrupt-")), false);
  });
});

test("fresh store creates its initial workspace on the first remote machine", () => {
  withTempState((filePath) => {
    const remoteMachines: MachineConfig[] = [
      { id: "remote", name: "Remote", kind: "ssh", host: "remote.ts.net", user: "user" },
    ];
    const snapshot = new StateStore(remoteMachines, filePath).snapshot();

    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.workspaces[0].machineId, "remote");
    assert.equal(snapshot.workspaces[0].tabs[0].panes[0].machineId, "remote");
    assert.equal(snapshot.activeWorkspaceId, snapshot.workspaces[0].id);
  });
});

test("fresh store remains idle when no machines are configured", () => {
  withTempState((filePath) => {
    const snapshot = new StateStore([], filePath).snapshot();

    assert.deepEqual(snapshot.workspaces, []);
    assert.equal(snapshot.activeWorkspaceId, "");
    assert.deepEqual(snapshot.machines, []);
  });
});

test("server-only PowerShell profile preferences are not persisted in state", () => {
  withTempState((filePath) => {
    const snapshot = new StateStore([
      {
        id: "windows",
        name: "Windows",
        kind: "powershell-ssh",
        host: "windows.ts.net",
        loadPowerShellProfile: true,
      },
    ], filePath).snapshot();
    assert.equal(snapshot.machines[0].loadPowerShellProfile, undefined);
    assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /loadPowerShellProfile/);
  });
});

test("fresh store does not pin a retained registered machine", () => {
  withTempState((filePath) => {
    const registeredMachines: MachineConfig[] = [
      {
        id: "stale-remote",
        name: "Stale remote",
        kind: "ssh",
        host: "100.70.0.8",
        source: "registered",
        online: false,
      },
    ];
    const snapshot = new StateStore(registeredMachines, filePath).snapshot();

    assert.equal(snapshot.workspaces.length, 0);
    assert.equal(snapshot.activeWorkspaceId, "");
  });
});

test("mutations round-trip through flush and reload", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const initialRevision = store.snapshot().revision;
    const workspace = store.createWorkspace("local");
    store.setWorkspaceTitle(workspace.id, "Renamed");
    assert.ok(store.snapshot().revision >= initialRevision + 2);
    store.flush();

    const reloaded = new StateStore(machines, filePath);
    const found = reloaded.snapshot().workspaces.find((w) => w.id === workspace.id);
    assert.equal(found?.name, "Renamed");
    assert.equal(reloaded.snapshot().revision, store.snapshot().revision);
  });
});

test("client-generated creation ids are idempotent and collision-safe", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const workspaceIds = {
      workspaceId: `ws_${"a".repeat(32)}`,
      tabId: `tab_${"b".repeat(32)}`,
      paneId: `pane_${"c".repeat(32)}`,
    };
    const workspace = store.createWorkspace("local", "/tmp", "user", workspaceIds);
    const workspaceRevision = store.snapshot().revision;
    assert.equal(store.createWorkspace("local", "/tmp", "user", workspaceIds).id, workspace.id);
    assert.equal(store.snapshot().revision, workspaceRevision);

    const tabIds = { tabId: `tab_${"d".repeat(32)}`, paneId: `pane_${"e".repeat(32)}` };
    const tab = store.createTab(workspace.id, "local", "/tmp", tabIds);
    const tabRevision = store.snapshot().revision;
    assert.equal(store.createTab(workspace.id, "local", "/tmp", tabIds).id, tab.id);
    assert.equal(store.snapshot().revision, tabRevision);

    const splitIds = { paneId: `pane_${"f".repeat(32)}` };
    store.splitPane(tab.id, tabIds.paneId, "vertical", "local", "/tmp", splitIds);
    const splitRevision = store.snapshot().revision;
    const repeated = store.splitPane(tab.id, tabIds.paneId, "vertical", "local", "/tmp", splitIds);
    assert.equal(repeated.panes.filter((pane) => pane.id === splitIds.paneId).length, 1);
    assert.equal(store.snapshot().revision, splitRevision);

    assert.throws(
      () => store.splitPane(tab.id, "pane_missing", "vertical", "local", "/tmp"),
      /pane not found/,
    );
    assert.equal(store.snapshot().revision, splitRevision);

    assert.throws(
      () => store.createWorkspace("local", undefined, "user", { ...workspaceIds, tabId: `tab_${"1".repeat(32)}` }),
      StateIdConflictError,
    );
  });
});

test("workspace reordering persists and ignores no-op moves", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const first = store.snapshot().workspaces[0];
    const second = store.createWorkspace("local");
    const third = store.createWorkspace("local");

    assert.deepEqual(store.snapshot().workspaces.map((workspace) => workspace.id), [third.id, second.id, first.id]);
    assert.equal(store.reorderWorkspace(third.id, first.id, "after"), true);
    assert.deepEqual(store.snapshot().workspaces.map((workspace) => workspace.id), [second.id, first.id, third.id]);

    const revision = store.snapshot().revision;
    assert.equal(store.reorderWorkspace(first.id, second.id, "after"), true);
    assert.equal(store.snapshot().revision, revision);
    assert.equal(store.reorderWorkspace("missing", first.id, "before"), false);
    assert.equal(store.snapshot().revision, revision);

    store.flush();
    assert.deepEqual(
      new StateStore(machines, filePath).snapshot().workspaces.map((workspace) => workspace.id),
      [second.id, first.id, third.id],
    );
  });
});

test("Windows agent generation ports persist across restart", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const pane = store.snapshot().workspaces[0].tabs[0].panes[0];
    store.updatePane(pane.id, { agentPort: 3482 });
    store.flush();

    const reloadedPane = new StateStore(machines, filePath).findPane(pane.id);
    assert.equal(reloadedPane?.agentPort, 3482);
  });
});

test("agent-created workspace origin persists while user workspaces remain unmarked", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const userWorkspace = store.createWorkspace("local");
    const agentWorkspace = store.createWorkspace("local", undefined, "agent");

    assert.equal(userWorkspace.createdBy, undefined);
    assert.equal(agentWorkspace.createdBy, "agent");
    store.flush();

    const reloaded = new StateStore(machines, filePath).snapshot();
    assert.equal(reloaded.workspaces.find((workspace) => workspace.id === userWorkspace.id)?.createdBy, undefined);
    assert.equal(reloaded.workspaces.find((workspace) => workspace.id === agentWorkspace.id)?.createdBy, "agent");
  });
});

test("a corrupt state file is quarantined and startup recovers", () => {
  withTempState((filePath, dir) => {
    fs.writeFileSync(filePath, "{ this is not valid json");
    const store = new StateStore(machines, filePath); // must not throw
    assert.equal(store.snapshot().workspaces.length, 1);
    const quarantined = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantined.length, 1);
  });
});

test("valid JSON with the wrong shape is also quarantined", () => {
  withTempState((filePath, dir) => {
    fs.writeFileSync(filePath, JSON.stringify({ notWorkspaces: true }));
    const store = new StateStore(machines, filePath);
    assert.equal(store.snapshot().workspaces.length, 1);
    assert.ok(fs.readdirSync(dir).some((name) => name.includes(".corrupt-")));
  });
});

test("restored panes marked running are downgraded to idle", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const snapshot = store.snapshot();
    snapshot.workspaces[0].tabs[0].panes[0].status = "running";
    fs.writeFileSync(filePath, JSON.stringify(snapshot));

    const reloaded = new StateStore(machines, filePath);
    assert.equal(reloaded.snapshot().workspaces[0].tabs[0].panes[0].status, "idle");
  });
});

test("flush persists debounced writes synchronously", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const workspace = store.createWorkspace("local");
    store.flush();
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.ok(onDisk.workspaces.some((w: { id: string }) => w.id === workspace.id));
  });
});

test("machine catalog updates advance revision only when content changes", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const initialRevision = store.snapshot().revision;
    assert.equal(store.updateMachines(machines), false);
    assert.equal(store.snapshot().revision, initialRevision);

    const nextMachines: MachineConfig[] = [
      ...machines,
      {
        id: "dynamic",
        name: "Dynamic",
        kind: "ssh",
        host: "100.70.0.8",
        source: "registered",
        online: true,
        registeredAt: "2026-07-08T00:00:00.000Z",
        lastSeenAt: "2026-07-08T00:00:00.000Z",
        expiresAt: "2026-07-08T00:01:00.000Z",
        agentToken: "server-only-agent-token",
      },
    ];
    assert.equal(store.updateMachines(nextMachines), true);
    assert.equal(store.snapshot().revision, initialRevision + 1);
    assert.equal(store.snapshot().machines.find((machine) => machine.id === "dynamic")?.agentToken, undefined);
    assert.equal(store.updateMachines(nextMachines.map((machine) =>
      machine.id === "dynamic"
        ? {
            ...machine,
            online: false,
            lastSeenAt: "2026-07-08T00:00:30.000Z",
            expiresAt: "2026-07-08T00:02:00.000Z",
          }
        : machine,
    )), false);
    assert.equal(store.snapshot().revision, initialRevision + 1);
    store.flush();
    assert.doesNotMatch(
      fs.readFileSync(filePath, "utf8"),
      /server-only-agent-token|"source"\s*:|"online"\s*:|registeredAt|lastSeenAt|expiresAt/,
    );
  });
});

test("agent messages are sanitized and persist across restart", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    const result = store.recordAgentEvent({
      paneId,
      agent: "codex",
      status: "completed",
      summary: "Finished the mobile response",
      message: "First line.  \r\n\r\nSecond line.\x00",
    });

    assert.equal(result.agentEvent.message, "First line.\n\nSecond line.");
    store.flush();

    const reloaded = new StateStore(machines, filePath);
    assert.equal(reloaded.snapshot().agentEvents[0].message, "First line.\n\nSecond line.");
  });
});

test("delegation results retain more detail than browser activity", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    const message = "result ".repeat(3_000);
    const result = store.recordAgentEvent({
      paneId,
      runId: "run-long-result",
      agent: "codex",
      status: "completed",
      summary: "Long result",
      message,
    });

    assert.equal(result.agentEvent.message?.length, 12_000);
    assert.equal(store.delegationForRun("run-long-result")?.result, message.trim());
  });
});

test("delegation lifecycle records remain queryable by run id after restart", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({
      paneId,
      runId: "run-durable-1",
      agent: "codex",
      status: "completed",
      title: "Durable review",
      summary: "Codex delegation completed",
      message: "Review complete.",
    });
    store.flush();

    const reloaded = new StateStore(machines, filePath);
    const delegation = reloaded.delegationForRun("run-durable-1");
    assert.equal(delegation?.state, "completed");
    assert.equal(delegation?.result, "Review complete.");
    assert.equal(reloaded.delegationForRun("missing"), undefined);
  });
});

test("delegation records survive workspace removal", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const workspace = store.createWorkspace("local");
    const paneId = workspace.tabs[0].panes[0].id;
    store.recordAgentEvent({
      paneId,
      runId: "run-closed-workspace",
      agent: "codex",
      status: "completed",
      summary: "Closed workspace result",
      message: "Still queryable",
    });

    assert.ok(store.removeWorkspace(workspace.id).length > 0);
    assert.equal(store.snapshot().agentEvents.some((event) => event.runId === "run-closed-workspace"), false);
    assert.equal(store.delegationForRun("run-closed-workspace")?.result, "Still queryable");
    store.flush();
    assert.equal(new StateStore(machines, filePath).delegationForRun("run-closed-workspace")?.result, "Still queryable");
  });
});

test("delegation records distinguish observer errors from agent outcomes", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({ paneId, runId: "run-observer", agent: "codex", status: "completed", summary: "Done", message: "Agent result" });
    store.recordAgentEvent({
      paneId,
      runId: "run-observer",
      agent: "codex",
      status: "observer_error",
      summary: "Controller lost contact",
      message: "Replay unavailable",
    });

    const delegation = store.delegationForRun("run-observer");
    assert.equal(delegation?.state, "completed");
    assert.equal(delegation?.result, "Agent result");
    assert.equal(delegation?.observerError, "Replay unavailable");

    store.recordAgentEvent({ paneId, runId: "run-late-result", agent: "codex", status: "running", summary: "Working" });
    store.recordAgentEvent({
      paneId,
      runId: "run-late-result",
      agent: "codex",
      status: "observer_error",
      summary: "Controller lost contact",
      message: "Status endpoint unavailable",
    });
    store.recordAgentEvent({ paneId, runId: "run-late-result", agent: "codex", status: "completed", summary: "Done", message: "Late result" });
    const lateResult = store.delegationForRun("run-late-result");
    assert.equal(lateResult?.state, "completed");
    assert.equal(lateResult?.result, "Late result");
    assert.equal(lateResult?.observerError, "Status endpoint unavailable");
  });
});

test("late active events cannot regress a terminal delegation", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({ paneId, runId: "run-terminal", agent: "codex", status: "completed", summary: "Done", message: "Final result" });
    store.recordAgentEvent({ paneId, runId: "run-terminal", agent: "codex", status: "running", summary: "Late start hook" });
    store.recordAgentEvent({ paneId, runId: "run-terminal", agent: "codex", status: "updated", summary: "Late notification" });

    const delegation = store.delegationForRun("run-terminal");
    assert.equal(delegation?.state, "completed");
    assert.equal(delegation?.result, "Final result");
  });
});

test("a new run interrupts the previous delegation without interrupting duplicate events for the same run", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({ paneId, runId: "run-first", agent: "codex", status: "running", summary: "Starting" });
    store.recordAgentEvent({ paneId, runId: "run-first", agent: "codex", status: "running", summary: "Still running" });
    assert.equal(store.delegationForRun("run-first")?.state, "running");

    store.recordAgentEvent({ paneId, runId: "run-second", agent: "codex", status: "running", summary: "New work" });
    assert.equal(store.delegationForRun("run-first")?.state, "interrupted");
    assert.equal(store.delegationForRun("run-second")?.state, "running");
  });
});

test("runless active hooks inherit the current delegation without interrupting it", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({ paneId, runId: "run-durable", agent: "codex", status: "running", summary: "Starting" });
    const hook = store.recordAgentEvent({ paneId, agent: "codex", status: "running", summary: "Prompt submitted" });

    assert.equal(hook.agentEvent.runId, "run-durable");
    assert.equal(store.delegationForRun("run-durable")?.state, "running");
    assert.equal(store.interruptAgentForPane(paneId), true);
    assert.equal(store.delegationForRun("run-durable")?.state, "interrupted");
  });
});

test("expired terminal delegations are pruned while active delegations remain", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({ paneId, runId: "run-expired", agent: "codex", status: "completed", summary: "Old" });
    store.recordAgentEvent({ paneId, runId: "run-active", agent: "codex", status: "running", summary: "Active" });
    store.flush();

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      delegations: Array<{ runId: string; updatedAt: string }>;
    };
    for (const delegation of persisted.delegations) delegation.updatedAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(filePath, JSON.stringify(persisted));

    const reloaded = new StateStore(machines, filePath);
    assert.equal(reloaded.delegationForRun("run-expired"), undefined);
    assert.equal(reloaded.delegationForRun("run-active")?.state, "running");
  });
});

test("terminal interrupts clear the latest running agent event", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({ paneId, agent: "codex", status: "running", summary: "Working" });

    assert.equal(store.interruptAgentForPane(paneId), true);
    const latest = store.snapshot().agentEvents[0];
    assert.equal(latest.status, "interrupted");
    assert.equal(latest.summary, "codex interrupted");
    assert.equal(store.interruptAgentForPane(paneId), false);
  });
});

test("waiting agent events can be interrupted and resume events reconcile them", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({ paneId, agent: "opencode", status: "waiting", summary: "Waiting for input" });

    assert.equal(store.interruptAgentForPane(paneId), true);
    assert.equal(store.snapshot().agentEvents[0].status, "interrupted");

    store.recordAgentEvent({ paneId, agent: "opencode", status: "waiting", summary: "Waiting for input" });
    store.recordAgentEvent({ paneId, agent: "opencode", status: "running", summary: "Running" });

    const [current, previous] = store.snapshot().agentEvents;
    assert.equal(current.status, "running");
    assert.equal(previous.status, "interrupted");
    assert.equal(previous.summary, "opencode interrupted");
  });
});

test("a new running event reconciles a prior turn without a stop hook", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    store.recordAgentEvent({ paneId, agent: "codex", status: "running", summary: "First turn" });
    store.recordAgentEvent({ paneId, agent: "codex", status: "running", summary: "Second turn" });

    const [current, previous] = store.snapshot().agentEvents;
    assert.equal(current.status, "running");
    assert.equal(current.summary, "Second turn");
    assert.equal(previous.status, "interrupted");
    assert.equal(previous.summary, "codex interrupted");
  });
});
