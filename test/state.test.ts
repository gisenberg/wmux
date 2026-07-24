import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentSessionService } from "../src/server/agent-sessions.js";
import { StateIdConflictError, StateStore, WorkspaceDepthError } from "../src/server/state.js";
import { CURRENT_STATE_SCHEMA_VERSION, parsePersistedState } from "../src/server/state-schema.js";
import type { MachineConfig } from "../src/server/types.js";

const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
const agentServices = new WeakMap<StateStore, AgentSessionService>();
const agentsFor = (state: StateStore): AgentSessionService => {
  const existing = agentServices.get(state);
  if (existing) return existing;
  const service = new AgentSessionService(state);
  agentServices.set(state, service);
  return service;
};

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

test("agent workspace children are preorder-first and parent deletion promotes them", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const root = store.snapshot().workspaces[0];
    const child = store.createWorkspace("local", undefined, "agent", root.id);
    const grandchild = store.createWorkspace("local", undefined, "agent", child.id);
    assert.deepEqual(store.snapshot().workspaces.map((workspace) => workspace.id), [root.id, child.id, grandchild.id]);
    const removedPaneIds = store.removeWorkspace(root.id);
    const snapshot = store.snapshot();
    assert.deepEqual(removedPaneIds, root.tabs.flatMap((tab) => tab.panes.map((pane) => pane.id)));
    assert.equal(snapshot.workspaces[0].parentWorkspaceId, undefined);
    assert.equal(snapshot.workspaces[1].parentWorkspaceId, child.id);
  });
});

test("workspace moves move whole subtrees and enforce tree revisions", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const root = store.snapshot().workspaces[0];
    const child = store.createWorkspace("local", undefined, "agent", root.id);
    const sibling = store.createWorkspace("local");
    const revision = store.snapshot().workspaceTreeRevision;
    assert.equal(store.reorderWorkspaceResult(sibling.id, root.id, "after", revision).ok, true);
    assert.deepEqual(store.snapshot().workspaces.map((workspace) => workspace.id), [root.id, child.id, sibling.id]);
    assert.equal(store.reorderWorkspaceResult(root.id, sibling.id, "before", revision).status, "conflict");
    assert.equal(store.reorderWorkspaceResult(root.id, child.id, "into", store.snapshot().workspaceTreeRevision).status, "cycle");
  });
});

test("workspace tree moves preserve subtree semantics and enforce depth", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const root = store.snapshot().workspaces[0];
    const first = store.createWorkspace("local", undefined, "agent", root.id);
    const second = store.createWorkspace("local", undefined, "agent", root.id);
    const nested = store.createWorkspace("local", undefined, "agent", first.id);
    const target = store.createWorkspace("local");
    let revision = store.snapshot().workspaceTreeRevision;
    assert.equal(store.reorderWorkspaceResult(second.id, first.id, "into", revision).ok, true);
    assert.deepEqual(store.snapshot().workspaces.map((workspace) => workspace.id), [target.id, root.id, first.id, second.id, nested.id]);
    revision = store.snapshot().workspaceTreeRevision;
    assert.equal(store.reorderWorkspaceResult(second.id, first.id, "out-of", revision).ok, true);
    assert.deepEqual(store.snapshot().workspaces.map((workspace) => workspace.id), [target.id, root.id, first.id, nested.id, second.id]);
    assert.equal(store.reorderWorkspaceResult(root.id, undefined, "out-of", store.snapshot().workspaceTreeRevision).status, "invalid_outdent");
    const beforeNoop = store.snapshot().workspaceTreeRevision;
    assert.equal(store.reorderWorkspaceResult(second.id, first.id, "after", beforeNoop).changed, false);
    assert.equal(store.snapshot().workspaceTreeRevision, beforeNoop);
    store.setWorkspaceTitle(root.id, "unchanged tree");
    store.updatePane(root.tabs[0].panes[0].id, { cwd: "/tmp" });
    assert.equal(store.snapshot().workspaceTreeRevision, beforeNoop);
  });
});

test("moving a tall subtree beyond depth three is rejected", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const destination = store.snapshot().workspaces[0];
    const destinationChild = store.createWorkspace("local", undefined, "agent", destination.id);
    const source = store.createWorkspace("local");
    const level1 = store.createWorkspace("local", undefined, "agent", source.id);
    const level2 = store.createWorkspace("local", undefined, "agent", level1.id);
    store.createWorkspace("local", undefined, "agent", level2.id);
    assert.equal(store.reorderWorkspaceResult(source.id, destinationChild.id, "into", store.snapshot().workspaceTreeRevision).status, "depth");
  });
});

test("workspace creation rejects a child below depth three without mutating state", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const root = store.snapshot().workspaces[0];
    const level1 = store.createWorkspace("local", undefined, "agent", root.id);
    const level2 = store.createWorkspace("local", undefined, "agent", level1.id);
    const level3 = store.createWorkspace("local", undefined, "agent", level2.id);
    const before = store.snapshot();
    assert.throws(() => store.createWorkspace("local", undefined, "agent", level3.id), WorkspaceDepthError);
    assert.deepEqual(store.snapshot().workspaces, before.workspaces);
    assert.equal(store.snapshot().workspaceTreeRevision, before.workspaceTreeRevision);
    assert.equal(store.snapshot().revision, before.revision);
    assert.equal(store.createWorkspace("local", undefined, "agent", level2.id).parentWorkspaceId, level2.id);
  });
});

test("v2 state migrates roots to v3 without changing order", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const second = store.createWorkspace("local");
    const v2 = store.snapshot() as unknown as Record<string, unknown>;
    v2.schemaVersion = 2;
    delete v2.workspaceTreeRevision;
    const parsed = parsePersistedState(v2);
    assert.equal(parsed.migrated, true);
    assert.equal(parsed.state.workspaceTreeRevision, 0);
    assert.deepEqual(parsed.state.workspaces.map((workspace) => workspace.id), [second.id, store.snapshot().workspaces[1].id]);
    assert.equal(parsed.state.workspaces.every((workspace) => workspace.parentWorkspaceId === undefined), true);
    fs.writeFileSync(filePath, JSON.stringify(v2));
    assert.equal(new StateStore(machines, filePath).snapshot().workspaceTreeRevision, 0);
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
    agentsFor(store).recordAgentEvent({
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
    assert.equal(agentsFor(migrated).delegationForRun("run-version-2")?.result, "Recovered while migrating");
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
    const workspace = store.createWorkspace("local", "/tmp", "user", undefined, workspaceIds);
    const workspaceRevision = store.snapshot().revision;
    assert.equal(store.createWorkspace("local", "/tmp", "user", undefined, workspaceIds).id, workspace.id);
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
      () => store.createWorkspace("local", undefined, "user", undefined, { ...workspaceIds, tabId: `tab_${"1".repeat(32)}` }),
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
    const result = agentsFor(store).recordAgentEvent({
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

test("agent titles update auto-owned workspaces but preserve user-owned titles", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const workspace = store.snapshot().workspaces[0];
    const paneId = workspace.tabs[0].panes[0].id;

    agentsFor(store).recordAgentEvent({ paneId, agent: "opencode", status: "running", title: "OpenCode title" });
    assert.equal(store.snapshot().workspaces[0].name, "OpenCode title");
    assert.equal(store.snapshot().workspaces[0].nameSource, "auto");

    store.setWorkspaceTitle(workspace.id, "Manual wmux title");
    agentsFor(store).recordAgentEvent({ paneId, agent: "opencode", status: "running", title: "Later OpenCode title" });
    assert.equal(store.snapshot().workspaces[0].name, "Manual wmux title");
    assert.equal(store.snapshot().workspaces[0].nameSource, "user");
  });
});

test("delegation results retain more detail than browser activity", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    const message = "result ".repeat(3_000);
    const result = agentsFor(store).recordAgentEvent({
      paneId,
      runId: "run-long-result",
      agent: "codex",
      status: "completed",
      summary: "Long result",
      message,
    });

    assert.equal(result.agentEvent.message?.length, 12_000);
    assert.equal(agentsFor(store).delegationForRun("run-long-result")?.result, message.trim());
  });
});

test("delegation lifecycle records remain queryable by run id after restart", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({
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
    const delegation = agentsFor(reloaded).delegationForRun("run-durable-1");
    assert.equal(delegation?.state, "completed");
    assert.equal(delegation?.result, "Review complete.");
    assert.equal(agentsFor(reloaded).delegationForRun("missing"), undefined);
  });
});

test("delegation records survive workspace removal", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const workspace = store.createWorkspace("local");
    const paneId = workspace.tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({
      paneId,
      runId: "run-closed-workspace",
      agent: "codex",
      status: "completed",
      summary: "Closed workspace result",
      message: "Still queryable",
    });

    assert.ok(store.removeWorkspace(workspace.id).length > 0);
    assert.equal(store.snapshot().agentEvents.some((event) => event.runId === "run-closed-workspace"), false);
    assert.equal(agentsFor(store).delegationForRun("run-closed-workspace")?.result, "Still queryable");
    store.flush();
    assert.equal(
      agentsFor(new StateStore(machines, filePath))
        .delegationForRun("run-closed-workspace")?.result,
      "Still queryable",
    );
  });
});

test("delegation records distinguish observer errors from agent outcomes", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-observer", agent: "codex", status: "completed", summary: "Done", message: "Agent result" });
    agentsFor(store).recordAgentEvent({
      paneId,
      runId: "run-observer",
      agent: "codex",
      status: "observer_error",
      summary: "Controller lost contact",
      message: "Replay unavailable",
    });

    const delegation = agentsFor(store).delegationForRun("run-observer");
    assert.equal(delegation?.state, "completed");
    assert.equal(delegation?.result, "Agent result");
    assert.equal(delegation?.observerError, "Replay unavailable");

    agentsFor(store).recordAgentEvent({ paneId, runId: "run-late-result", agent: "codex", status: "running", summary: "Working" });
    agentsFor(store).recordAgentEvent({
      paneId,
      runId: "run-late-result",
      agent: "codex",
      status: "observer_error",
      summary: "Controller lost contact",
      message: "Status endpoint unavailable",
    });
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-late-result", agent: "codex", status: "completed", summary: "Done", message: "Late result" });
    const lateResult = agentsFor(store).delegationForRun("run-late-result");
    assert.equal(lateResult?.state, "completed");
    assert.equal(lateResult?.result, "Late result");
    assert.equal(lateResult?.observerError, "Status endpoint unavailable");
  });
});

test("detached delegations reconcile delayed success and failure after controller restart", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneIds = [
      store.snapshot().workspaces[0].tabs[0].panes[0].id,
      store.createWorkspace("local").tabs[0].panes[0].id,
    ];
    for (const [index, runId] of ["run-delayed-success", "run-delayed-failure"].entries()) {
      const paneId = paneIds[index];
      agentsFor(store).recordAgentEvent({ paneId, runId, agent: "codex", status: "running", summary: "Working" });
      agentsFor(store).recordAgentEvent({
        paneId,
        runId,
        agent: "codex",
        status: "observer_error",
        summary: "Controller wait expired",
        message: "Watcher detached",
      });
      agentsFor(store).recordAgentEvent({ paneId, runId, agent: "codex", status: "waiting", summary: "Worker may still be running" });
      assert.equal(agentsFor(store).delegationForRun(runId)?.state, "waiting");
    }
    store.flush();

    const recovered = new StateStore(machines, filePath);
    agentsFor(recovered).recordAgentEvent({
      paneId: paneIds[0],
      runId: "run-delayed-success",
      agent: "codex",
      status: "completed",
      summary: "Completed later",
      message: "Late success",
    });
    agentsFor(recovered).recordAgentEvent({
      paneId: paneIds[1],
      runId: "run-delayed-failure",
      agent: "codex",
      status: "failed",
      summary: "Failed later",
      message: "Late worker failure",
    });

    assert.equal(agentsFor(recovered).delegationForRun("run-delayed-success")?.state, "completed");
    assert.equal(agentsFor(recovered).delegationForRun("run-delayed-success")?.result, "Late success");
    assert.equal(agentsFor(recovered).delegationForRun("run-delayed-failure")?.state, "failed");
    assert.equal(agentsFor(recovered).delegationForRun("run-delayed-failure")?.error, "Late worker failure");
    assert.equal(
      recovered.snapshot().notifications.filter((notification) => notification.subtitle === "completed").length,
      1,
    );
    assert.equal(
      recovered.snapshot().notifications.filter((notification) => notification.subtitle === "failed").length,
      1,
    );
  });
});

test("delegation terminal outcomes and notifications are exact-once", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-exact-success", agent: "codex", status: "running", summary: "Working" });
    agentsFor(store).recordAgentEvent({
      paneId,
      runId: "run-exact-success",
      agent: "codex",
      status: "completed",
      summary: "Completed once",
      message: "First result",
    });
    agentsFor(store).recordAgentEvent({
      paneId,
      runId: "run-exact-success",
      agent: "codex",
      status: "completed",
      summary: "Duplicate completion",
      message: "Duplicate result",
    });
    agentsFor(store).recordAgentEvent({
      paneId,
      runId: "run-exact-success",
      agent: "codex",
      status: "failed",
      summary: "Late conflicting failure",
      message: "Late failure",
    });

    const completed = agentsFor(store).delegationForRun("run-exact-success");
    assert.equal(completed?.state, "completed");
    assert.equal(completed?.result, "First result");
    assert.equal(store.snapshot().notifications.filter((note) => note.paneId === paneId).length, 1);
    assert.equal(
      store.snapshot().agentEvents.filter((event) =>
        event.runId === "run-exact-success" && ["completed", "failed"].includes(event.status)).length,
      1,
    );
    assert.equal(store.snapshot().workspaces[0].descriptor, "Completed once");

    agentsFor(store).recordAgentEvent({ paneId, runId: "run-exact-failure", agent: "codex", status: "failed", summary: "Failed once", message: "First failure" });
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-exact-failure", agent: "codex", status: "completed", summary: "Late success", message: "Late result" });
    const failed = agentsFor(store).delegationForRun("run-exact-failure");
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.error, "First failure");
  });
});

test("late active events cannot regress a terminal delegation", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-terminal", agent: "codex", status: "completed", summary: "Done", message: "Final result" });
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-terminal", agent: "codex", status: "running", summary: "Late start hook" });
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-terminal", agent: "codex", status: "updated", summary: "Late notification" });

    const delegation = agentsFor(store).delegationForRun("run-terminal");
    assert.equal(delegation?.state, "completed");
    assert.equal(delegation?.result, "Final result");
  });
});

test("a new run interrupts the previous delegation without interrupting duplicate events for the same run", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-first", agent: "codex", status: "running", summary: "Starting" });
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-first", agent: "codex", status: "running", summary: "Still running" });
    assert.equal(agentsFor(store).delegationForRun("run-first")?.state, "running");

    agentsFor(store).recordAgentEvent({ paneId, runId: "run-second", agent: "codex", status: "running", summary: "New work" });
    assert.equal(agentsFor(store).delegationForRun("run-first")?.state, "interrupted");
    assert.equal(agentsFor(store).delegationForRun("run-second")?.state, "running");
  });
});

test("runless hooks inherit the current delegation through terminal completion", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-durable", agent: "codex", status: "running", summary: "Starting" });
    const hook = agentsFor(store).recordAgentEvent({ paneId, agent: "codex", status: "running", summary: "Prompt submitted" });
    const stop = agentsFor(store).recordAgentEvent({
      paneId,
      agent: "codex",
      status: "completed",
      summary: "Prompt completed",
      message: "Finished work",
    });

    assert.equal(hook.agentEvent.runId, "run-durable");
    assert.equal(stop.agentEvent.runId, "run-durable");
    assert.equal(agentsFor(store).delegationForRun("run-durable")?.state, "completed");
    assert.equal(agentsFor(store).delegationForRun("run-durable")?.result, "Finished work");
    assert.equal(agentsFor(store).interruptAgentForPane(paneId), false);
  });
});

test("expired terminal delegations are pruned while active delegations remain", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-expired", agent: "codex", status: "completed", summary: "Old" });
    agentsFor(store).recordAgentEvent({ paneId, runId: "run-active", agent: "codex", status: "running", summary: "Active" });
    store.flush();

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      delegations: Array<{ runId: string; updatedAt: string }>;
    };
    for (const delegation of persisted.delegations) delegation.updatedAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(filePath, JSON.stringify(persisted));

    const reloaded = new StateStore(machines, filePath);
    assert.equal(agentsFor(reloaded).delegationForRun("run-expired"), undefined);
    assert.equal(agentsFor(reloaded).delegationForRun("run-active")?.state, "running");
  });
});

test("terminal interrupts clear the latest running agent event", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({ paneId, agent: "codex", status: "running", summary: "Working" });

    assert.equal(agentsFor(store).interruptAgentForPane(paneId), true);
    const latest = store.snapshot().agentEvents[0];
    assert.equal(latest.status, "interrupted");
    assert.equal(latest.summary, "codex interrupted");
    assert.equal(agentsFor(store).interruptAgentForPane(paneId), false);
  });
});

test("waiting agent events can be interrupted and resume events reconcile them", () => {
  withTempState((filePath) => {
    const store = new StateStore(machines, filePath);
    const paneId = store.snapshot().workspaces[0].tabs[0].panes[0].id;
    agentsFor(store).recordAgentEvent({ paneId, agent: "opencode", status: "waiting", summary: "Waiting for input" });

    assert.equal(agentsFor(store).interruptAgentForPane(paneId), true);
    assert.equal(store.snapshot().agentEvents[0].status, "interrupted");

    agentsFor(store).recordAgentEvent({ paneId, agent: "opencode", status: "waiting", summary: "Waiting for input" });
    agentsFor(store).recordAgentEvent({ paneId, agent: "opencode", status: "running", summary: "Running" });

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
    agentsFor(store).recordAgentEvent({ paneId, agent: "codex", status: "running", summary: "First turn" });
    agentsFor(store).recordAgentEvent({ paneId, agent: "codex", status: "running", summary: "Second turn" });

    const [current, previous] = store.snapshot().agentEvents;
    assert.equal(current.status, "running");
    assert.equal(current.summary, "Second turn");
    assert.equal(previous.status, "interrupted");
    assert.equal(previous.summary, "codex interrupted");
  });
});
