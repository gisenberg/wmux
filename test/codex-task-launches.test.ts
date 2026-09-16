import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION,
  CodexTaskLaunchConflictError,
  CodexCliViewUncertainError,
  CodexTaskLaunches,
  UnsupportedCodexTaskLaunchVersionError,
} from "../src/server/codex-task-launches.js";
import { assertPrivateFile, privateTempDirectory } from "./private-fixture.js";

const requestId = "a9c96e17-8bd8-421e-a9ad-490184337662";
const input = { requestId, endpointId: "endpoint", cwd: "/srv/project" };
const target = { workspaceId: "workspace", tabId: "tab", paneId: "pane" };

test("concurrent identical clicks share one fresh launch attempt and persist its target", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = new CodexTaskLaunches({ open: async () => { calls++; await gate; return target; } });
  const first = store.launch(input);
  const second = store.launch(input);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { ...input, status: "opened", target, reason: null, createdAt: (await second).createdAt });
  assert.equal(store.get(requestId)?.status, "opened");
  assert.throws(() => store.launch({ ...input, cwd: "/other" }), CodexTaskLaunchConflictError);
});

test("opening attempts become unknown on restart and are never retried", () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-codex-launch-opening-"));
  const filePath = path.join(directory, "launches.json");
  try {
    fs.writeFileSync(filePath, `${JSON.stringify({
      schemaVersion: CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION,
      launches: [{ ...input, status: "opening", target: null, reason: null, createdAt: "2026-09-16T00:00:00.000Z" }],
    })}\n`, { mode: 0o600 });
    let calls = 0;
    const store = new CodexTaskLaunches({ filePath, open: async () => { calls++; return target; } });
    assert.deepEqual(store.get(requestId), { ...input, status: "unknown", target: null, reason: "launch_outcome_unknown", createdAt: "2026-09-16T00:00:00.000Z" });
    assert.equal(calls, 0);
    assertPrivateFile(filePath);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("callback uncertainty is recorded as unknown and an existing request is not resubmitted", async () => {
  let calls = 0;
  const store = new CodexTaskLaunches({ open: async () => { calls++; throw new Error("transport uncertain"); } });
  const result = await store.launch(input);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "launch_outcome_unknown");
  assert.equal((await store.launch(input)).status, "unknown");
  assert.equal(calls, 1);
});

test("known display targets survive uncertain CLI outcomes and explicit acknowledgement never retries", async () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-codex-launch-known-"));
  const filePath = path.join(directory, "launches.json");
  let calls = 0;
  try {
    const store = new CodexTaskLaunches({ filePath, open: async () => { calls++; throw new CodexCliViewUncertainError(target); } });
    const uncertain = await store.launch(input);
    assert.deepEqual(uncertain.target, target);
    assert.equal(uncertain.status, "unknown");
    const reloaded = new CodexTaskLaunches({ filePath, open: async () => { calls++; return target; } });
    assert.deepEqual(reloaded.get(requestId)?.target, target);
    const acknowledged = reloaded.acknowledge(requestId);
    assert.ok(acknowledged.acknowledgedAt);
    assert.equal(acknowledged.status, "unknown");
    assert.equal(calls, 1);
    assert.equal(reloaded.acknowledge(requestId).acknowledgedAt, acknowledged.acknowledgedAt);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("only unknown launches can be acknowledged", async () => {
  const store = new CodexTaskLaunches({ open: async () => target });
  await store.launch(input);
  assert.throws(() => store.acknowledge(requestId), (error: unknown) => error instanceof CodexTaskLaunchConflictError && error.statusCode === 409);
});

test("list returns persisted recent attempts and endpoint identity participates in idempotency", async () => {
  const store = new CodexTaskLaunches({ open: async () => target });
  await store.launch({ ...input, endpointIdentity: "fingerprint-a" });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]?.requestId, requestId);
  assert.throws(() => store.launch({ ...input, endpointIdentity: "fingerprint-b" }), CodexTaskLaunchConflictError);
});

test("failed persistence prevents callback invocation and inputs cannot reach it before strict validation", async () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-codex-launch-write-"));
  const filePath = path.join(directory, "launches.json");
  const originalRename = fs.renameSync;
  let calls = 0;
  try {
    const store = new CodexTaskLaunches({ filePath, open: async () => { calls++; return target; } });
    assert.throws(() => store.launch({ ...input, requestId: "not-a-uuid" }), /uuid/);
    assert.throws(() => store.launch({ ...input, cwd: "/srv/project\u0000injected" }), /custom/);
    assert.equal(calls, 0);
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === filePath) throw new Error("injected persistence failure");
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    assert.throws(() => store.launch(input), /injected persistence failure/);
    assert.equal(calls, 0);
    assert.equal(store.get(requestId), undefined);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("future ledgers are refused without rewrite", () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-codex-launch-future-"));
  const filePath = path.join(directory, "launches.json");
  const future = `${JSON.stringify({ schemaVersion: CURRENT_CODEX_TASK_LAUNCH_SCHEMA_VERSION + 1, launches: [] })}\n`;
  try {
    fs.writeFileSync(filePath, future, { mode: 0o600 });
    assert.throws(() => new CodexTaskLaunches({ filePath, open: async () => target }), UnsupportedCodexTaskLaunchVersionError);
    assert.equal(fs.readFileSync(filePath, "utf8"), future);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
