import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createHttpServer } from "../src/server/http.js";
import { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

const scripts = path.resolve("plugins/wmux/scripts");

async function runHook(env: NodeJS.ProcessEnv, sessionId: string) {
  const child = spawn(process.execPath, [path.join(scripts, "wmux-context.mjs")], { env });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.resume();
  child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "A task whose words must not become the generated title." }));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const parsed = JSON.parse(output);
  assert.match(parsed.systemMessage, /^\[\[WMUX:[A-Za-z0-9_-]{22}\]\]$/);
  return { marker: parsed.systemMessage as string, bindingId: parsed.systemMessage.slice(7, -2) as string, output };
}

function mcp(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path.join(scripts, "wmux-mcp.mjs")], { env });
  child.stderr.resume();
  let next = 0;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message.result);
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("MCP child exited")); }
    pending.clear();
  });
  return {
    child,
    request(method: string, params: object = {}) {
      const id = ++next;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP test request timed out")); }, 12_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  await done;
}

test("plugin handshake crosses real HTTP and live PTY output without inherited pane identity", { timeout: 40_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-wire-"));
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(path.join(home, ".wmux"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin);
  // Only the native name API is a fixture. The plugin, HTTP routes, state store,
  // SessionManager, marker parser, and PTY backend below are production code.
  fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
rl.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line),p=m.params||{},f=path.join(process.env.CODEX_HOME,'name-'+p.threadId);
  let result={};
  if(m.method==='thread/read')result={thread:{id:p.threadId,name:fs.existsSync(f)?fs.readFileSync(f,'utf8'):null}};
  if(m.method==='thread/name/set')fs.writeFileSync(f,p.name+' canonical');
  if(m.id)process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`, { mode: 0o700 });
  const machines: MachineConfig[] = [{
    id: "local", name: "Fixture", kind: "local", sessionBackend: "pty", cwd: directory,
    command: [process.execPath, "-e", "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write(d));"],
  }];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const sessions = new SessionManager(state, machines);
  const helperToken = "H".repeat(43);
  const server = await createHttpServer("127.0.0.1", state, machines, sessions, settings, {
    auth: { enabled: true, token: "B".repeat(43), helperToken, loginEnabled: false, sessionSecret: "test-only", browserAuthMode: "shared-or-login" },
    healthResolvers: { machines: async () => [], streams: async () => [] },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  fs.writeFileSync(path.join(home, ".wmux", "url"), base, { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".wmux", "helper-token"), helperToken, { mode: 0o600 });
  const env = { ...process.env, HOME: home, CODEX_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const key of Object.keys(env)) if (key.startsWith("WMUX_")) delete env[key as keyof typeof env];
  const client = mcp(env);
  const first = state.createWorkspace("local");
  const second = state.createWorkspace("local");
  const firstPane = first.tabs[0].panes[0].id;
  const secondPane = second.tabs[0].panes[0].id;
  const inspect = (sessionId: string, bindingId: string) => client.request("tools/call", { name: "get_current_wmux_session", arguments: { sessionId, bindingId } });
  const observe = async (paneId: string, sessionId: string, binding: Awaited<ReturnType<typeof runHook>>) => {
    sessions.writePane(paneId, binding.marker, 40, 36);
    let result: any;
    for (let attempt = 0; attempt < 15; attempt++) {
      result = await inspect(sessionId, binding.bindingId);
      if (!result.isError) break;
      await delay(50);
    }
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.paneId, paneId);
  };
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18" });
    const one = await runHook(env, "thread_one");
    const two = await runHook(env, "thread_two");
    assert.doesNotMatch(one.output + two.output, new RegExp(helperToken));
    await observe(firstPane, "thread_one", one);
    await observe(secondPane, "thread_two", two);
    const named = await client.request("tools/call", { name: "name_current_wmux_session", arguments: { sessionId: "thread_one", bindingId: one.bindingId, title: "Semantic Task Objective" } });
    assert.equal(named.isError, undefined, JSON.stringify(named));
    assert.equal(named.structuredContent.codexName, "Semantic Task Objective canonical");
    assert.equal(named.structuredContent.workspaceApplied, true);
    assert.equal(state.findPaneContext(firstPane)?.workspace.name, "Semantic Task Objective canonical");
    assert.notEqual(state.findPaneContext(secondPane)?.workspace.name, "Semantic Task Objective canonical");

    state.setWorkspaceTitle(first.id, "User Owned Workspace");
    const synced = await client.request("tools/call", { name: "sync_current_wmux_session", arguments: { sessionId: "thread_one", bindingId: one.bindingId } });
    assert.equal(synced.structuredContent.workspaceApplied, false);
    assert.equal(state.findPaneContext(firstPane)?.workspace.name, "User Owned Workspace");

    const replacement = await runHook(env, "thread_replacement");
    await observe(firstPane, "thread_replacement", replacement);
    const stale = await client.request("tools/call", { name: "name_current_wmux_session", arguments: { sessionId: "thread_one", bindingId: one.bindingId, title: "Must Not Apply" } });
    assert.equal(stale.isError, true);
    assert.equal(fs.readFileSync(path.join(home, "name-thread_one"), "utf8"), "Semantic Task Objective canonical");
    // A replayed old marker must not regain authority over the newer root.
    sessions.writePane(firstPane, one.marker);
    await delay(100);
    assert.equal((await inspect("thread_one", one.bindingId)).isError, true);
  } finally {
    await stop(client.child);
    sessions.disposeAll();
    const closed = once(server, "close");
    server.close();
    await closed;
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
