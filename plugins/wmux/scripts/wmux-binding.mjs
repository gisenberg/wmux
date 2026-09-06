import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const BINDING_ID = /^[A-Za-z0-9_-]{22}$/;
const RECEIPT = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_RECORDS = 512;
const EXPIRY_MS = 24 * 60 * 60 * 1000;

function home() { return process.env.HOME || os.homedir(); }
function ownPrivate(stat) { return !process.getuid || (stat.uid === process.getuid() && !(stat.mode & 0o077)); }
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownPrivate(stat)) throw new Error("wmux binding directory must be private and owned by the current user.");
  return directory;
}
export function runtimeDirectory() { return privateDirectory(process.env.WMUX_CODEX_PLUGIN_RUNTIME_DIR || path.join(home(), ".wmux", "codex-plugin")); }
function filename(sessionId, bindingId) {
  if (!ID.test(sessionId || "") || !BINDING_ID.test(bindingId || "")) throw new Error("A trusted wmux sessionId and bindingId are required.");
  return path.join(runtimeDirectory(), `${createHash("sha256").update(`${sessionId}\0${bindingId}`).digest("hex")}.json`);
}
function readJson(name) {
  let fd;
  try {
    fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192 || !ownPrivate(stat)) throw new Error("unsafe");
    return { value: JSON.parse(fs.readFileSync(fd, "utf8")), stat };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("wmux binding data is unreadable or unsafe.");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function valid(record, sessionId, bindingId) {
  if (!record || record.schemaVersion !== 2 || record.sessionId !== sessionId || record.bindingId !== bindingId || !RECEIPT.test(record.receipt || "") || !Number.isFinite(record.createdAt) || Date.now() - record.createdAt > EXPIRY_MS) throw new Error("No matching live wmux binding. Submit another prompt to refresh it.");
  return record;
}
export function loadBinding(sessionId, bindingId) { return valid(readJson(filename(sessionId, bindingId))?.value, sessionId, bindingId); }
function records() {
  const entries = fs.readdirSync(runtimeDirectory()).filter(entry => /^[a-f0-9]{64}\.json$/.test(entry));
  if (entries.length > MAX_RECORDS * 2) throw new Error("wmux binding storage has too many records; no selection was made.");
  return entries;
}
function cleanup() {
  const directory = runtimeDirectory();
  const safe = [];
  for (const entry of records()) {
    const full = path.join(directory, entry);
    try {
      const item = readJson(full);
      if (item?.value?.schemaVersion === 2 && Number.isFinite(item.value.createdAt) && Date.now() - item.value.createdAt > EXPIRY_MS) fs.unlinkSync(full);
      else if (item?.value?.schemaVersion === 2 && Number.isFinite(item.value.createdAt)) safe.push({ full, createdAt: item.value.createdAt });
    } catch { /* Never remove malformed or unsafe records. */ }
  }
  safe.sort((a, b) => a.createdAt - b.createdAt);
  for (const record of safe.slice(0, Math.max(0, safe.length - MAX_RECORDS + 1))) fs.unlinkSync(record.full);
}
export function saveBinding(record) {
  valid(record, record.sessionId, record.bindingId);
  cleanup();
  const target = filename(record.sessionId, record.bindingId), temp = `${target}.${randomUUID()}.tmp`;
  if (!fs.existsSync(target) && records().length >= MAX_RECORDS) throw new Error("wmux binding storage is full; remove expired trusted binding records.");
  try { fs.writeFileSync(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, target); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
export async function withBinding(record, action) {
  // Codex owns one name per thread, even when two terminal clients have distinct
  // receipts. Serialize the complete read/set/read/mirror operation per thread.
  const key = createHash("sha256").update(record.sessionId).digest("hex");
  const lock = path.join(runtimeDirectory(), `${key}.session.lock`), owner = randomUUID();
  for (let attempt = 0; attempt < 30; attempt++) {
    try { fs.writeFileSync(lock, owner, { flag: "wx", mode: 0o600 }); break; }
    catch (error) { if (error?.code !== "EEXIST") throw new Error("Cannot acquire wmux binding lock."); if (attempt === 29) throw new Error("wmux naming is busy; retry later."); await delay(100); }
  }
  try { return await action(loadBinding(record.sessionId, record.bindingId)); }
  finally { try { if (fs.readFileSync(lock, "utf8") === owner) fs.unlinkSync(lock); } catch {} }
}
export function promptBinding(sessionId, turnId) {
  if (!ID.test(sessionId || "") || typeof turnId !== "string" || turnId.length < 1 || turnId.length > 128) return null;
  const matches = [];
  for (const entry of records().slice(0, MAX_RECORDS)) {
    try { const record = readJson(path.join(runtimeDirectory(), entry))?.value; if (record?.sessionId === sessionId && record.promptTurnId === turnId) matches.push(record); } catch {}
  }
  return matches.length === 1 ? valid(matches[0], sessionId, matches[0].bindingId) : null;
}
function read(name) { try { return fs.readFileSync(name, "utf8").trim(); } catch { return ""; } }
function allowedHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".ts.net")) return true;
  if (net.isIP(host) === 6) return host === "::1" || /^f[cd][0-9a-f:]*$/i.test(host);
  if (net.isIP(host) !== 4) return (process.env.WMUX_ALLOWED_HOSTS || "").split(",").map(x => x.trim().toLowerCase()).some(x => x === host || (x.startsWith("*.") && host.endsWith(x.slice(1))));
  const [first, second] = host.split(".").map(Number);
  return first === 127 || first === 10 || (first === 100 && second >= 64 && second <= 127) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}
function serviceUrl() {
  const value = read(path.join(home(), ".wmux", "url")) || process.env.WMUX_HELPER_URL || process.env.WMUX_PUBLIC_URL || process.env.WMUX_URL || "http://127.0.0.1:3478";
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || !allowedHost(parsed.hostname)) throw new Error("wmux connection is unavailable or unsafe.");
  return parsed;
}
function credential() {
  const helperPath = process.env.WMUX_HELPER_TOKEN_PATH || path.join(home(), ".wmux", "helper-token");
  const helperFile = read(helperPath), helperConfigured = Object.hasOwn(process.env, "WMUX_HELPER_TOKEN_PATH") || Object.hasOwn(process.env, "WMUX_HELPER_TOKEN") || fs.existsSync(helperPath);
  if (helperConfigured) {
    const value = helperFile || (Object.hasOwn(process.env, "WMUX_HELPER_TOKEN_PATH") || fs.existsSync(helperPath) ? "" : process.env.WMUX_HELPER_TOKEN);
    if (!TOKEN.test(value || "")) throw new Error("wmux helper credential is unavailable or invalid.");
    return value;
  }
  if ((process.env.WMUX_BROWSER_AUTH_MODE || "shared-or-login") !== "shared-or-login") throw new Error("wmux helper credentials are required in login-only mode.");
  const tokenPath = process.env.WMUX_TOKEN_PATH || path.join(home(), ".wmux", "token");
  const value = read(tokenPath) || (Object.hasOwn(process.env, "WMUX_TOKEN_PATH") || fs.existsSync(tokenPath) ? "" : process.env.WMUX_TOKEN) || "";
  if ((value && !TOKEN.test(value)) || (!value && Object.hasOwn(process.env, "WMUX_TOKEN_PATH"))) throw new Error("wmux credential is unavailable or invalid.");
  return value;
}
export async function api(endpoint, body) {
  const token = credential();
  const response = await fetch(new URL(endpoint, serviceUrl()), { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  let json; try { json = await response.json(); } catch { json = null; }
  if (!response.ok) throw new Error(response.status === 409 ? "wmux binding is stale or pending; submit another prompt." : `wmux returned ${response.status}.`);
  return json;
}
export async function issue(sessionId, promptTurnId = null) {
  if (!ID.test(sessionId || "")) throw new Error("Codex session id is invalid.");
  const answer = await api("/api/codex-bindings", { sessionId });
  const matched = /^\[\[WMUX:([A-Za-z0-9_-]{22})\]\]$/.exec(answer?.marker || "");
  if (!RECEIPT.test(answer?.receipt || "") || !matched) throw new Error("wmux returned an invalid binding challenge.");
  const record = { schemaVersion: 2, sessionId, bindingId: matched[1], receipt: answer.receipt, expiresAt: answer.expiresAt, createdAt: Date.now(), promptTurnId: typeof promptTurnId === "string" && promptTurnId.length <= 128 ? promptTurnId : null, lastName: null };
  saveBinding(record);
  return { bindingId: record.bindingId, marker: answer.marker, expiresAt: answer.expiresAt };
}
