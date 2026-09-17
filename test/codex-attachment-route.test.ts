import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { attestCodexAttachment } from "../src/server/codex-attachment-route.js";

const endpoint = (id = "one", socketPath = "/private/native.sock") => ({ id, label: id, machineId: "local", transport: "local" as const, socketPath,
  managedLaunch: { launcherPath: "/release/codex-guard", deploymentPath: "/release" } });
const receipt = (socket = "/private/native.sock", generation = "gen-a") => ({ ready: true, policy: "enforce", account: process.getuid?.(), socket, generation, launcherHash: "l", deploymentHash: "d" });
const native = (id = "thread_a", status = "idle", queued: unknown[] = []) => ({ thread: { id, cwd: "/work", status: { type: status }, canAcceptDirectInput: true }, queue: { data: queued, nextCursor: null }, loaded: { data: [id], nextCursor: null } });

test("browser terminal identity replies preserve attachment proof but actual input invalidates it", () => {
  const script = fileURLToPath(new URL("../scripts/wmux-agent-run", import.meta.url));
  const result = spawnSync("python3", ["-c", `
import importlib.machinery,importlib.util,sys
loader=importlib.machinery.SourceFileLoader('wmux_run',sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader);m=importlib.util.module_from_spec(spec);loader.exec_module(m)
reply=bytes.fromhex('1b5b3f36323b3232631b5b3e313b303b30631b503e7c6c696267686f737474791b5c')
assert m.terminal_reply_only(reply)
assert m.terminal_reply_only(bytes.fromhex('1b5b313b3252'))
for value in [b'/resume another-task',b'hello',b'\\r',reply+b'/resume other',bytes.fromhex('1b5b3230307e')+b'/resume other',b'\\x1bP>|unknown-terminal\\x1b\\\\']:
 assert not m.terminal_reply_only(value),repr(value)
`, script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("native attestation refuses a socket replaced between stat and connect", () => {
  const script = fileURLToPath(new URL("../scripts/wmux_codex_attach.py", import.meta.url));
  const result = spawnSync("python3", ["-c", `
import importlib.util,sys,types,stat,os
s=importlib.util.spec_from_file_location('probe',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
changed=False
def entry(p): return types.SimpleNamespace(st_mode=stat.S_IFSOCK|0o600,st_uid=os.getuid(),st_dev=1,st_ino=2 if changed else 1)
class Client:
 def settimeout(self,n): pass
 def connect(self,p):
  global changed
  changed=True
 def getsockopt(self,*args): raise AssertionError('peer queried for a replaced socket')
 def close(self): pass
m.os.lstat=entry;m.socket.socket=lambda *args:Client()
try: m.socket_peer('/private/native.sock')
except ValueError: print('refused')
else: raise AssertionError('replacement accepted')
`, script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "refused");
});

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

test("checks SSH peer ownership without requiring a remote managed launcher", async () => {
  const first = endpoint(), remote = { ...endpoint("remote"), transport: "ssh" as const, managedLaunch: undefined };
  const outcomes = [
    { page: { data: [], nextCursor: null }, reason: null },
    { page: { data: ["thread_a"], nextCursor: null }, reason: "attachment_owner_ambiguous" },
    { page: { data: [], nextCursor: "more" }, reason: "attachment_owner_unknown" },
    { page: { data: [{}], nextCursor: null }, reason: "attachment_owner_unknown" },
    { page: null, reason: "attachment_owner_unknown" },
  ];
  for (const { page, reason } of outcomes) {
    const checked: string[] = [];
    const result = await attestCodexAttachment({ endpoint: first, endpoints: [first, remote], threadId: "thread_a",
      inspect: async () => receipt(), probe: async () => native(), loadedProbe: async candidate => {
        checked.push(candidate.id);
        if (!page) throw new Error("peer offline");
        return page;
      } });
    assert.deepEqual(checked, ["remote"]);
    assert.equal(result.public.reason, reason);
    assert.equal(result.public.enabled, reason === null);
  }
});
