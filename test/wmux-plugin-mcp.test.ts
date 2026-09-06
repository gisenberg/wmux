import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";

const plugin = path.resolve("plugins/wmux/scripts/wmux-mcp.mjs"), hook = path.resolve("plugins/wmux/scripts/wmux-context.mjs"), config = path.resolve("plugins/wmux/.mcp.json");
const sessionId = "session_one", bindingId = "B".repeat(22), receipt = "R".repeat(43);
function fakeCodex(home: string) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-fake-codex-")); fs.writeFileSync(path.join(directory, "codex"), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),home=process.env.CODEX_HOME,state=path.join(home,'name'),log=path.join(home,'calls');function o(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n')}process.stdin.on('data',d=>d.toString().split('\\n').filter(Boolean).forEach(l=>{const m=JSON.parse(l);fs.appendFileSync(log,m.method+'\\n');if(m.method==='initialize')o(m.id,{});else if(m.method==='thread/read')o(m.id,{thread:{id:m.params.threadId,name:fs.existsSync(state)?fs.readFileSync(state,'utf8'):null}});else if(m.method==='thread/name/set'){fs.writeFileSync(state,process.env.FAKE_CANONICAL||m.params.name);o(m.id,{})}}));`); fs.chmodSync(path.join(directory, "codex"), 0o755); return { directory, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) }; }
function cleanEnv(home: string, fake: string) { const result = { ...process.env, HOME: home, CODEX_HOME: home, PATH: `${fake}:${process.env.PATH}` }; for (const key of Object.keys(result)) if (key.startsWith("WMUX_")) delete result[key]; return result; }
async function server(handler: http.RequestListener) { const value = http.createServer(handler); await new Promise<void>(resolve => value.listen(0, "127.0.0.1", resolve)); const address = value.address(); assert.ok(address && typeof address !== "string"); return { value, url: `http://127.0.0.1:${address.port}` }; }
function wire(home: string, url: string) { fs.mkdirSync(path.join(home, ".wmux"), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(home, ".wmux", "url"), url); fs.writeFileSync(path.join(home, ".wmux", "helper-token"), "a".repeat(32), { mode: 0o600 }); }
function mcp(environment: NodeJS.ProcessEnv) { const child = spawn(process.execPath, [plugin], { env: environment, stdio: ["pipe", "pipe", "pipe"] }); const pending = new Map<number, (v: any) => void>(); readline.createInterface({ input: child.stdout }).on("line", line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); }); let id = 0; return { child, request(method: string, params = {}) { return new Promise<any>(resolve => { const requestId = ++id; pending.set(requestId, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`); }); } }; }
async function runHook(environment: NodeJS.ProcessEnv, payload: Record<string, unknown> = {}) { return new Promise<any>((resolve, reject) => { const child = spawn(process.execPath, [hook], { env: environment, stdio: ["pipe", "pipe", "pipe"] }); let output = "", error = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => error += chunk); child.once("exit", code => code === 0 ? resolve(JSON.parse(output || "{}")) : reject(new Error(error))); child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "private prompt", ...payload })); }); }
function json(response: http.ServerResponse, body: object, status = 200) { response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); }
async function boundFixture() {
  const titles: any[] = [];
  const fixture = await server(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    if (request.url === "/api/codex-bindings") return json(response, { receipt, marker: `[[WMUX:${bindingId}]]`, expiresAt: "2030-01-01T00:00:00.000Z" });
    if (request.url === "/api/codex-bindings/resolve") { assert.deepEqual(parsed, { sessionId, receipt }); return json(response, { workspaceId: "workspace", tabId: "tab", paneId: "pane", sessionId, expiresAt: "2030-01-01T00:00:00.000Z" }); }
    if (request.url === "/api/codex-bindings/title") { titles.push(parsed); return json(response, { sessionId, workspaceId: "workspace", tabId: "tab", paneId: "pane", workspace: { id: "workspace", name: parsed.title, nameSource: "auto", tabs: [{ id: "tab", title: parsed.title, titleSource: "auto", panes: [{ id: "pane" }] }] }, workspaceApplied: true, tabApplied: true }); }
    return json(response, {}, 404);
  });
  return { fixture, titles };
}
function nameSetCalls(home: string) { return fs.existsSync(path.join(home, "calls")) ? fs.readFileSync(path.join(home, "calls"), "utf8").split("\n").filter(line => line === "thread/name/set").length : 0; }
function bindingRecord(home: string) { const directory = path.join(home, ".wmux", "codex-plugin"); const name = fs.readdirSync(directory).find(entry => /^[a-f0-9]{64}\.json$/.test(entry)); assert.ok(name); return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")); }

test("plugin MCP supports private wmux connection files and optional embedded credentials", () => { const parsed = JSON.parse(fs.readFileSync(config, "utf8")); assert.ok(parsed.mcpServers.wmux.env_vars.includes("CODEX_HOME")); assert.ok(parsed.mcpServers.wmux.env_vars.includes("WMUX_HELPER_TOKEN_PATH")); assert.equal(parsed.mcpServers.wmux.env_vars.includes("WMUX_WORKSPACE_ID"), false); });


function call(client: ReturnType<typeof mcp>, name: string, title?: string, explicitBinding = bindingId) {
  return client.request("tools/call", { name, arguments: { sessionId, bindingId: explicitBinding, ...(title === undefined ? {} : { title }) } });
}
function nameStore(home: string) { return path.join(home, ".wmux", "codex-plugin", "wmux-session-names-v1.json"); }
function noNativeCalls(home: string) { assert.equal(fs.existsSync(path.join(home, "calls")), false, "Naming must never launch or contact native Codex"); }

test("private binding names wmux semantically with no native call and reports manual title protection", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-plugin-")), fake = fakeCodex(home); let title: any;
  const fixture = await server(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    assert.equal(request.headers.authorization, `Bearer ${"a".repeat(32)}`);
    if (request.url === "/api/codex-bindings") return json(response, { receipt, marker: `[[WMUX:${bindingId}]]`, expiresAt: "2030-01-01T00:00:00.000Z" });
    if (request.url === "/api/codex-bindings/resolve") return json(response, { workspaceId: "workspace", tabId: "tab", paneId: "pane", sessionId });
    if (request.url === "/api/codex-bindings/title") {
      title = parsed;
      return json(response, { sessionId, workspaceId: "workspace", tabId: "tab", paneId: "pane",
        workspace: { id: "workspace", name: "User title", nameSource: "manual", tabs: [{ id: "tab", title: "User tab", titleSource: "manual", panes: [{ id: "pane" }] }] },
        workspaceApplied: false, tabApplied: false });
    }
    return json(response, {}, 404);
  });
  wire(home, fixture.url); const environment = cleanEnv(home, fake.directory);
  try {
    const output = await runHook(environment);
    assert.equal(output.systemMessage, `[[WMUX:${bindingId}]]`);
    assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`sessionId=${sessionId} bindingId=${bindingId}`));
    assert.doesNotMatch(JSON.stringify(output), new RegExp(receipt));
    assert.equal(bindingRecord(home).receipt, receipt);
    const client = mcp(environment);
    try {
      const named = await call(client, "name_current_wmux_session", "  Semantic   task  ");
      const result = named.result.structuredContent;
      assert.equal(result.namingMode, "wmux-owned-name");
      assert.equal(result.wmuxName, "Semantic task");
      assert.equal(result.wmuxNameSaved, true);
      assert.equal(result.nativeNameRead, false); assert.equal(result.nativeNameSet, false);
      assert.equal(result.workspaceApplied, false); assert.equal(result.tabApplied, false);
      assert.equal(result.workspaceTitle, "User title");
      assert.equal(title.title, "Semantic task"); assert.equal(title.receipt, receipt);
      assert.doesNotMatch(JSON.stringify(named), new RegExp(receipt));
      noNativeCalls(home);
    } finally { client.child.kill(); }
  } finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("stale bindings fail before changing the semantic store or contacting Codex", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-stale-")), fake = fakeCodex(home); let resolveCalls = 0;
  const fixture = await server((request, response) => {
    if (request.url === "/api/codex-bindings") return json(response, { receipt, marker: `[[WMUX:${bindingId}]]` });
    if (request.url === "/api/codex-bindings/resolve") { resolveCalls++; return json(response, {}, 409); }
    return json(response, {}, 500);
  });
  wire(home, fixture.url); const environment = cleanEnv(home, fake.directory);
  try {
    await runHook(environment); const client = mcp(environment);
    try {
      const named = await call(client, "name_current_wmux_session", "No stale name");
      assert.equal(named.result.isError, true);
      assert.match(named.result.structuredContent.error, /stale or pending/);
      assert.equal(resolveCalls, 1); assert.equal(fs.existsSync(nameStore(home)), false); noNativeCalls(home);
    } finally { client.child.kill(); }
  } finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("first task and major shifts use agent titles despite preexisting native automatic or user names", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-independent-")), fake = fakeCodex(home), { fixture, titles } = await boundFixture();
  wire(home, fixture.url); const environment = cleanEnv(home, fake.directory);
  fs.writeFileSync(path.join(home, "name"), "Native automatically generated title");
  try {
    await runHook(environment); const client = mcp(environment);
    try {
      const first = await call(client, "name_current_wmux_session", "Community Book Exchange");
      assert.equal(first.result.structuredContent.workspaceTitle, "Community Book Exchange");
      assert.equal(first.result.structuredContent.workspaceApplied, true);
      assert.equal(fs.readFileSync(path.join(home, "name"), "utf8"), "Native automatically generated title");
      fs.writeFileSync(path.join(home, "name"), "User native rename");
      const sync = await call(client, "sync_current_wmux_session");
      assert.equal(sync.result.structuredContent.wmuxName, "Community Book Exchange");
      const shift = await call(client, "name_current_wmux_session", "Garden Volunteer Onboarding");
      assert.equal(shift.result.structuredContent.wmuxName, "Garden Volunteer Onboarding");
      assert.equal(titles.at(-1).title, "Garden Volunteer Onboarding");
      assert.equal(fs.readFileSync(path.join(home, "name"), "utf8"), "User native rename");
      noNativeCalls(home);
    } finally { client.child.kill(); }
  } finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("follow-up sync and Stop reuse durable wmux name across new receipts and MCP processes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-resync-")), fake = fakeCodex(home), { fixture, titles } = await boundFixture();
  wire(home, fixture.url); const environment = cleanEnv(home, fake.directory);
  try {
    await runHook(environment);
    const first = mcp(environment);
    try { await call(first, "name_current_wmux_session", "Persistent Semantic Task"); }
    finally { first.child.kill(); }
    // A fresh prompt receipt has no per-binding lastName. Persist by thread.
    const runtime = path.join(home, ".wmux", "codex-plugin");
    const record = { ...bindingRecord(home), bindingId: "C".repeat(22), promptTurnId: "turn_two" };
    const { createHash } = await import("node:crypto");
    const file = createHash("sha256").update(`${sessionId}\0${record.bindingId}`).digest("hex") + ".json";
    fs.writeFileSync(path.join(runtime, file), JSON.stringify(record), { mode: 0o600 });
    const second = mcp(environment);
    try {
      const sync = await call(second, "sync_current_wmux_session", undefined, record.bindingId);
      assert.equal(sync.result.structuredContent.wmuxName, "Persistent Semantic Task");
      const before = titles.length;
      await runHook(environment, { hook_event_name: "Stop", turn_id: "turn_two" });
      assert.equal(titles.length, before + 1);
      assert.equal(titles.at(-1).title, "Persistent Semantic Task"); noNativeCalls(home);
    } finally { second.child.kill(); }
  } finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("no saved wmux title skips sync without importing legacy native provenance", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-no-name-")), fake = fakeCodex(home), { fixture, titles } = await boundFixture();
  wire(home, fixture.url); const environment = cleanEnv(home, fake.directory);
  try {
    await runHook(environment);
    fs.writeFileSync(path.join(home, ".wmux", "codex-plugin", "native-name-ownership-v1.json"), "obsolete corrupt native state", { mode: 0o600 });
    const client = mcp(environment);
    try {
      const result = await call(client, "sync_current_wmux_session");
      assert.equal(result.result.structuredContent.wmuxNameSaved, false);
      assert.match(result.result.structuredContent.skipped, /No wmux semantic name/);
      assert.equal(titles.length, 0);
      assert.equal((await call(client, "name_current_wmux_session", "New Agent Title")).result.isError, undefined);
      noNativeCalls(home);
    } finally { client.child.kill(); }
  } finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("corrupt semantic store fails closed before applying a title", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-corrupt-")), fake = fakeCodex(home), { fixture, titles } = await boundFixture();
  wire(home, fixture.url); const environment = cleanEnv(home, fake.directory);
  try {
    await runHook(environment); fs.writeFileSync(nameStore(home), "not json", { mode: 0o600 });
    const client = mcp(environment);
    try {
      for (const method of ["name_current_wmux_session", "sync_current_wmux_session"]) {
        const result = await call(client, method, method.startsWith("name_") ? "Must not apply" : undefined);
        assert.equal(result.result.isError, true);
        assert.equal(result.result.structuredContent.wmuxNameSaved, false);
      }
      assert.equal(titles.length, 0); noNativeCalls(home);
    } finally { client.child.kill(); }
  } finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

for (const status of [409, 503]) test(`title delivery ${status} cannot persist a rejected name for later sync`, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-retry-")), fake = fakeCodex(home); let fail = true, applied = "";
  const fixture = await server(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    if (request.url === "/api/codex-bindings") return json(response, { receipt, marker: `[[WMUX:${bindingId}]]` });
    if (request.url === "/api/codex-bindings/resolve") return json(response, { sessionId, workspaceId: "workspace", tabId: "tab", paneId: "pane" });
    if (request.url === "/api/codex-bindings/title") {
      if (fail) return json(response, {}, status);
      applied = parsed.title;
      return json(response, { sessionId, workspaceId: "workspace", tabId: "tab", paneId: "pane", workspace: { id: "workspace", name: applied, nameSource: "auto", tabs: [{ id: "tab", title: applied, titleSource: "auto", panes: [{ id: "pane" }] }] }, workspaceApplied: true, tabApplied: true });
    }
    return json(response, {}, 404);
  });
  wire(home, fixture.url); const environment = cleanEnv(home, fake.directory);
  try {
    await runHook(environment); const client = mcp(environment);
    try {
      const failed = (await call(client, "name_current_wmux_session", "Retry This Task")).result;
      assert.equal(failed.isError, true); assert.equal(failed.structuredContent.wmuxNameSaved, false);
      assert.equal(fs.existsSync(nameStore(home)), false);
      assert.equal(failed.structuredContent.workspaceApplied, false);
      assert.equal(failed.structuredContent.retry, "name_current_wmux_session");
      fail = false;
      const sync = (await call(client, "sync_current_wmux_session")).result;
      assert.equal(sync.structuredContent.wmuxNameSaved, false); assert.equal(applied, "");
      const retry = (await call(client, "name_current_wmux_session", "Accepted Task")).result;
      assert.equal(retry.isError, undefined); assert.equal(retry.structuredContent.workspaceApplied, true);
      assert.equal(applied, "Accepted Task");
      fail = true;
      assert.equal((await call(client, "name_current_wmux_session", "Rejected Shift")).result.isError, true);
      fail = false;
      await call(client, "sync_current_wmux_session");
      assert.equal(applied, "Accepted Task"); noNativeCalls(home);
    } finally { client.child.kill(); }
  } finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("store failure after title acceptance reports applied but unsaved and cannot be repaired by sync", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-store-failure-")), fake = fakeCodex(home);
  let titleCalls = 0;
  const fixture = await server(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    if (request.url === "/api/codex-bindings") return json(response, { receipt, marker: `[[WMUX:${bindingId}]]` });
    if (request.url === "/api/codex-bindings/resolve") return json(response, { sessionId, workspaceId: "workspace", tabId: "tab", paneId: "pane" });
    if (request.url === "/api/codex-bindings/title") {
      titleCalls++;
      // Simulate storage becoming unsafe after its preflight and before save.
      fs.writeFileSync(nameStore(home), "unreadable", { mode: 0o600 });
      return json(response, { sessionId, workspaceId: "workspace", tabId: "tab", paneId: "pane", workspace: { id: "workspace", name: parsed.title, nameSource: "auto", tabs: [{ id: "tab", title: parsed.title, titleSource: "auto", panes: [{ id: "pane" }] }] }, workspaceApplied: true, tabApplied: true });
    }
    return json(response, {}, 404);
  });
  wire(home, fixture.url); const environment = cleanEnv(home, fake.directory);
  try {
    await runHook(environment); const client = mcp(environment);
    try {
      const failed = (await call(client, "name_current_wmux_session", "Accepted Unsaved Title")).result;
      assert.equal(failed.isError, true);
      assert.equal(failed.structuredContent.workspaceApplied, true);
      assert.equal(failed.structuredContent.workspaceTitle, "Accepted Unsaved Title");
      assert.equal(failed.structuredContent.wmuxNameSaved, false);
      assert.equal(failed.structuredContent.retry, "name_current_wmux_session");
      assert.equal(fs.readFileSync(nameStore(home), "utf8"), "unreadable");
      fs.unlinkSync(nameStore(home)); // Repair only this fixture's failed store.
      const sync = (await call(client, "sync_current_wmux_session")).result;
      assert.equal(sync.structuredContent.wmuxNameSaved, false);
      assert.match(sync.structuredContent.skipped, /No wmux semantic name/);
      assert.equal(titleCalls, 1); noNativeCalls(home);
    } finally { client.child.kill(); }
  } finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("invalid titles, manual mode, absent binding and child hooks cannot change a wmux title", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-invalid-")), fake = fakeCodex(home), { fixture, titles } = await boundFixture();
  wire(home, fixture.url); const environment = cleanEnv(home, fake.directory);
  try {
    assert.deepEqual(await runHook(environment, { agent_id: "child" }), {});
    await runHook(environment); const client = mcp(environment);
    try {
      for (const title of ["", "x".repeat(81), "Bad\u0000Title"]) assert.equal((await call(client, "name_current_wmux_session", title)).result.isError, true);
      const manual = await client.request("tools/call", { name: "name_current_wmux_session", arguments: { sessionId, bindingId, title: "Manual", mode: "manual" } });
      assert.equal(manual.result.isError, true);
      assert.equal((await call(client, "name_current_wmux_session", "Absent binding", "D".repeat(22))).result.isError, true);
      assert.equal(titles.length, 0); noNativeCalls(home);
    } finally { client.child.kill(); }
  } finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("a configured empty helper file never falls back to the broad token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-helper-")), fake = fakeCodex(home); let calls = 0;
  const fixture = await server((_request, response) => { calls++; json(response, {}); });
  wire(home, fixture.url); fs.writeFileSync(path.join(home, ".wmux", "helper-token"), "", { mode: 0o600 }); fs.writeFileSync(path.join(home, ".wmux", "token"), "b".repeat(32), { mode: 0o600 });
  try { const output = await runHook(cleanEnv(home, fake.directory)); assert.match(output.systemMessage, /unavailable/); assert.equal(calls, 0); }
  finally { fixture.value.close(); fake.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});
