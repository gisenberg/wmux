import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexCatalogError, CodexTaskCatalog, loadCodexCatalogConfig } from "../src/server/codex-task-catalog.js";

const machine = (overrides: Record<string, unknown> = {}) => ({
  id: "local_fixture", label: "Local fixture", kind: "local", source: "static", host: "127.0.0.1", ...overrides,
}) as any;
const endpoint = { id: "native", label: "Native", machineId: "local_fixture", transport: "local" as const, socketPath: "/tmp/native.sock" };
const native = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: "same title", preview: "private preview", cwd: "/private/repo", modelProvider: "openai", source: "cli",
  parentThreadId: null, status: { type: "idle" }, updatedAt: 1, ...extra,
});

const catalog = (query: (input: any) => Promise<unknown>, machines = () => [machine()]) =>
  new CodexTaskCatalog(machines, [endpoint], query as any);

test("loads only a private, bounded, canonical catalog JSON file", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-catalog-config-"));
  const file = path.join(directory, "catalog.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, endpoints: [endpoint] }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  assert.deepEqual(loadCodexCatalogConfig(file), [endpoint]);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadCodexCatalogConfig(file), /private owned/);
  fs.chmodSync(file, 0o600);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => loadCodexCatalogConfig(file), /private owned/);
  fs.chmodSync(directory, 0o700);
  const linked = path.join(directory, "linked.json");
  fs.symlinkSync(file, linked);
  assert.throws(() => loadCodexCatalogConfig(linked), /private owned/);
});

test("host replacement invalidates endpoint identity before any query", async () => {
  let current = [machine()]; let calls = 0;
  const instance = catalog(async () => { calls++; return { data: [] }; }, () => current);
  const identity = instance.identity("native");
  assert.ok(identity);
  current = [machine({ host: "127.0.0.2" })];
  assert.equal(instance.identity("native"), null);
  await assert.rejects(instance.list("native"), (error: unknown) => error instanceof CodexCatalogError && error.code === "endpoint_identity_changed");
  assert.equal(calls, 0);
});

test("page caches are cursor-separated and stale cached tasks are explicitly unavailable", async () => {
  let fail = false;
  const instance = catalog(async input => {
    if (fail) throw new Error("private native error");
    return { data: [native(input.cursor === "second" ? "thr_second" : "thr_first")], nextCursor: input.cursor ? null : "second" };
  });
  const first = await instance.list("native");
  const second = await instance.list("native", "second");
  assert.equal(first.tasks[0]!.threadId, "thr_first");
  assert.equal(second.tasks[0]!.threadId, "thr_second");
  fail = true;
  const stale = await instance.list("native", "second");
  assert.equal(stale.tasks[0]!.threadId, "thr_second");
  assert.equal(stale.tasks[0]!.stale, true);
  assert.equal(stale.tasks[0]!.status, "unavailable");
  assert.equal(JSON.stringify(stale).includes("private native error"), false);
});

test("read rejects a response that does not repeat the requested exact identity", async () => {
  const instance = catalog(async input => input.operation === "read" ? { thread: native("thr_other") } : { data: [] });
  await assert.rejects(instance.read("native", "thr_expected"), (error: unknown) => error instanceof CodexCatalogError && error.code === "native_identity_mismatch");
});

test("read never substitutes cached metadata for a native exact-identity mismatch", async () => {
  let wrong = false;
  const instance = catalog(async input => {
    if (input.operation === "list") return { data: [native("thr_expected")] };
    if (input.operation === "read") return { thread: native(wrong ? "thr_other" : "thr_expected") };
    return { data: [] };
  });
  await instance.list("native");
  wrong = true;
  await assert.rejects(instance.read("native", "thr_expected"), (error: unknown) => error instanceof CodexCatalogError && error.code === "native_identity_mismatch");
});

test("malformed native pages fail closed and mark the endpoint unavailable", async () => {
  const instance = catalog(async () => ({ data: "not an array" }));
  await assert.rejects(instance.list("native"), (error: unknown) => error instanceof CodexCatalogError && error.code === "invalid_native_page");
  assert.equal(instance.listEndpoints()[0]!.status, "unavailable");
});

test("a rejected page cannot leave its valid prefix available as stale task metadata", async () => {
  const instance = catalog(async input => {
    if (input.operation === "list") return { data: [native("thr_prefix"), { id: "bad/id" }] };
    throw new Error("native unavailable");
  });
  await assert.rejects(instance.list("native"), (error: unknown) => error instanceof CodexCatalogError && error.code === "native_identity_mismatch");
  await assert.rejects(instance.read("native", "thr_prefix"));
});

test("parent task metadata and duplicate titles remain separate task identities", async () => {
  const instance = catalog(async input => input.operation === "list" ? { data: [
    native("thr_one", { parentThreadId: "thr_parent" }), native("thr_two"),
  ] } : { data: [] });
  const page = await instance.list("native");
  assert.deepEqual(page.tasks.map(task => task.threadId), ["thr_one", "thr_two"]);
  assert.deepEqual(page.tasks.map(task => task.name), ["same title", "same title"]);
  assert.equal(page.tasks[0]!.parentThreadId, "thr_parent");
});

test("turn history is bounded and a turns failure does not change exact task identity", async () => {
  const instance = catalog(async input => {
    if (input.operation === "read") return { thread: native("thr_one") };
    return { data: Array.from({ length: 9 }, (_, index) => ({ id: `turn_${index}`, status: "completed", items: [] })) };
  });
  const detail = await instance.read("native", "thr_one", true);
  assert.equal(detail.task.threadId, "thr_one");
  assert.deepEqual(detail.turns, []);
  assert.equal(detail.historyReason, "Turn metadata is unavailable for this endpoint.");
  assert.equal(detail.resume.enabled, false);
});

test("read serves known task metadata as stale after a sanitized query failure", async () => {
  let fail = false;
  const instance = catalog(async input => {
    if (fail) throw new Error("do not expose this");
    if (input.operation === "list") return { data: [native("thr_one")] };
    return { thread: native("thr_one") };
  });
  await instance.list("native");
  fail = true;
  const detail = await instance.read("native", "thr_one");
  assert.equal(detail.task.stale, true);
  assert.equal(detail.task.status, "unavailable");
  assert.equal(JSON.stringify(detail).includes("do not expose this"), false);
});

test("global catalog concurrency is bounded at four active endpoint queries", async () => {
  const gates: Array<() => void> = [];
  const instance = catalog(async () => new Promise(resolve => gates.push(() => resolve({ data: [] }))));
  const firstFour = [0, 1, 2, 3].map(() => instance.list("native"));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(instance.list("native"), (error: unknown) => error instanceof CodexCatalogError && error.code === "catalog_busy");
  for (const release of gates.splice(0)) release();
  await Promise.all(firstFour);
});

test("one endpoint/thread read owns metadata and turns until it settles", async () => {
  let release!: () => void;
  let hold = true;
  const instance = catalog(async input => {
    if (input.operation === "read" && input.threadId === "thr_one" && hold) await new Promise<void>(resolve => { release = resolve; });
    if (input.operation === "read") return { thread: native(input.threadId!) };
    return { data: [] };
  });
  const first = instance.read("native", "thr_one");
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(instance.read("native", "thr_one"), (error: unknown) => error instanceof CodexCatalogError && error.code === "catalog_busy" && error.status === 429);
  const other = instance.read("native", "thr_two");
  release(); hold = false;
  await Promise.all([first, other]);
  await instance.read("native", "thr_one");
});

test("per-task read exclusion releases after an error", async () => {
  let fail = true;
  const instance = catalog(async input => input.operation === "read"
    ? { thread: native(fail ? "thr_wrong" : input.threadId!) } : { data: [] });
  await assert.rejects(instance.read("native", "thr_one"));
  fail = false;
  assert.equal((await instance.read("native", "thr_one")).task.threadId, "thr_one");
});

test("remote catalog uses only its configured bridge subprocess and accepts one bounded bridge envelope", { skip: process.platform === "win32" }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-catalog-fake-ssh-"));
  const fakeSsh = path.join(directory, "ssh");
  const captured = path.join(directory, "input.json");
  fs.writeFileSync(fakeSsh, `#!/bin/sh\ncat > ${JSON.stringify(captured)}\nprintf '%s\\n' '{"ok":true,"result":{"data":[],"nextCursor":null}}'\n`, { mode: 0o700 });
  fs.chmodSync(fakeSsh, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; fs.rmSync(directory, { recursive: true, force: true }); });
  const remoteEndpoint = { ...endpoint, transport: "ssh" as const, bridgePath: "/opt/wmux/codex-catalog-bridge.mjs", nodePath: "/usr/bin/node" };
  const instance = new CodexTaskCatalog(() => [machine({ kind: "ssh", host: "127.0.0.2", user: "iceparrot" })], [remoteEndpoint]);
  const page = await instance.list("native");
  assert.deepEqual(page.tasks, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(captured, "utf8")), {
    operation: "list", cursor: null, archived: false, socketPath: "/tmp/native.sock",
  });
});

test("remote bridge stdout preserves UTF-8 split across process chunks", { skip: process.platform === "win32" }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-catalog-utf8-"));
  const fakeSsh = path.join(directory, "ssh");
  const before = '{"ok":true,"result":{"data":[{"id":"thr_utf","name":"';
  const after = '","preview":"","cwd":"/x","modelProvider":"openai","source":"cli","parentThreadId":null,"status":{"type":"idle"},"updatedAt":1}]}}';
  fs.writeFileSync(fakeSsh, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${before}'\nsleep 0.05\nprintf '\\342'\nsleep 0.05\nprintf '\\202'\nsleep 0.05\nprintf '\\254'\nsleep 0.05\nprintf '%s\\n' '${after}'\n`, { mode: 0o700 });
  fs.chmodSync(fakeSsh, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; fs.rmSync(directory, { recursive: true, force: true }); });
  const remoteEndpoint = { ...endpoint, transport: "ssh" as const, bridgePath: "/opt/wmux/codex-catalog-bridge.mjs", nodePath: "/usr/bin/node" };
  const instance = new CodexTaskCatalog(() => [machine({ kind: "ssh", host: "127.0.0.2", user: "iceparrot" })], [remoteEndpoint]);
  const page = await instance.list("native");
  assert.equal(page.tasks[0]!.name, "€");
});


test("controller transport can disable fresh launch without changing endpoint identity", () => {
  const instance = new CodexTaskCatalog(() => [machine()], [{ ...endpoint, allowFreshLaunch: true }]);
  const identity = instance.identity("native");
  instance.disableFreshLaunch("Direct TLS controller unsupported");
  assert.equal(instance.identity("native"), identity);
  assert.equal(instance.listEndpoints()[0]!.freshLaunch, false);
  assert.equal(instance.listEndpoints()[0]!.launchReason, "Direct TLS controller unsupported");
  assert.throws(() => instance.launchConfig("native"), (error: unknown) => error instanceof CodexCatalogError && error.code === "fresh_launch_disabled");
});

test("existing-task attachment config stays private and requires a local managed launcher", () => {
  const managed = { ...endpoint, managedLaunch: { launcherPath: "/release/bin/codex-guard", deploymentPath: "/release" } };
  const instance = new CodexTaskCatalog(() => [machine()], [managed]);
  assert.deepEqual(instance.attachmentConfig("native").managedLaunch, managed.managedLaunch);
  const ssh = new CodexTaskCatalog(() => [machine({ kind: "ssh", host: "127.0.0.2" })], [{ ...managed, transport: "ssh" as const, bridgePath: "/release/bridge", nodePath: "/usr/bin/node" }]);
  assert.throws(() => ssh.attachmentConfig("native"), (error: unknown) => error instanceof CodexCatalogError && error.code === "attachment_ssh_unsupported");
});
