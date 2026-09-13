import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import test from "node:test";
import { createHash } from "node:crypto";
import { codexNameFixture } from "./helpers/codex-name-fixture.js";

const scripts = path.resolve("plugins/wmux/scripts");
const sessionId = "root", bindingId = "B".repeat(22), receipt = "R".repeat(43);

async function fixture(t: any) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-name-mcp-"));
  const native = await codexNameFixture(home);
  const runtime = path.join(home, ".wmux", "codex-plugin");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const recordPath = path.join(runtime, createHash("sha256").update(`${sessionId}\0${bindingId}`).digest("hex") + ".json");
  fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 2, sessionId, bindingId, receipt, createdAt: Date.now(), promptTurnId: null }), { mode: 0o600 });
  const requests: any[] = [], titles: string[] = [];
  const state = { resolveStatus: 200, titleStatus: 200, pinned: false };
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); requests.push({ url: req.url, body: value });
    assert.equal(req.headers.authorization, `Bearer ${"a".repeat(32)}`);
    assert.equal(value.sessionId, sessionId);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/codex-bindings") return res.end(JSON.stringify({ receipt, marker: `[[WMUX:${bindingId}]]` }));
    if (req.url === "/api/codex-bindings/revoke") {
      assert.deepEqual(value.receipts, [receipt]); return res.end(JSON.stringify({ revoked: true }));
    }
    assert.equal(value.receipt, receipt);
    if (req.url?.endsWith("resolve")) {
      res.statusCode = state.resolveStatus;
      return res.end(JSON.stringify({ sessionId, workspaceId: "workspace", tabId: "tab", paneId: "pane" }));
    }
    assert.ok(req.url?.endsWith("title"));
    res.statusCode = state.titleStatus;
    if (state.titleStatus !== 200) return res.end("{}");
    titles.push(value.title);
    const title = state.pinned ? "Pinned" : value.title;
    res.end(JSON.stringify({ sessionId, workspaceId: "workspace", tabId: "tab", paneId: "pane",
      workspace: { id: "workspace", name: title, nameSource: state.pinned ? "user" : "auto",
        tabs: [{ id: "tab", title, titleSource: state.pinned ? "user" : "auto", panes: [{ id: "pane" }] }] },
      workspaceApplied: !state.pinned, tabApplied: !state.pinned }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  fs.writeFileSync(path.join(home, ".wmux", "url"), `http://127.0.0.1:${address.port}`);
  fs.writeFileSync(path.join(home, ".wmux", "helper-token"), "a".repeat(32), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith("WMUX_")) delete env[key];
  env.WMUX_CODEX_SOCKET_PATH = native.socketPath;
  const child = spawn(process.execPath, [path.join(scripts, "wmux-mcp.mjs")], { env });
  child.stderr.resume();
  let sequence = 0;
  const pending = new Map<number, (value: any) => void>();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line); pending.get(message.id)?.(message.result); pending.delete(message.id);
  });
  const request = (method: string, params: object = {}) => new Promise<any>(resolve => {
    const id = ++sequence; pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const call = async (name = "sync_current_wmux_session", extra = {}) => request("tools/call", { name, arguments: { sessionId, bindingId, ...extra } });
  t.after(async () => {
    const exited = once(child, "exit"); child.kill(); await exited;
    await native.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, native, titles, requests, state, request, call, env };
}

test("MCP advertises native mirroring, negotiates protocol, and never exposes a private receipt", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("initialize", { protocolVersion: "2025-06-18" })).protocolVersion, "2025-06-18");
  const list = await f.request("tools/list");
  assert.deepEqual(list.tools.map((v: any) => v.name), ["get_current_wmux_session", "name_current_wmux_session", "sync_current_wmux_session"]);
  const synced = await f.call();
  assert.equal(synced.structuredContent.namingMode, "native-name-mirror");
  assert.equal(synced.structuredContent.nativeNameRead, true);
  assert.equal(synced.structuredContent.nativeNameSet, false);
  assert.equal(synced.structuredContent.workspaceTitle, "Native Task Name");
  assert.doesNotMatch(JSON.stringify(synced), new RegExp(receipt));
  assert.ok(f.native.calls.every(m => ["initialize", "initialized", "thread/read"].includes(m.method)));
  assert.ok(f.native.calls.filter(m => m.method === "thread/read").every(m => m.params.threadId === sessionId && m.params.includeTurns === false));
});

test("native automatic titles and later desktop renames win over legacy stores and proposed semantic names", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.home, ".wmux", "codex-plugin", "wmux-session-names-v1.json"), "obsolete corrupt state");
  await f.call("name_current_wmux_session", { title: "Agent proposal" });
  f.native.state.name = "Desktop Rename";
  await f.call();
  assert.deepEqual(f.titles, ["Native Task Name", "Desktop Rename"]);
  assert.equal(fs.readFileSync(path.join(f.home, ".wmux", "codex-plugin", "wmux-session-names-v1.json"), "utf8"), "obsolete corrupt state");
});

test("manual pins survive sync; explicit unpin permits the current native name", async t => {
  const f = await fixture(t); f.state.pinned = true;
  const pinned = (await f.call()).structuredContent;
  assert.equal(pinned.workspaceApplied, false); assert.equal(pinned.tabApplied, false);
  assert.equal(pinned.workspaceTitle, "Pinned");
  f.native.state.name = "Rename While Pinned";
  await f.call();
  f.state.pinned = false;
  assert.equal((await f.call()).structuredContent.workspaceTitle, "Rename While Pinned");
});

test("missing, unrepresentable, child and wrong-thread names leave wmux unchanged", async t => {
  const f = await fixture(t);
  for (const name of [null, "", "x".repeat(513), "a" + "\u0301".repeat(4096), "Bad\u0000Title"]) {
    f.native.state.name = name; await f.call();
  }
  f.native.state.name = "Child"; f.native.state.parentThreadId = "parent";
  assert.equal((await f.call()).isError, true);
  f.native.state.parentThreadId = null; f.native.state.id = "other";
  assert.equal((await f.call()).isError, true);
  assert.deepEqual(f.titles, []);
});

test("bounded long names and native whitespace mirror without rewriting", async t => {
  const f = await fixture(t);
  for (const name of ["x".repeat(512), " Exact  native whitespace! ", "👩‍💻".repeat(100)]) {
    f.native.state.name = name;
    const response = await f.call();
    assert.equal(response.structuredContent.workspaceTitle, name);
  }
});

test("stale receipt and absent binding fail before any native read", async t => {
  const f = await fixture(t); f.state.resolveStatus = 409;
  assert.equal((await f.call()).isError, true);
  assert.equal((await f.call("sync_current_wmux_session", { bindingId: "D".repeat(22) })).isError, true);
  assert.deepEqual(f.native.calls, []); assert.deepEqual(f.titles, []);
});

test("unavailable server and rejected title delivery recover using a fresh native read", async t => {
  const f = await fixture(t); f.native.state.available = false;
  assert.equal((await f.call()).isError, true); assert.deepEqual(f.titles, []);
  f.native.state.available = true; f.state.titleStatus = 409;
  assert.equal((await f.call()).isError, true);
  f.state.titleStatus = 503;
  assert.equal((await f.call()).isError, true);
  f.state.titleStatus = 200; f.native.state.name = "Latest Accepted Name";
  assert.equal((await f.call()).structuredContent.workspaceTitle, "Latest Accepted Name");
  assert.deepEqual(f.titles, ["Latest Accepted Name"]);
});

test("manual mode and empty helper credentials cannot acquire title authority", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("name_current_wmux_session", { title: "Manual", mode: "manual" })).isError, true);
  fs.writeFileSync(path.join(f.home, ".wmux", "helper-token"), "");
  fs.writeFileSync(path.join(f.home, ".wmux", "token"), "b".repeat(32));
  assert.equal((await f.call()).isError, true);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.native.calls, []);
});

test("plugin forwards an explicit private socket route, never inherited pane identity", () => {
  const config = JSON.parse(fs.readFileSync("plugins/wmux/.mcp.json", "utf8")).mcpServers.wmux;
  assert.ok(config.env_vars.includes("WMUX_CODEX_SOCKET_PATH"));
  assert.equal(config.env_vars.includes("WMUX_WORKSPACE_ID"), false);
});

test("SessionEnd revokes exact stored receipts without a turn ID; child hooks cannot revoke the root", async t => {
  const f = await fixture(t);
  async function end(agent_id?: string) {
    const child = spawn(process.execPath, [path.join(scripts, "wmux-context.mjs")], { env: f.env });
    child.stdout.resume(); child.stderr.resume();
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, agent_id }));
    const [code] = await once(child, "exit"); assert.equal(code, 0);
  }
  await end("child"); assert.deepEqual(f.requests, []);
  await f.call();
  await end();
  assert.equal(f.requests.at(-1).url, "/api/codex-bindings/revoke");
  assert.equal((await f.call()).isError, true);
  assert.equal(f.titles.length, 1);
});
