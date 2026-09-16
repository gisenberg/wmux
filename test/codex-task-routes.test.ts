import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/server/http.js";
import { CodexTaskCatalog } from "../src/server/codex-task-catalog.js";
import { CodexTasksService } from "../src/server/codex-tasks.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { SessionManager } from "../src/server/session-manager.js";

const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const task = (id: string) => ({ id, name: "same title", preview: "private", cwd: "/repo", modelProvider: "openai", source: "cli", parentThreadId: null, status: { type: "idle" }, updatedAt: 1 });

test("Codex task HTTP routes are user-only, strict, metadata-only, and preserve exact association identity", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-task-routes-"));
  fs.chmodSync(directory, 0o700);
  const machines = [{ id: "local", name: "Local", kind: "local", source: "static" }] as any[];
  let stale = false, mismatch = false, opens = 0, uncertain = false;
  const query = (async (input: any) => {
    if (input.operation === "list") return { data: [task("thr_one"), task("thr_two")] };
    if (input.operation === "read") {
      if (stale) throw new Error("native unavailable");
      return { thread: task(mismatch ? "thr_other" : input.threadId!) };
    }
    return { data: [] };
  }) as any;
  const catalog = new CodexTaskCatalog(() => machines, [{ id: "native", label: "Native", machineId: "local", transport: "local", socketPath: "/tmp/never-used.sock", allowFreshLaunch: true }], query);
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const workspace = state.createWorkspace("local");
  const savedWorkspace = state.snapshot().workspaces.find(candidate => candidate.id === workspace.id)!;
  const pane = state.findPaneContext(savedWorkspace.tabs[0]!.panes[0]!.id)!;
  const tasks = new CodexTasksService(state, () => machines, { catalog, open: async () => { opens++; if (uncertain) throw new Error("submission uncertain"); return { workspaceId: workspace.id, tabId: pane.tab.id, paneId: pane.pane.id }; } });
  const legacy = "L".repeat(43), automation = "A".repeat(43), helper = "H".repeat(43);
  const server = await createHttpServer("127.0.0.1", state, machines, {} as SessionManager, new SettingsStore(path.join(directory, "settings.json")), {
    auth: { enabled: true, token: legacy, automationToken: automation, helperToken: helper, loginEnabled: false, sessionSecret: "test" },
    codexTasks: tasks, healthResolvers: { machines: async () => [], streams: async () => [] },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const endpoints = await fetch(`${base}/api/codex-tasks/endpoints`, { headers: headers(legacy) });
    assert.equal(endpoints.status, 200);
    const endpointBody = await endpoints.json() as any;
    assert.equal(endpointBody.endpoints[0].id, "native");
    assert.equal(JSON.stringify(endpointBody).includes("never-used.sock"), false);
    assert.equal((await fetch(`${base}/api/codex-tasks/endpoints`, { headers: headers(automation) })).status, 403);
    assert.equal((await fetch(`${base}/api/codex-tasks/endpoints`, { headers: headers(helper) })).status, 403);
    assert.equal((await fetch(`${base}/api/codex-tasks/list`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ endpointId: "native", extra: true }) })).status, 400);
    const listing = await fetch(`${base}/api/codex-tasks/list`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ endpointId: "native" }) });
    const page = await listing.json() as any;
    assert.deepEqual(page.tasks.map((row: any) => row.threadId), ["thr_one", "thr_two"]);
    const identity = page.endpoint.identity;
    const target = { workspaceId: workspace.id, tabId: pane.tab.id, paneId: pane.pane.id };
    for (const [url, title] of [[`/api/workspaces/${workspace.id}/title`, "Pinned workspace"], [`/api/workspaces/${workspace.id}/tabs/${pane.tab.id}/title`, "Pinned tab"]]) {
      const response = await fetch(`${base}${url}`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ title }) });
      assert.equal(response.status, 200);
    }
    const associate = await fetch(`${base}/api/codex-task-associations`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ endpointId: "native", endpointIdentity: identity, threadId: "thr_one", target }) });
    assert.equal(associate.status, 200);
    const association = (await associate.json() as any).association;
    const pinned = state.findPaneContext(pane.pane.id)!;
    assert.equal(pinned.workspace.name, "Pinned workspace");
    assert.equal(pinned.workspace.nameSource, "user");
    assert.equal(pinned.tab.title, "Pinned tab");
    assert.equal(pinned.tab.titleSource, "user");
    const destination = state.createWorkspace("local");
    const destinationTab = destination.tabs[0]!;
    const movedTarget = { workspaceId: destination.id, tabId: destinationTab.id, paneId: destinationTab.panes[0]!.id };
    const moved = await fetch(`${base}/api/codex-task-associations`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ id: association.id, endpointId: "native", endpointIdentity: identity, threadId: "thr_one", target: movedTarget }) });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json() as any).association.id, association.id);
    state.removeWorkspace(destination.id);
    const unresolved = await fetch(`${base}/api/codex-task-associations`, { headers: headers(legacy) });
    assert.equal((await unresolved.json() as any).associations[0].resolved, false);
    assert.equal((await fetch(`${base}/api/codex-task-associations`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ endpointId: "native", endpointIdentity: identity, threadId: "thr_one", target: movedTarget }) })).status, 404);
    assert.equal((await fetch(`${base}/api/codex-task-associations/${association.id}`, { method: "DELETE", headers: headers(legacy) })).status, 200);
    const requestId = "123e4567-e89b-12d3-a456-426614174000";
    const replaced = await fetch(`${base}/api/codex-task-launches`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ requestId, endpointId: "native", endpointIdentity: "0".repeat(64), cwd: "/repo" }) });
    assert.equal(replaced.status, 409);
    assert.equal(opens, 0);
    assert.equal((await fetch(`${base}/api/codex-task-launches/not-a-uuid`, { headers: headers(legacy) })).status, 400);
    const launch = () => fetch(`${base}/api/codex-task-launches`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ requestId, endpointId: "native", endpointIdentity: identity, cwd: "/repo" }) });
    assert.equal((await launch()).status, 200); assert.equal((await launch()).status, 200); assert.equal(opens, 1);
    const changedLaunch = await fetch(`${base}/api/codex-task-launches`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ requestId, endpointId: "native", endpointIdentity: identity, cwd: "/other" }) });
    assert.equal(changedLaunch.status, 409);
    uncertain = true;
    const unknownId = "123e4567-e89b-42d3-a456-426614174001";
    const unknownResponse = await fetch(`${base}/api/codex-task-launches`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ requestId: unknownId, endpointId: "native", endpointIdentity: identity, cwd: "/repo" }) });
    assert.equal((await unknownResponse.json() as any).launch.status, "unknown");
    const unknownRead = await fetch(`${base}/api/codex-task-launches/${unknownId}`, { headers: headers(legacy) });
    assert.equal((await unknownRead.json() as any).launch.status, "unknown");
    assert.equal(opens, 2, "GET reconciliation never opens another view");
    mismatch = true;
    assert.equal((await fetch(`${base}/api/codex-task-associations`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ endpointId: "native", endpointIdentity: identity, threadId: "thr_one", target }) })).status, 503);
    mismatch = false; stale = true;
    assert.equal((await fetch(`${base}/api/codex-task-associations`, { method: "POST", headers: headers(legacy), body: JSON.stringify({ endpointId: "native", endpointIdentity: identity, threadId: "thr_two", target }) })).status, 409);
    stale = false;
    assert.equal((await fetch(`${base}/api/codex-task-launches/${requestId}`, { headers: headers(legacy) })).status, 200);
  } finally {
    server.close(); await once(server, "close"); tasks.close(); state.flush(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
