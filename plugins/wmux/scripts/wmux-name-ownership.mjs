import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ID, runtimeDirectory } from "./wmux-binding.mjs";
import { validTitle } from "./wmux-title.mjs";

// This is wmux-only semantic state. It deliberately has no relationship to a
// Codex thread's native `name`: native titles have no supported provenance.
const FILE = "wmux-session-names-v1.json";
const LOCK = "wmux-session-names-v1.lock";
const VERSION = 1;
const MAX_SESSIONS = 512;
// A valid title can be 80 UTF-16 units. JSON may encode each lone surrogate as
// six ASCII bytes, so 128 session-id bytes + 480 title bytes + envelope per
// entry still fits comfortably below this 512-entry store limit.
const MAX_BYTES = 512 * 1024;

function ownPrivate(stat) { return !process.getuid || (stat.uid === process.getuid() && !(stat.mode & 0o077)); }
function filename() { return path.join(runtimeDirectory(), FILE); }
function normalizedTitle(value) {
  try { return validTitle(value); }
  catch { return null; }
}
function validEntry(value) {
  return value && typeof value === "object" && ID.test(value.sessionId || "")
    && typeof value.name === "string" && normalizedTitle(value.name) === value.name
    && Number.isFinite(value.updatedAt) && value.updatedAt >= 0;
}
function empty() { return { schemaVersion: VERSION, sessions: [] }; }
function validStore(value) {
  return value && typeof value === "object" && value.schemaVersion === VERSION
    && Array.isArray(value.sessions) && value.sessions.length <= MAX_SESSIONS
    && value.sessions.every(validEntry) && new Set(value.sessions.map(entry => entry.sessionId)).size === value.sessions.length;
}
function readStore() {
  const name = filename(); let fd;
  try {
    fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || !ownPrivate(stat)) throw new Error("unsafe");
    const data = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!validStore(data)) throw new Error("invalid");
    return data;
  } catch (error) {
    if (error?.code === "ENOENT") return empty();
    throw new Error("wmux session-name data is unreadable or unsafe.");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeStore(store) {
  const target = filename(), temp = `${target}.${randomUUID()}.tmp`;
  const encoded = JSON.stringify(store);
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("wmux session-name data exceeds its limit.");
  try { fs.writeFileSync(temp, encoded, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, target); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
async function withStoreLock(action) {
  const lock = path.join(runtimeDirectory(), LOCK), owner = randomUUID();
  for (let attempt = 0; attempt < 200; attempt++) {
    try { fs.writeFileSync(lock, owner, { flag: "wx", mode: 0o600 }); break; }
    catch (error) {
      if (error?.code !== "EEXIST") throw new Error("Cannot acquire wmux session-name lock.");
      if (attempt === 199) throw new Error("wmux session-name storage is busy; retry later.");
      await delay(20);
    }
  }
  try { return await action(); }
  finally { try { if (fs.readFileSync(lock, "utf8") === owner) fs.unlinkSync(lock); } catch {} }
}

export function wmuxSessionName(sessionId) {
  if (!ID.test(sessionId || "")) throw new Error("Codex session id is invalid.");
  return readStore().sessions.find(entry => entry.sessionId === sessionId) ?? null;
}

// Call while wmux-binding's per-thread lock is held. This second, short lock
// serializes the one shared bounded store across distinct Codex processes.
export async function rememberWmuxSessionName(sessionId, name) {
  if (!ID.test(sessionId || "")) throw new Error("Codex session id is invalid.");
  const normalized = normalizedTitle(name);
  if (!normalized) throw new Error("Invalid wmux session name.");
  return withStoreLock(() => {
    const store = readStore();
    const entry = { sessionId, name: normalized, updatedAt: Date.now() };
    const index = store.sessions.findIndex(item => item.sessionId === sessionId);
    if (index >= 0) store.sessions[index] = entry; else store.sessions.push(entry);
    store.sessions.sort((a, b) => a.updatedAt - b.updatedAt || a.sessionId.localeCompare(b.sessionId));
    if (store.sessions.length > MAX_SESSIONS) store.sessions.splice(0, store.sessions.length - MAX_SESSIONS);
    writeStore(store);
    return entry;
  });
}
