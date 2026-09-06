import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "./vendor/ws.cjs";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MESSAGE = 1024 * 1024;
const REQUEST_TIMEOUT = 4000;
const unavailable = () => new Error("Codex read-only observation is unavailable.");

function privateSocket(socketPath) {
  if (process.platform === "win32" || !path.isAbsolute(socketPath) || /[\x00-\x1f\x7f:?#]/.test(socketPath)) throw unavailable();
  const directory = fs.lstatSync(path.dirname(socketPath));
  const socket = fs.lstatSync(socketPath);
  const privateOwned = stat => !process.getuid || (stat.uid === process.getuid() && !(stat.mode & 0o077));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !privateOwned(directory)
    || !socket.isSocket() || socket.isSymbolicLink() || !privateOwned(socket)) throw unavailable();
}

/** Connect only to an existing local daemon, scoped to one explicit thread.
 * No process is spawned, thread resumed, or request/notification answered.
 * This is an observation transport, NOT a general App Server client.
 */
export async function connectCodexObserver({ threadId, socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "app-server-control", "app-server-control.sock") }) {
  if (typeof threadId !== "string" || !ID.test(threadId)) throw unavailable();
  try { privateSocket(socketPath); } catch { throw unavailable(); }
  const pending = new Map();
  let sequence = 0, ended = false;
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false, maxPayload: MAX_MESSAGE, handshakeTimeout: REQUEST_TIMEOUT, followRedirects: false });
  const shutdown = () => {
    if (ended) return;
    ended = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(unavailable()); }
    pending.clear();
    socket.terminate();
  };
  socket.on("error", shutdown);
  socket.on("close", shutdown);
  socket.on("message", (data, binary) => {
    let message;
    try {
      if (binary || data.length > MAX_MESSAGE) throw unavailable();
      message = JSON.parse(data.toString("utf8"));
      if (!message || typeof message !== "object" || Array.isArray(message)) throw unavailable();
    } catch { shutdown(); return; }
    // Never answer server requests (including permissions/questions). Observing
    // a thread must not become a second controller or native approval client.
    if (Object.hasOwn(message, "method") || !Object.hasOwn(message, "id")) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (Object.hasOwn(message, "error") || !Object.hasOwn(message, "result")) waiter.reject(unavailable());
    else waiter.resolve(message.result);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    if (ended || socket.readyState !== WebSocket.OPEN || pending.size >= 4) { reject(unavailable()); return; }
    const id = ++sequence;
    const timer = setTimeout(shutdown, REQUEST_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), error => { if (error) shutdown(); });
  });
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { socket.off("open", opened); socket.off("error", failed); socket.off("close", failed); };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(unavailable()); };
      socket.once("open", opened); socket.once("error", failed); socket.once("close", failed);
    });
    await send("initialize", { clientInfo: { name: "wmux_readonly_observer", version: "0.3.0" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    return {
      close: shutdown,
      request: async (method, params) => {
        if (!params || params.threadId !== threadId) throw unavailable();
        // Construct parameters from an allowlist instead of forwarding caller
        // data: bounded metadata only, never turns/items/transcript contents.
        if (method === "thread/read") return send(method, { threadId, includeTurns: false });
        if (method === "thread/turns/list") {
          if (params.cursor !== undefined && params.cursor !== null && (typeof params.cursor !== "string" || params.cursor.length > 4096)) throw unavailable();
          return send(method, { threadId, cursor: params.cursor ?? null, limit: 8, sortDirection: "desc", itemsView: "notLoaded" });
        }
        throw unavailable();
      },
    };
  } catch { shutdown(); throw unavailable(); }
}
