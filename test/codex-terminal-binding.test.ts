import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexBindingError,
  CodexMarkerParser,
  CodexTerminalBindingRegistry,
} from "../src/server/codex-terminal-binding.js";
import type { AuthConfig } from "../src/server/auth.js";
import { createHttpServer } from "../src/server/http.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

const makeRegistry = () => {
  const panes = new Map([["pane-a", { workspaceId: "workspace-a", tabId: "tab-a", paneId: "pane-a" }], ["pane-b", { workspaceId: "workspace-b", tabId: "tab-b", paneId: "pane-b" }]]);
  const live = new Set(panes.keys());
  const registry = new CodexTerminalBindingRegistry((paneId) => panes.get(paneId), (paneId) => live.has(paneId));
  return { registry, live };
};

test("Codex marker parser accepts only a contiguous marker across output chunks", () => {
  const parser = new CodexMarkerParser();
  const markers: string[] = [];
  const marker = "[[WMUX:Abcdefghijklmnopqrstu_]]";
  parser.push(marker.slice(0, 11), (value) => markers.push(value));
  parser.push(marker.slice(11), (value) => markers.push(value));
  parser.push("[[WMUX:Abcd text efghijklmnopqrstu_]]", (value) => markers.push(value));
  assert.deepEqual(markers, [marker]);
});

test("Codex bindings remain pending until the exact live pane emits their marker", () => {
  const { registry } = makeRegistry();
  const issued = registry.issue("thread_1");
  assert.throws(() => registry.resolve("thread_1", issued.receipt), (error: unknown) =>
    error instanceof CodexBindingError && error.status === 409 && error.code === "binding_pending");
  registry.observe("pane-a", issued.marker);
  assert.deepEqual(registry.resolve("thread_1", issued.receipt).paneId, "pane-a");
  assert.throws(() => registry.resolve("thread_2", issued.receipt), /binding_not_found/);
});

test("duplicate redraw is idempotent, but a marker observed in another pane fails closed", () => {
  const { registry } = makeRegistry();
  const issued = registry.issue("thread_1");
  registry.observe("pane-a", issued.marker);
  const first = registry.resolve("thread_1", issued.receipt);
  registry.observe("pane-a", issued.marker);
  assert.deepEqual(registry.resolve("thread_1", issued.receipt).expiresAt, first.expiresAt);
  registry.observe("pane-b", issued.marker);
  assert.throws(() => registry.resolve("thread_1", issued.receipt), /binding_not_found/);
});

test("newer challenge observed in one pane supersedes older replay without conflating sessions", () => {
  const { registry } = makeRegistry();
  const older = registry.issue("thread_same");
  const newer = registry.issue("thread_same");
  registry.observe("pane-a", newer.marker);
  registry.observe("pane-a", older.marker);
  assert.throws(() => registry.resolve("thread_same", older.receipt), /binding_not_found/);
  assert.equal(registry.resolve("thread_same", newer.receipt).paneId, "pane-a");
});

test("same Codex session with separate receipts in different panes fails closed", () => {
  const { registry } = makeRegistry();
  const first = registry.issue("thread_same");
  const second = registry.issue("thread_same");
  registry.observe("pane-a", first.marker);
  registry.observe("pane-b", second.marker);
  assert.throws(() => registry.resolve("thread_same", first.receipt), /binding_not_found/);
  assert.throws(() => registry.resolve("thread_same", second.receipt), /binding_not_found/);
});

test("deleted panes cannot resolve a previously observed binding", () => {
  const { registry, live } = makeRegistry();
  const issued = registry.issue("thread_1");
  registry.observe("pane-a", issued.marker);
  live.delete("pane-a");
  assert.throws(() => registry.resolve("thread_1", issued.receipt), (error: unknown) =>
    error instanceof CodexBindingError && error.status === 409 && error.code === "pane_unavailable");
});

test("unresolved challenges expire after one minute", () => {
  const { registry } = makeRegistry();
  const issued = registry.issue("thread_1");
  const realNow = Date.now;
  Date.now = () => realNow() + 60_001;
  try {
    assert.throws(() => registry.resolve("thread_1", issued.receipt), /binding_not_found/);
  } finally {
    Date.now = realNow;
  }
});

test("a resolved binding cannot outlive its 24 hour maximum lease", () => {
  const { registry } = makeRegistry();
  const issued = registry.issue("thread_1");
  registry.observe("pane-a", issued.marker);
  registry.resolve("thread_1", issued.receipt);
  const realNow = Date.now;
  Date.now = () => realNow() + 24 * 60 * 60 * 1000 + 1;
  try {
    assert.throws(() => registry.resolve("thread_1", issued.receipt), /binding_not_found/);
  } finally {
    Date.now = realNow;
  }
});

test("an observed marker remains resolvable after a slow human tool approval", () => {
  const { registry } = makeRegistry();
  const issued = registry.issue("thread_1");
  registry.observe("pane-a", issued.marker);
  const realNow = Date.now;
  Date.now = () => realNow() + 60_001;
  try {
    assert.equal(registry.resolve("thread_1", issued.receipt).paneId, "pane-a");
  } finally {
    Date.now = realNow;
  }
});

test("process invalidation prevents a stale receipt from becoming live again", () => {
  const { registry } = makeRegistry();
  const issued = registry.issue("thread_1");
  registry.observe("pane-a", issued.marker);
  registry.invalidatePane("pane-a");
  registry.observe("pane-a", issued.marker);
  assert.throws(() => registry.resolve("thread_1", issued.receipt), /binding_not_found/);
});

test("registry is bounded and rejects malformed credentials", () => {
  const { registry } = makeRegistry();
  assert.throws(() => registry.issue("not valid space"), /invalid_session_id/);
  for (let index = 0; index < 513; index += 1) registry.issue(`thread_${index}`);
  assert.equal((registry as unknown as { byMarker: Map<string, unknown> }).byMarker.size, 512);
  assert.throws(() => registry.resolve("thread_1", "not-a-receipt"), /invalid_receipt/);
});

test("Codex binding routes accept helper authority, validate bodies, and never echo receipts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-binding-http-"));
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const workspace = state.snapshot().workspaces[0];
  const tab = workspace.tabs[0];
  const pane = tab.panes[0];
  state.updatePane(pane.id, { status: "running" });
  const live = new Set([pane.id]);
  const registry = new CodexTerminalBindingRegistry((paneId) => {
    const context = state.findPaneContext(paneId);
    return context ? { workspaceId: context.workspace.id, tabId: context.tab.id, paneId } : undefined;
  }, (paneId) => live.has(paneId));
  const sessions = {
    codexTerminalBindings: registry,
    setAgentInputCapabilityIssuer: () => undefined,
    setAgentInputSourceRetirer: () => undefined,
  } as unknown as SessionManager;
  const auth: AuthConfig = {
    enabled: true,
    token: "B".repeat(43),
    helperToken: "H".repeat(43),
    automationToken: "A".repeat(43),
    loginEnabled: false,
    sessionSecret: "test-only",
    browserAuthMode: "shared-or-login",
  };
  const server = await createHttpServer("127.0.0.1", state, machines, sessions, settings, {
    auth,
    healthResolvers: { machines: async () => [], streams: async () => [] },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (url: string, token?: string, body: unknown = {}) => fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await request("/api/codex-bindings", undefined, { sessionId: "thread_1" })).status, 401);
    assert.equal((await request("/api/codex-bindings", auth.automationToken, { sessionId: "thread_1" })).status, 403);
    assert.equal((await request("/api/codex-bindings", auth.helperToken, { sessionId: "thread_1", paneId: pane.id })).status, 400);
    const issuedResponse = await request("/api/codex-bindings", auth.helperToken, { sessionId: "thread_1" });
    assert.equal(issuedResponse.status, 201);
    const issued = await issuedResponse.json() as { receipt: string; marker: string };
    registry.observe(pane.id, issued.marker);
    assert.equal((await request("/api/codex-bindings/title", auth.helperToken, {
      sessionId: "thread_1", receipt: issued.receipt, title: "\u0000bad", mode: "auto",
    })).status, 400);
    state.setWorkspaceTitle(workspace.id, "Manual workspace");
    assert.equal((await request("/api/codex-bindings/title", auth.helperToken, {
      sessionId: "thread_1", receipt: issued.receipt, title: "Attempted replacement", mode: "manual",
    })).status, 400);
    assert.equal(state.snapshot().workspaces[0]?.name, "Manual workspace");
    const titled = await request("/api/codex-bindings/title", auth.helperToken, {
      sessionId: "thread_1", receipt: issued.receipt, title: "Automatic title", mode: "auto",
    });
    assert.equal(titled.status, 200);
    const titledText = await titled.text();
    assert.doesNotMatch(titledText, new RegExp(issued.receipt));
    assert.equal(Object.hasOwn(JSON.parse(titledText), "state"), false);
    assert.equal((JSON.parse(titledText) as { workspace: { name: string } }).workspace.name, "Manual workspace");
    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { authorization: `Bearer ${auth.token}` } });
    assert.equal(bootstrap.status, 200);
    assert.doesNotMatch(await bootstrap.text(), new RegExp(issued.receipt));
  } finally {
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
