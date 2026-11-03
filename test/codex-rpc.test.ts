import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { connectCodexObservationBatch, connectCodexObserver } from "../plugins/wmux/scripts/codex-rpc.mjs";

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
        if (result !== undefined) socket.send(JSON.stringify(result?.__error ? { id: message.id, error: result.__error } : { id: message.id, result }));
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

test("read-only Codex transport connects over a private Unix socket and bounds every request", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
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

test("read-only Codex transport cannot drive, resume, answer, or select another thread", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
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

test("read-only Codex transport rejects unsafe socket and parent permissions without connecting", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
  const f = await fixture(t);
  fs.chmodSync(f.socketPath, 0o666);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: f.socketPath }));
  fs.chmodSync(f.socketPath, 0o600);
  fs.chmodSync(f.directory, 0o755);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: f.socketPath }));
  fs.chmodSync(f.directory, 0o700);
  const ancestor = path.join(f.directory, "ancestor-link");
  fs.symlinkSync(f.directory, ancestor);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: path.join(ancestor, "native.sock") }));
  assert.deepEqual(f.messages, []);
});

test("read-only Codex transport accepts a private native socket alias and follows replacement on reconnect", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
  const first = await fixture(t, () => ({ endpoint: "first" }));
  const second = await fixture(t, () => ({ endpoint: "second" }));
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-control-"));
  t.after(() => fs.rmSync(control, { recursive: true, force: true }));
  const alias = path.join(control, "control.sock");
  fs.symlinkSync(first.socketPath, alias);
  const a = await connectCodexObserver({ threadId: "root", socketPath: alias });
  t.after(() => a.close());
  assert.deepEqual(await a.request("thread/read", { threadId: "root" }), { endpoint: "first" });
  fs.unlinkSync(alias);
  fs.symlinkSync(second.socketPath, alias);
  const b = await connectCodexObservationBatch({ threadIds: ["root"], socketPath: alias });
  t.after(() => b.close());
  assert.deepEqual(await b.request("thread/read", { threadId: "root" }), { endpoint: "second" });
  assert.deepEqual(await a.request("thread/read", { threadId: "root" }), { endpoint: "first" });
});

test("socket aliases cannot bypass private parents, socket permissions or direct-target validation", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
  const target = await fixture(t);
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-control-"));
  t.after(() => fs.rmSync(control, { recursive: true, force: true }));
  const alias = path.join(control, "control.sock");
  fs.symlinkSync(target.socketPath, alias);
  fs.chmodSync(control, 0o755);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: alias }));
  fs.chmodSync(control, 0o700);
  fs.chmodSync(target.directory, 0o755);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: alias }));
  fs.chmodSync(target.directory, 0o700);
  fs.chmodSync(target.socketPath, 0o666);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: alias }));
  fs.chmodSync(target.socketPath, 0o600);
  const intermediate = path.join(target.directory, "intermediate.sock");
  fs.symlinkSync(target.socketPath, intermediate);
  fs.unlinkSync(alias);
  fs.symlinkSync(intermediate, alias);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: alias }));
  fs.unlinkSync(alias);
  fs.symlinkSync(path.join(target.directory, "missing.sock"), alias);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: alias }));
  fs.unlinkSync(alias);
  const file = path.join(target.directory, "file");
  fs.writeFileSync(file, "not a socket", { mode: 0o600 });
  fs.symlinkSync(file, alias);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: alias }));
  fs.unlinkSync(alias);
  const linkedParent = path.join(control, "linked-parent");
  fs.symlinkSync(target.directory, linkedParent);
  fs.symlinkSync(path.join(linkedParent, "native.sock"), alias);
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: alias }));
  assert.deepEqual(target.messages, []);
});

test("an alias replaced during connection sends no native RPC", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const alias = path.join(first.directory, "control.sock");
  fs.symlinkSync(first.socketPath, alias);
  first.wss.on("connection", () => {
    fs.unlinkSync(alias);
    fs.symlinkSync(second.socketPath, alias);
  });
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: alias }));
  assert.deepEqual(first.messages, []);
  assert.deepEqual(second.messages, []);
});

test("unsupported native metadata capability remains a sanitized endpoint reason", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
  const f = await fixture(t, m => m.method === "initialize" ? { __error: { code: -32601, message: "no" } } : {});
  await assert.rejects(connectCodexObserver({ threadId: "root", socketPath: f.socketPath }), (error: any) => error?.reason === "unsupported_endpoint");
});

test("read-only Codex transport rejects pending operations when its local connection closes", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
  const f = await fixture(t, m => m.method === "initialize" ? {} : undefined);
  const client = await connectCodexObserver({ threadId: "root", socketPath: f.socketPath });
  const pending = client.request("thread/read", { threadId: "root" });
  const rejected = assert.rejects(pending, /observation is unavailable/);
  client.close();
  await rejected;
  await assert.rejects(client.request("thread/read", { threadId: "root" }));
});

test("read-only Codex transport fails closed on malformed native messages", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
  const f = await fixture(t, m => m.method === "initialize" ? {} : undefined);
  const client = await connectCodexObserver({ threadId: "root", socketPath: f.socketPath });
  t.after(() => client.close());
  const pending = assert.rejects(client.request("thread/read", { threadId: "root" }), /observation is unavailable/);
  for (const socket of f.wss.clients) socket.send("not json");
  await pending;
});

test("two recorded Unix endpoints retain separate bounded batch scopes", { skip: process.platform === "win32" ? "requires POSIX host facilities" : false }, async t => {
  const first = await fixture(t, m => ({ endpoint: "first", id: m.params?.threadId }));
  const second = await fixture(t, m => ({ endpoint: "second", id: m.params?.threadId }));
  const a = await connectCodexObservationBatch({ threadIds: ["same_root", "first_only"], socketPath: first.socketPath });
  const b = await connectCodexObservationBatch({ threadIds: ["same_root", "second_only"], socketPath: second.socketPath });
  t.after(() => { a.close(); b.close(); });
  assert.deepEqual(await a.request("thread/read", { threadId: "same_root" }), { endpoint: "first", id: "same_root" });
  assert.deepEqual(await b.request("thread/read", { threadId: "same_root" }), { endpoint: "second", id: "same_root" });
  await assert.rejects(a.request("thread/read", { threadId: "second_only" }), /observation is unavailable/);
  await assert.rejects(b.request("thread/read", { threadId: "first_only" }), /observation is unavailable/);
  assert.deepEqual(first.messages.filter(m => m.method === "thread/read").map(m => m.params.threadId), ["same_root"]);
  assert.deepEqual(second.messages.filter(m => m.method === "thread/read").map(m => m.params.threadId), ["same_root"]);
});
