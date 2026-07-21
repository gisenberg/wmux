import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/server/http.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig, MachineSource } from "../src/server/types.js";

const withServer = async (
  initialMachines: MachineConfig[],
  run: (baseUrl: string) => Promise<void>,
  machineSource: MachineSource = initialMachines,
): Promise<void> => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-http-target-"));
  const state = new StateStore(initialMachines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const server = await createHttpServer(
    "127.0.0.1",
    state,
    machineSource,
    {} as SessionManager,
    settings,
    { auth: { enabled: false, token: "", loginEnabled: false, sessionSecret: "test" } },
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const postWorkspace = (baseUrl: string, body: object = {}): Promise<Response> =>
  fetch(`${baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("workspace creation defaults to the first configured remote machine", async () => {
  const machines: MachineConfig[] = [
    { id: "remote", name: "Remote", kind: "ssh", host: "remote.ts.net", user: "user" },
  ];
  await withServer(machines, async (baseUrl) => {
    const response = await postWorkspace(baseUrl);
    const payload = (await response.json()) as { workspace: { machineId: string } };

    assert.equal(response.status, 201);
    assert.equal(payload.workspace.machineId, "remote");
  });
});

test("workspace creation rejects an explicit unknown machine", async () => {
  const machines: MachineConfig[] = [
    { id: "remote", name: "Remote", kind: "ssh", host: "remote.ts.net", user: "user" },
  ];
  await withServer(machines, async (baseUrl) => {
    const response = await postWorkspace(baseUrl, { machineId: "missing" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "unknown_machine" });
  });
});

test("workspace creation accepts idempotent validated client ids", async () => {
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  await withServer(machines, async (baseUrl) => {
    const clientIds = {
      workspaceId: `ws_${"a".repeat(32)}`,
      tabId: `tab_${"b".repeat(32)}`,
      paneId: `pane_${"c".repeat(32)}`,
    };
    const first = await postWorkspace(baseUrl, { machineId: "local", clientIds });
    const firstPayload = await first.json() as { workspace: { id: string }; state: { revision: number } };
    const second = await postWorkspace(baseUrl, { machineId: "local", clientIds });
    const secondPayload = await second.json() as { workspace: { id: string }; state: { revision: number } };

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(firstPayload.workspace.id, clientIds.workspaceId);
    assert.equal(secondPayload.workspace.id, clientIds.workspaceId);
    assert.equal(secondPayload.state.revision, firstPayload.state.revision);
  });
});

test("workspace creation rejects malformed or conflicting client ids", async () => {
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  await withServer(machines, async (baseUrl) => {
    const malformed = await postWorkspace(baseUrl, {
      machineId: "local",
      clientIds: { workspaceId: "ws_short", tabId: "tab_short", paneId: "pane_short" },
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_client_ids" });

    const clientIds = {
      workspaceId: `ws_${"a".repeat(32)}`,
      tabId: `tab_${"b".repeat(32)}`,
      paneId: `pane_${"c".repeat(32)}`,
    };
    assert.equal((await postWorkspace(baseUrl, { machineId: "local", clientIds })).status, 201);
    const conflict = await postWorkspace(baseUrl, {
      machineId: "local",
      clientIds: { ...clientIds, tabId: `tab_${"d".repeat(32)}` },
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "client_id_conflict" });
  });
});

test("split creation rejects a pane outside the target tab without mutating state", async () => {
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  await withServer(machines, async (baseUrl) => {
    const first = await postWorkspace(baseUrl, { machineId: "local" });
    const firstPayload = await first.json() as {
      workspace: { activeTabId: string; tabs: Array<{ panes: Array<{ id: string }> }> };
    };
    const second = await postWorkspace(baseUrl, { machineId: "local" });
    const secondPayload = await second.json() as {
      workspace: { tabs: Array<{ panes: Array<{ id: string }> }> };
      state: { revision: number };
    };

    const response = await fetch(`${baseUrl}/api/tabs/${firstPayload.workspace.activeTabId}/split`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paneId: secondPayload.workspace.tabs[0].panes[0].id,
        direction: "vertical",
      }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "pane_not_found" });

    const current = await fetch(`${baseUrl}/api/bootstrap`);
    const currentPayload = await current.json() as { revision: number };
    assert.equal(currentPayload.revision, secondPayload.state.revision);
  });
});

test("workspace creation reports when no machine target exists", async () => {
  await withServer([], async (baseUrl) => {
    const response = await postWorkspace(baseUrl);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "no_machine_available" });
  });
});

test("workspace target validation follows a live dynamic machine source", async () => {
  let liveMachines: MachineConfig[] = [
    {
      id: "dynamic",
      name: "Dynamic",
      kind: "ssh",
      host: "100.70.0.8",
      source: "registered",
      online: false,
    },
  ];
  await withServer([], async (baseUrl) => {
    const offline = await postWorkspace(baseUrl);
    assert.equal(offline.status, 409);
    assert.deepEqual(await offline.json(), { error: "no_machine_available" });

    liveMachines = [{ ...liveMachines[0], online: true }];
    const created = await postWorkspace(baseUrl);
    const payload = (await created.json()) as { workspace: { machineId: string } };
    assert.equal(created.status, 201);
    assert.equal(payload.workspace.machineId, "dynamic");

    liveMachines = [];
    const removed = await postWorkspace(baseUrl, { machineId: "dynamic" });
    assert.equal(removed.status, 400);
    assert.deepEqual(await removed.json(), { error: "unknown_machine" });
  }, () => liveMachines);
});
