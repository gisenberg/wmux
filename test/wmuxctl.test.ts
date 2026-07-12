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

test("Windows wmux-title sends the bearer token used by authenticated APIs", () => {
  const helper = fs.readFileSync(path.join(repoRoot, "scripts", "windows", "wmux-title.ps1"), "utf8");
  assert.match(helper, /function Get-WmuxToken/);
  assert.match(helper, /\$Headers\['Authorization'\] = "Bearer \$WmuxToken"/);
  assert.match(helper, /Invoke-RestMethod[^\n]+-Headers \$Headers/);
});
