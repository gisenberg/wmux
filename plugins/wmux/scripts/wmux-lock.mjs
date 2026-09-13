import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const MARKER = { schemaVersion: 1, kind: "wmux-advisory-lock" };
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code, message) => Object.assign(new Error(message), { code });
const startToken = (pid = process.pid) => { try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(") ")[1]?.split(" ")[19] || null; } catch { return null; } };

const privateParent = (file) => {
  if (!path.isAbsolute(file)) throw fail("lock_unsafe", "wmux lock path must be absolute.");
  const parent = path.dirname(file);
  let real, stat;
  try { real = fs.realpathSync.native(parent); stat = fs.lstatSync(parent); } catch { throw fail("lock_unsafe", "wmux lock parent must already exist."); }
  if (real !== parent || !stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw fail("lock_unsafe", "wmux lock parent must be private, current-user-owned, and free of symlink traversal.");
};
const safeFile = (file) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw fail("lock_unsafe", "wmux lock data is unsafe.");
  return stat;
};
const syncDirectory = async (directory) => {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
};

// link() atomically publishes a completed marker; no empty newly-created lock
// file can be parsed or removed by a competing process.
const ensureLockFile = async (lockPath) => {
  privateParent(lockPath);
  try { safeFile(lockPath); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const temp = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${randomUUID()}.tmp`);
    try {
      const handle = await fsp.open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(MARKER)); await handle.sync(); } finally { await handle.close(); }
      try { await fsp.link(temp, lockPath); await syncDirectory(path.dirname(lockPath)); } catch (linkError) { if (linkError?.code !== "EEXIST") throw linkError; }
    } finally { await fsp.unlink(temp).catch(() => undefined); }
    safeFile(lockPath);
  }
  let marker;
  try { marker = JSON.parse(await fsp.readFile(lockPath, "utf8")); } catch { throw fail("lock_unsafe", "wmux found an unparseable legacy lock file; it was left untouched."); }
  if (marker?.schemaVersion !== MARKER.schemaVersion || marker?.kind !== MARKER.kind) throw fail("lock_unsafe", "wmux found an incompatible legacy lock file; it was left untouched.");
};

const ownerPathFor = (lockPath) => `${lockPath}.owner`;
const validOwner = (owner) => owner && owner.schemaVersion === 1 && TOKEN.test(owner.token || "") && Number.isInteger(owner.pid) && owner.pid > 0 && (typeof owner.startedAt === "string" || owner.startedAt === null) && ["active", "released"].includes(owner.state);
const readOwner = async (file) => {
  try { safeFile(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  let owner;
  try { owner = JSON.parse(await fsp.readFile(file, "utf8")); } catch { throw fail("lock_unsafe", "wmux found an unparseable legacy owner record; it was left untouched."); }
  if (!validOwner(owner)) throw fail("lock_unsafe", "wmux found an incompatible legacy owner record; it was left untouched.");
  return owner;
};
const publishOwner = async (file, owner) => {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fsp.open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    await fsp.rename(temp, file);
    await syncDirectory(path.dirname(file));
  } finally { await fsp.unlink(temp).catch(() => undefined); }
};

// flock obtains a lock on the open-file-description inherited as fd 3. The
// utility exits after acquiring it, while this process retains that descriptor.
const flockDescriptor = (fd, waitSeconds, signal) => new Promise((resolve, reject) => {
  const child = spawn("flock", ["-x", "-E", "75", "-w", String(waitSeconds), "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
  let done = false;
  const finish = (callback, value) => { if (done) return; done = true; signal?.removeEventListener("abort", abort); callback(value); };
  const abort = () => { child.kill("SIGTERM"); finish(reject, fail("lock_cancelled", "wmux lock acquisition was cancelled.")); };
  if (signal?.aborted) return abort();
  signal?.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => finish(reject, fail("lock_unsafe", `wmux could not start flock: ${error.message}`)));
  child.once("exit", (code) => finish(code === 0 ? resolve : reject, code === 0 ? undefined : (code === 75 ? fail("lock_contended", "wmux lock is held by another process.") : fail("lock_unsafe", "wmux flock exited unexpectedly."))));
});
const sleep = async (milliseconds, signal) => { try { await delay(milliseconds, undefined, signal ? { signal } : undefined); } catch { throw fail("lock_cancelled", "wmux lock acquisition was cancelled."); } };

/** POSIX/Linux lock. It never deletes or replaces the flock inode. A killed
 * owner closes its descriptor, releasing flock in the kernel. */
export async function acquireWmuxLock(lockPath, { timeoutMs = 3_000, retryMs = 50, signal } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs < 1) throw fail("lock_unsafe", "wmux lock timing values are invalid.");
  await ensureLockFile(lockPath);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw fail("lock_cancelled", "wmux lock acquisition was cancelled.");
    let handle;
    try {
      handle = await fsp.open(lockPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw fail("lock_unsafe", "wmux lock file is unsafe.");
      await flockDescriptor(handle.fd, Math.min(3, Math.max(0.001, (deadline - Date.now()) / 1_000)), signal);
      const ownerPath = ownerPathFor(lockPath);
      // A kernel grant is the authority for exclusion. A valid stale record
      // can name this still-live process after a failed release publication,
      // and must not turn a free flock inode into a permanent denial.
      await readOwner(ownerPath);
      const owner = { schemaVersion: 1, token: randomUUID(), pid: process.pid, startedAt: startToken(), acquiredAt: Date.now(), state: "active" };
      await publishOwner(ownerPath, owner);
      let released = false;
      return { owner, async release() {
        if (released) return;
        released = true;
        try { await publishOwner(ownerPath, { ...owner, state: "released", releasedAt: Date.now() }); }
        finally { await handle.close(); }
      } };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (error?.code !== "lock_contended") throw error;
      if (Date.now() >= deadline) throw fail("lock_contended", "wmux lock stayed busy until the acquisition deadline.");
      await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())), signal);
    }
  }
}

export async function withWmuxLock(lockPath, options, action) {
  if (typeof options === "function") { action = options; options = undefined; }
  if (typeof action !== "function") throw fail("lock_unsafe", "wmux lock action must be a function.");
  const lock = await acquireWmuxLock(lockPath, options);
  try { return await action(lock.owner); } finally { await lock.release(); }
}
