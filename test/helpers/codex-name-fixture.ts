import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";

/** Private native metadata fixture; no Codex subprocess, account, or database. */
export async function codexNameFixture(directory: string, initialName: string | null = "Native Task Name") {
  const socketPath = path.join(directory, "native.sock");
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const calls: any[] = [];
  const state = { name: initialName, available: true, parentThreadId: null as string | null, id: null as string | null };
  wss.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString());
    calls.push(message);
    if (!message.id) return;
    if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === "thread/read" && state.available) socket.send(JSON.stringify({ id: message.id, result: {
      thread: { id: state.id ?? message.params.threadId, sessionId: message.params.threadId,
        parentThreadId: state.parentThreadId, name: state.name, status: { type: "notLoaded" } },
    } }));
    else socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "unavailable" } }));
  }));
  server.listen(socketPath);
  await once(server, "listening");
  fs.chmodSync(socketPath, 0o600);
  return { socketPath, calls, state, close: async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
