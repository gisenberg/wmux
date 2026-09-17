import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexTaskCatalog } from "../src/server/codex-task-catalog.js";
import { CodexTasksService } from "../src/server/codex-tasks.js";
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
  catalog.attestAttachment = async () => { attestations++; return {
    public: { enabled, reason: enabled ? null : "attachment_route_untrusted", generation },
    private: enabled ? { fingerprint: "f", endpointId: "native", threadId, generation, cwd: "/work", route: { launcherPath: "/private/launcher", deploymentPath: "/private/release", managedArgv: ["/private/launcher", "resume", threadId] }, receipt: {} } : null,
  }; };
  const service = new CodexTasksService(state, () => machines, { catalog,
    openAttached: async () => { opened++; return target; },
    verifyAttached: async () => { verified++; return true; },
  });
  const request = { operation: "attach" as const, requestId: "123e4567-e89b-12d3-a456-426614174001", endpointId: "native", endpointIdentity: catalog.identity("native")!, generation, threadId };
  try {
    assert.equal((await service.launches.launch(request)).status, "opened");
    assert.equal(opened, 1); assert.equal(verified, 1); assert.equal(attestations, 2);
    enabled = false;
    assert.equal((await service.launches.reconcile(service.launches.get(request.requestId)!)).status, "unknown");
    assert.equal(verified, 1, "guard drift refuses even a live process receipt");
    enabled = true;
    assert.equal((await service.launches.reconcile(service.launches.get(request.requestId)!)).status, "opened");
    state.removeWorkspace(workspace.id);
    assert.equal(await service.launches.verifiedTarget(request.endpointIdentity, generation, threadId), null);
    assert.equal((await service.launches.reconcile(service.launches.get(request.requestId)!)).status, "unknown");
    assert.equal(opened, 1, "reconciliation never creates a replacement pane");
  } finally { service.close(); state.flush(); fs.rmSync(directory, { recursive: true, force: true }); }
});
