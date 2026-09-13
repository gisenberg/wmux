import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { acquireWmuxLock, withWmuxLock } from "../plugins/wmux/scripts/wmux-lock.mjs";

const worker = async () => {
  const { acquireWmuxLock: acquire } = await import("../plugins/wmux/scripts/wmux-lock.mjs");
  const lock = await acquire(process.argv[3]!, { timeoutMs: 30_000, retryMs: 5 });
  process.stdout.write("acquired\n");
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
  await lock.release();
};
if (process.argv[2] === "--wmux-lock-owner") { await worker(); process.exit(0); }
if (process.argv[2] === "--wmux-lock-contender") {
  await withWmuxLock(process.argv[3]!, { timeoutMs: 30_000, retryMs: 2 }, async () => {
    process.stdout.write("enter\n"); await wait(3); process.stdout.write("exit\n");
  });
  process.exit(0);
}

const directory = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-lock-")); fs.chmodSync(dir, 0o700); return dir; };
const owner = (lock: string) => spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--wmux-lock-owner", lock], { stdio: ["ignore", "pipe", "ignore"] });
const acquired = (child: ReturnType<typeof owner>) => new Promise<void>((resolve, reject) => {
  child.stdout.once("data", (data) => data.toString() === "acquired\n" ? resolve() : reject(new Error("owner did not acquire")));
  child.once("exit", (code) => reject(new Error(`owner exited ${code}`)));
});

test("a killed owner releases the kernel lock for a successor", async () => {
  const dir = directory(), lock = path.join(dir, "binding.flock"), child = owner(lock);
  try {
    await acquired(child);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const successor = await acquireWmuxLock(lock, { timeoutMs: 2_000 });
    await successor.release();
  } finally { child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("slow live owner is never stolen and bounded acquisition never enters action", async () => {
  const dir = directory(), lock = path.join(dir, "binding.flock"); let entered = false;
  try {
    const held = await acquireWmuxLock(lock);
    await assert.rejects(() => withWmuxLock(lock, { timeoutMs: 80, retryMs: 10 }, async () => { entered = true; }), { code: "lock_contended" });
    assert.equal(entered, false);
    await held.release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("100 bare Node subprocess contenders cannot enter one filesystem sentinel together", async () => {
  const dir = directory(), lock = path.join(dir, "binding.flock"), sentinel = path.join(dir, "critical");
  try {
    await Promise.all(Array.from({ length: 100 }, () => new Promise<void>((resolve, reject) => {
      const moduleUrl = new URL("../plugins/wmux/scripts/wmux-lock.mjs", import.meta.url).href;
      const source = `import fs from 'node:fs'; import { setTimeout as sleep } from 'node:timers/promises'; import { withWmuxLock } from ${JSON.stringify(moduleUrl)}; await withWmuxLock(${JSON.stringify(lock)}, {timeoutMs:30000,retryMs:2}, async()=>{fs.mkdirSync(${JSON.stringify(sentinel)}); await sleep(3); fs.rmdirSync(${JSON.stringify(sentinel)});});`;
      const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "ignore"] });
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`contender exited ${code}`)));
    })));
    assert.equal(fs.existsSync(sentinel), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cancelled acquisition never enters action", async () => {
  const dir = directory(), lock = path.join(dir, "binding.flock"), controller = new AbortController(); let entered = false;
  try {
    const held = await acquireWmuxLock(lock);
    const pending = withWmuxLock(lock, { timeoutMs: 1_000, signal: controller.signal }, async () => { entered = true; });
    controller.abort();
    await assert.rejects(pending, { code: "lock_cancelled" });
    assert.equal(entered, false);
    await held.release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("symlinked parent is rejected without traversal", async () => {
  const dir = directory(), link = `${dir}-link`;
  try {
    fs.symlinkSync(dir, link);
    await assert.rejects(() => acquireWmuxLock(path.join(link, "binding.flock")), { code: "lock_unsafe" });
  } finally { fs.unlinkSync(link); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("malformed legacy lock is left untouched", async () => {
  const dir = directory(), lock = path.join(dir, "legacy.flock");
  try {
    fs.writeFileSync(lock, "not json", { mode: 0o600 });
    await assert.rejects(() => acquireWmuxLock(lock), { code: "lock_unsafe" });
    assert.equal(fs.readFileSync(lock, "utf8"), "not json");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
