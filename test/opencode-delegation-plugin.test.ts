import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooksScript = path.join(repoRoot, "scripts", "wmux-hooks");

const writeRuntimePackages = (configHome: string) => {
  const pluginPackage = path.join(configHome, "node_modules", "@opencode-ai", "plugin");
  const effectPackage = path.join(configHome, "node_modules", "effect");
  fs.mkdirSync(pluginPackage, { recursive: true });
  fs.mkdirSync(effectPackage, { recursive: true });
  const packageJson = JSON.stringify({ type: "module", exports: "./index.js" });
  fs.writeFileSync(path.join(pluginPackage, "package.json"), packageJson);
  fs.writeFileSync(
    path.join(pluginPackage, "index.js"),
    'const optional = () => ({ optional });\nconst schema = { string: () => ({ optional }), number: () => ({ optional }), boolean: () => ({ optional }) };\nexport const tool = Object.assign((value) => value, { schema });\n',
  );
  fs.writeFileSync(path.join(effectPackage, "package.json"), packageJson);
  fs.writeFileSync(
    path.join(effectPackage, "index.js"),
    "export const Effect = { runPromise: async (effect) => typeof effect === 'function' ? effect() : effect };\n",
  );
};

type CapturedRequest = { method: string; pathname: string; body?: Record<string, unknown> };
type FixtureWorkspace = { id: string; createdBy?: "agent" | "user"; tabs?: Array<Record<string, unknown>> };
type ApiOptions = { failTitle?: boolean; failDelete?: boolean; workspaces?: FixtureWorkspace[] };

const startApi = async (options: ApiOptions = {}) => {
  const requests: CapturedRequest[] = [];
  const workspaces = structuredClone(options.workspaces ?? []);
  let authenticated = true;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      authenticated &&= request.headers.authorization === "Bearer test-token-private";
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      requests.push({ method: request.method ?? "GET", pathname, body });
      response.setHeader("content-type", "application/json");
      if (pathname === "/api/bootstrap") {
        response.end(JSON.stringify({
          machines: [{ id: "posix-1", reachable: true, platform: "linux", kind: "ssh" }],
          workspaces,
        }));
        return;
      }
      if (pathname === "/api/workspaces") {
        const workspace = {
          id: "workspace-1",
          createdBy: "agent" as const,
          tabs: [{ id: "tab-1", panes: [{ id: "pane-1" }] }],
        };
        workspaces.push(workspace);
        response.statusCode = 201;
        response.end(JSON.stringify({ workspace }));
        return;
      }
      const workspaceDelete = /^\/api\/workspaces\/([^/]+)$/.exec(pathname);
      if (workspaceDelete && request.method === "DELETE") {
        if (options.failDelete) {
          response.statusCode = 500;
          response.end("{}");
          return;
        }
        const workspaceId = decodeURIComponent(workspaceDelete[1]);
        const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
        const removed = index >= 0;
        if (removed) workspaces.splice(index, 1);
        response.statusCode = removed ? 200 : 409;
        response.end(JSON.stringify({ removed }));
        return;
      }
      if (pathname === "/api/workspaces/workspace-1/title" && options.failTitle) {
        response.statusCode = 500;
        response.end("{}");
        return;
      }
      if (pathname === "/api/workspaces/workspace-1/title" || pathname === "/api/agent-events") {
        response.statusCode = pathname === "/api/agent-events" ? 201 : 200;
        response.end("{}");
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    workspaces,
    authenticated: () => authenticated,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

type SentInput = { data: string; at: number };

const fakeWebSocket = (mode: "complete" | "failure" | "abort", onRequest?: () => void) => {
  const instances: FakeWebSocket[] = [];
  class FakeWebSocket {
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    onclose?: () => void;
    sent: SentInput[] = [];
    decodedRequest?: Record<string, unknown>;
    closed = false;
    authorized: boolean;
    inputBeforePrompt = false;
    promptEmitted = false;
    private pending = "";
    private listeners = new Map<string, Set<() => void>>();

    constructor(endpoint: URL) {
      this.authorized = endpoint.searchParams.has("token");
      instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
        for (const listener of this.listeners.get("open") ?? []) listener();
        this.emit({ type: "ready", replay: "old replay\r\nWMUX_OPENCODE_READY\r\nstarting shell\r\n" });
        setTimeout(() => {
          this.promptEmitted = true;
          this.emit({ type: "output", data: "\u001b[35moperator@host /repo ❯\u001b[0m " });
        }, 20);
      });
    }

    addEventListener(type: string, listener: () => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: () => void) {
      this.listeners.get(type)?.delete(listener);
    }

    send(raw: string) {
      const message = JSON.parse(raw) as { type: string; data: string };
      assert.equal(message.type, "input");
      if (!this.promptEmitted) this.inputBeforePrompt = true;
      this.sent.push({ data: message.data, at: Date.now() });
      if (message.data === "\u0003") return;
      if (message.data !== "\r") {
        this.pending = message.data;
        return;
      }
      const line = this.pending;
      this.pending = "";
      if (line === "wmux-opencode-run") {
        this.emit({ type: "output", data: "wmux-opencode-run\r\n\u001b[32mWMUX_OPENCODE_READY\u001b[0m\r" });
        return;
      }
      this.decodedRequest = JSON.parse(Buffer.from(line, "base64").toString("utf8")) as Record<string, unknown>;
      onRequest?.();
      if (mode === "abort") return;
      const runId = String(this.decodedRequest.runId);
      const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64");
      this.emit({ type: "output", data: "x".repeat(600 * 1024) + "\r" });
      this.emit({ type: "output", data: `WMUX_OPENCODE_RESULT ${encode({ runId, ok: true, result: "stale result" })}\r` });
      this.emit({ type: "output", data: "WMUX_OPENCODE_RESULT not-base64!\r" });
      this.emit({ type: "output", data: `WMUX_OPENCODE_RESULT ${encode({ runId: "another-run", ok: true, result: "wrong run" })}\r` });
      this.emit({ type: "output", data: `echo WMUX_OPENCODE_DONE ${runId} 99\r` });
      const failed = mode === "failure";
      this.emit({
        type: "output",
        data: `\u001b[36mWMUX_OPENCODE_RESULT ${encode(failed
          ? { runId, ok: false, error: "delegated failure" }
          : { runId, ok: true, result: "delegated ✓" })}\u001b[0m\r`,
      });
      this.emit({ type: "output", data: `\u001b[32mWMUX_OPENCODE_DONE ${runId} ${failed ? 1 : 0}\u001b[0m\r` });
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      this.onclose?.();
    }

    private emit(message: Record<string, unknown>) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  return { WebSocket: FakeWebSocket, instances };
};

const withGeneratedTool = async (
  run: (input: { tool: any; closeTool: any; api: Awaited<ReturnType<typeof startApi>>; home: string }) => Promise<void>,
  apiOptions: ApiOptions = {},
) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-delegation-plugin-"));
  const configHome = path.join(home, "config");
  const api = await startApi(apiOptions);
  const saved = { HOME: process.env.HOME, WMUX_URL: process.env.WMUX_URL, WMUX_TOKEN: process.env.WMUX_TOKEN };
  try {
    Object.assign(process.env, { HOME: home, WMUX_URL: api.url, WMUX_TOKEN: "test-token-private" });
    await execFileAsync(hooksScript, ["install", "opencode"], { env: { ...process.env, XDG_CONFIG_HOME: configHome } });
    writeRuntimePackages(configHome);
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    await execFileAsync(process.execPath, ["--experimental-strip-types", "--check", pluginPath]);
    const module = await import(`${pathToFileURL(pluginPath).href}?delegation=${Date.now()}-${Math.random()}`);
    const plugin = await module.default({ client: {}, directory: repoRoot });
    await run({ tool: plugin.tool.wmux_delegate, closeTool: plugin.tool.wmux_close, api, home });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await api.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
};

test("generated OpenCode delegation tool runs permission, pane protocol, result parsing, and lifecycle", async () => {
  await withGeneratedTool(async ({ tool, api }) => {
    const fake = fakeWebSocket("complete");
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = fake.WebSocket;
    const abort = new AbortController();
    const asks: Record<string, unknown>[] = [];
    const metadata: Record<string, unknown>[] = [];
    let effectsRun = 0;
    const prompt = "private raw prompt Ω";
    try {
      const output = await tool.execute(
        { machine: "posix-1", directory: repoRoot, prompt, agent: "build", title: "Delegated build", timeout_seconds: 30, auto_approve: true },
        {
          abort: abort.signal,
          ask: (input: Record<string, unknown>) => {
            asks.push(input);
            return () => { effectsRun += 1; };
          },
          metadata: (input: Record<string, unknown>) => metadata.push(input),
        },
      );

      assert.equal(effectsRun, 1);
      assert.deepEqual(asks[0], {
        permission: "wmux_delegate",
        patterns: ["posix-1", repoRoot],
        always: ["*"],
        metadata: { machine: "posix-1", directory: repoRoot, closeOnSuccess: false },
      });
      assert.equal(fake.instances.length, 1);
      const socket = fake.instances[0];
      assert.equal(socket.authorized, true);
      assert.equal(socket.closed, true);
      assert.equal(socket.inputBeforePrompt, false);
      assert.deepEqual(socket.sent.slice(0, 4).map((item) => item.data), ["wmux-opencode-run", "\r", socket.sent[2].data, "\r"]);
      assert.ok(socket.sent[1].at - socket.sent[0].at >= 75, "command and Enter are separated");
      assert.ok(socket.sent[3].at - socket.sent[2].at >= 75, "request and Enter are separated");
      assert.equal(socket.sent.some((item) => item.data.includes(prompt)), false);
      assert.deepEqual(socket.decodedRequest, {
        runId: (metadata[0] as any).metadata.runId,
        prompt,
        directory: repoRoot,
        agent: "build",
        title: "Delegated build",
        autoApprove: true,
      });
      assert.deepEqual(metadata[0], {
        title: "Delegated build",
        metadata: {
          runId: (metadata[0] as any).metadata.runId,
          workspaceId: "workspace-1",
          tabId: "tab-1",
          paneId: "pane-1",
          url: `${api.url}/workspaces/workspace-1/tabs/tab-1`,
        },
      });
      assert.match(output, /State: completed/);
      assert.match(output, /Workspace closed: false/);
      assert.match(output, /<task_result>\ndelegated ✓\n<\/task_result>/);
      assert.match(output, new RegExp(`URL: ${api.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/workspaces/workspace-1/tabs/tab-1`));
      assert.equal(output.includes(prompt), false);
      assert.equal(output.includes("test-token-private"), false);

      const workspaceRequest = api.requests.find((request) => request.pathname === "/api/workspaces");
      assert.deepEqual(workspaceRequest?.body, { machineId: "posix-1", createdBy: "agent" });
      assert.deepEqual(
        api.requests.filter((request) => request.pathname === "/api/workspaces/workspace-1/title").map((request) => request.body),
        [{ title: "Delegated build" }],
      );
      const lifecycle = api.requests.filter((request) => request.pathname === "/api/agent-events").map((request) => request.body);
      assert.deepEqual(lifecycle.map((event) => ({ agent: event?.agent, status: event?.status, title: event?.title, summary: event?.summary })), [
        { agent: "opencode", status: "running", title: "Delegated build", summary: "OpenCode delegation running" },
        { agent: "opencode", status: "completed", title: "Delegated build", summary: "OpenCode delegation completed" },
      ]);
      assert.equal(api.authenticated(), true);
      assert.equal(api.workspaces.some((workspace) => workspace.id === "workspace-1"), true);
      assert.equal(api.requests.some((request) => request.method === "DELETE"), false);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});

test("generated wmux_close permission-gates ownership, closes agent workspaces, and is idempotent", async () => {
  await withGeneratedTool(async ({ closeTool, api }) => {
    const asks: Record<string, unknown>[] = [];
    let effectsRun = 0;
    const context = {
      abort: new AbortController().signal,
      ask: (input: Record<string, unknown>) => {
        asks.push(input);
        return () => { effectsRun += 1; };
      },
    };
    await assert.rejects(
      closeTool.execute({ workspace_id: "../workspace-user" }, context),
      /invalid wmux workspace ID/,
    );
    const refused = await closeTool.execute({ workspace_id: "workspace-user" }, context);
    assert.match(refused, /State: refused/);
    assert.match(refused, /Workspace closed: false/);
    assert.equal(api.workspaces.some((workspace) => workspace.id === "workspace-user"), true);

    const closed = await closeTool.execute({ workspace_id: "workspace-agent" }, context);
    assert.match(closed, /State: closed/);
    assert.match(closed, /Workspace closed: true/);
    assert.equal(api.workspaces.some((workspace) => workspace.id === "workspace-agent"), false);

    const absent = await closeTool.execute({ workspace_id: "workspace-agent" }, context);
    assert.match(absent, /State: not_found/);
    assert.match(absent, /not found or was already closed/i);
    assert.equal(effectsRun, 3);
    assert.deepEqual(asks, ["workspace-user", "workspace-agent", "workspace-agent"].map((workspaceId) => ({
      permission: "wmux_close",
      patterns: [workspaceId],
      always: ["*"],
      metadata: { workspaceId },
    })));
    assert.deepEqual(
      api.requests.filter((request) => request.method === "DELETE").map((request) => request.pathname),
      ["/api/workspaces/workspace-agent"],
    );
    assert.equal([refused, closed, absent].some((output) => output.includes("test-token-private")), false);
  }, {
    workspaces: [
      { id: "workspace-agent", createdBy: "agent" },
      { id: "workspace-user", createdBy: "user" },
    ],
  });
});

test("close_on_success closes only after completed lifecycle and reports the URL unavailable", async () => {
  await withGeneratedTool(async ({ tool, api }) => {
    const fake = fakeWebSocket("complete");
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = fake.WebSocket;
    const asks: Record<string, unknown>[] = [];
    let effectsRun = 0;
    const prompt = "close-success private prompt";
    try {
      const output = await tool.execute(
        { machine: "posix-1", directory: repoRoot, prompt, close_on_success: true, timeout_seconds: 30 },
        {
          abort: new AbortController().signal,
          ask: (input: Record<string, unknown>) => {
            asks.push(input);
            return () => { effectsRun += 1; };
          },
          metadata: () => undefined,
        },
      );
      assert.equal(effectsRun, 1);
      assert.deepEqual(asks[0], {
        permission: "wmux_delegate",
        patterns: ["posix-1", repoRoot],
        always: ["*"],
        metadata: { machine: "posix-1", directory: repoRoot, closeOnSuccess: true },
      });
      assert.match(output, /State: completed/);
      assert.match(output, /Workspace closed: true/);
      assert.match(output, /URL: unavailable \(workspace closed\)/);
      assert.equal(output.includes(`${api.url}/workspaces/workspace-1/tabs/tab-1`), false);
      assert.match(output, /<task_result>\ndelegated ✓\n<\/task_result>/);
      assert.equal(output.includes(prompt), false);
      assert.equal(output.includes("test-token-private"), false);
      assert.equal(api.workspaces.some((workspace) => workspace.id === "workspace-1"), false);
      const completedIndex = api.requests.findIndex((request) => request.pathname === "/api/agent-events" && request.body?.status === "completed");
      const deleteIndex = api.requests.findIndex((request) => request.method === "DELETE");
      assert.ok(completedIndex >= 0 && deleteIndex > completedIndex, "completed lifecycle precedes workspace deletion");
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});

test("close_on_success preserves successful output and workspace when close fails", async () => {
  await withGeneratedTool(async ({ tool, api }) => {
    const fake = fakeWebSocket("complete");
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = fake.WebSocket;
    const prompt = "close-failure private prompt";
    try {
      const output = await tool.execute(
        { machine: "posix-1", directory: repoRoot, prompt, close_on_success: true, timeout_seconds: 30 },
        { abort: new AbortController().signal, ask: () => () => undefined, metadata: () => undefined },
      );
      assert.match(output, /State: completed/);
      assert.match(output, /Workspace closed: false/);
      assert.match(output, /Close warning: Workspace could not be closed and remains available\./);
      assert.match(output, /<task_result>\ndelegated ✓\n<\/task_result>/);
      assert.equal(api.workspaces.some((workspace) => workspace.id === "workspace-1"), true);
      assert.equal(output.includes(prompt), false);
      assert.equal(output.includes("test-token-private"), false);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  }, { failDelete: true });
});

test("close_on_success does not close failed delegations", async () => {
  await withGeneratedTool(async ({ tool, api }) => {
    const fake = fakeWebSocket("failure");
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = fake.WebSocket;
    try {
      const output = await tool.execute(
        { machine: "posix-1", directory: repoRoot, prompt: "failed private prompt", close_on_success: true, timeout_seconds: 30 },
        { abort: new AbortController().signal, ask: () => () => undefined, metadata: () => undefined },
      );
      assert.match(output, /State: failed/);
      assert.match(output, /Workspace closed: false/);
      assert.equal(api.requests.some((request) => request.method === "DELETE"), false);
      assert.equal(api.workspaces.some((workspace) => workspace.id === "workspace-1"), true);
      assert.equal(output.includes("failed private prompt"), false);
      assert.equal(output.includes("test-token-private"), false);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});

test("generated OpenCode delegation aborts promptly, interrupts, posts stopped, and leaves workspace", async () => {
  await withGeneratedTool(async ({ tool, api }) => {
    const abort = new AbortController();
    const fake = fakeWebSocket("abort", () => setTimeout(() => abort.abort(), 10));
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = fake.WebSocket;
    try {
      const started = Date.now();
      const output = await tool.execute(
        { machine: "posix-1", directory: repoRoot, prompt: "abort-only private prompt", close_on_success: true, timeout_seconds: 30 },
        { abort: abort.signal, ask: () => () => undefined, metadata: () => undefined },
      );
      assert.ok(Date.now() - started < 2_000, "abort does not wait for the delegation timeout");
      assert.match(output, /State: stopped/);
      assert.match(output, /<task_error>\nDelegation was stopped\./);
      assert.equal(output.includes("abort-only private prompt"), false);
      const socket = fake.instances[0];
      assert.equal(socket.sent.some((item) => item.data === "\u0003"), true);
      assert.equal(socket.closed, true);
      assert.deepEqual(
        api.requests.filter((request) => request.pathname === "/api/agent-events").map((request) => request.body?.status),
        ["running", "stopped"],
      );
      assert.equal(api.requests.some((request) => request.method === "DELETE"), false);
      assert.equal(api.workspaces.some((workspace) => workspace.id === "workspace-1"), true);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});

test("generated OpenCode delegation posts failed when title setup fails after workspace creation", async () => {
  await withGeneratedTool(async ({ tool, api }) => {
    const fake = fakeWebSocket("complete");
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = fake.WebSocket;
    try {
      const output = await tool.execute(
        { machine: "posix-1", directory: repoRoot, prompt: "prelaunch private prompt", timeout_seconds: 30 },
        { abort: new AbortController().signal, ask: () => () => undefined, metadata: () => undefined },
      );
      assert.match(output, /State: failed/);
      assert.equal(output.includes("prelaunch private prompt"), false);
      assert.equal(fake.instances.length, 0);
      assert.deepEqual(
        api.requests.filter((request) => request.pathname === "/api/agent-events").map((request) => request.body?.status),
        ["failed"],
      );
      assert.equal(api.requests.some((request) => request.method === "DELETE"), false);
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  }, { failTitle: true });
});
