import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../src/client/src/api.ts";
import { setToken } from "../src/client/src/token.ts";

test("create requests carry browser-local source pane context", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      path: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await api.createWorkspace("local", "pane_source");
    await api.createTab("ws_target", "local", "pane_source");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { path: "/api/workspaces", body: { machineId: "local", sourcePaneId: "pane_source" } },
    {
      path: "/api/workspaces/ws_target/tabs",
      body: { machineId: "local", sourcePaneId: "pane_source" },
    },
  ]);
});

test("create requests carry stable client-generated ids", async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const workspaceIds = { workspaceId: `ws_${"a".repeat(32)}`, tabId: `tab_${"b".repeat(32)}`, paneId: `pane_${"c".repeat(32)}` };
  const tabIds = { tabId: `tab_${"d".repeat(32)}`, paneId: `pane_${"e".repeat(32)}` };
  const splitIds = { paneId: `pane_${"f".repeat(32)}` };

  try {
    await api.createWorkspace("local", "pane_source", workspaceIds);
    await api.createTab("ws_target", "local", "pane_source", tabIds);
    await api.splitPane("tab_target", "pane_source", "vertical", "local", splitIds);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { machineId: "local", sourcePaneId: "pane_source", clientIds: workspaceIds },
    { machineId: "local", sourcePaneId: "pane_source", clientIds: tabIds },
    { paneId: "pane_source", direction: "vertical", machineId: "local", clientIds: splitIds },
  ]);
});

test("pane image staging sends authenticated raw bytes without a client path", async () => {
  const originalFetch = globalThis.fetch;
  const image = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  setToken("browser-token");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: String(input), init });
    return new Response(JSON.stringify({
      stageId: `paste-${"a".repeat(36)}`,
      targetPath: "/tmp/wmux/image.png",
      mimeType: "image/png",
      bytes: 4,
      expiresAt: new Date().toISOString(),
    }), { status: init?.method === "DELETE" ? 200 : 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const staged = await api.stagePanePasteImage("pane / one", image);
    await api.discardPanePasteImage("pane / one", staged.stageId);
  } finally {
    globalThis.fetch = originalFetch;
    setToken("");
  }

  assert.equal(requests[0].path, "/api/panes/pane%20%2F%20one/paste-images");
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(requests[0].init?.body, image);
  assert.deepEqual(requests[0].init?.headers, {
    "content-type": "application/octet-stream",
    authorization: "Bearer browser-token",
  });
  assert.equal(requests[1].path, `/api/panes/pane%20%2F%20one/paste-images/paste-${"a".repeat(36)}`);
  assert.equal(requests[1].init?.method, "DELETE");
});
