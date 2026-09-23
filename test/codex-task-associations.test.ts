import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CodexTask, CodexTaskTarget } from "../src/shared/codex-tasks.js";
import type { TerminalNotification } from "../src/shared/protocol.js";
import {
  CURRENT_CODEX_TASK_ASSOCIATION_SCHEMA_VERSION,
  CodexTaskAssociations,
  UnsupportedCodexTaskAssociationVersionError,
} from "../src/server/codex-task-associations.js";
import { assertPrivateFile, privateTempDirectory } from "./private-fixture.js";

const target: CodexTaskTarget = { workspaceId: "workspace", tabId: "tab", paneId: "pane" };
const task = (overrides: Partial<CodexTask> = {}): CodexTask => ({
  endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread",
  name: "Same title", preview: "", cwd: null, modelProvider: null, source: "native",
  parentThreadId: null, status: "active", updatedAt: null, sampledAt: new Date().toISOString(), stale: false,
  latestTurn: { id: "turn", status: "inProgress" }, ...overrides,
});

const harness = (filePath?: string) => {
  let endpoint = "fingerprint-a";
  const targets = new Set([JSON.stringify(target)]);
  const notifications: TerminalNotification[] = [];
  const store = new CodexTaskAssociations({
    filePath,
    endpointIdentity: (id) => id === "endpoint" ? endpoint : null,
    resolveTarget: (candidate) => targets.has(JSON.stringify(candidate)),
    notify: (notification) => notifications.push(notification),
  });
  return { store, notifications, targets, setEndpoint: (value: string) => { endpoint = value; } };
};

test("display associations are endpoint-pinned, target-resolved, and preserve identity on moves", () => {
  const h = harness();
  assert.throws(() => h.store.put({ endpointId: "endpoint", endpointIdentity: "wrong", threadId: "thread", target }), /identity/);
  const created = h.store.put({ endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target });
  const moved = h.store.put({ id: created.id, endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target: { ...target, paneId: "other" } });
  assert.equal(moved.id, created.id);
  assert.equal(moved.createdAt, created.createdAt);
  assert.equal(moved.resolved, false);
  assert.equal(moved.reason, "display_target_unavailable");
  h.setEndpoint("replacement");
  assert.deepEqual(h.store.list()[0] && { resolved: h.store.list()[0].resolved, reason: h.store.list()[0].reason }, { resolved: false, reason: "endpoint_unavailable" });
});

test("only a live associated task transition emits one notification across displays", () => {
  const h = harness();
  h.store.put({ endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target });
  h.store.put({ endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target });
  h.store.observe(task()); // baseline
  h.store.observe(task({ latestTurn: { id: "turn", status: "completed" }, status: "idle" }));
  h.store.observe(task({ latestTurn: { id: "turn", status: "completed" }, status: "idle" }));
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.title, "Codex task completed");
  assert.equal(h.notifications[0]?.subtitle, "Native task activity · display association");

  h.store.observe(task({ threadId: "unassociated", latestTurn: { id: "turn", status: "failed" } }));
  assert.equal(h.notifications.length, 1);
});

test("a later turn completed between polls is announced after a historical baseline", () => {
  const h = harness();
  h.store.put({ endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target });
  h.store.observe(task({ latestTurn: { id: "old", status: "completed" } }));
  assert.equal(h.notifications.length, 0);
  h.store.observe(task({ latestTurn: { id: "new", status: "completed" } }));
  h.store.observe(task({ latestTurn: { id: "new", status: "failed" } }));
  assert.equal(h.notifications.length, 1);
});

test("historical terminal tasks establish a baseline and never announce on initial observation", () => {
  const h = harness();
  h.store.put({ endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target });
  h.store.observe(task({ status: "idle", latestTurn: { id: "old-turn", status: "completed" } }));
  assert.equal(h.notifications.length, 0);
});

test("outages preserve an active baseline and a fast later terminal turn is notified once", () => {
  const h = harness();
  h.store.put({ endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target });
  h.store.observe(task());
  h.store.observe(task({ stale: true, status: "unknown", latestTurn: { id: "turn", status: "completed" } }));
  h.store.observe(task({ latestTurn: null, status: "unavailable" }));
  h.store.observe(task({ status: "idle", latestTurn: { id: "fast-turn", status: "failed" } }));
  h.store.observe(task({ status: "idle", latestTurn: { id: "fast-turn", status: "interrupted" } }));
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.title, "Codex task failed");
});

test("pending notifications wait for their associated endpoint and exact display target to resolve", () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-codex-associations-pending-"));
  const filePath = path.join(directory, "associations.json");
  const association = {
    id: "association", endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target,
    createdAt: "2026-09-16T00:00:00.000Z",
  };
  const note = {
    id: "codex-task-pending", workspaceId: target.workspaceId, tabId: target.tabId, paneId: target.paneId,
    title: "Codex task completed", subtitle: "Native task activity · display association", body: "",
    createdAt: "2026-09-16T00:00:00.000Z", read: false,
  };
  try {
    fs.writeFileSync(filePath, `${JSON.stringify({
      schemaVersion: 1, associations: [association], observations: [],
      outbox: [{ id: note.id, endpointIdentity: "fingerprint-a", threadId: "thread", notification: note, delivered: false }],
    })}\n`, { mode: 0o600 });
    const notifications: TerminalNotification[] = [];
    const targets = new Set<string>();
    const store = new CodexTaskAssociations({ filePath, endpointIdentity: () => "fingerprint-a", resolveTarget: (value) => targets.has(JSON.stringify(value)), notify: (value) => notifications.push(value) });
    assert.equal(notifications.length, 0);
    targets.add(JSON.stringify(target));
    store.observe(task());
    assert.equal(notifications.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("association ledger persists atomically and retains dedupe state across reload", () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-codex-associations-"));
  const filePath = path.join(directory, "associations.json");
  try {
    const first = harness(filePath);
    first.store.put({ endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target });
    first.store.observe(task());
    assertPrivateFile(filePath);

    const second = harness(filePath);
    second.store.observe(task({ latestTurn: { id: "turn", status: "completed" }, status: "idle" }));
    assert.equal(second.notifications.length, 1);
    const third = harness(filePath);
    third.store.observe(task({ latestTurn: { id: "turn", status: "completed" }, status: "idle" }));
    assert.equal(third.notifications.length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("endpoint replacements and missing displays make associations unresolved until the exact target returns", () => {
  const h = harness();
  h.store.put({ endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target });
  h.targets.clear();
  assert.equal(h.store.list()[0]?.reason, "display_target_unavailable");
  h.targets.add(JSON.stringify(target));
  assert.equal(h.store.list()[0]?.resolved, true);
  h.setEndpoint("replacement");
  assert.equal(h.store.list()[0]?.reason, "endpoint_unavailable");
  h.store.observe(task({ latestTurn: { id: "turn", status: "completed" } }));
  assert.equal(h.notifications.length, 0);
});

test("future association ledgers are refused without rewriting", () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-codex-associations-future-"));
  const filePath = path.join(directory, "associations.json");
  const future = `${JSON.stringify({ schemaVersion: CURRENT_CODEX_TASK_ASSOCIATION_SCHEMA_VERSION + 1, associations: [], observations: [], outbox: [] })}\n`;
  try {
    fs.writeFileSync(filePath, future, { mode: 0o600 });
    assert.throws(() => harness(filePath), UnsupportedCodexTaskAssociationVersionError);
    assert.equal(fs.readFileSync(filePath, "utf8"), future);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("failed atomic writes do not change the in-memory association ledger", () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-codex-associations-write-"));
  const filePath = path.join(directory, "associations.json");
  const originalRename = fs.renameSync;
  try {
    const h = harness(filePath);
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === filePath) throw new Error("injected rename failure");
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    assert.throws(() => h.store.put({ endpointId: "endpoint", endpointIdentity: "fingerprint-a", threadId: "thread", target }), /injected/);
    assert.equal(h.store.list().length, 0);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
