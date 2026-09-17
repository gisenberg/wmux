import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexTaskCatalog } from "../src/server/codex-task-catalog.js";
import { CodexTasksService } from "../src/server/codex-tasks.js";
import { CodexCliViewUncertainError } from "../src/server/codex-task-launches.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

test("live attachment rechecks route and exact pane; deleting the pane cannot reuse its launch receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attach-service-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const workspace = state.createWorkspace("local");
  const target = { workspaceId: workspace.id, tabId: workspace.tabs[0]!.id, paneId: workspace.tabs[0]!.panes[0]!.id };
  const catalog = new CodexTaskCatalog(() => machines, [{ id: "native", label: "Native", machineId: "local", transport: "local", socketPath: "/private/native.sock", managedLaunch: { launcherPath: "/private/launcher", deploymentPath: "/private/release" } }]);
  const generation = "a".repeat(64), threadId = "123e4567-e89b-12d3-a456-426614174000";
  let attestations = 0, enabled = true, opened = 0, verified = 0;
  let name = "Native task 日本語 👩🏽‍💻";
  catalog.attestAttachment = async () => { attestations++; return {
    public: { enabled, reason: enabled ? null : "attachment_route_untrusted", generation },
    private: enabled ? { fingerprint: "f", endpointId: "native", threadId, generation, cwd: "/work", name, route: { launcherPath: "/private/launcher", deploymentPath: "/private/release", managedArgv: ["/private/launcher", "resume", threadId] }, receipt: {} } : null,
  }; };
  const service = new CodexTasksService(state, () => machines, { catalog,
    openAttached: async () => { opened++; return target; },
    verifyAttached: async () => { verified++; return true; },
  });
  const request = { operation: "attach" as const, requestId: "123e4567-e89b-12d3-a456-426614174001", endpointId: "native", endpointIdentity: catalog.identity("native")!, generation, threadId };
  try {
    assert.equal((await service.launches.launch(request)).status, "opened");
    assert.equal(opened, 1); assert.equal(verified, 1); assert.equal(attestations, 2);
    assert.equal(state.findPaneContext(target.paneId)!.workspace.name, name);
    assert.equal(state.findPaneContext(target.paneId)!.tab.title, name);
    assert.equal(state.findPaneContext(target.paneId)!.workspace.nameSource, "auto");
    assert.equal(state.findPaneContext(target.paneId)!.tab.titleSource, "auto");
    const originalName = name;
    name = "Later native name";
    enabled = false;
    assert.equal((await service.launches.reconcile(service.launches.get(request.requestId)!)).status, "unknown");
    assert.equal(verified, 1, "guard drift refuses even a live process receipt");
    enabled = true;
    assert.equal((await service.launches.reconcile(service.launches.get(request.requestId)!)).status, "opened");
    assert.equal(state.findPaneContext(target.paneId)!.workspace.name, originalName, "inspection does not take over ongoing naming");
    state.removeWorkspace(workspace.id);
    assert.equal(await service.launches.verifiedTarget(request.endpointIdentity, generation, threadId), null);
    assert.equal((await service.launches.reconcile(service.launches.get(request.requestId)!)).status, "unknown");
    assert.equal(opened, 1, "reconciliation never creates a replacement pane");
  } finally { service.close(); state.flush(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("requested attachment names preserve independent pins and unnamed views without claiming verification", async () => {
  for (const scenario of [
    { workspacePin: true, tabPin: false, name: "Native 日本語", verified: true },
    { workspacePin: false, tabPin: true, name: "Native 日本語", verified: true },
    { workspacePin: true, tabPin: true, name: "Native 日本語", verified: true },
    { workspacePin: false, tabPin: false, name: null, verified: true },
    { workspacePin: false, tabPin: false, name: "Native 日本語", verified: false },
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attach-name-"));
    const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
    const state = new StateStore(machines, path.join(directory, "state.json"));
    const workspace = state.createWorkspace("local"), tab = workspace.tabs[0]!;
    const target = { workspaceId: workspace.id, tabId: tab.id, paneId: tab.panes[0]!.id };
    if (scenario.workspacePin) state.setWorkspaceTitle(workspace.id, "Workspace pin");
    if (scenario.tabPin) state.setTabTitle(workspace.id, tab.id, "Tab pin");
    const before = structuredClone(state.findPaneContext(target.paneId)!);
    const catalog = new CodexTaskCatalog(() => machines, [{ id: "native", label: "Native", machineId: "local", transport: "local", socketPath: "/private/native.sock", managedLaunch: { launcherPath: "/private/launcher", deploymentPath: "/private/release" } }]);
    const generation = "a".repeat(64), threadId = "123e4567-e89b-12d3-a456-426614174000";
    catalog.attestAttachment = async () => ({ public: { enabled: true, reason: null, generation },
      private: { fingerprint: "f", endpointId: "native", threadId, generation, cwd: "/work", name: scenario.name,
        route: { launcherPath: "/private/launcher", deploymentPath: "/private/release", managedArgv: [] }, receipt: {} } });
    const service = new CodexTasksService(state, () => machines, { catalog, openAttached: async () => target, verifyAttached: async () => scenario.verified });
    try {
      const launch = await service.launches.launch({ operation: "attach", requestId: "123e4567-e89b-12d3-a456-426614174001", endpointId: "native", endpointIdentity: catalog.identity("native")!, generation, threadId });
      assert.equal(launch.status, scenario.verified ? "opened" : "unknown");
      const after = state.findPaneContext(target.paneId)!;
      assert.equal(after.workspace.name, scenario.name && !scenario.workspacePin ? scenario.name : before.workspace.name);
      assert.equal(after.tab.title, scenario.name && !scenario.tabPin ? scenario.name : before.tab.title);
      state.flush();
      const restored = new StateStore(machines, path.join(directory, "state.json")).findPaneContext(target.paneId)!;
      assert.equal(restored.workspace.name, after.workspace.name);
      assert.equal(restored.tab.title, after.tab.title);
    } finally { service.close(); state.flush(); fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test("uncertain startup and recovered attempts initialize only default titles, including after restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attach-recover-name-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const workspace = state.createWorkspace("local", undefined, "agent"), tab = workspace.tabs[0]!;
  const unrelated = state.createWorkspace("local", undefined, "agent");
  const target = { workspaceId: workspace.id, tabId: tab.id, paneId: tab.panes[0]!.id };
  const catalog = new CodexTaskCatalog(() => machines, [{ id: "native", label: "Native", machineId: "local", transport: "local", socketPath: "/private/native.sock", managedLaunch: { launcherPath: "/private/launcher", deploymentPath: "/private/release" } }]);
  const generation = "a".repeat(64), threadId = "123e4567-e89b-12d3-a456-426614174000";
  let name = "Requested task 日本語 👩🏽‍💻";
  catalog.attestAttachment = async () => ({ public: { enabled: true, reason: null, generation },
    private: { fingerprint: "f", endpointId: "native", threadId, generation, cwd: "/work", name,
      route: { launcherPath: "/private/launcher", deploymentPath: "/private/release", managedArgv: [] }, receipt: {} } });
  let opens = 0;
  const options = { catalog, openAttached: async () => { opens++; throw new CodexCliViewUncertainError(target); }, verifyAttached: async () => false };
  let service = new CodexTasksService(state, () => machines, options);
  const request = { operation: "attach" as const, requestId: "123e4567-e89b-12d3-a456-426614174001", endpointId: "native", endpointIdentity: catalog.identity("native")!, generation, threadId };
  try {
    const result = await service.launches.launch(request);
    assert.equal(result.status, "unknown");
    assert.equal(state.findPaneContext(target.paneId)!.workspace.name, name);
    assert.equal(state.findPaneContext(target.paneId)!.tab.title, name);
    service.close(); state.flush();
    const restored = new StateStore(machines, path.join(directory, "state.json"));
    // Simulate a pre-fix unresolved view whose workspace retained its placeholder.
    restored.setWorkspaceTitle(workspace.id, "Local 1", "default");
    restored.setTabTitle(workspace.id, tab.id, "My tab pin");
    name = "Current native task name";
    service = new CodexTasksService(restored, () => machines, options);
    assert.notEqual(restored.findPaneContext(target.paneId)!.workspace.createdBy, "agent");
    assert.equal(restored.snapshot().workspaces.find(w => w.id === unrelated.id)!.createdBy, "agent");
    restored.flush();
    const persisted = new StateStore(machines, path.join(directory, "state.json"));
    assert.notEqual(persisted.findPaneContext(target.paneId)!.workspace.createdBy, "agent");
    assert.equal((await service.launches.reconcile(service.launches.get(request.requestId)!)).status, "unknown");
    assert.equal(restored.findPaneContext(target.paneId)!.workspace.name, name);
    assert.equal(restored.findPaneContext(target.paneId)!.tab.title, "My tab pin");
    name = "Later name must not take over";
    await service.launches.reconcile(service.launches.get(request.requestId)!);
    assert.equal(restored.findPaneContext(target.paneId)!.workspace.name, "Current native task name");
    assert.equal(opens, 1);
    restored.removeWorkspace(workspace.id);
    const removed = await service.launches.reconcile(service.launches.get(request.requestId)!);
    assert.equal(removed.reason, "attachment_target_removed");
    assert.equal(removed.acknowledgedAt, undefined, "removal does not imply user consent to another CLI");
    restored.flush();
  } finally { service.close(); state.flush(); fs.rmSync(directory, { recursive: true, force: true }); }
});
