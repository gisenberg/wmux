import assert from "node:assert/strict";
import test from "node:test";
import { attestCodexAttachment } from "../src/server/codex-attachment-route.js";

const endpoint = (id = "one", socketPath = "/private/native.sock") => ({ id, label: id, machineId: "local", transport: "local" as const, socketPath,
  managedLaunch: { launcherPath: "/release/codex-guard", deploymentPath: "/release" } });
const receipt = (socket = "/private/native.sock", generation = "gen-a") => ({ ready: true, policy: "enforce", account: process.getuid?.(), socket, generation, launcherHash: "l", deploymentHash: "d" });
const native = (id = "thread_a", status = "idle", queued: unknown[] = []) => ({ thread: { id, cwd: "/work", status: { type: status }, canAcceptDirectInput: true }, queue: { data: queued, nextCursor: null }, loaded: { data: [id], nextCursor: null } });

test("attests an exact loaded local task and keeps route proof private", async () => {
  const result = await attestCodexAttachment({ endpoint: endpoint(), endpoints: [endpoint()], threadId: "thread_a",
    inspect: async () => receipt(), probe: async () => native() });
  assert.equal(result.public.enabled, true);
  assert.equal(result.public.reason, null);
  assert.equal(result.public.generation?.length, 64);
  assert.equal(result.private?.cwd, "/work");
  assert.deepEqual(result.private?.route.managedArgv, ["/release/codex-guard", "resume", "thread_a"]);
  assert.equal(result.private?.fingerprint.length, 64);
});

test("fails closed for a queue, wrong loaded UUID, and non-direct input", async () => {
  for (const response of [native("thread_a", "idle", [{}]), native("other"), { ...native(), thread: { ...native().thread, canAcceptDirectInput: false } }]) {
    const result = await attestCodexAttachment({ endpoint: endpoint(), endpoints: [endpoint()], threadId: "thread_a", inspect: async () => receipt(), probe: async () => response });
    assert.equal(result.public.enabled, false);
    assert.equal(result.private, null);
  }
});

test("does not count aliases of the same socket generation as competing owners", async () => {
  const first = endpoint("one"), alias = endpoint("alias");
  const result = await attestCodexAttachment({ endpoint: first, endpoints: [first, alias], threadId: "thread_a", inspect: async () => receipt(), probe: async () => native() });
  assert.equal(result.public.enabled, true);
});

test("requires a complete loaded-owner page and does not mistake stored metadata for ownership", async () => {
  const first = endpoint("one"), other = endpoint("other", "/private/other.sock");
  const partial = { ...native(), loaded: { data: ["thread_a"], nextCursor: "more" } };
  const incomplete = await attestCodexAttachment({ endpoint: first, endpoints: [first], threadId: "thread_a", inspect: async () => receipt(), probe: async () => partial });
  assert.equal(incomplete.public.reason, "attachment_not_loaded");
  const storedElsewhere = await attestCodexAttachment({ endpoint: first, endpoints: [first, other], threadId: "thread_a",
    inspect: async input => input.socketPath.includes("other") ? receipt("/private/other.sock", "gen-b") : receipt(),
    probe: async input => input.socketPath.includes("other") ? { ...native(), loaded: { data: [], nextCursor: null } } : native() });
  assert.equal(storedElsewhere.public.enabled, true);
});

test("fails closed when another configured endpoint is unavailable or owns the loaded task", async () => {
  const first = endpoint("one"), other = endpoint("other", "/private/other.sock");
  const unavailable = await attestCodexAttachment({ endpoint: first, endpoints: [first, other], threadId: "thread_a",
    inspect: async input => input.socketPath.includes("other") ? Promise.reject(new Error()) : receipt(), probe: async () => native() });
  assert.equal(unavailable.public.reason, "attachment_owner_unknown");
  const ambiguous = await attestCodexAttachment({ endpoint: first, endpoints: [first, other], threadId: "thread_a",
    inspect: async input => input.socketPath.includes("other") ? receipt("/private/other.sock", "gen-b") : receipt(),
    probe: async () => native() });
  assert.equal(ambiguous.public.reason, "attachment_owner_ambiguous");
});

test("never attests SSH or a route without managed launch material", async () => {
  const ssh = await attestCodexAttachment({ endpoint: { ...endpoint(), transport: "ssh" }, endpoints: [], threadId: "thread_a" });
  const missing = await attestCodexAttachment({ endpoint: { ...endpoint(), managedLaunch: undefined }, endpoints: [], threadId: "thread_a" });
  assert.equal(ssh.public.reason, "attachment_ssh_unsupported");
  assert.equal(missing.public.reason, "attachment_unconfigured");
});

test("requires an exact empty queue cursor and a concrete task cwd", async () => {
  const noCursor = { ...native(), queue: { data: [], nextCursor: undefined } };
  const noCwd = { ...native(), thread: { ...native().thread, cwd: null } };
  for (const response of [noCursor, noCwd]) {
    const result = await attestCodexAttachment({ endpoint: endpoint(), endpoints: [endpoint()], threadId: "thread_a", inspect: async () => receipt(), probe: async () => response });
    assert.equal(result.public.enabled, false);
  }
});
