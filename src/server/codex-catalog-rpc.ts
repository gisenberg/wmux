import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEADLINE_MS = 4_000;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CURSOR_MAX_LENGTH = 4_096;

export type CodexCatalogOperation = "list" | "read" | "turns" | "attachment" | "loaded";

export interface CodexCatalogInput {
  socketPath: string;
  operation: CodexCatalogOperation;
  threadId?: string;
  cursor?: string | null;
  archived?: boolean;
}

export class CodexCatalogRpcError extends Error {
  readonly reason: "unsupported_endpoint" | "socket_unavailable" | "invalid_request";

  constructor(reason: CodexCatalogRpcError["reason"]) {
    super("Codex catalog is unavailable.");
    this.reason = reason;
  }
}

const fail = (reason: CodexCatalogRpcError["reason"]): never => { throw new CodexCatalogRpcError(reason); };

const validateSocket = (socketPath: unknown): string => {
  if (process.platform === "win32") fail("invalid_request");
  const candidate = typeof socketPath === "string" ? socketPath : fail("invalid_request");
  if (!path.isAbsolute(candidate) || candidate.length > 4_096 || /[\x00-\x1f\x7f:?#]/.test(candidate)) fail("invalid_request");
  const resolved = path.resolve(candidate);
  const parent = path.dirname(resolved);
  try {
    // `realpath` catches a symlink in any ancestor; lstat rejects a final
    // symlink instead of following it to an unrelated local endpoint.
    if (fs.realpathSync.native(parent) !== parent) fail("socket_unavailable");
    const directory = fs.lstatSync(parent);
    const socket = fs.lstatSync(resolved);
    const uid = process.getuid?.();
    const privatelyOwned = (stat: fs.Stats): boolean => uid !== undefined && stat.uid === uid && !(stat.mode & 0o077);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !privatelyOwned(directory)
      || !socket.isSocket() || socket.isSymbolicLink() || !privatelyOwned(socket)) fail("socket_unavailable");
  } catch (error) {
    if (error instanceof CodexCatalogRpcError) throw error;
    fail("socket_unavailable");
  }
  return resolved;
};

const requestFor = (input: CodexCatalogInput): { method: string; params: Record<string, unknown> } => {
  if (!input || typeof input !== "object" || !["list", "read", "turns", "attachment", "loaded"].includes(input.operation)) fail("invalid_request");
  if (input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== "string" || input.cursor.length > CURSOR_MAX_LENGTH)) fail("invalid_request");
  if (input.archived !== undefined && typeof input.archived !== "boolean") fail("invalid_request");
  if (input.operation === "loaded") return { method: "thread/loaded/list", params: { cursor: null, limit: 200 } };
  if (input.operation === "list") {
    return { method: "thread/list", params: {
      limit: 40, cursor: input.cursor ?? null, archived: input.archived ?? false, useStateDbOnly: true, sourceKinds: [],
    } };
  }
  if (typeof input.threadId !== "string" || !THREAD_ID.test(input.threadId)) fail("invalid_request");
  if (input.operation === "read" || input.operation === "attachment") return { method: "thread/read", params: { threadId: input.threadId, includeTurns: false } };
  return { method: "thread/turns/list", params: {
    threadId: input.threadId, cursor: input.cursor ?? null, limit: 8, sortDirection: "desc", itemsView: "summary",
  } };
};

/**
 * One bounded query to an already-running private App Server.  This is a
 * catalog only: it never creates/resumes a thread, starts a turn, queues
 * input, or establishes a wmux-to-thread identity relationship.
 */
export async function queryCodexCatalog(input: CodexCatalogInput): Promise<unknown> {
  const socketPath = validateSocket(input?.socketPath);
  const request = requestFor(input);
  const deadline = Date.now() + DEADLINE_MS;
  let socket: WebSocket | undefined;
  let settled = false;
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const unavailable = (): CodexCatalogRpcError => new CodexCatalogRpcError("socket_unavailable");
  const shutdown = (): void => {
    if (settled) return;
    settled = true;
    for (const waiter of pending.values()) waiter.reject(unavailable());
    pending.clear();
    socket?.terminate();
  };
  const timer = setTimeout(shutdown, DEADLINE_MS);
  try {
    socket = new WebSocket(`ws+unix://${socketPath}:/`, {
      followRedirects: false, handshakeTimeout: Math.max(1, remaining()), maxPayload: MAX_RESPONSE_BYTES, perMessageDeflate: false,
    });
    socket.on("error", shutdown);
    socket.on("close", shutdown);
    socket.on("message", (data, binary) => {
      let message: unknown;
      try {
        const payload = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (binary || payload.length > MAX_RESPONSE_BYTES) throw new Error();
        message = JSON.parse(payload.toString("utf8"));
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      } catch { shutdown(); return; }
      // Server requests and notifications are deliberately ignored. This
      // bridge never acts as an approval, elicitation, or control client.
      const record = message as Record<string, unknown>;
      if (typeof record.id !== "number" || typeof record.method === "string") return;
      const waiter = pending.get(record.id);
      if (!waiter) return;
      pending.delete(record.id);
      if (Object.hasOwn(record, "error") || !Object.hasOwn(record, "result")) {
        waiter.reject(new CodexCatalogRpcError((record.error as { code?: unknown } | undefined)?.code === -32601 ? "unsupported_endpoint" : "socket_unavailable"));
      } else waiter.resolve(record.result);
    });
    await new Promise<void>((resolve, reject) => {
      const opened = (): void => { cleanup(); resolve(); };
      const failed = (): void => { cleanup(); reject(unavailable()); };
      const cleanup = (): void => { socket?.off("open", opened); socket?.off("error", failed); socket?.off("close", failed); };
      socket!.once("open", opened); socket!.once("error", failed); socket!.once("close", failed);
    });
    const send = (method: string, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
      if (settled || !socket || socket.readyState !== WebSocket.OPEN || remaining() <= 0) { reject(unavailable()); return; }
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), error => { if (error) shutdown(); });
    });
    await send("initialize", { clientInfo: { name: "wmux_catalog", version: "0.3.0" }, capabilities: { experimentalApi: true } });
    if (!socket || socket.readyState !== WebSocket.OPEN || remaining() <= 0) fail("socket_unavailable");
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }), error => { if (error) shutdown(); });
    const thread = await send(request.method, request.params);
    // Attachment preflight is read-only.  The queue is checked before any
    // launcher is permitted to resume a saved task, because native resume can
    // consume pending input.  No thread/load/resume/turn method is sent here.
    if (input.operation === "attachment") {
      const queue = await send("thread/queue/list", { threadId: input.threadId });
      // Explicit bounded first page makes a non-null cursor an ownership
      // unknown rather than silently treating a partial inventory as absent.
      const loaded = await send("thread/loaded/list", { cursor: null, limit: 200 });
      return { thread: (thread as Record<string, unknown>).thread ?? thread, queue, loaded };
    }
    return thread;
  } catch (error) {
    if (error instanceof CodexCatalogRpcError) throw error;
    fail("socket_unavailable");
  } finally {
    clearTimeout(timer);
    settled = true;
    for (const waiter of pending.values()) waiter.reject(unavailable());
    pending.clear();
    socket?.terminate();
  }
}
