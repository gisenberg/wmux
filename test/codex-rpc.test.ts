import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { connectCodexObserver } from "../plugins/wmux/scripts/codex-rpc.mjs";

async function fixture(t: any, respond: (message: any) => unknown = () => ({})) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-rpc-"));
  const socketPath = path.join(directory, "native.sock");
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const messages: any[] = [];
  let extensions = "", userAgent: string | undefined;
  wss.on("connection", (socket, request) => {
    extensions = socket.extensions;
    userAgent = request.headers["user-agent"];
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.id) {
        const result = respond(message);
        if (result !== undefined) socket.send(JSON.stringify({ id: message.id, result }));
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  fs.chmodSync(socketPath, 0o600);
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { socketPath, directory, messages, wss, details: () => ({ extensions, userAgent }) };
}

test("read-only Codex transport connects over a private Unix socket and bounds every request", async t => {
  const f = await fixture(t, m => ({ method: m.method }));
  const client = await connectCodexObserver({ threadId: "root_thread", socketPath: f.socketPath });
  t.after(() => client.close());
  assert.deepEqual(await client.request("thread/read", { threadId: "root_thread", includeTurns: true, unexpected: "discard" }), { method: "thread/read" });
  await client.request("thread/turns/list", { threadId: "root_thread", limit: 9999, itemsView: "full" });
  assert.deepEqual(f.details(), { extensions: "", userAgent: undefined });
  assert.deepEqual(f.messages.map(m => m.method), ["initialize", "initialized", "thread/read", "thread/turns/list"]);
  assert.deepEqual(f.messages[2].params, { threadId: "root_thread", includeTurns: false });
  assert.deepEqual(f.messages[3].params, { threadId: "root_thread", cursor: null, limit: 8, sortDirection: "desc", itemsView: "notLoaded" });
});

test("read-only Codex transport cannot drive, resume, answer, or select another thread", async t => {
  const f = await fixture(t);
  const client = await connectCodexObserver({ threadId: "root", socketPath: f.socketPath });
  t.after(() => client.close());
  for (const method of ["thread/resume", "turn/start", "thread/name/set", "thread/queue/add", "thread/increment_elicitation", "tool/requestUserInput"]) {
    await assert.rejects(client.request(method, { threadId: "root" }), /observation is unavailable/);
  }
  await assert.rejects(client.request("thread/read", { threadId: "other" }));
  await assert.rejects(client.request("thread/turns/list", { threadId: "root", cursor: "x".repeat(4097) }));
  // Sending a server permission request must not produce any client answer.
  for (const socket of f.wss.clients) socket.send(JSON.stringify({ id: 87, method: "item/commandExecution/requestApproval", params: { threadId: "root" } }));
  await client.request("thread/read", { threadId: "root" });
  assert.deepEqual(f.messages.map(m => m.method), ["initialize", "initialized", "thread/read"]);
});

test("read-only Codex transport rejects unsafe socket and parent permissions without connecting", async t => {
  const f = await fixture(t);
  fs.chmodSync(f.socketPath, 0o666);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: f.socketPath }));
  fs.chmodSync(f.socketPath, 0o600);
  fs.chmodSync(f.directory, 0o755);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: f.socketPath }));
  fs.chmodSync(f.directory, 0o700);
  const link = path.join(f.directory, "link.sock");
  fs.symlinkSync(f.socketPath, link);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: link }));
  assert.deepEqual(f.messages, []);
});

test("read-only Codex transport rejects pending operations when its local connection closes", async t => {
  const f = await fixture(t, m => m.method === "initialize" ? {} : undefined);
  const client = await connectCodexObserver({ threadId: "root", socketPath: f.socketPath });
  const pending = client.request("thread/read", { threadId: "root" });
  const rejected = assert.rejects(pending, /observation is unavailable/);
  client.close();
  await rejected;
  await assert.rejects(client.request("thread/read", { threadId: "root" }));
});

test("read-only Codex transport fails closed on malformed native messages", async t => {
  const f = await fixture(t, m => m.method === "initialize" ? {} : undefined);
  const client = await connectCodexObserver({ threadId: "root", socketPath: f.socketPath });
  t.after(() => client.close());
  const pending = assert.rejects(client.request("thread/read", { threadId: "root" }), /observation is unavailable/);
  for (const socket of f.wss.clients) socket.send("not json");
  await pending;
});
