#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const tools = [
  {
    name: "get_current_wmux_session",
    description: "Read the exact wmux workspace, tab, and pane bound to this Codex process. It does not request broader wmux read access or guess from browser focus.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "name_current_wmux_session",
    description: "Name the exact wmux workspace and tab bound to this Codex process. Use mode auto by default; auto preserves user-owned wmux titles. Manual mode is only for an explicit user request.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short session title, at most 80 characters." },
        mode: { type: "string", enum: ["auto", "manual"], description: "auto preserves manual wmux titles; manual intentionally makes the workspace title user-owned." },
      },
      required: ["title"], additionalProperties: false,
    },
  },
];

function result(id, value) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`); }
function error(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`); }
function toolResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}
function current() {
  const output = { workspaceId: process.env.WMUX_WORKSPACE_ID, tabId: process.env.WMUX_TAB_ID, paneId: process.env.WMUX_PANE_ID };
  if (!Object.values(output).every((value) => typeof value === "string" && ID.test(value))) {
    throw new Error("This Codex process has no complete usable wmux pane binding.");
  }
  return output;
}
function read(pathname) { try { return fs.readFileSync(pathname, "utf8").trim(); } catch { return ""; } }
function allowedHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".ts.net")) return true;
  if (net.isIP(host) === 6) return host === "::1" || /^f[cd][0-9a-f:]*$/i.test(host);
  if (net.isIP(host) !== 4) {
    return (process.env.WMUX_ALLOWED_HOSTS || "").split(",").map((entry) => entry.trim().toLowerCase()).some((entry) => entry === host || (entry.startsWith("*.") && host.endsWith(entry.slice(1))));
  }
  const [first, second] = host.split(".").map(Number);
  return first === 127 || first === 10 || (first === 100 && second >= 64 && second <= 127)
    || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}
function serviceUrl() {
  const value = read(path.join(os.homedir(), ".wmux", "url")) || process.env.WMUX_HELPER_URL || process.env.WMUX_PUBLIC_URL || process.env.WMUX_URL || "http://127.0.0.1:3478";
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("wmux URL must be an HTTP(S) URL without embedded credentials.");
  if (!allowedHost(parsed.hostname)) throw new Error("wmux URL must use a loopback, private, Tailscale, or explicitly allowed host.");
  return parsed;
}
function auth() {
  const helperConfigured = Object.hasOwn(process.env, "WMUX_HELPER_TOKEN") || Object.hasOwn(process.env, "WMUX_HELPER_TOKEN_PATH");
  const helper = Object.hasOwn(process.env, "WMUX_HELPER_TOKEN") ? process.env.WMUX_HELPER_TOKEN
    : (process.env.WMUX_HELPER_TOKEN_PATH ? read(process.env.WMUX_HELPER_TOKEN_PATH) : read(path.join(os.homedir(), ".wmux", "helper-token")));
  if (helperConfigured || helper) {
    if (!TOKEN.test(helper || "")) throw new Error("wmux helper credential is unavailable or invalid.");
    return helper;
  }
  if ((process.env.WMUX_BROWSER_AUTH_MODE || "shared-or-login") !== "shared-or-login") throw new Error("wmux helper credentials are required in login-only mode.");
  const normal = process.env.WMUX_TOKEN || read(process.env.WMUX_TOKEN_PATH || path.join(os.homedir(), ".wmux", "token"));
  if (normal && !TOKEN.test(normal)) throw new Error("wmux credential is invalid.");
  return normal;
}
async function request(method, pathname, body) {
  const url = new URL(pathname, serviceUrl());
  const token = auth();
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`wmux returned ${response.status}.`);
  return response.json();
}
function visible(workspace, binding) {
  const tab = workspace?.tabs?.find((entry) => entry.id === binding.tabId);
  if (!workspace || !tab || !tab.panes?.some((pane) => pane.id === binding.paneId)) throw new Error("The bound wmux session no longer exists.");
  return { ...binding, workspaceTitle: workspace.name, workspaceTitleSource: workspace.nameSource, tabTitle: tab.title, tabTitleSource: tab.titleSource };
}
function context() {
  // A helper credential deliberately has narrow write authority and may not
  // read bootstrap. The binding was injected by wmux itself, so reporting it
  // needs neither a browser-focus guess nor broader API access.
  return { ...current(), titleRead: false };
}
function title(value) {
  if (typeof value !== "string" || value.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(value) || !value.trim()) throw new Error("title must be non-empty, printable, and at most 80 characters.");
  return value.replace(/\s+/g, " ").trim();
}
async function call(name, args) {
  if (name === "get_current_wmux_session") return context();
  if (name !== "name_current_wmux_session") throw new Error("Unknown wmux tool.");
  const binding = current();
  const value = title(args?.title);
  const mode = args?.mode ?? "auto";
  if (mode === "manual") {
    const response = await request("POST", `/api/workspaces/${encodeURIComponent(binding.workspaceId)}/title`, { title: value });
    return { ...visible(response.workspace, binding), workspaceApplied: true, tabApplied: false, mode };
  }
  if (mode !== "auto") throw new Error("mode must be auto or manual.");
  const response = await request("POST", `/api/workspaces/${encodeURIComponent(binding.workspaceId)}/auto-title`, {
    title: value, tabId: binding.tabId, paneId: binding.paneId, tabOnlyIfMultiple: false,
  });
  return { ...visible(response.workspace, binding), workspaceApplied: response.workspaceApplied, tabApplied: response.tabApplied, mode };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!Object.hasOwn(message, "id")) return;
  try {
    if (message.method === "initialize") {
      const protocolVersion = message.params?.protocolVersion;
      if (typeof protocolVersion !== "string") {
        error(message.id, -32602, "MCP protocol version is required.");
        return;
      }
      const selectedVersion = PROTOCOL_VERSIONS.has(protocolVersion) ? protocolVersion : "2025-11-25";
      result(message.id, { protocolVersion: selectedVersion, capabilities: { tools: {} }, serverInfo: { name: "wmux", version: "0.2.0" } });
    }
    else if (message.method === "ping") result(message.id, {});
    else if (message.method === "tools/list") result(message.id, { tools });
    else if (message.method === "tools/call") result(message.id, toolResult(await call(message.params?.name, message.params?.arguments)));
    else error(message.id, -32601, "Method not found.");
  } catch (cause) { result(message.id, toolResult({ error: cause instanceof Error ? cause.message : "wmux tool failed." }, true)); }
});
