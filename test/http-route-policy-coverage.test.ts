import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/server/http.js";
import { apiRoutes } from "../src/server/routes/index.js";
import { matchApiRoute } from "../src/server/routes/route.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";

const documentedRoutes = [
  ["health", "GET", "/api/health"],
  ["auth-info", "GET", "/api/auth-info"],
  ["login", "POST", "/api/login"],
  ["bootstrap", "GET", "/api/bootstrap"],
  ["registry-list", "GET", "/api/registry/hosts"],
  ["registry-register", "POST", "/api/registry/hosts"],
  ["registry-delete", "DELETE", "/api/registry/hosts/linux-box"],
  ["workspace-create", "POST", "/api/workspaces"],
  ["workspace-close", "DELETE", "/api/workspaces/workspace"],
  ["workspace-title", "POST", "/api/workspaces/workspace/title"],
  ["tab-create", "POST", "/api/workspaces/workspace/tabs"],
  ["pane-split", "POST", "/api/tabs/tab/split"],
  ["pane-input", "POST", "/api/panes/pane/input"],
  ["agent-event", "POST", "/api/agent-events"],
  ["run-event", "POST", "/api/run-events"],
  ["stream-request", "POST", "/api/streams/linux-box/request"],
  ["stream-release", "DELETE", "/api/streams/linux-box/request/request"],
] as const;

test("every dispatched HTTP route has one matching authorization policy", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-route-coverage-"));
  const state = new StateStore([], path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const server = await createHttpServer(
    "127.0.0.1",
    state,
    [],
    {} as SessionManager,
    settings,
    {
      auth: {
        enabled: false,
        token: "",
        loginEnabled: false,
        sessionSecret: "route-coverage",
      },
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const ids = apiRoutes.map((route) => route.id);
    assert.equal(new Set(ids).size, ids.length, "route ids must be unique");
    for (const route of apiRoutes) {
      assert.ok(route.policy, `missing policy for route ${route.id}`);
      assert.equal(route.policy.id, route.id);
      assert.equal(route.policy.method, route.method);
    }

    assert.deepEqual(documentedRoutes.map(([id, method, pathname]) =>
      matchApiRoute(apiRoutes, method, pathname)?.route.id
    ), documentedRoutes.map(([id]) => id));
  } finally {
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
