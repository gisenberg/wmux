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

test("OpenCode installer writes an idempotent global plugin without touching config", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-hooks-"));
  const configHome = path.join(home, "config home");
  const configPath = path.join(configHome, "opencode", "opencode.json");
  const config = '{"unrelated":true}\n';
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, config);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome };
  const hooks = path.join(repoRoot, "scripts", "wmux-hooks");
  try {
    await execFileAsync(hooks, ["install", "opencode"], { env });
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const plugin = fs.readFileSync(pluginPath, "utf8");
    assert.match(plugin, /const eventScript = .*wmux-agent-event/);
    assert.match(plugin, /"chat\.message"/);
    assert.match(plugin, /if \(!session \|\| session\.data\?\.parentID\) return/);
    assert.match(plugin, /session\.idle/);
    assert.match(plugin, /session\.error/);
    assert.match(plugin, /question\.asked/);
    assert.match(plugin, /question\.replied/);
    assert.match(plugin, /question\.rejected/);
    assert.match(plugin, /permission\.asked/);
    assert.match(plugin, /permission\.replied/);
    assert.match(plugin, /pending: new Set\(\)/);
    assert.match(plugin, /current\.pending\.delete\(key\) \|\| current\.pending\.size/);
    assert.match(plugin, /sendQueue = sendQueue\.then\(\(\) => sendNow\(input\)\)\.catch\(\(\) => \{\}\)/);
    assert.match(plugin, /hook_event_name: "Question"/);
    assert.match(plugin, /hook_event_name: "Resume"/);
    assert.match(plugin, /UserPromptSubmit", title, prompt/);
    assert.match(plugin, /const session = await client\.session\.get/);
    assert.match(plugin, /const sessionTitle = \(title: string \| undefined\)/);
    assert.match(plugin, /\^New session - \\d\{4\}/);
    assert.match(plugin, /const title = sessionTitle\(session\.data\?\.title\)/);
    assert.match(plugin, /const title = sessionTitle\(session\?\.data\?\.title\) \|\| current\.title/);
    await execFileAsync(process.execPath, ["--experimental-strip-types", "--check", pluginPath]);
    const before = fs.statSync(pluginPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await execFileAsync(hooks, ["install", "opencode"], { env });
    assert.equal(fs.statSync(pluginPath).mtimeMs, before);
    assert.equal(fs.readFileSync(configPath, "utf8"), config);
    const { stdout } = await execFileAsync(hooks, ["status"], { env });
    const status = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(status.opencode, "installed");
    assert.equal(status.opencodePath, pluginPath);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated OpenCode plugin forwards a complete top-level lifecycle", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-opencode-plugin-"));
  const configHome = path.join(home, "config");
  const captured: Record<string, unknown>[] = [];
  let requestsInFlight = 0;
  let maxRequestsInFlight = 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      requestsInFlight += 1;
      maxRequestsInFlight = Math.max(maxRequestsInFlight, requestsInFlight);
      setTimeout(() => {
        requestsInFlight -= 1;
        response.writeHead(201, { "content-type": "application/json" });
        response.end("{}");
      }, 75);
    });
  });
  const savedEnv = {
    HOME: process.env.HOME,
    WMUX_HELPER_URL: process.env.WMUX_HELPER_URL,
    WMUX_URL: process.env.WMUX_URL,
    WMUX_TOKEN: process.env.WMUX_TOKEN,
    WMUX_TOKEN_PATH: process.env.WMUX_TOKEN_PATH,
    WMUX_PANE_ID: process.env.WMUX_PANE_ID,
    WMUX_WORKSPACE_ID: process.env.WMUX_WORKSPACE_ID,
  };
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    Object.assign(process.env, {
      HOME: home,
      WMUX_HELPER_URL: `http://127.0.0.1:${address.port}`,
      WMUX_URL: `http://127.0.0.1:${address.port}`,
      WMUX_TOKEN: "",
      WMUX_TOKEN_PATH: path.join(home, "missing-token"),
      WMUX_PANE_ID: "pane-opencode",
      WMUX_WORKSPACE_ID: "workspace-opencode",
    });

    const hooksScript = path.join(repoRoot, "scripts", "wmux-hooks");
    await execFileAsync(hooksScript, ["install", "opencode"], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
    });
    const pluginPackage = path.join(configHome, "node_modules", "@opencode-ai", "plugin");
    const effectPackage = path.join(configHome, "node_modules", "effect");
    fs.mkdirSync(pluginPackage, { recursive: true });
    fs.mkdirSync(effectPackage, { recursive: true });
    fs.writeFileSync(path.join(pluginPackage, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(pluginPackage, "index.js"), 'export const tool = Object.assign((value) => value, { schema: { string: () => ({ optional: () => ({}) }), number: () => ({ optional: () => ({}) }), boolean: () => ({ optional: () => ({}) }) } });\n');
    fs.writeFileSync(path.join(effectPackage, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(effectPackage, "index.js"), 'export const Effect = { runPromise: (fn) => fn() };\n');
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
    const createPlugin = pluginModule.default as (input: Record<string, unknown>) => Promise<Record<string, (...args: unknown[]) => Promise<void>>>;
    const client = {
      session: {
        get: async () => ({ data: { title: "OpenCode integration", parentID: undefined } }),
        messages: async () => ({
          data: [
            { info: { id: "user-1", role: "user" }, parts: [{ type: "text", text: "fix hooks" }] },
            { info: { id: "assistant-1", role: "assistant", parentID: "user-1" }, parts: [{ type: "text", text: "Done." }] },
          ],
        }),
      },
    };
    const plugin = await createPlugin({ client, directory: repoRoot });
    await plugin["chat.message"](
      { sessionID: "session-1" },
      { message: { id: "user-1" }, parts: [{ type: "text", text: "fix hooks" }] },
    );
    const dispatches = [
      plugin.event({ event: { type: "question.asked", properties: { sessionID: "session-1", id: "question-1" } } }),
      plugin.event({ event: { type: "question.asked", properties: { sessionID: "session-1", id: "question-1" } } }),
      plugin.event({ event: { type: "permission.asked", properties: { sessionID: "session-1", id: "permission-1" } } }),
      plugin.event({ event: { type: "question.replied", properties: { sessionID: "session-1", requestID: "question-1" } } }),
      plugin.event({ event: { type: "permission.replied", properties: { sessionID: "session-1", requestID: "permission-1" } } }),
      plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } }),
    ];
    await Promise.all(dispatches);

    assert.deepEqual(
      captured.map(({ status, title, message }) => ({ status, title, message })),
      [
        { status: "running", title: "OpenCode integration", message: undefined },
        { status: "waiting", title: "OpenCode integration", message: undefined },
        { status: "waiting", title: "OpenCode integration", message: undefined },
        { status: "running", title: "OpenCode integration", message: undefined },
        { status: "completed", title: "OpenCode integration", message: "Done." },
      ],
    );
    assert.equal(maxRequestsInFlight, 1);
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
