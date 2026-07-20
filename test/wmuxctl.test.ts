import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

const cli = (url: string, args: string[]) => execFileAsync("python3", [wmuxctl, "--url", url, ...args], {
  cwd: repoRoot,
  env: { ...process.env, WMUX_TOKEN: "test-token" },
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
    socket.end(websocketFrame({ type: "ready", paneId: "pane_agent", replay, outputOnly: true }));
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
    const sent = await cli(url, ["run", "windows-runner", "--title", "Fresh", "--new", "--line", "Get-Date"]);
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
      request.resume();
      request.on("end", () => jsonResponse(response, { workspace, state: {} }, 201));
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
    if (upgradeCount === 2) replay = "WMUX_AGENT_READY\r\n";
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
    ]);
    const result = JSON.parse(delegated.stdout);
    assert.equal(result.state, "completed");
    assert.equal(result.result, "review complete");
    assert.equal(result.closed, true);
    assert.equal(result.url, `${url}/workspaces/ws_delegate/tabs/tab_delegate`);
    assert.deepEqual(inputs.slice(0, 2).map((body) => body.data), ["wmux-agent-run", "\r"]);
    assert.equal(inputs.some((body) => String(body.data).includes(prompt)), false);
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
        if (typeof body.data === "string" && body.data !== "wmux-agent-run" && body.data !== "\r") {
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
    if (upgradeCount === 2) replay = "WMUX_AGENT_READY\r\n";
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
        if (typeof body.data === "string" && body.data !== "wmux-agent-run" && body.data !== "\r") {
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
    if (upgradeCount === 2) replay = "WMUX_AGENT_READY\r\n";
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
        if (typeof body.data === "string" && body.data !== "wmux-agent-run" && body.data !== "\r" && body.data !== "\u0003") {
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
    if (upgradeCount === 2) replay = "WMUX_AGENT_READY\r\n";
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
      request.resume();
      request.on("end", () => {
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
      cli(url, ["delegate", "codex", "linux-box", "--directory", "/srv/project", "--prompt-file", promptPath]),
      (error: { stdout?: string }) => {
        const result = JSON.parse(error.stdout ?? "{}");
        assert.equal(result.state, "failed");
        assert.equal(result.closed, false);
        assert.match(result.error, /HTTP 500/);
        return true;
      },
    );
    assert.equal(interrupted, true);
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
