import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

const ownershipPath = path.resolve("plugins/wmux/scripts/wmux-name-ownership.mjs");
const FILE = "wmux-session-names-v1.json";

function runtime() { return fs.mkdtempSync(path.join(os.tmpdir(), "wmux-session-name-store-")); }
async function withRuntime(action: (directory: string, store: typeof import("../plugins/wmux/scripts/wmux-name-ownership.mjs")) => Promise<void>) {
  const directory = runtime(), prior = process.env.WMUX_CODEX_PLUGIN_RUNTIME_DIR;
  process.env.WMUX_CODEX_PLUGIN_RUNTIME_DIR = directory;
  try { await action(directory, await import(`${ownershipPath}?${Math.random()}`)); }
  finally {
    if (prior === undefined) delete process.env.WMUX_CODEX_PLUGIN_RUNTIME_DIR; else process.env.WMUX_CODEX_PLUGIN_RUNTIME_DIR = prior;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("wmux semantic names are private, atomic, per-session, normalized, and bounded", async () => {
  await withRuntime(async (directory, names) => {
    assert.equal(names.wmuxSessionName("thread_one"), null);
    const saved = await names.rememberWmuxSessionName("thread_one", "  Canonical   task  ");
    assert.deepEqual({ sessionId: saved.sessionId, name: saved.name }, { sessionId: "thread_one", name: "Canonical task" });
    assert.equal(names.wmuxSessionName("thread_two"), null);
    assert.equal(names.wmuxSessionName("thread_one")?.name, "Canonical task");
    // Lone surrogates are valid JavaScript strings accepted by validTitle and
    // are the largest JSON encoding (six bytes per UTF-16 code unit).
    for (let index = 0; index < 520; index++) await names.rememberWmuxSessionName(`thread_${index}`, "\ud800".repeat(80));
    const file = path.join(directory, FILE), stat = fs.statSync(file), stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stat.mode & 0o077, 0);
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.sessions.length, 512);
    assert.equal(names.wmuxSessionName("thread_one"), null);
    assert.ok(Buffer.byteLength(fs.readFileSync(file)) < 512 * 1024);
  });
});

test("distinct processes retain concurrent session-name writes without native calls", async () => {
  const directory = runtime();
  const sentinel = path.join(directory, "native-called");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-no-native-"));
  const codex = path.join(bin, "codex");
  fs.writeFileSync(codex, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'called'); process.exit(99);\n`);
  fs.chmodSync(codex, 0o755);
  const worker = `import { rememberWmuxSessionName } from ${JSON.stringify(ownershipPath)}; const [prefix, count] = process.argv.slice(1); for (let index = 0; index < Number(count); index++) await rememberWmuxSessionName(prefix + index, prefix + index);`;
  const run = (prefix: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", worker, prefix, "80"], {
      env: { ...process.env, WMUX_CODEX_PLUGIN_RUNTIME_DIR: directory, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore",
    });
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`session-name worker exited ${code}`)));
  });
  try {
    await Promise.all([run("alpha_"), run("bravo_")]);
    const stored = JSON.parse(fs.readFileSync(path.join(directory, FILE), "utf8"));
    assert.equal(stored.sessions.length, 160);
    assert.equal(new Set(stored.sessions.map((entry: { sessionId: string }) => entry.sessionId)).size, 160);
    assert.equal(fs.existsSync(sentinel), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});

test("session-name storage rejects corrupt, future, and symlinked files", async () => {
  await withRuntime(async (directory, names) => {
    const file = path.join(directory, FILE);
    fs.writeFileSync(file, "not json", { mode: 0o600 });
    assert.throws(() => names.wmuxSessionName("thread_one"), /unreadable or unsafe/);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, sessions: [] }), { mode: 0o600 });
    assert.throws(() => names.wmuxSessionName("thread_one"), /unreadable or unsafe/);
    fs.unlinkSync(file);
    const target = path.join(directory, "target.json");
    fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, sessions: [] }), { mode: 0o600 });
    fs.symlinkSync(target, file);
    assert.throws(() => names.wmuxSessionName("thread_one"), /unreadable or unsafe/);
  });
});

test("old native provenance is ignored and cannot become a wmux semantic name", async () => {
  await withRuntime(async (directory, names) => {
    const legacy = path.join(directory, "native-name-ownership-v1.json");
    const contents = JSON.stringify({ schemaVersion: 1, sessions: [{ sessionId: "thread_one", ownership: "auto", name: "Untrusted native title", updatedAt: 1 }] });
    fs.writeFileSync(legacy, contents, { mode: 0o600 });
    assert.equal(names.wmuxSessionName("thread_one"), null);
    assert.equal(fs.readFileSync(legacy, "utf8"), contents);
    await names.rememberWmuxSessionName("thread_one", "wmux semantic title");
    assert.equal(names.wmuxSessionName("thread_one")?.name, "wmux semantic title");
    assert.equal(fs.readFileSync(legacy, "utf8"), contents);
  });
});
