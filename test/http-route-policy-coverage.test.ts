import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HTTP_ROUTE_POLICIES,
  classifyHttpRoute,
} from "../src/server/auth-policy.js";
import { createHttpServer } from "../src/server/http.js";
import { KNOWN_HTTP_ROUTES } from "../src/server/route-manifest.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";

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
    const matchedPolicyIds = new Set<string>();

    for (const route of KNOWN_HTTP_ROUTES) {
      const policy = classifyHttpRoute(route.method, route.pathname);
      assert.ok(policy, `missing policy for ${route.method} ${route.pathname}`);
      assert.equal(
        HTTP_ROUTE_POLICIES.filter((candidate) =>
          candidate.method === route.method && candidate.pattern.test(route.pathname)
        ).length,
        1,
        `expected one policy for ${route.method} ${route.pathname}`,
      );
      matchedPolicyIds.add(policy.id);
    }

    assert.deepEqual(
      [...matchedPolicyIds].sort(),
      HTTP_ROUTE_POLICIES.map((policy) => policy.id).sort(),
      "every authorization policy must match a dispatched route",
    );
  } finally {
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
