import assert from "node:assert/strict";
import test from "node:test";
import { api, modalSettingsUpdate, WorkspaceReorderConflictError } from "../src/client/src/api.ts";
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

test("workspace tree mutations carry revisions, optional outdent targets, and collapse settings", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ state: {}, settings: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await api.reorderWorkspace("child", undefined, "out-of", 7);
    await api.reorderWorkspace("child", "root", "into", 8);
    await api.updateCollapsedWorkspaceIds(["root"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests, [
    { path: "/api/workspaces/reorder", body: { workspaceId: "child", position: "out-of", workspaceTreeRevision: 7 } },
    { path: "/api/workspaces/reorder", body: { workspaceId: "child", targetWorkspaceId: "root", position: "into", workspaceTreeRevision: 8 } },
    { path: "/api/settings", body: { collapsedWorkspaceIds: ["root"] } },
  ]);
});

test("ordinary settings updates never transmit synchronized collapse state", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    return new Response(JSON.stringify({ settings: {}, state: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const settings = {
    terminalFontSize: 18,
    terminalScrollbackRows: 20_000,
    colorScheme: "wmux" as const,
    inactiveTabStreaming: "suspend" as const,
    tuiFrameRate: 30 as const,
    terminalScrollMode: "immediate" as const,
    machineAliases: { local: "Local" },
    collapsedWorkspaceIds: ["newer-collapse"],
  };
  try {
    // A wider object remains harmless at runtime; the API serializes only modal-owned fields.
    await api.updateSettings(settings);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(body, modalSettingsUpdate(settings));
  assert.equal(Object.hasOwn(body ?? {}, "collapsedWorkspaceIds"), false);
});

test("workspace reorder conflicts expose the server's latest state without replay", async () => {
  const originalFetch = globalThis.fetch;
  const latestState = { workspaceTreeRevision: 9 };
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "workspace_conflict", state: latestState }), {
    status: 409,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    await assert.rejects(
      api.reorderWorkspace("child", "root", "into", 8),
      (error: unknown) => error instanceof WorkspaceReorderConflictError && error.state.workspaceTreeRevision === 9,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
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
