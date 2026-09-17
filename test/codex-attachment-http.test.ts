import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/server/http.js";
import { CodexCatalogError } from "../src/server/codex-task-catalog.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { SessionManager } from "../src/server/session-manager.js";

const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const threadId = "01a0accb-8c1b-7230-abe4-d42ea8e64a1b";
const generation = "a".repeat(64), identity = "b".repeat(64);

test("existing-task HTTP launch is user-only, strict, and passes only an eligible exact request", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attachment-http-"));
  const machines = [{ id: "local", name: "Local", kind: "local", source: "static" }] as any[];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  let attestations = 0, launches = 0, identityCurrent = identity, generationCurrent = generation, enabled = true;
  const fake = {
    catalog: {
      identity: () => identityCurrent,
      attachmentConfig: () => ({ machineId: "local" }),
      attestAttachment: async () => ({ public: { enabled, reason: enabled ? null : "attachment_queue_not_empty", generation: generationCurrent }, private: enabled ? { cwd: "/work" } : null }),
    },
    requireAttachment: async (request: any) => {
      if (!enabled) throw new CodexCatalogError("attachment_queue_not_empty", 409);
      if (request.generation !== generationCurrent) throw new CodexCatalogError("attachment_generation_changed", 409);
      attestations++; return { public: { enabled: true, reason: null, generation: generationCurrent }, private: { cwd: "/work", request } };
    },
    launches: { launch: async (request: any) => { launches++; return { ...request, status: "opened", target: { workspaceId: "ws", tabId: "tab", paneId: "pane" } }; } },
    associations: { list: () => [], observe: () => {} },
    close: () => {},
  };
  const server = await createHttpServer("127.0.0.1", state, machines, {} as SessionManager, new SettingsStore(path.join(directory, "settings.json")), {
    auth: { enabled: true, token: "L".repeat(43), automationToken: "A".repeat(43), helperToken: "H".repeat(43), loginEnabled: false, sessionSecret: "test" },
    codexTasks: fake as any, healthResolvers: { machines: async () => [], streams: async () => [] },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/codex-task-launches`;
  const body = { requestId: "123e4567-e89b-12d3-a456-426614174000", operation: "attach", endpointId: "native", endpointIdentity: identity, threadId, generation };
  try {
    for (const token of ["A".repeat(43), "H".repeat(43)]) assert.equal((await fetch(url, { method: "POST", headers: headers(token), body: JSON.stringify(body) })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: headers("L".repeat(43)), body: JSON.stringify({ ...body, cwd: "/must-not-pass" }) })).status, 400);
    identityCurrent = "c".repeat(64);
    assert.equal((await fetch(url, { method: "POST", headers: headers("L".repeat(43)), body: JSON.stringify(body) })).status, 409);
    assert.equal(attestations, 0);
    identityCurrent = identity;
    generationCurrent = "d".repeat(64);
    assert.equal((await fetch(url, { method: "POST", headers: headers("L".repeat(43)), body: JSON.stringify(body) })).status, 409);
    assert.equal(attestations, 0);
    generationCurrent = generation;
    enabled = false;
    assert.equal((await fetch(url, { method: "POST", headers: headers("L".repeat(43)), body: JSON.stringify(body) })).status, 409);
    assert.equal(launches, 0, "queue/saved ineligible tasks never invoke a launcher");
    enabled = true;
    const response = await fetch(url, { method: "POST", headers: headers("L".repeat(43)), body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal(attestations, 1); assert.equal(launches, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});
