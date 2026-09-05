import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";

const plugin = path.resolve("plugins/wmux/scripts/wmux-mcp.mjs");
const pluginConfig = path.resolve("plugins/wmux/.mcp.json");

test("plugin prompt hook supplies bounded instructions only inside a complete wmux binding", () => {
  const script = path.resolve("plugins/wmux/scripts/wmux-context.mjs");
  const env = { ...process.env, WMUX_WORKSPACE_ID: "ws_test", WMUX_TAB_ID: "tab_test", WMUX_PANE_ID: "pane_test", WMUX_TOKEN: "never-output-this-secret" };
  const invoke = () => execFileSync(process.execPath, [script], { env, encoding: "utf8", input: '{"prompt":"private user prompt"}' });
  const output = invoke();
  const context = JSON.parse(output).hookSpecificOutput;
  assert.equal(context.hookEventName, "UserPromptSubmit");
  assert.match(context.additionalContext, /overall objective materially changes/);
  assert.match(context.additionalContext, /workspaceApplied/);
  assert.ok(output.length < 2400);
  assert.doesNotMatch(output, /never-output-this-secret|private user prompt/);
  delete env.WMUX_PANE_ID;
  assert.equal(invoke(), "");
});

async function server(handler: http.RequestListener) {
  const value = http.createServer(handler);
  await new Promise<void>((resolve) => value.listen(0, "127.0.0.1", resolve));
  const address = value.address();
  assert.ok(address && typeof address !== "string");
  return { value, url: `http://127.0.0.1:${address.port}` };
}

function mcp(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [plugin], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (value: any) => void>();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let id = 0;
  return { child, request(method: string, params = {}) {
    return new Promise<any>((resolve) => {
      const current = ++id;
      pending.set(current, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    });
  } };
}

test("wmux plugin forwards only the pane binding and wmux connection inputs its MCP server needs", () => {
  const config = JSON.parse(fs.readFileSync(pluginConfig, "utf8"));
  const server = config.mcpServers.wmux;
  assert.equal(server.cwd, ".");
  assert.deepEqual(server.env_vars, [
    "WMUX_WORKSPACE_ID", "WMUX_TAB_ID", "WMUX_PANE_ID", "WMUX_URL", "WMUX_HELPER_URL", "WMUX_PUBLIC_URL",
    "WMUX_HELPER_TOKEN", "WMUX_HELPER_TOKEN_PATH", "WMUX_TOKEN", "WMUX_TOKEN_PATH", "WMUX_BROWSER_AUTH_MODE", "WMUX_ALLOWED_HOSTS",
  ]);
});

test("wmux MCP names only its complete current pane and preserves server auto-title ownership", async () => {
  const calls: Array<{ url?: string; body?: any; auth?: string }> = [];
  const fixture = await server((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      calls.push({ url: request.url, body: text ? JSON.parse(text) : undefined, auth: request.headers.authorization });
      const workspace = { id: "workspace", name: "Original", nameSource: "default", tabs: [{ id: "tab", title: "Shell", titleSource: "default", panes: [{ id: "pane" }] }] };
      const body = { workspace: { ...workspace, name: "Agent title", nameSource: "auto", tabs: [{ ...workspace.tabs[0], title: "Agent title", titleSource: "auto" }] }, workspaceApplied: true, tabApplied: true };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-mcp-test-"));
  const token = "a".repeat(32);
  const env = { ...process.env, HOME: home, WMUX_URL: fixture.url, WMUX_TOKEN: token, WMUX_WORKSPACE_ID: "workspace", WMUX_TAB_ID: "tab", WMUX_PANE_ID: "pane", WMUX_DELEGATED_RUN: "1" };
  for (const key of ["WMUX_HELPER_URL", "WMUX_PUBLIC_URL", "WMUX_HELPER_TOKEN", "WMUX_HELPER_TOKEN_PATH"]) delete env[key];
  const client = mcp(env);
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-11-25" });
    assert.equal(init.result.capabilities.tools.constructor, Object);
    assert.equal(init.result.protocolVersion, "2025-11-25");
    const olderInit = await client.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(olderInit.result.protocolVersion, "2025-06-18");
    const unsupportedInit = await client.request("initialize", { protocolVersion: "2099-01-01" });
    assert.equal(unsupportedInit.result.protocolVersion, "2025-11-25");
    const missingVersion = await client.request("initialize");
    assert.equal(missingVersion.error.code, -32602);
    const listed = await client.request("tools/list");
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ["get_current_wmux_session", "name_current_wmux_session"]);
    const context = await client.request("tools/call", { name: "get_current_wmux_session", arguments: {} });
    assert.equal(context.result.structuredContent.workspaceId, "workspace");
    assert.equal(context.result.structuredContent.titleRead, false);
    const renamed = await client.request("tools/call", { name: "name_current_wmux_session", arguments: { title: "Agent title" } });
    assert.equal(renamed.result.structuredContent.tabApplied, true);
    assert.deepEqual(calls.map((call) => call.url), ["/api/workspaces/workspace/auto-title"]);
    assert.deepEqual(calls[0]?.body, { title: "Agent title", tabId: "tab", paneId: "pane", tabOnlyIfMultiple: false });
    assert.equal(calls[0]?.auth, `Bearer ${token}`);
  } finally { client.child.kill(); fixture.value.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("wmux MCP fails closed without a complete bound pane and never makes a request", async () => {
  const env = { ...process.env, WMUX_WORKSPACE_ID: "workspace", WMUX_TAB_ID: "tab" };
  delete env.WMUX_PANE_ID; delete env.WMUX_DELEGATED_RUN;
  const client = mcp(env);
  try {
    const outcome = await client.request("tools/call", { name: "name_current_wmux_session", arguments: { title: "No target" } });
    assert.equal(outcome.result.isError, true);
    assert.match(outcome.result.structuredContent.error, /complete usable wmux pane binding/);
  } finally { client.child.kill(); }
});

test("wmux MCP refuses an external helper URL before reading or sending its credential", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-mcp-test-"));
  const env = {
    ...process.env,
    HOME: home,
    WMUX_URL: "https://example.com",
    WMUX_HELPER_TOKEN: "a".repeat(32),
    WMUX_WORKSPACE_ID: "workspace",
    WMUX_TAB_ID: "tab",
    WMUX_PANE_ID: "pane",
  };
  for (const key of ["WMUX_HELPER_URL", "WMUX_PUBLIC_URL", "WMUX_DELEGATED_RUN", "WMUX_HELPER_TOKEN_PATH", "WMUX_ALLOWED_HOSTS"]) delete env[key];
  const client = mcp(env);
  try {
    const outcome = await client.request("tools/call", { name: "name_current_wmux_session", arguments: { title: "No egress" } });
    assert.equal(outcome.result.isError, true);
    assert.match(outcome.result.structuredContent.error, /loopback, private, Tailscale, or explicitly allowed host/);
  } finally { client.child.kill(); fs.rmSync(home, { recursive: true, force: true }); }
});
