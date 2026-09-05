import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = (name: string) => path.join(repoRoot, "scripts", name);

test("every POSIX helper refuses an explicit unreadable helper path without legacy fallback", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-helper-auth-"));
  const mediaFile = path.join(home, "media.txt");
  fs.writeFileSync(mediaFile, "media");
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WMUX_URL: url,
    WMUX_TOKEN: "legacy-compatibility-token",
    WMUX_HELPER_TOKEN_PATH: path.join(home, "missing-helper-token"),
    WMUX_BROWSER_AUTH_MODE: "shared-or-login",
    WMUX_PANE_ID: "pane-test",
    WMUX_WORKSPACE_ID: "workspace-test",
  };
  delete env.WMUX_HELPER_TOKEN;
  const invocations: Array<[string, string[]]> = [
    ["bash", [script("wmux-notify"), "--body", "test"]],
    ["bash", [script("wmux-title"), "--workspace", "workspace-test", "--title", "test"]],
    ["bash", [script("wmux-media"), "--mode", "http", mediaFile]],
    ["python3", [script("wmux-agent-event"), "--pane", "pane-test", "--force"]],
    ["python3", [script("wmux-copy"), mediaFile]],
    ["python3", [script("wmux-run"), "--", "/bin/true"]],
    ["python3", [script("wmux-shell-run-event"), "start", "--run-id", "run-test", "--command", "true"]],
    ["python3", ["-c", "import importlib.machinery,sys;m=importlib.machinery.SourceFileLoader('stream',sys.argv[1]).load_module();m.wmux_headers()", script("wmux-stream-agent")]],
    [process.execPath, [script("wmux-doctor"), "--json"]],
  ];
  try {
    for (const [command, args] of invocations) {
      await assert.rejects(execFileAsync(command, args, { cwd: repoRoot, env }));
    }
    assert.equal(requests, 0, "no helper retries with the compatibility token");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("wmux-media uploads file bytes and pane metadata", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-media-upload-"));
  const mediaFile = path.join(home, "render.mp4");
  const mediaBytes = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
  fs.writeFileSync(mediaFile, mediaBytes);
  let received: {
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    payload: Record<string, unknown>;
  } | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      };
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const helperToken = "media-helper-token-0123456789abcdef";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      WMUX_URL: `http://127.0.0.1:${address.port}`,
      WMUX_HELPER_TOKEN: helperToken,
      WMUX_BROWSER_AUTH_MODE: "login-only",
    };
    delete env.WMUX_HELPER_TOKEN_PATH;
    delete env.WMUX_TOKEN;
    delete env.WMUX_TOKEN_PATH;

    await execFileAsync("bash", [
      script("wmux-media"),
      "--mode", "http",
      "--mime", "video/mp4",
      "--name", "full-gpu-render.mp4",
      "--pane", "pane-test",
      "--workspace", "workspace-test",
      "--tab", "tab-test",
      mediaFile,
    ], { cwd: repoRoot, env });

    assert.ok(received);
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/api/media");
    assert.equal(received.authorization, `Bearer ${helperToken}`);
    assert.equal(received.payload.name, "full-gpu-render.mp4");
    assert.equal(received.payload.mimeType, "video/mp4");
    assert.equal(received.payload.data, mediaBytes.toString("base64"));
    assert.equal(received.payload.paneId, "pane-test");
    assert.equal(received.payload.workspaceId, "workspace-test");
    assert.equal(received.payload.tabId, "tab-test");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("wmux-title prefers the refreshed persisted helper URL when the environment is absent", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-title-url-"));
  const wmuxDirectory = path.join(home, ".wmux");
  fs.mkdirSync(wmuxDirectory, { mode: 0o700 });
  let requestUrl = "";
  let payload: Record<string, unknown> = {};
  const server = http.createServer((request, response) => {
    requestUrl = request.url ?? "";
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(wmuxDirectory, "url"), `http://127.0.0.1:${address.port}\n`, { mode: 0o600 });
    const env = {
      ...process.env,
      HOME: home,
      WMUX_BROWSER_AUTH_MODE: "login-only",
      WMUX_URL: "http://127.0.0.1:1",
      WMUX_HELPER_URL: "http://127.0.0.1:2",
      WMUX_PUBLIC_URL: "http://127.0.0.1:3",
      WMUX_WORKSPACE_ID: "ws_source",
      WMUX_TAB_ID: "tab_source",
      WMUX_PANE_ID: "pane_source",
    };
    delete env.HERDR_WORKSPACE_ID;
    delete env.HERDR_TAB_ID;
    delete env.HERDR_PANE_ID;
    delete env.PRIME_AGENT_INTERNAL_DAEMON_WORKER;
    delete env.WMUX_HELPER_TOKEN;
    delete env.WMUX_HELPER_TOKEN_PATH;
    await execFileAsync("bash", [script("wmux-title"), "--workspace", "ws_test", "--title", "Persisted URL"], { env });
    assert.equal(requestUrl, "/api/workspaces/ws_test/auto-title");
    assert.deepEqual(payload, { title: "Persisted URL", tabOnlyIfMultiple: true, tabId: "tab_source" });

    await execFileAsync("bash", [script("wmux-title"), "--title", "Environment tuple"], { env });
    assert.equal(requestUrl, "/api/workspaces/ws_source/auto-title");
    assert.deepEqual(payload, {
      title: "Environment tuple",
      tabOnlyIfMultiple: true,
      tabId: "tab_source",
      paneId: "pane_source",
    });

    await assert.rejects(execFileAsync("bash", [script("wmux-title"), "--title", "Partial HERDR"], {
      env: { ...env, HERDR_WORKSPACE_ID: "ws_partial" },
    }), /incomplete HERDR identity tuple/);

    await execFileAsync("bash", [script("wmux-title"),
      "--workspace", "ws_explicit",
      "--tab", "tab_explicit",
      "--pane", "pane_explicit",
      "--title", "Explicit tuple",
    ], { env: { ...env, HERDR_WORKSPACE_ID: "ws_partial" } });
    assert.deepEqual(payload, {
      title: "Explicit tuple",
      tabOnlyIfMultiple: true,
      tabId: "tab_explicit",
      paneId: "pane_explicit",
    });

    const staleDaemonEnv = { ...env, PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1" };
    delete staleDaemonEnv.HERDR_WORKSPACE_ID;
    delete staleDaemonEnv.HERDR_TAB_ID;
    delete staleDaemonEnv.HERDR_PANE_ID;
    await assert.rejects(execFileAsync("bash", [script("wmux-title"), "--title", "Stale daemon"], {
      env: staleDaemonEnv,
    }), /incomplete HERDR identity tuple/);
    await execFileAsync("bash", [script("wmux-title"),
      "--workspace", "ws_daemon",
      "--tab", "tab_daemon",
      "--pane", "pane_daemon",
      "--title", "Explicit daemon tuple",
    ], { env: staleDaemonEnv });
    assert.deepEqual(payload, {
      title: "Explicit daemon tuple",
      tabOnlyIfMultiple: true,
      tabId: "tab_daemon",
      paneId: "pane_daemon",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("explicit malformed helper environments fail before compatibility fallback", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-helper-env-"));
  try {
    await assert.rejects(execFileAsync("python3", [script("wmux-agent-event"), "--pane", "pane-test", "--force"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        WMUX_HELPER_TOKEN: "short",
        WMUX_TOKEN: "legacy-compatibility-token",
        WMUX_BROWSER_AUTH_MODE: "shared-or-login",
      },
    }), /configured helper token is empty or malformed/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("all Windows helper token loaders enforce explicit scoped sources", () => {
  for (const name of ["wmux-agent-event.ps1", "wmux-copy.ps1", "wmux-media.ps1", "wmux-notify.ps1", "wmux-run.ps1", "wmux-title.ps1"]) {
    const source = fs.readFileSync(path.join(repoRoot, "scripts", "windows", name), "utf8");
    assert.match(source, /GetEnvironmentVariable\('WMUX_HELPER_TOKEN', 'Process'\)/, name);
    assert.match(source, /GetEnvironmentVariable\('WMUX_HELPER_TOKEN_PATH', 'Process'\)/, name);
    assert.match(source, /\^\[A-Za-z0-9_-\]\{32,256\}\$/, name);
    assert.match(source, /configured helper token file is unreadable or malformed/, name);
    assert.ok(source.indexOf("configured helper token file is unreadable or malformed") < source.lastIndexOf("$env:WMUX_TOKEN"), name);
  }
});
