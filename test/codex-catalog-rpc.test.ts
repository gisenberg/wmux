import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { queryCodexCatalog } from "../src/server/codex-catalog-rpc.js";

async function fixture(t: test.TestContext, respond: (message: Record<string, unknown>, socket: import("ws").WebSocket) => unknown = message => ({ method: message.method })) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-catalog-rpc-"));
  const socketPath = path.join(directory, "native.sock");
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const messages: Record<string, unknown>[] = [];
  wss.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    messages.push(message);
    if (typeof message.id !== "number") return;
    const result = respond(message, socket);
    if (result !== undefined) socket.send(JSON.stringify({ id: message.id, result }));
  }));
  server.listen(socketPath);
  await once(server, "listening");
  fs.chmodSync(socketPath, 0o600);
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, socketPath, messages, wss };
}

const unavailable = (promise: Promise<unknown>, reason: string) => assert.rejects(promise, (error: unknown) =>
  typeof error === "object" && error !== null && (error as { reason?: unknown }).reason === reason);

test("catalog RPC sends only bounded, allowlisted list/read/turns requests", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  assert.deepEqual(await queryCodexCatalog({ socketPath: f.socketPath, operation: "list", cursor: "page", archived: true }), { method: "thread/list" });
  assert.deepEqual(await queryCodexCatalog({ socketPath: f.socketPath, operation: "read", threadId: "thr_123" }), { method: "thread/read" });
  assert.deepEqual(await queryCodexCatalog({ socketPath: f.socketPath, operation: "turns", threadId: "thr_123", cursor: null }), { method: "thread/turns/list" });
  const rpc = f.messages.filter(message => typeof message.id === "number");
  assert.deepEqual(rpc.map(message => message.method), ["initialize", "thread/list", "initialize", "thread/read", "initialize", "thread/turns/list"]);
  assert.deepEqual(rpc[1].params, { limit: 40, cursor: "page", archived: true, useStateDbOnly: true, sourceKinds: [] });
  assert.deepEqual(rpc[3].params, { threadId: "thr_123", includeTurns: false });
  assert.deepEqual(rpc[5].params, { threadId: "thr_123", cursor: null, limit: 8, sortDirection: "desc", itemsView: "summary" });
});

test("attachment preflight is read-only and checks queue plus loaded ownership", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, message => ({ method: message.method, params: message.params }));
  const result = await queryCodexCatalog({ socketPath: f.socketPath, operation: "attachment", threadId: "thr_123" }) as any;
  assert.equal(result.thread.method, "thread/read");
  assert.equal(result.queue.method, "thread/queue/list");
  assert.equal(result.loaded.method, "thread/loaded/list");
  assert.deepEqual(result.loaded.params, { cursor: null, limit: 200 });
  assert.deepEqual(f.messages.filter(message => typeof message.id === "number").map(message => message.method), ["initialize", "thread/read", "thread/queue/list", "thread/loaded/list"]);
});

test("catalog RPC validates exact thread IDs and bounded pagination before connecting", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await unavailable(queryCodexCatalog({ socketPath: f.socketPath, operation: "read" }), "invalid_request");
  await unavailable(queryCodexCatalog({ socketPath: f.socketPath, operation: "read", threadId: "other/thread" }), "invalid_request");
  await unavailable(queryCodexCatalog({ socketPath: f.socketPath, operation: "turns", threadId: "thr_1", cursor: "x".repeat(4097) }), "invalid_request");
  await unavailable(queryCodexCatalog({ socketPath: f.socketPath, operation: "list", archived: "yes" as unknown as boolean }), "invalid_request");
  assert.deepEqual(f.messages, []);
});

test("catalog RPC ignores malicious server requests and never answers them", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, (message, socket) => {
    if (message.method === "thread/read") socket.send(JSON.stringify({ id: 91, method: "item/commandExecution/requestApproval", params: {} }));
    return { safe: true };
  });
  assert.deepEqual(await queryCodexCatalog({ socketPath: f.socketPath, operation: "read", threadId: "thr_123" }), { safe: true });
  assert.deepEqual(f.messages.map(message => message.method), ["initialize", "initialized", "thread/read"]);
});

test("catalog RPC fails closed for non-private sockets and symlinked ancestors", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  fs.chmodSync(f.socketPath, 0o666);
  await unavailable(queryCodexCatalog({ socketPath: f.socketPath, operation: "list" }), "socket_unavailable");
  fs.chmodSync(f.socketPath, 0o600);
  const linkedParent = path.join(f.directory, "linked");
  fs.symlinkSync(f.directory, linkedParent);
  await unavailable(queryCodexCatalog({ socketPath: path.join(linkedParent, "native.sock"), operation: "list" }), "socket_unavailable");
  assert.deepEqual(f.messages, []);
});

test("catalog RPC applies one deadline to handshake and response", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, message => message.method === "initialize" ? {} : undefined);
  const started = Date.now();
  await unavailable(queryCodexCatalog({ socketPath: f.socketPath, operation: "list" }), "socket_unavailable");
  assert.ok(Date.now() - started < 4_600);
});

test("catalog RPC rejects an oversized native response", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, message => message.method === "initialize" ? {} : { payload: "x".repeat(2 * 1024 * 1024 + 1) });
  await unavailable(queryCodexCatalog({ socketPath: f.socketPath, operation: "list" }), "socket_unavailable");
});

test("SSH bridge waits for complete chunked UTF-8 input and bounds incomplete input", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, message => ({ params: message.params }));
  // Exercise the deployed bridge verbatim, resolving its one build import to
  // source so this test also runs in clean checkouts before npm run build.
  const source = fs.readFileSync(new URL("../scripts/codex-catalog-bridge.mjs", import.meta.url), "utf8")
    .replace("../dist/server/codex-catalog-rpc.js", new URL("../src/server/codex-catalog-rpc.ts", import.meta.url).href);
  const run = async (chunks: Buffer[], end = true): Promise<Record<string, unknown>> => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { child.kill(); });
    let output = "", errors = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
    child.stdin.on("error", () => {});
    const finished = once(child, "exit");
    for (const chunk of chunks) {
      child.stdin.write(chunk);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (end) child.stdin.end();
    const [code] = await finished;
    assert.equal(code, 0, errors);
    return JSON.parse(output) as Record<string, unknown>;
  };
  const input = Buffer.from(JSON.stringify({ socketPath: f.socketPath, operation: "list", cursor: "分頁😀" }));
  const split = input.indexOf(Buffer.from("😀")) + 2;
  const result = await run([input.subarray(0, split), input.subarray(split)]);
  assert.equal(result.ok, true);
  assert.equal(((result.result as { params: { cursor: string } }).params).cursor, "分頁😀");
  const started = Date.now();
  assert.deepEqual(await run([Buffer.from("{")], false), { ok: false, error: "invalid_request" });
  assert.ok(Date.now() - started < 6_000);
  assert.deepEqual(await run([Buffer.alloc(16 * 1024 + 1, "x")]), { ok: false, error: "invalid_request" });
});
