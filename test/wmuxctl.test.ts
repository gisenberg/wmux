import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wmuxctl = path.join(repoRoot, "skills", "wmux", "scripts", "wmuxctl.py");
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: http.Server) => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};

const websocketFrame = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  assert.ok(payload.length < 65536);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
};

const cli = (url: string, args: string[], env: NodeJS.ProcessEnv = {}) => execFileAsync("python3", [wmuxctl, "--url", url, ...args], {
  cwd: repoRoot,
  env: { ...process.env, WMUX_TOKEN: "test-token", ...env },
});

test("wmuxctl rejects Codex-only delegation options for other runtimes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-runtime-options-"));
  const promptPath = path.join(root, "prompt.md");
  fs.writeFileSync(promptPath, "inspect only");
  try {
    await assert.rejects(
      cli("http://127.0.0.1:1", [
        "delegate", "claude", "local", "--directory", root,
        "--prompt-file", promptPath, "--sandbox", "read-only",
      ]),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(error.stderr ?? "", /explicit sandbox modes currently require the Codex runtime/);
        return true;
      },
    );
    await assert.rejects(
      cli("http://127.0.0.1:1", [
        "delegate", "claude", "local", "--directory", root,
        "--prompt-file", promptPath, "--structured-outcome",
      ]),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(error.stderr ?? "", /structured outcomes currently require the Codex runtime/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const cliProcess = async (
  url: string,
  args: string[],
  input = "",
  env: NodeJS.ProcessEnv = {},
) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn("python3", [wmuxctl, "--url", url, ...args], {
    cwd: repoRoot,
    env: { ...process.env, WMUX_TOKEN: "test-token", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(input);
});

test("wmuxctl output and wait read authenticated pane replay", async () => {
  const authorizations: Array<string | undefined> = [];
  const replay = "\u001b[2JDo you trust the contents of this directory?\r\n1. Yes, continue\r\ntask_complete";
  const server = http.createServer();
  server.on("upgrade", (request, socket) => {
    authorizations.push(request.headers.authorization);
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    socket.write(websocketFrame({
      type: "ready",
      paneId: "pane_agent",
      replay: "",
      replayKind: "raw",
      outputOnly: true,
      waitForRefresh: true,
    }));
    setTimeout(() => socket.write(websocketFrame({ type: "output", paneId: "pane_agent", data: replay })), 10);
    setTimeout(() => socket.end(), 250);
  });

  const url = await listen(server);
  try {
    const output = await cli(url, ["output", "pane_agent", "--tail-chars", "200"]);
    assert.match(output.stdout, /Do you trust the contents/);
    assert.doesNotMatch(output.stdout, /\u001b\[/);

    const waited = await cli(url, ["wait", "pane_agent", "--pattern", "task_complete", "--timeout", "2"]);
    const result = JSON.parse(waited.stdout);
    assert.equal(result.paneId, "pane_agent");
    assert.equal(result.matched, "task_complete");
    assert.deepEqual(authorizations, ["Bearer test-token", "Bearer test-token"]);
  } finally {
    await close(server);
  }
});

test("wmuxctl wait strips terminal character-set escapes around a shell prompt", async () => {
  const replay = "\u001b(Bwmux@host:~ $\u001b(B";
  const server = http.createServer();
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    socket.end(websocketFrame({ type: "ready", paneId: "pane_prompt", replay, outputOnly: true }));
  });

  const url = await listen(server);
  try {
    const waited = await cli(url, [
      "wait",
      "pane_prompt",
      "--pattern",
      "(?m)^.*(?:[$#%❯])\\s*$",
      "--timeout",
      "2",
    ]);
    const result = JSON.parse(waited.stdout);
    assert.equal(result.matched, "wmux@host:~ $");
  } finally {
    await close(server);
  }
});

test("wmuxctl bounds noisy durable refresh replay to the newest 2 MiB of valid UTF-8", async () => {
  const server = http.createServer();
  const newest = "newest-é-🦜\n";
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    socket.write(websocketFrame({
      type: "ready",
      paneId: "pane_noisy",
      replay: "oldest-must-be-trimmed\n",
      replayKind: "raw",
      outputOnly: true,
      waitForRefresh: true,
    }));
    for (let index = 0; index < 40; index += 1) {
      socket.write(websocketFrame({ type: "output", paneId: "pane_noisy", data: "é".repeat(30_000) }));
    }
    socket.write(websocketFrame({ type: "output", paneId: "pane_noisy", data: newest }));
    setTimeout(() => socket.end(), 300);
  });

  const url = await listen(server);
  try {
    const result = await execFileAsync(
      "python3",
      [wmuxctl, "--url", url, "output", "pane_noisy", "--raw", "--tail-chars", "0"],
      {
        cwd: repoRoot,
        env: { ...process.env, WMUX_TOKEN: "test-token" },
        maxBuffer: 3 * 1024 * 1024,
      },
    );
    const replayBytes = Buffer.byteLength(result.stdout, "utf8");
    assert.ok(replayBytes <= 2 * 1024 * 1024);
    assert.ok(replayBytes >= 2 * 1024 * 1024 - 3, "only a split leading UTF-8 code point may be discarded");
    assert.equal(result.stdout.endsWith(newest), true);
    assert.doesNotMatch(result.stdout, /oldest-must-be-trimmed/);
  } finally {
    await close(server);
  }
});

test("wmuxctl caps durable refresh waiting at the caller's overall timeout", async () => {
  const server = http.createServer();
  let upgradedSocket: import("node:stream").Duplex | undefined;
  server.on("upgrade", (request, socket) => {
    upgradedSocket = socket;
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    socket.write(websocketFrame({
      type: "ready",
      paneId: "pane_silent",
      replay: "",
      replayKind: "raw",
      outputOnly: true,
      waitForRefresh: true,
    }));
  });

  const url = await listen(server);
  try {
    await assert.rejects(
      cli(url, ["output", "pane_silent", "--timeout", "0.2"]),
      (error: { stderr?: string }) => {
        assert.match(error.stderr ?? "", /timed out waiting for pane output refresh after 0\.2s/);
        return true;
      },
    );
  } finally {
    upgradedSocket?.destroy();
    await close(server);
  }
});

test("WMUX_URL overrides a stale saved URL", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-home-"));
  fs.mkdirSync(path.join(home, ".wmux"));
  fs.writeFileSync(path.join(home, ".wmux", "url"), "http://127.0.0.1:1\n");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ machines: [{ id: "windows-runner", kind: "powershell-ssh", reachable: true }] }));
  });
  const url = await listen(server);
  try {
    const result = await execFileAsync("python3", [wmuxctl, "machines"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, WMUX_URL: url, WMUX_TOKEN: "test-token" },
    });
    assert.match(result.stdout, /^windows-runner\tpowershell-ssh\tup/m);
  } finally {
    await close(server);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("wmuxctl refuses an ambiguous reused workspace and honors an explicit tab", async () => {
  const inputs: Array<Record<string, unknown>> = [];
  const workspace = {
    id: "ws_multi",
    name: "Runner repair",
    machineId: "windows-runner",
    activeTabId: "tab_shell",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tabs: [
      {
        id: "tab_agent",
        title: "Codex",
        activePaneId: "pane_agent",
        panes: [{ id: "pane_agent", machineId: "windows-runner" }],
      },
      {
        id: "tab_shell",
        title: "Shell",
        activePaneId: "pane_shell",
        panes: [{ id: "pane_shell", machineId: "windows-runner" }],
      },
    ],
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ workspaces: [workspace], machines: [] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/panes/pane_agent/input") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        inputs.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
      return;
    }
    response.writeHead(404).end();
  });

  const url = await listen(server);
  try {
    await assert.rejects(
      cli(url, ["run", "windows-runner", "--title", "Runner repair", "--line", "Get-Date"]),
      (error: { stderr?: string }) => {
        assert.match(error.stderr ?? "", /multiple tabs; choose --tab or --pane explicitly/);
        return true;
      },
    );

    const sent = await cli(url, [
      "run", "windows-runner", "--title", "Runner repair", "--tab", "tab_agent", "--line", "Get-Date",
    ]);
    const result = JSON.parse(sent.stdout);
    assert.equal(result.tabId, "tab_agent");
    assert.equal(result.paneId, "pane_agent");
    assert.deepEqual(inputs, [
      { data: "Get-Date", cols: 120, rows: 36 },
      { data: "\r", cols: 120, rows: 36 },
    ]);
  } finally {
    await close(server);
  }
});

test("wmuxctl waits for a new Windows shell prompt before sending input", async () => {
  const events: string[] = [];
  const workspaceRequests: Array<Record<string, unknown>> = [];
  const workspace = {
    id: "ws_new",
    name: "Fresh",
    machineId: "windows-runner",
    activeTabId: "tab_new",
    tabs: [{
      id: "tab_new",
      title: "Shell",
      activePaneId: "pane_new",
      panes: [{ id: "pane_new", machineId: "windows-runner" }],
    }],
  };
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/workspaces") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        workspaceRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ workspace, state: {} }));
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces/ws_new/title") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ machines: [{ id: "windows-runner", kind: "powershell-ssh" }], workspaces: [workspace] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/panes/pane_new/input") {
      events.push("input");
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    events.push("prompt");
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    socket.end(websocketFrame({ type: "ready", paneId: "pane_new", replay: "PS C:\\Users\\operator> " }));
  });

  const url = await listen(server);
  try {
    const sent = await cli(url, ["run", "windows-runner", "--title", "Fresh", "--new", "--line", "Get-Date"], { WMUX_PANE_ID: "" });
    const result = JSON.parse(sent.stdout);
    assert.equal(result.paneId, "pane_new");
    assert.equal(typeof result.shellReadySeconds, "number");
    assert.deepEqual(workspaceRequests, [{ machineId: "windows-runner", createdBy: "agent" }]);
    assert.deepEqual(events, ["prompt", "input", "input"]);
  } finally {
    await close(server);
  }
});

test("wmuxctl delegate drives the staged runner, lifecycle, and close-on-success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-delegate-"));
  const promptPath = path.join(root, "prompt.md");
  const prompt = "private parity task Ω";
  fs.writeFileSync(promptPath, prompt);
  const inputs: Array<Record<string, unknown>> = [];
  const lifecycle: Array<Record<string, unknown>> = [];
  const workspaceRequests: Array<Record<string, unknown>> = [];
  let runId = "";
  let upgradeCount = 0;
  let deleted = false;
  const machine = { id: "linux-box", kind: "ssh", platform: "linux", reachable: true };
  const workspace = {
    id: "ws_delegate",
    machineId: "linux-box",
    activeTabId: "tab_delegate",
    tabs: [{
      id: "tab_delegate",
      activePaneId: "pane_delegate",
      panes: [{ id: "pane_delegate", machineId: "linux-box" }],
    }],
  };
  const jsonResponse = (response: http.ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      jsonResponse(response, { machines: [machine], workspaces: [workspace] });
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        workspaceRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        jsonResponse(response, { workspace, state: {} }, 201);
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces/ws_delegate/title") {
      request.resume();
      request.on("end", () => jsonResponse(response, {}));
      return;
    }
    if (request.method === "POST" && request.url === "/api/agent-events") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        lifecycle.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        jsonResponse(response, {}, 201);
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/panes/pane_delegate/input") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        inputs.push(body);
        if (typeof body.data === "string" && body.data.startsWith("wmux-agent-run request ")) {
          runId = body.data.slice("wmux-agent-run request ".length);
        }
        if (inputs.length === 3) {
          const delegated = JSON.parse(Buffer.from(body.data, "base64").toString("utf8"));
          runId = delegated.runId;
          assert.deepEqual(delegated, {
            runId,
            runtime: "codex",
            prompt,
            directory: "/srv/project",
            unattended: true,
            writeAccess: true,
            title: "Parity review",
            model: "gpt-test",
          });
        }
        jsonResponse(response, {});
      });
      return;
    }
    if (request.method === "DELETE" && request.url === "/api/workspaces/ws_delegate") {
      deleted = true;
      jsonResponse(response, { removed: true });
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    upgradeCount += 1;
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    let replay = "operator@host /srv/project ❯ ";
    if (upgradeCount === 2) replay = `WMUX_AGENT_READY ${runId}\r\n`;
    if (upgradeCount === 3) {
      const result = Buffer.from(JSON.stringify({ runId, runtime: "codex", ok: true, result: "review complete", error: "" })).toString("base64");
      replay = `WMUX_AGENT_RESULT ${result}\r\nWMUX_AGENT_DONE ${runId} 0\r\n`;
    }
    socket.end(websocketFrame({ type: "ready", paneId: "pane_delegate", replay }));
  });

  const url = await listen(server);
  try {
    const delegated = await cli(url, [
      "delegate", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath,
      "--title", "Parity review", "--model", "gpt-test", "--write-access", "--unattended", "--close-on-success",
    ], { WMUX_PANE_ID: "pane_parent" });
    const result = JSON.parse(delegated.stdout);
    assert.equal(result.state, "completed");
    assert.equal(result.result, "review complete");
    assert.equal(result.closed, true);
    assert.equal(result.url, `${url}/workspaces/ws_delegate/tabs/tab_delegate`);
    assert.deepEqual(inputs.slice(0, 2).map((body) => body.data), [`wmux-agent-run request ${runId}`, "\r"]);
    assert.equal(inputs.some((body) => String(body.data).includes(prompt)), false);
    assert.deepEqual(workspaceRequests, [{ machineId: "linux-box", createdBy: "agent", parentPaneId: "pane_parent" }]);
    assert.deepEqual(lifecycle.map((event) => ({ agent: event.agent, status: event.status, message: event.message, runId: event.runId })), [
      { agent: "codex", status: "running", message: undefined, runId },
      { agent: "codex", status: "completed", message: "review complete", runId },
    ]);
    assert.equal(deleted, true);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wmuxctl delegates Codex directly to Windows with an explicit sandbox and structured outcome", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-windows-delegate-"));
  const promptPath = path.join(root, "prompt.md");
  const prompt = `import the requested catalog ${"carefully ".repeat(80)}`;
  fs.writeFileSync(promptPath, prompt);
  const inputs: Array<Record<string, unknown>> = [];
  const lifecycle: Array<Record<string, unknown>> = [];
  const agentEvents: Array<Record<string, unknown>> = [];
  const completedRuns = new Set<string>();
  let runId = "";
  let upgradeCount = 0;
  let promptSubmitted = false;
  let promptSubmitAttempts = 0;
  let createRequests = 0;
  const machine = { id: "windows-runner", kind: "powershell-ssh", platform: "win", reachable: true };
  const workspace = {
    id: "ws_windows_delegate",
    machineId: "windows-runner",
    activeTabId: "tab_windows_delegate",
    tabs: [{
      id: "tab_windows_delegate",
      activePaneId: "pane_windows_delegate",
      panes: [{ id: "pane_windows_delegate", machineId: "windows-runner" }],
    }],
    manualTitle: "",
  };
  const jsonResponse = (response: http.ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      jsonResponse(response, { machines: [machine], workspaces: [workspace], agentEvents, delegations: [] });
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces") {
      createRequests += 1;
      request.resume();
      request.on("end", () => jsonResponse(response, { workspace, state: {} }, 201));
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces/ws_windows_delegate/title") {
      request.resume();
      request.on("end", () => {
        workspace.manualTitle = "Windows catalog import";
        jsonResponse(response, {});
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/agent-events") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        lifecycle.push(event);
        runId = event.runId;
        promptSubmitted = false;
        promptSubmitAttempts = 0;
        agentEvents.unshift(event);
        jsonResponse(response, {}, 201);
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/panes/pane_windows_delegate/input") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        inputs.push(body);
        if (body.data === "\r" && inputs.some((input) => input.data === "\u001b[201~")) {
          promptSubmitAttempts += 1;
          promptSubmitted = promptSubmitAttempts >= 2;
        }
        jsonResponse(response, {});
      });
      return;
    }
    if (request.method === "GET" && request.url === `/api/delegations/${runId}`) {
      if (promptSubmitted && !completedRuns.has(runId)) {
        completedRuns.add(runId);
        agentEvents.unshift({
          ...agentEvents[0],
          id: `complete-${runId}`,
          status: "completed",
          message: JSON.stringify({ outcome: "completed", summary: "catalog imported" }),
        });
      }
      jsonResponse(response, promptSubmitted ? {
        delegation: {
          runId,
          state: "completed",
          runtime: "codex",
          title: "Windows catalog import",
          summary: "Codex delegation completed",
          result: JSON.stringify({ outcome: "completed", summary: "catalog imported" }),
          error: "",
        },
      } : { delegation: { runId, state: "running" } });
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    upgradeCount += 1;
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    let replay = "PS T:\\git\\example\\project> ";
    if (upgradeCount >= 2) {
      replay = `WMUX_CODEX_START_${runId}\r\nOpenAI Codex · directory: T:\\git\\example\\project › Implement a feature\r\n`;
    }
    socket.end(websocketFrame({ type: "ready", paneId: "pane_windows_delegate", replay }));
  });

  const url = await listen(server);
  try {
    const delegated = await cli(url, [
      "delegate", "codex", "windows-runner", "--directory", "T:\\git\\example\\project",
      "--prompt-file", promptPath, "--title", "Windows catalog import", "--write-access",
      "--sandbox", "danger-full-access", "--structured-outcome",
    ]);
    const result = JSON.parse(delegated.stdout);
    assert.equal(result.state, "completed");
    assert.equal(result.outcome, "completed");
    assert.equal(result.result, "catalog imported");
    const launch = String(inputs[0].data);
    assert.match(launch, /WMUX_DELEGATED_RUN='1'/);
    assert.match(launch, /Remove-Item Env:WMUX_DELEGATION_RUN_ID/);
    assert.match(launch, /Set-Location -LiteralPath 'T:\\git\\example\\project'/);
    assert.match(launch, /codex --sandbox 'danger-full-access' --no-alt-screen/);
    assert.doesNotMatch(launch, /--ask-for-approval never/);
    assert.doesNotMatch(launch, new RegExp(prompt.slice(0, 30)));
    assert.deepEqual(inputs.slice(0, 3).map((body) => body.data), [launch, "\r", "\u001b[200~"]);
    const pasteEnd = inputs.findIndex((body) => body.data === "\u001b[201~");
    assert.ok(pasteEnd > 3);
    const submittedPrompt = inputs.slice(3, pasteEnd).map((body) => body.data).join("");
    assert.match(submittedPrompt, new RegExp(prompt.slice(0, 30)));
    assert.match(submittedPrompt, /Return the entire final response as exactly one JSON object/);
    assert.ok(inputs.slice(3, pasteEnd).every((body) => String(body.data).length <= 256));
    assert.equal(inputs[pasteEnd + 1].data, "\r");
    assert.deepEqual(lifecycle.map((event) => event.status), ["running"]);

    const firstInputCount = inputs.length;
    const secondDelegation = await cli(url, [
      "delegate", "codex", "windows-runner", "--directory", "T:\\git\\example\\project",
      "--prompt-file", promptPath, "--title", "Windows catalog import", "--write-access",
      "--sandbox", "danger-full-access", "--structured-outcome",
    ]);
    const secondResult = JSON.parse(secondDelegation.stdout);
    assert.equal(secondResult.state, "completed");
    assert.equal(secondResult.reused, true);
    assert.notEqual(secondResult.runId, result.runId);
    assert.equal(createRequests, 1);
    assert.equal(inputs[firstInputCount].data, "\u001b[200~");
    assert.equal(inputs.slice(firstInputCount).some((body) => String(body.data).includes("codex --sandbox")), false);
    assert.deepEqual(lifecycle.map((event) => event.status), ["running", "running"]);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wmuxctl delegate recovers a completed result from durable lifecycle status", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-delegate-recover-"));
  const promptPath = path.join(root, "prompt.md");
  fs.writeFileSync(promptPath, "durable recovery task");
  const lifecycle: Array<Record<string, unknown>> = [];
  let runId = "";
  let upgradeCount = 0;
  const workspace = {
    id: "ws_recover",
    machineId: "linux-box",
    activeTabId: "tab_recover",
    tabs: [{
      id: "tab_recover",
      activePaneId: "pane_recover",
      panes: [{ id: "pane_recover", machineId: "linux-box" }],
    }],
  };
  const jsonResponse = (response: http.ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      jsonResponse(response, {
        machines: [{ id: "linux-box", kind: "ssh", platform: "linux", reachable: true }],
        workspaces: [workspace],
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces") {
      request.resume();
      request.on("end", () => jsonResponse(response, { workspace, state: {} }, 201));
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces/ws_recover/title") {
      request.resume();
      request.on("end", () => jsonResponse(response, {}));
      return;
    }
    if (request.method === "POST" && request.url === "/api/agent-events") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        lifecycle.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        jsonResponse(response, {}, 201);
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/panes/pane_recover/input") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof body.data === "string" && body.data.startsWith("wmux-agent-run request ")) {
          runId = body.data.slice("wmux-agent-run request ".length);
        } else if (typeof body.data === "string" && body.data !== "\r") {
          runId = JSON.parse(Buffer.from(body.data, "base64").toString("utf8")).runId;
        }
        jsonResponse(response, {});
      });
      return;
    }
    if (request.method === "GET" && request.url === `/api/delegations/${runId}`) {
      jsonResponse(response, {
        delegation: {
          runId,
          state: "completed",
          runtime: "codex",
          title: "Recovered review",
          summary: "Codex delegation completed",
          result: "durable review result",
          error: "",
        },
      });
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    upgradeCount += 1;
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    let replay = "operator@host /srv/project ❯ ";
    if (upgradeCount === 2) replay = `WMUX_AGENT_READY ${runId}\r\n`;
    if (upgradeCount === 3) replay = `WMUX_AGENT_DONE ${runId} 0\r\n`;
    socket.end(websocketFrame({ type: "ready", paneId: "pane_recover", replay }));
  });

  const url = await listen(server);
  try {
    const delegated = await cli(url, [
      "delegate", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath,
      "--title", "Recovered review",
    ]);
    const result = JSON.parse(delegated.stdout);
    assert.equal(result.state, "completed");
    assert.equal(result.result, "durable review result");
    assert.equal(lifecycle.length, 1);
    assert.equal(lifecycle[0].status, "running");
    assert.equal(lifecycle[0].runId, runId);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wmuxctl delegate finishes from lifecycle status when terminal replay has no markers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-delegate-lifecycle-first-"));
  const promptPath = path.join(root, "prompt.md");
  fs.writeFileSync(promptPath, "lifecycle-first task");
  let runId = "";
  let upgradeCount = 0;
  let statusRequests = 0;
  const workspace = {
    id: "ws_lifecycle_first",
    machineId: "linux-box",
    activeTabId: "tab_lifecycle_first",
    tabs: [{
      id: "tab_lifecycle_first",
      activePaneId: "pane_lifecycle_first",
      panes: [{ id: "pane_lifecycle_first", machineId: "linux-box" }],
    }],
  };
  const jsonResponse = (response: http.ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      jsonResponse(response, {
        machines: [{ id: "linux-box", kind: "ssh", platform: "linux", reachable: true }],
        workspaces: [workspace],
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces") {
      request.resume();
      request.on("end", () => jsonResponse(response, { workspace, state: {} }, 201));
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces/ws_lifecycle_first/title") {
      request.resume();
      request.on("end", () => jsonResponse(response, {}));
      return;
    }
    if (request.method === "POST" && request.url === "/api/agent-events") {
      request.resume();
      request.on("end", () => jsonResponse(response, {}, 201));
      return;
    }
    if (request.method === "POST" && request.url === "/api/panes/pane_lifecycle_first/input") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof body.data === "string" && body.data.startsWith("wmux-agent-run request ")) {
          runId = body.data.slice("wmux-agent-run request ".length);
        } else if (typeof body.data === "string" && body.data !== "\r") {
          runId = JSON.parse(Buffer.from(body.data, "base64").toString("utf8")).runId;
        }
        jsonResponse(response, {});
      });
      return;
    }
    if (request.method === "GET" && request.url === `/api/delegations/${runId}`) {
      statusRequests += 1;
      jsonResponse(response, {
        delegation: {
          runId,
          state: "completed",
          runtime: "codex",
          title: "Lifecycle-first review",
          summary: "Codex delegation completed",
          result: "completed without replay markers",
          error: "",
        },
      });
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    upgradeCount += 1;
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    let replay = "operator@host /srv/project ❯ ";
    if (upgradeCount === 2) replay = `WMUX_AGENT_READY ${runId}\r\n`;
    if (upgradeCount >= 3) replay = "agent output without control markers\r\n";
    socket.end(websocketFrame({ type: "ready", paneId: "pane_lifecycle_first", replay }));
  });

  const url = await listen(server);
  try {
    const delegated = await cli(url, [
      "delegate", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath,
      "--title", "Lifecycle-first review", "--timeout", "10",
    ]);
    const result = JSON.parse(delegated.stdout);
    assert.equal(result.state, "completed");
    assert.equal(result.result, "completed without replay markers");
    assert.ok(result.elapsedSeconds < 3);
    assert.equal(statusRequests, 1);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wmuxctl delegate records observer failure without replacing the agent outcome", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-delegate-observer-error-"));
  const promptPath = path.join(root, "prompt.md");
  fs.writeFileSync(promptPath, "observer failure task");
  const lifecycle: Array<Record<string, unknown>> = [];
  let runId = "";
  let upgradeCount = 0;
  const workspace = {
    id: "ws_observer_error",
    machineId: "linux-box",
    activeTabId: "tab_observer_error",
    tabs: [{
      id: "tab_observer_error",
      activePaneId: "pane_observer_error",
      panes: [{ id: "pane_observer_error", machineId: "linux-box" }],
    }],
  };
  const jsonResponse = (response: http.ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      jsonResponse(response, {
        machines: [{ id: "linux-box", kind: "ssh", platform: "linux", reachable: true }],
        workspaces: [workspace],
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces") {
      request.resume();
      request.on("end", () => jsonResponse(response, { workspace, state: {} }, 201));
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces/ws_observer_error/title") {
      request.resume();
      request.on("end", () => jsonResponse(response, {}));
      return;
    }
    if (request.method === "POST" && request.url === "/api/agent-events") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        lifecycle.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        jsonResponse(response, {}, 201);
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/panes/pane_observer_error/input") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof body.data === "string" && body.data.startsWith("wmux-agent-run request ")) {
          runId = body.data.slice("wmux-agent-run request ".length);
        } else if (typeof body.data === "string" && body.data !== "\r" && body.data !== "\u0003") {
          runId = JSON.parse(Buffer.from(body.data, "base64").toString("utf8")).runId;
        }
        jsonResponse(response, {});
      });
      return;
    }
    if (request.method === "GET" && request.url === `/api/delegations/${runId}`) {
      jsonResponse(response, { error: "temporarily_unavailable" }, 503);
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    upgradeCount += 1;
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    let replay = "operator@host /srv/project ❯ ";
    if (upgradeCount === 2) replay = `WMUX_AGENT_READY ${runId}\r\n`;
    if (upgradeCount >= 3) replay = "agent output without control markers\r\n";
    socket.end(websocketFrame({ type: "ready", paneId: "pane_observer_error", replay }));
  });

  const url = await listen(server);
  try {
    await assert.rejects(
      cli(url, [
        "delegate", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath,
        "--title", "Observer failure", "--timeout", "0.5",
      ]),
      (error: { stdout?: string }) => {
        const result = JSON.parse(error.stdout ?? "{}");
        assert.equal(result.state, "failed");
        assert.equal(result.failureKind, "observer");
        return true;
      },
    );
    assert.deepEqual(lifecycle.map((event) => event.status), ["running", "observer_error"]);
    assert.equal(lifecycle[1].runId, runId);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wmuxctl delegate records failure and preserves the workspace when setup fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-delegate-fail-"));
  const promptPath = path.join(root, "prompt.md");
  fs.writeFileSync(promptPath, "setup failure prompt");
  const lifecycle: Array<Record<string, unknown>> = [];
  const workspaceRequests: Array<Record<string, unknown>> = [];
  let interrupted = false;
  const workspace = {
    id: "ws_failed",
    machineId: "linux-box",
    activeTabId: "tab_failed",
    tabs: [{ id: "tab_failed", activePaneId: "pane_failed", panes: [{ id: "pane_failed", machineId: "linux-box" }] }],
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ machines: [{ id: "linux-box", kind: "local", platform: "linux", reachable: true }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        workspaceRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ workspace, state: {} }));
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspaces/ws_failed/title") {
      request.resume();
      request.on("end", () => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":"title unavailable"}');
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/panes/pane_failed/input") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        interrupted = JSON.parse(Buffer.concat(chunks).toString("utf8")).data === "\u0003";
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/agent-events") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        lifecycle.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(201, { "content-type": "application/json" });
        response.end("{}");
      });
      return;
    }
    response.writeHead(404).end();
  });
  const url = await listen(server);
  try {
    await assert.rejects(
      cli(url, ["delegate", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath], { WMUX_PANE_ID: "" }),
      (error: { stdout?: string }) => {
        const result = JSON.parse(error.stdout ?? "{}");
        assert.equal(result.state, "failed");
        assert.equal(result.closed, false);
        assert.match(result.error, /HTTP 500/);
        return true;
      },
    );
    assert.equal(interrupted, true);
    assert.deepEqual(workspaceRequests, [{ machineId: "linux-box", createdBy: "agent" }]);
    assert.deepEqual(lifecycle.map((event) => event.status), ["failed"]);
    assert.equal(lifecycle[0].message && String(lifecycle[0].message).includes("setup failure prompt"), false);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows wmux-title sends the bearer token used by authenticated APIs", () => {
  const helper = fs.readFileSync(path.join(repoRoot, "scripts", "windows", "wmux-title.ps1"), "utf8");
  assert.match(helper, /function Get-WmuxToken/);
  assert.match(helper, /\$Headers\['Authorization'\] = "Bearer \$WmuxToken"/);
  assert.match(helper, /Invoke-RestMethod[^\n]+-Headers \$Headers/);
});

test("wmuxctl prefers automation auth and scoped preflight never falls back", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-scoped-"));
  fs.mkdirSync(path.join(home, ".wmux"));
  fs.writeFileSync(path.join(home, ".wmux", "automation-token"), `${"A".repeat(43)}\n`);
  const authorizations: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":"unauthorized"}');
  });
  const url = await listen(server);
  try {
    await assert.rejects(execFileAsync("python3", [wmuxctl, "--url", url, "--scoped-auth", "bootstrap"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, WMUX_TOKEN: "legacy-test-token" },
    }));
    assert.deepEqual(authorizations, [`Bearer ${"A".repeat(43)}`], "a rejected scoped credential is never retried with legacy auth");
    fs.unlinkSync(path.join(home, ".wmux", "automation-token"));
    await assert.rejects(execFileAsync("python3", [wmuxctl, "--url", url, "--scoped-auth", "bootstrap"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, WMUX_TOKEN: "legacy-test-token" },
    }), /requires WMUX_AUTOMATION_TOKEN/);
    assert.equal(authorizations.length, 1, "preflight failure makes no compatibility request");
    await assert.rejects(execFileAsync("python3", [wmuxctl, "--url", url, "--automation-token-path", path.join(home, "missing"), "bootstrap"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, WMUX_TOKEN: "legacy-test-token" },
    }), /configured automation token file is empty or unreadable/);
    assert.equal(authorizations.length, 1, "an explicitly configured scoped path never falls through to legacy auth");
    await assert.rejects(execFileAsync("python3", [wmuxctl, "--url", url, "bootstrap"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, WMUX_AUTOMATION_TOKEN: "short", WMUX_TOKEN: "legacy-test-token" },
    }), /configured automation token is empty or malformed/);
    assert.equal(authorizations.length, 1, "an invalid scoped environment never falls through to legacy auth");
  } finally {
    await close(server);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generic scripts/wmuxctl wrapper routes tui help to the canonical CLI", async () => {
  const wrapper = path.join(repoRoot, "scripts", "wmuxctl");
  const result = await execFileAsync(wrapper, ["tui", "--help"], { cwd: repoRoot });
  assert.match(result.stdout, /--accept-trust/);
  assert.match(result.stdout, /\{opencode,codex,claude\}/);
});

const fastTuiGate = ["--gate-timeout", "0.05"];

test("wmuxctl tui uses post-launch replay, bracketed paste, and stable handoff JSON", async () => {
  const prompt = "private\tinteractive Ω\nsecond line";
  const promptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-tui-")), "prompt.txt");
  fs.writeFileSync(promptPath, prompt.replace("\n", "\r\n"));
  const inputs: Array<Record<string, unknown>> = [];
  let upgrades = 0;
  let runId = "";
  let launchMarkerSent = false;
  const machine = { id: "linux-box", kind: "ssh", platform: "linux", reachable: true, source: "static", endpoint: "10.0.0.2:22" };
  const workspace = { id: "ws_tui", machineId: "linux-box", activeTabId: "tab_tui", tabs: [{ id: "tab_tui", activePaneId: "pane_tui", panes: [{ id: "pane_tui", machineId: "linux-box" }] }] };
  const server = http.createServer((request, response) => {
    const reply = (body: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method === "GET" && request.url === "/api/bootstrap") return reply({ machines: [machine], workspaces: [workspace] });
    if (request.method === "POST" && request.url === "/api/workspaces") { request.resume(); request.on("end", () => reply({ workspace, state: {} }, 201)); return; }
    if (request.method === "POST" && request.url === "/api/workspaces/ws_tui/title") { request.resume(); request.on("end", () => reply({})); return; }
    if (request.method === "POST" && request.url === "/api/panes/pane_tui/input") { const chunks: Buffer[] = []; request.on("data", (c) => chunks.push(Buffer.from(c))); request.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString()); inputs.push(body); if (inputs.length === 1) runId = String(body.data).split(" ").at(-1) ?? ""; reply({}); }); return; }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"]; assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
    upgrades += 1;
    let replay = upgrades === 1 ? "operator@host $ " : "initial shell";
    if (inputs.length === 2) replay = `WMUX_AGENT_TUI_READY ${runId}`;
    if (inputs.length === 4 && !launchMarkerSent) { replay = `WMUX_AGENT_TUI_LAUNCH ${runId}`; launchMarkerSent = true; }
    else if (inputs.length === 6) replay = "Codex interactive ready";
    else if (inputs.length === 7) replay = "prompt pasted";
    else if (inputs.length >= 8) replay = "working";
    socket.end(websocketFrame({ type: "ready", paneId: "pane_tui", replay }));
  });
  const url = await listen(server);
  try {
    const result = JSON.parse((await cli(url, ["--public-url", "https://wmux.example", "tui", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath, ...fastTuiGate])).stdout);
    assert.equal(result.state, "active"); assert.equal(result.closed, false); assert.equal(result.promptSubmitted, true); assert.equal(result.activityVerified, true);
    assert.equal(result.localUrl, `${url}/workspaces/ws_tui/tabs/tab_tui`); assert.equal(result.publicUrl, "https://wmux.example/workspaces/ws_tui/tabs/tab_tui"); assert.equal(result.url, result.publicUrl);
    assert.deepEqual(inputs.slice(-2).map((item) => item.data), [`\u001b[200~${prompt}\u001b[201~`, "\r"]);
    assert.equal(inputs.some((item) => String(item.data).includes(prompt)), true); // only terminal paste, never launch request
    const launch = String(inputs[0].data); assert.match(launch, /^wmux-agent-run tui /);
    const request = JSON.parse(Buffer.from(String(inputs[2].data), "base64").toString()); assert.equal("prompt" in request, false);
    assert.deepEqual(inputs.slice(4, 6).map((item) => item.data), [`WMUX_AGENT_TUI_ACK ${result.runId}`, "\r"]);
    assert.equal(launchMarkerSent, true); // later checkpoint replays omit it after ACK
  } finally { await close(server); fs.rmSync(path.dirname(promptPath), { recursive: true, force: true }); }
});

type TuiFixtureOptions = {
  pathPrefix?: string;
  machineAtBootstrap?: (count: number) => Record<string, unknown>;
  replayAtUpgrade?: (count: number, runId: string, token: string) => string;
};

const startTuiFixture = async (options: TuiFixtureOptions = {}) => {
  const prefix = options.pathPrefix ?? "";
  const inputs: Array<Record<string, unknown>> = [];
  const methods: string[] = [];
  let bootstrapCount = 0;
  let workspacePosts = 0;
  let upgrades = 0;
  let runId = "";
  let launchMarkerSent = false;
  const defaultMachine = {
    id: "linux-box", kind: "ssh", platform: "linux", reachable: true,
    source: "static", endpoint: "10.0.0.2:22", user: "operator", port: 22,
  };
  const workspace = {
    id: "ws_tui_fixture", machineId: "linux-box", activeTabId: "tab_tui_fixture",
    tabs: [{ id: "tab_tui_fixture", activePaneId: "pane_tui_fixture", panes: [{ id: "pane_tui_fixture", machineId: "linux-box" }] }],
  };
  const defaultReplay = (count: number) => {
    if (count === 1) return "operator@host /srv/project $ ";
    if (inputs.length === 0) return "shell baseline";
    if (inputs.length === 2) return `WMUX_AGENT_TUI_READY ${runId}`;
    if (inputs.length === 4 && !launchMarkerSent) {
      launchMarkerSent = true;
      return `WMUX_AGENT_TUI_LAUNCH ${runId}`;
    }
    if (inputs.length === 6) return "interactive TUI rendered";
    if (inputs.length === 7) return "paste rendered";
    return "active turn rendered";
  };
  const reply = (response: http.ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    methods.push(`${request.method} ${request.url}`);
    const route = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) || "/" : request.url;
    if (request.method === "GET" && route === "/api/bootstrap") {
      bootstrapCount += 1;
      reply(response, { machines: [options.machineAtBootstrap?.(bootstrapCount) ?? defaultMachine], workspaces: [workspace] });
      return;
    }
    if (request.method === "POST" && route === "/api/workspaces") {
      workspacePosts += 1;
      request.resume();
      request.on("end", () => reply(response, { workspace, state: {} }, 201));
      return;
    }
    if (request.method === "POST" && route === "/api/workspaces/ws_tui_fixture/title") {
      request.resume();
      request.on("end", () => reply(response, {}));
      return;
    }
    if (request.method === "POST" && route === "/api/panes/pane_tui_fixture/input") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        inputs.push(body);
        if (inputs.length === 1) runId = String(body.data).split(" ").at(-1) ?? "";
        reply(response, {});
      });
      return;
    }
    if (request.method === "DELETE") {
      reply(response, { removed: true });
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    upgrades += 1;
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = crypto.createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`, "", "",
    ].join("\r\n"));
    const replay = options.replayAtUpgrade?.(upgrades, runId, "test-token") ?? defaultReplay(upgrades);
    socket.end(websocketFrame({ type: "ready", paneId: "pane_tui_fixture", replay }));
  });
  const origin = await listen(server);
  return {
    url: `${origin}${prefix}`,
    inputs,
    methods,
    get workspacePosts() { return workspacePosts; },
    async stop() { await close(server); },
  };
};

const establishedFields = [
  "machineId", "workspaceId", "tabId", "paneId", "runId", "runtime", "state", "closed",
  "promptSubmitted", "activityVerified", "url", "localUrl", "publicUrl",
];

const assertEstablishedResult = (result: Record<string, unknown>) => {
  for (const key of establishedFields) assert.ok(key in result, `missing stable field ${key}`);
  assert.equal(result.closed, false);
  assert.equal(result.machineId, "linux-box");
};

test("wmuxctl tui accepts piped and dash stdin prompts, and deliberate no-prompt", async () => {
  for (const promptArgs of [[], ["--prompt-file", "-"]]) {
    const fixture = await startTuiFixture();
    const prompt = `stdin\tprompt Ω ${promptArgs.length}\nsecond line`;
    try {
      const completed = await cliProcess(fixture.url, [
        "tui", "claude", "linux-box", "--directory", "/srv/project", ...promptArgs, ...fastTuiGate,
      ], prompt);
      assert.equal(completed.code, 0, completed.stderr);
      const result = JSON.parse(completed.stdout);
      assertEstablishedResult(result);
      assert.equal(result.state, "active");
      assert.deepEqual(fixture.inputs.slice(-2).map((body) => body.data), [`\u001b[200~${prompt}\u001b[201~`, "\r"]);
      assert.equal(String(fixture.inputs[0].data).includes(prompt), false);
      assert.equal(String(fixture.inputs[2].data).includes(prompt), false);
      assert.equal(completed.stderr.includes(prompt), false);
      assert.equal(JSON.stringify(result).includes(prompt), false);
      assert.equal(fixture.methods.some((value) => value.startsWith("DELETE ")), false);
    } finally {
      await fixture.stop();
    }
  }

  const fixture = await startTuiFixture();
  try {
    const completed = await cliProcess(fixture.url, [
      "tui", "opencode", "linux-box", "--directory", "/srv/project", "--no-prompt", "--model", "m", "--opencode-agent", "review",
      ...fastTuiGate,
    ]);
    assert.equal(completed.code, 0, completed.stderr);
    const result = JSON.parse(completed.stdout);
    assertEstablishedResult(result);
    assert.equal(result.state, "ready");
    assert.equal(result.promptSubmitted, false);
    assert.equal(result.activityVerified, false);
    const launchRequest = JSON.parse(Buffer.from(String(fixture.inputs[2].data), "base64").toString("utf8"));
    assert.deepEqual(launchRequest, { runId: result.runId, runtime: "opencode", directory: "/srv/project", model: "m", agent: "review" });
    assert.equal(fixture.methods.some((value) => value.startsWith("DELETE ")), false);
  } finally {
    await fixture.stop();
  }
});

test("wmuxctl tui rejects terminal controls from prompt files and stdin without exposing prompt text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-tui-controls-"));
  const promptPath = path.join(root, "prompt.txt");
  const cases = [
    {
      args: ["--prompt-file", promptPath],
      input: "",
      prompt: "file-secret\u001b[201~injected\rcommand",
      secret: "file-secret",
    },
    {
      args: [],
      input: "stdin-cr-secret\rcommand",
      prompt: "",
      secret: "stdin-cr-secret",
    },
    {
      args: [],
      input: "stdin-secret\u009b201~injected\u007fcommand",
      prompt: "",
      secret: "stdin-secret",
    },
  ];
  try {
    for (const entry of cases) {
      if (entry.prompt) fs.writeFileSync(promptPath, entry.prompt);
      const fixture = await startTuiFixture();
      try {
        const completed = await cliProcess(fixture.url, [
          "tui", "codex", "linux-box", "--directory", "/srv/project", ...entry.args,
          ...fastTuiGate,
        ], entry.input);
        assert.notEqual(completed.code, 0);
        assert.match(completed.stderr, /unsafe terminal control character; only TAB and LF are allowed/);
        assert.equal(completed.stdout.includes(entry.secret), false);
        assert.equal(completed.stderr.includes(entry.secret), false);
        assert.equal(fixture.workspacePosts, 0);
        assert.equal(fixture.inputs.length, 0);
      } finally {
        await fixture.stop();
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wmuxctl tui validates prompts, scalar arguments, and URLs before workspace creation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-tui-validation-"));
  const empty = path.join(root, "empty.txt");
  const nul = path.join(root, "nul.txt");
  const invalidUtf8 = path.join(root, "invalid.txt");
  const oversized = path.join(root, "oversized.txt");
  fs.writeFileSync(empty, "");
  fs.writeFileSync(nul, "bad\0prompt");
  fs.writeFileSync(invalidUtf8, Buffer.from([0xff, 0xfe]));
  fs.writeFileSync(oversized, "x".repeat(128 * 1024 + 1));
  const cases: string[][] = [
    ["--prompt-file", empty], ["--prompt-file", nul], ["--prompt-file", invalidUtf8], ["--prompt-file", oversized],
    ["--prompt-file", empty, "--no-prompt"], ["--no-prompt", "--directory", "relative"],
    ["--no-prompt", "--directory", `/${"x".repeat(4097)}`], ["--no-prompt", "--timeout", "nan"],
    ["--no-prompt", "--ready-timeout", "inf"], ["--no-prompt", "--cols", "0"],
    ["--no-prompt", "--gate-timeout", "nan"],
    ["--no-prompt", "--rows", "1001"], ["--no-prompt", "--title", "x".repeat(513)],
    ["--no-prompt", "--model", "x".repeat(513)], ["--no-prompt", "--opencode-agent", "review"],
  ];
  const fixture = await startTuiFixture();
  try {
    const implicitEmpty = await cliProcess(fixture.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project",
    ]);
    assert.notEqual(implicitEmpty.code, 0);
    for (const entry of cases) {
      const hasDirectory = entry.includes("--directory");
      const completed = await cliProcess(fixture.url, [
        "tui", "codex", "linux-box", ...(hasDirectory ? [] : ["--directory", "/srv/project"]), ...fastTuiGate, ...entry,
      ]);
      assert.notEqual(completed.code, 0, `unexpected success for ${entry[0]}`);
    }
    for (const publicUrl of ["relative", "ftp://wmux.example", "https://user@wmux.example", "https://wmux.example/?q=1", "https://wmux.example/#x"]) {
      const completed = await cliProcess(fixture.url, [
        "--public-url", publicUrl, "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt",
        ...fastTuiGate,
      ]);
      assert.notEqual(completed.code, 0);
    }
    const invalidEnvironment = await cliProcess(fixture.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt",
      ...fastTuiGate,
    ], "", { WMUX_PUBLIC_URL: "https://wmux.example/?bad=1" });
    assert.notEqual(invalidEnvironment.code, 0);
    assert.equal(fixture.workspacePosts, 0);
  } finally {
    await fixture.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const invalidApi = await cliProcess("http://127.0.0.1:3478/base?token=no", [
    "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt",
    ...fastTuiGate,
  ]);
  assert.notEqual(invalidApi.code, 0);
  assert.match(invalidApi.stderr, /without a query or fragment/);
});

test("wmuxctl tui honors public URL environment/flag, path-prefixed API bases, and fallback", async () => {
  const cases = [
    { env: { WMUX_PUBLIC_URL: "https://env.example/wmux" }, global: [] as string[], expected: "https://env.example/wmux" },
    { env: { WMUX_PUBLIC_URL: "https://env.example" }, global: ["--public-url", "https://flag.example/ui"], expected: "https://flag.example/ui" },
    { env: { WMUX_PUBLIC_URL: "" }, global: [] as string[], expected: "" },
  ];
  for (const entry of cases) {
    const fixture = await startTuiFixture({ pathPrefix: "/api-base" });
    try {
      const completed = await cliProcess(fixture.url, [
        ...entry.global, "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt",
        ...fastTuiGate,
      ], "", entry.env);
      assert.equal(completed.code, 0, completed.stderr);
      const result = JSON.parse(completed.stdout);
      assertEstablishedResult(result);
      assert.equal(result.localUrl, `${fixture.url}/workspaces/ws_tui_fixture/tabs/tab_tui_fixture`);
      const publicBase = entry.expected || fixture.url;
      assert.equal(result.publicUrl, `${publicBase}/workspaces/ws_tui_fixture/tabs/tab_tui_fixture`);
      assert.equal(result.url, result.publicUrl);
    } finally {
      await fixture.stop();
    }
  }
});

test("wmuxctl tui rejects unreachable/non-POSIX targets before creation and identity drift after creation", async () => {
  for (const machine of [
    { id: "other-box", kind: "ssh", platform: "linux", reachable: true },
    { id: "linux-box", kind: "ssh", platform: "linux", reachable: false },
    { id: "linux-box", kind: "powershell-ssh", platform: "win", reachable: true },
  ]) {
    const fixture = await startTuiFixture({ machineAtBootstrap: () => machine });
    try {
      const completed = await cliProcess(fixture.url, [
        "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt",
        ...fastTuiGate,
      ]);
      assert.notEqual(completed.code, 0);
      assert.equal(fixture.workspacePosts, 0);
    } finally {
      await fixture.stop();
    }
  }

  const fixture = await startTuiFixture({
    machineAtBootstrap: (count) => ({
      id: "linux-box", kind: "ssh", platform: "linux", reachable: true, source: "dynamic",
      endpoint: count >= 3 ? "10.0.0.9:22" : "10.0.0.2:22", user: "operator", port: 22,
      backendDetail: count >= 2 ? "new health prose" : "old health prose",
    }),
  });
  try {
    const completed = await cliProcess(fixture.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt",
      ...fastTuiGate,
    ]);
    assert.equal(completed.code, 1);
    const result = JSON.parse(completed.stdout);
    assertEstablishedResult(result);
    assert.match(result.error, /identity changed/);
    assert.equal(fixture.inputs.length, 0);
    assert.equal(fixture.methods.some((value) => value.startsWith("DELETE ")), false);
  } finally {
    await fixture.stop();
  }

  const lostFixture = await startTuiFixture({
    machineAtBootstrap: (count) => ({
      id: "linux-box", kind: "ssh", platform: "linux", reachable: count < 3,
      source: "static", endpoint: "10.0.0.2:22", user: "operator", port: 22,
    }),
  });
  try {
    const completed = await cliProcess(lostFixture.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt",
      ...fastTuiGate,
    ]);
    assert.equal(completed.code, 1);
    const result = JSON.parse(completed.stdout);
    assertEstablishedResult(result);
    assert.match(result.error, /not reachable/);
    assert.equal(lostFixture.inputs.length, 0);
    assert.equal(lostFixture.methods.some((value) => value.startsWith("DELETE ")), false);
  } finally {
    await lostFixture.stop();
  }
});

test("wmuxctl tui reports helper failure immediately and post-launch timeout with stable open-workspace JSON", async () => {
  const prompt = "never expose this prompt\nwith a quoted Ω value";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-tui-helper-fail-"));
  const promptPath = path.join(root, "prompt.txt");
  fs.writeFileSync(promptPath, prompt);
  const helperFixture = await startTuiFixture({
    replayAtUpgrade: (count, runId, token) => {
      if (count === 1) return "operator@host $ ";
      if (count === 2) return "baseline";
      if (count === 3) return `WMUX_AGENT_TUI_READY ${runId}`;
      const escapedPrompt = JSON.stringify(prompt).slice(1, -1);
      const payload = Buffer.from(JSON.stringify({ runId, ok: false, error: `launch rejected ${escapedPrompt} ${token}` })).toString("base64");
      return `WMUX_AGENT_RESULT ${payload}\nWMUX_AGENT_DONE ${runId} 2`;
    },
  });
  try {
    const started = Date.now();
    const completed = await cliProcess(helperFixture.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath, "--ready-timeout", "2",
      ...fastTuiGate,
    ]);
    assert.equal(completed.code, 1);
    assert.ok(Date.now() - started < 1500, "helper failure should not consume the readiness timeout");
    const result = JSON.parse(completed.stdout);
    assertEstablishedResult(result);
    assert.match(result.error, /interactive helper failed/);
    assert.equal(JSON.stringify(result).includes(prompt), false);
    assert.equal(JSON.stringify(result).includes(JSON.stringify(prompt).slice(1, -1)), false);
    assert.equal(JSON.stringify(result).includes("test-token"), false);
    assert.equal(completed.stderr.includes(prompt), false);
    assert.equal(helperFixture.methods.some((value) => value.startsWith("DELETE ")), false);
  } finally {
    await helperFixture.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const timeoutFixture = await startTuiFixture({
    replayAtUpgrade: (count, runId) => {
      if (count === 1) return "operator@host $ ";
      if (count === 2) return "baseline";
      if (count === 3) return `WMUX_AGENT_TUI_READY ${runId}`;
      return `WMUX_AGENT_TUI_LAUNCH ${runId}`;
    },
  });
  try {
    const completed = await cliProcess(timeoutFixture.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt", "--ready-timeout", "0.05",
      ...fastTuiGate,
    ]);
    assert.equal(completed.code, 1);
    const result = JSON.parse(completed.stdout);
    assertEstablishedResult(result);
    assert.match(result.error, /post-start TUI output/);
    assert.equal(timeoutFixture.methods.some((value) => value.startsWith("DELETE ")), false);
  } finally {
    await timeoutFixture.stop();
  }
});

test("wmuxctl tui refuses safety gates, accepts only recognized trust with separate input, and allows ordinary output", async () => {
  const scenarios = [
    { name: "trust refusal after splash", output: "Do you trust the contents of this directory?\n1. Yes, continue\n2. No, exit", error: /repository-trust/, accept: false, delayed: true },
    { name: "login", output: "Enter your API key:", error: /login prompt/, accept: false },
    { name: "unknown first run", output: "Would you like to configure telemetry? [y/N]", error: /unknown-first-run prompt/, accept: false },
    { name: "unmapped trust", output: "Trust this repository? [y/N]", error: /unknown-first-run prompt/, accept: true },
  ];
  for (const scenario of scenarios) {
    const fixture = await startTuiFixture({
      replayAtUpgrade: (count, runId) => [
        "operator@host $ ", "baseline", `WMUX_AGENT_TUI_READY ${runId}`,
        `WMUX_AGENT_TUI_LAUNCH ${runId}`, scenario.delayed ? "runtime splash" : scenario.output,
      ][count - 1] ?? scenario.output,
    });
    try {
      const completed = await cliProcess(fixture.url, [
        "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt",
        ...fastTuiGate,
        ...(scenario.accept ? ["--accept-trust"] : []),
      ]);
      assert.equal(completed.code, 1, scenario.name);
      const result = JSON.parse(completed.stdout);
      assertEstablishedResult(result);
      assert.match(result.error, scenario.error);
      assert.equal(fixture.methods.some((value) => value.startsWith("DELETE ")), false);
    } finally {
      await fixture.stop();
    }
  }

  const trustFixture = await startTuiFixture({
    replayAtUpgrade: (count, runId) => [
      "operator@host $ ", "baseline", `WMUX_AGENT_TUI_READY ${runId}`,
      `WMUX_AGENT_TUI_LAUNCH ${runId}`, "Do you trust the contents of this directory?\n1. Yes, continue\n2. No, exit",
      "Do you trust the contents of this directory?\n1. Yes, continue\n2. No, exit\nCodex interactive ready",
    ][count - 1] ?? "Codex interactive ready",
  });
  try {
    const completed = await cliProcess(trustFixture.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt", "--accept-trust",
      ...fastTuiGate,
    ]);
    assert.equal(completed.code, 0, completed.stderr);
    const result = JSON.parse(completed.stdout);
    assertEstablishedResult(result);
    assert.equal(result.state, "ready");
    assert.deepEqual(trustFixture.inputs.slice(-2).map((body) => body.data), ["1", "\r"]);
    assert.equal(trustFixture.methods.some((value) => value.startsWith("DELETE ")), false);
  } finally {
    await trustFixture.stop();
  }

  const ordinaryFixture = await startTuiFixture({
    replayAtUpgrade: (count, runId) => [
      "operator@host $ ", "baseline", `WMUX_AGENT_TUI_READY ${runId}`,
      `WMUX_AGENT_TUI_LAUNCH ${runId}`,
      "Agent notes: the API key parser changed during the first run; ordinary TUI is ready.",
    ][count - 1] ?? "ordinary TUI is ready",
  });
  try {
    const completed = await cliProcess(ordinaryFixture.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project", "--no-prompt",
      ...fastTuiGate,
    ]);
    assert.equal(completed.code, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).state, "ready");
  } finally {
    await ordinaryFixture.stop();
  }
});

test("wmuxctl tui observes delayed gates and helper exit before delivering a prompt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmuxctl-tui-gate-observation-"));
  const promptPath = path.join(root, "prompt.txt");
  const prompt = "must not be delivered to a gate or exited runtime";
  fs.writeFileSync(promptPath, prompt);
  const delayedGate = await startTuiFixture({
    replayAtUpgrade: (count, runId) => {
      if (count === 1) return "operator@host $ ";
      if (count === 2) return "baseline";
      if (count === 3) return `WMUX_AGENT_TUI_READY ${runId}`;
      if (count === 4) return `WMUX_AGENT_TUI_LAUNCH ${runId}`;
      if (count <= 7) return "runtime splash";
      return "Enter your API key:";
    },
  });
  try {
    const completed = await cliProcess(delayedGate.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath,
      "--gate-timeout", "0.6",
    ]);
    assert.equal(completed.code, 1);
    const result = JSON.parse(completed.stdout);
    assertEstablishedResult(result);
    assert.match(result.error, /login prompt/);
    assert.equal(delayedGate.inputs.length, 6, "prompt was sent after a delayed startup gate");
    assert.equal(JSON.stringify(delayedGate.inputs).includes(prompt), false);
    assert.equal(delayedGate.methods.some((value) => value.startsWith("DELETE ")), false);
  } finally {
    await delayedGate.stop();
  }

  const earlyExit = await startTuiFixture({
    replayAtUpgrade: (count, runId) => {
      if (count === 1) return "operator@host $ ";
      if (count === 2) return "baseline";
      if (count === 3) return `WMUX_AGENT_TUI_READY ${runId}`;
      if (count === 4) return `WMUX_AGENT_TUI_LAUNCH ${runId}`;
      if (count === 5) return "runtime splash";
      return `WMUX_AGENT_TUI_EXIT ${runId} 9`;
    },
  });
  try {
    const started = Date.now();
    const completed = await cliProcess(earlyExit.url, [
      "tui", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath,
      "--gate-timeout", "0.6",
    ]);
    assert.equal(completed.code, 1);
    assert.ok(Date.now() - started < 1000, "runtime exit should fail before the observation interval expires");
    const result = JSON.parse(completed.stdout);
    assertEstablishedResult(result);
    assert.match(result.error, /interactive runtime exited with code 9/);
    assert.equal(earlyExit.inputs.length, 6, "prompt was sent after an early runtime exit");
    assert.equal(JSON.stringify(earlyExit.inputs).includes(prompt), false);
    assert.equal(earlyExit.methods.some((value) => value.startsWith("DELETE ")), false);
  } finally {
    await earlyExit.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
