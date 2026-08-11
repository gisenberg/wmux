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

test("OpenCode installer writes an idempotent global plugin without touching config", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-hooks-"));
  const configHome = path.join(home, "config home");
  const configPath = path.join(configHome, "opencode", "opencode.json");
  const config = '{"unrelated":true}\n';
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.chmodSync(configHome, 0o700);
  fs.chmodSync(path.join(configHome, "opencode"), 0o700);
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
    assert.match(plugin, /custom: question\.custom \?\? true/);
    assert.match(plugin, /permission\.asked/);
    assert.match(plugin, /permission\.replied/);
    assert.match(plugin, /event\.type === "session\.updated"/);
    assert.match(plugin, /event\.properties\.info/);
    assert.match(plugin, /cacheTitle\(info\.id, info\.title\)/);
    assert.match(plugin, /pending: new Set\(\)/);
    assert.match(plugin, /current\.pending\.delete\(key\) \|\| current\.pending\.size/);
    assert.match(plugin, /sendQueue = sendQueue\.then\(\(\) => sendNow\(input\)\)\.catch\(\(\) => \{\}\)/);
    assert.match(plugin, /hook_event_name: "Question"/);
    assert.match(plugin, /hook_event_name: "Resume"/);
    assert.match(plugin, /UserPromptSubmit", title, prompt/);
    assert.match(plugin, /const session = await client\.session\.get/);
    assert.match(plugin, /const sessionTitle = \(title: string \| undefined\)/);
    assert.match(plugin, /\^New session - \\d\{4\}/);
    assert.match(plugin, /cacheTitle\(input\.sessionID, session\.data\?\.title\)/);
    assert.match(plugin, /const title = titles\.get\(sessionID\) \|\| sessionTitle\(session\?\.data\?\.title\) \|\| current\.title/);
    assert.match(plugin, /if \(!await beginDelivery\(delivery\)\) \{[\s\S]*deliveryStates\.delete\(invocationKey\)/,
      "an unstarted delivery remains eligible after broker refresh or start-response loss");
    assert.match(plugin, /result\.data\.length > 256/,
      "the v9 compatibility contract bounds snapshot validation before per-session SDK calls");
    assert.match(plugin, /Buffer\.byteLength\(JSON\.stringify\(message\)\) > MAX_BROKER_LINE_BYTES/,
      "complete snapshots cannot be silently dropped at the broker-control line bound");
    assert.match(plugin, /return questionBroker\?\.send\(\{[\s\S]*type: "asked"[\s\S]*\}\) === true/,
      "direct asks report broker-line admission instead of silently succeeding");
    assert.match(plugin, /Math\.min\(8, validated\.length\)/,
      "snapshot session validation uses bounded concurrency under one deadline");
    assert.match(plugin, /Symbol\.for\("wmux\.opencode\.question-broker-owner"\)/,
      "plugin replacement owns and retires one broker process");
    await execFileAsync(process.execPath, ["--experimental-strip-types", "--check", pluginPath]);
    const before = fs.statSync(pluginPath).mtimeMs;
    fs.chmodSync(pluginPath, 0o644);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await execFileAsync(hooks, ["install", "opencode"], { env });
    assert.equal(fs.statSync(pluginPath).mtimeMs, before);
    assert.equal(fs.statSync(pluginPath).mode & 0o777, 0o600, "unchanged managed plugins still receive owner-only mode repair");
    assert.equal(fs.readFileSync(configPath, "utf8"), config);
    const { stdout } = await execFileAsync(hooks, ["status"], { env });
    const status = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(status.opencode, "installed");
    assert.equal(status.opencodePath, pluginPath);
    assert.equal(status.opencodeParity, true);
    assert.match(String(status.opencodeExpectedHash), /^[a-f0-9]{64}$/);
    assert.equal(status.opencodeExpectedHash, status.opencodeInstalledHash);
    const hash = (await execFileAsync(hooks, ["hash", "opencode"], { env })).stdout.trim();
    assert.equal(hash, status.opencodeExpectedHash);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("OpenCode installer refuses a symlinked plugin staging path", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-hooks-opencode-link-"));
  const configHome = path.join(home, "config");
  const pluginDirectory = path.join(configHome, "opencode", "plugins");
  const target = path.join(home, "target.ts");
  fs.mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, "unmanaged\n", { mode: 0o600 });
  fs.symlinkSync(target, path.join(pluginDirectory, "wmux.ts"));
  try {
    await assert.rejects(
      execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "opencode"], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
      }),
      /non-symlink/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "unmanaged\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("OpenCode installer rejects unsafe ancestors and files without mutating unmanaged content", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-hooks-opencode-integrity-"));
  const hooks = path.join(repoRoot, "scripts", "wmux-hooks");
  try {
    const unsafeRoot = path.join(home, "unsafe-root");
    fs.mkdirSync(unsafeRoot, { mode: 0o777 });
    fs.chmodSync(unsafeRoot, 0o777);
    await assert.rejects(
      execFileAsync(hooks, ["install", "opencode"], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: unsafeRoot } }),
      /group\/world writable/,
    );
    assert.equal(fs.existsSync(path.join(unsafeRoot, "opencode", "plugins", "wmux.ts")), false);

    const configHome = path.join(home, "safe-root");
    const pluginDirectory = path.join(configHome, "opencode", "plugins");
    fs.mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 });
    const pluginPath = path.join(pluginDirectory, "wmux.ts");
    fs.writeFileSync(pluginPath, "user-owned plugin\n", { mode: 0o600 });
    await assert.rejects(
      execFileAsync(hooks, ["install", "opencode"], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome } }),
      /unmanaged file/,
    );
    assert.equal(fs.readFileSync(pluginPath, "utf8"), "user-owned plugin\n");

    fs.rmSync(pluginPath);
    await execFileAsync(hooks, ["install", "opencode"], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome } });
    const managed = fs.readFileSync(pluginPath, "utf8");
    fs.chmodSync(pluginPath, 0o666);
    await assert.rejects(
      execFileAsync(hooks, ["install", "opencode"], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome } }),
      /plugin file must not be group\/world writable/,
    );
    assert.equal(fs.readFileSync(pluginPath, "utf8"), managed);
    assert.equal(fs.statSync(pluginPath).mode & 0o777, 0o666, "unsafe files are rejected rather than silently mutated");

    const linkedRoot = path.join(home, "linked-root");
    const linkTarget = path.join(home, "linked-target");
    fs.mkdirSync(linkedRoot, { mode: 0o700 });
    fs.mkdirSync(linkTarget, { mode: 0o700 });
    fs.symlinkSync(linkTarget, path.join(linkedRoot, "opencode"));
    await assert.rejects(
      execFileAsync(hooks, ["install", "opencode"], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: linkedRoot } }),
      /ancestors must not use symlinks/,
    );
    assert.equal(fs.existsSync(path.join(linkTarget, "plugins", "wmux.ts")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("Prime Agent installer writes an idempotent managed extension and preserves unmanaged files", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-prime-agent-hooks-"));
  const hooks = path.join(repoRoot, "scripts", "wmux-hooks");
  const env = { ...process.env, HOME: home };
  const extensionPath = path.join(home, ".prime", "agent", "extensions", "wmux.ts");
  try {
    await execFileAsync(hooks, ["install", "prime-agent"], { env });
    const extension = fs.readFileSync(extensionPath, "utf8");
    assert.match(extension, /Generated by wmux-hooks/);
    assert.match(extension, /before_agent_start/);
    assert.match(extension, /agent_end/);
    assert.match(extension, /stopReason === "error" \? "Error"/);
    assert.match(extension, /stopReason === "aborted" \? "Interrupted"/);
    assert.match(extension, /WMUX_DELEGATED_RUN/);
    assert.match(extension, /HERDR_WORKSPACE_ID/);
    assert.match(extension, /PRIME_AGENT_INTERNAL_DAEMON_WORKER/);
    assert.match(extension, /hasPendingMessages/);
    assert.match(extension, /--prime-agent-hook/);
    assert.match(extension, /wmux-title/);
    assert.match(extension, /setSessionName/);
    assert.match(extension, /getSessionName/);
    assert.match(extension, /appendEntry/);
    assert.match(extension, /wmux\.prime-title-state\.v1/);
    assert.match(extension, /TITLE_REFRESH_INTERVAL = 6/);
    assert.match(extension, /rlmDepth/);
    await execFileAsync(process.execPath, ["--experimental-strip-types", "--check", extensionPath]);

    const before = fs.statSync(extensionPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await execFileAsync(hooks, ["install", "prime-agent"], { env });
    assert.equal(fs.statSync(extensionPath).mtimeMs, before);
    const status = JSON.parse((await execFileAsync(hooks, ["status"], { env })).stdout) as Record<string, unknown>;
    assert.equal(status.primeAgent, "installed");
    assert.equal(status.primeAgentPath, extensionPath);

    fs.writeFileSync(extensionPath, "user-owned Prime Agent extension\n");
    const reinstall = await execFileAsync(hooks, ["install", "prime-agent"], { env });
    assert.match(reinstall.stdout, /Preserved existing unmanaged Prime Agent extension/);
    assert.equal(fs.readFileSync(extensionPath, "utf8"), "user-owned Prime Agent extension\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Prime Agent extension binds each session to its forwarded pane environment", { skip: process.platform === "win32", concurrency: false }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-prime-agent-routing-"));
  const captured: Record<string, unknown>[] = [];
  const titleCaptured: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const isTitle = request.url?.endsWith("/auto-title") === true;
      (isTitle ? titleCaptured : captured).push(body);
      response.writeHead(isTitle ? 200 : 201, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const saved = Object.fromEntries([
    "HOME", "WMUX_URL", "WMUX_HELPER_URL", "WMUX_PUBLIC_URL", "WMUX_TOKEN", "WMUX_TOKEN_PATH",
    "WMUX_HELPER_TOKEN", "WMUX_HELPER_TOKEN_PATH", "WMUX_BROWSER_AUTH_MODE",
    "WMUX_WORKSPACE_ID", "WMUX_TAB_ID", "WMUX_PANE_ID",
    "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "WMUX_DELEGATED_RUN", "RLM_DEPTH",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER",
  ].map((key) => [key, process.env[key]]));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    delete process.env.WMUX_DELEGATED_RUN;
    delete process.env.RLM_DEPTH;
    delete process.env.WMUX_HELPER_URL;
    delete process.env.WMUX_PUBLIC_URL;
    delete process.env.WMUX_HELPER_TOKEN;
    delete process.env.WMUX_HELPER_TOKEN_PATH;
    Object.assign(process.env, {
      HOME: home,
      WMUX_URL: `http://127.0.0.1:${address.port}`,
      WMUX_TOKEN: "",
      WMUX_TOKEN_PATH: path.join(home, "missing-token"),
      WMUX_BROWSER_AUTH_MODE: "shared-or-login",
      WMUX_WORKSPACE_ID: "ws_aaaaaaaa",
      WMUX_TAB_ID: "tab_aaaaaaaa",
      WMUX_PANE_ID: "pane_aaaaaaaa",
      PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
    });
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "prime-agent"], { env: process.env });
    const extensionPath = path.join(home, ".prime", "agent", "extensions", "wmux.ts");
    const context = (rlmDepth = 0, pending = false, sessionId = rlmDepth > 0 ? "child-default" : "root") => ({
      hasPendingMessages: () => pending,
      sessionManager: {
        getSessionId: () => sessionId,
        getHeader: () => ({ id: sessionId, rlmDepth }),
      },
    });
    const createHandlers = async (digit?: string) => {
      if (digit) {
        process.env.HERDR_WORKSPACE_ID = `ws_${digit.repeat(8)}`;
        process.env.HERDR_TAB_ID = `tab_${digit.repeat(8)}`;
        process.env.HERDR_PANE_ID = `pane_${digit.repeat(8)}`;
      } else {
        delete process.env.HERDR_WORKSPACE_ID;
        delete process.env.HERDR_TAB_ID;
        delete process.env.HERDR_PANE_ID;
      }
      const sessionExtensionPath = path.join(home, `.prime-session-${digit ?? "missing"}-${Date.now()}-${Math.random()}.ts`);
      fs.copyFileSync(extensionPath, sessionExtensionPath);
      const module = await import(pathToFileURL(sessionExtensionPath).href);
      const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
      module.default({ on: (name: string, handler: (event: any, ctx: any) => Promise<void>) => handlers.set(name, handler) });
      return handlers;
    };
    const one = await createHandlers("1");
    const two = await createHandlers("2");
    const childOneA = await createHandlers("1");
    const childOneB = await createHandlers("1");
    const childOneReloaded = await createHandlers("1");
    const missing = await createHandlers();

    // Prime creates its persistent IPython kernel before applying the session
    // exec-env provider, so tool calls must repair stale daemon WMUX_* identity.
    const pythonTool = { toolName: "ipython", input: {
      code: "import json, os; print(json.dumps([os.environ.get('WMUX_WORKSPACE_ID'), os.environ.get('WMUX_TAB_ID'), os.environ.get('WMUX_PANE_ID')]))",
    } };
    await one.get("tool_call")?.(pythonTool, context());
    const pythonResult = await execFileAsync("python3", ["-c", pythonTool.input.code], {
      env: { ...process.env, WMUX_WORKSPACE_ID: "ws_aaaaaaaa", WMUX_TAB_ID: "tab_aaaaaaaa", WMUX_PANE_ID: "pane_aaaaaaaa" },
    });
    assert.deepEqual(JSON.parse(pythonResult.stdout.trim()), ["ws_11111111", "tab_11111111", "pane_11111111"]);

    const futureTool = { toolName: "ipython", input: { code: [
      "   ",
      '"""module documentation"""',
      "# Future imports must remain ahead of executable environment repair.",
      "from __future__ import annotations",
      "from __future__ import (",
      "    generator_stop,",
      ")",
      "import json, os",
      "print(json.dumps([os.environ.get('WMUX_WORKSPACE_ID'), os.environ.get('WMUX_TAB_ID'), os.environ.get('WMUX_PANE_ID')]))",
    ].join("\n") } };
    await one.get("tool_call")?.(futureTool, context());
    assert.ok(futureTool.input.code.indexOf("from __future__ import (") < futureTool.input.code.indexOf("__wmux_os.environ.update"));
    const futureResult = await execFileAsync("python3", ["-c", futureTool.input.code], {
      env: { ...process.env, WMUX_WORKSPACE_ID: "ws_aaaaaaaa", WMUX_TAB_ID: "tab_aaaaaaaa", WMUX_PANE_ID: "pane_aaaaaaaa" },
    });
    assert.deepEqual(JSON.parse(futureResult.stdout.trim()), ["ws_11111111", "tab_11111111", "pane_11111111"]);

    const escapedTripleTool = { toolName: "ipython", input: { code: [
      String.raw`"""line \"""`,
      "continued",
      '"""',
      "from __future__ import annotations",
      "import json, os",
      "print(json.dumps([__doc__, os.environ.get('WMUX_WORKSPACE_ID')]))",
    ].join("\n") } };
    await one.get("tool_call")?.(escapedTripleTool, context());
    const escapedTripleResult = await execFileAsync("python3", ["-c", escapedTripleTool.input.code], {
      env: { ...process.env, WMUX_WORKSPACE_ID: "ws_aaaaaaaa" },
    });
    assert.deepEqual(JSON.parse(escapedTripleResult.stdout.trim()), ['line """\ncontinued\n', "ws_11111111"]);

    const docstringTool = { toolName: "ipython", input: { code: [
      "(",
      '  "module "',
      '  "documentation"',
      ")",
      "from __future__ import annotations",
      "import json, os",
      "print(json.dumps([__doc__, os.environ.get('WMUX_WORKSPACE_ID')]))",
    ].join("\n") } };
    await one.get("tool_call")?.(docstringTool, context());
    assert.ok(docstringTool.input.code.indexOf("from __future__ import annotations") < docstringTool.input.code.indexOf("__wmux_os.environ.update"));
    const docstringResult = await execFileAsync("python3", ["-c", docstringTool.input.code], {
      env: { ...process.env, WMUX_WORKSPACE_ID: "ws_aaaaaaaa" },
    });
    assert.deepEqual(JSON.parse(docstringResult.stdout.trim()), ["module documentation", "ws_11111111"]);

    const joinedDocstringTool = { toolName: "ipython", input: { code: [
      '"module " \\',
      '"documentation"',
      "from __future__ import annotations",
      "import json, os",
      "print(json.dumps([__doc__, os.environ.get('WMUX_WORKSPACE_ID')]))",
    ].join("\n") } };
    await one.get("tool_call")?.(joinedDocstringTool, context());
    const joinedDocstringResult = await execFileAsync("python3", ["-c", joinedDocstringTool.input.code], {
      env: { ...process.env, WMUX_WORKSPACE_ID: "ws_aaaaaaaa" },
    });
    assert.deepEqual(JSON.parse(joinedDocstringResult.stdout.trim()), ["module documentation", "ws_11111111"]);

    const crlfFutureTool = { toolName: "ipython", input: { code: [
      "from __future__ import annotations, \\",
      "    generator_stop",
      "import json, os",
      "print(json.dumps([os.environ.get('WMUX_WORKSPACE_ID'), os.environ.get('WMUX_TAB_ID')]))",
    ].join("\r\n") } };
    await one.get("tool_call")?.(crlfFutureTool, context());
    const crlfFutureResult = await execFileAsync("python3", ["-c", crlfFutureTool.input.code], {
      env: { ...process.env, WMUX_WORKSPACE_ID: "ws_aaaaaaaa", WMUX_TAB_ID: "tab_aaaaaaaa" },
    });
    assert.deepEqual(JSON.parse(crlfFutureResult.stdout.trim()), ["ws_11111111", "tab_11111111"]);

    const bashTool = { toolName: "ipython", input: {
      code: `%%bash\nprintf '%s|%s|%s\n' "$WMUX_WORKSPACE_ID" "$WMUX_TAB_ID" "$WMUX_PANE_ID"`,
    } };
    await two.get("tool_call")?.(bashTool, context());
    assert.match(bashTool.input.code, /^%%bash\nexport WMUX_WORKSPACE_ID='ws_22222222'/);
    const bashResult = await execFileAsync("bash", ["-c", bashTool.input.code.replace(/^%%bash\n/, "")], {
      env: { ...process.env, WMUX_WORKSPACE_ID: "ws_aaaaaaaa", WMUX_TAB_ID: "tab_aaaaaaaa", WMUX_PANE_ID: "pane_aaaaaaaa" },
    });
    assert.equal(bashResult.stdout.trim(), "ws_22222222|tab_22222222|pane_22222222");

    const unboundTool = { toolName: "ipython", input: { code: "print('unchanged')" } };
    await missing.get("tool_call")?.(unboundTool, context());
    assert.equal(unboundTool.input.code, "print('unchanged')");

    await one.get("before_agent_start")?.({ prompt: "Name workspace one" }, context());
    await two.get("before_agent_start")?.({ prompt: "Name workspace two" }, context());
    await one.get("agent_end")?.({ messages: [{ role: "assistant", content: "done one" }] }, context());
    await two.get("agent_end")?.({ messages: [{ role: "assistant", content: "done two" }] }, context());
    assert.deepEqual(captured.slice(0, 4).map((event) => [event.workspaceId, event.tabId, event.paneId, event.status, event.title]), [
      ["ws_11111111", "tab_11111111", "pane_11111111", "running", ""],
      ["ws_22222222", "tab_22222222", "pane_22222222", "running", ""],
      ["ws_11111111", "tab_11111111", "pane_11111111", "completed", ""],
      ["ws_22222222", "tab_22222222", "pane_22222222", "completed", ""],
    ]);
    assert.deepEqual(titleCaptured, [
      { title: "Name workspace one", tabOnlyIfMultiple: false, tabId: "tab_11111111" },
      { title: "Name workspace two", tabOnlyIfMultiple: false, tabId: "tab_22222222" },
    ]);
    assert.equal(captured[0]?.runId, captured[2]?.runId);
    assert.equal(captured[1]?.runId, captured[3]?.runId);

    // A later turn in the same bound workspace must not rename it again.
    await one.get("before_agent_start")?.({ prompt: "Do not rename workspace one" }, context());
    await one.get("agent_end")?.({ messages: [{ role: "assistant", content: "done again" }] }, context());
    assert.deepEqual(captured.slice(4, 6).map((event) => [event.paneId, event.status, event.title]), [
      ["pane_11111111", "running", ""],
      ["pane_11111111", "completed", ""],
    ]);

    // A queued continuation remains on one run without a false completion flicker.
    await one.get("before_agent_start")?.({ prompt: "Continue pending work" }, context());
    const pendingRunId = captured.at(-1)?.runId;
    await one.get("agent_end")?.({ messages: [{ role: "assistant", content: "intermediate" }] }, context(0, true));
    assert.equal(captured.at(-1)?.status, "running");
    await one.get("before_agent_start")?.({ prompt: "queued continuation" }, context());
    assert.equal(captured.at(-1)?.runId, pendingRunId);
    await one.get("agent_end")?.({ messages: [{ role: "assistant", content: "finished" }] }, context());
    assert.equal(captured.at(-1)?.status, "completed");
    assert.equal(captured.at(-1)?.runId, pendingRunId);

    // Missing forwarded identity fails closed even when daemon ambient WMUX_*
    // variables contain another pane. Delegated worker sessions remain silent.
    const quietCount = captured.length;
    await missing.get("before_agent_start")?.({ prompt: "ambient must not route" }, context());
    await missing.get("agent_end")?.({ messages: [] }, context());
    process.env.WMUX_DELEGATED_RUN = "1";
    await one.get("before_agent_start")?.({ prompt: "delegated" }, context());
    await one.get("agent_end")?.({ messages: [] }, context());
    delete process.env.WMUX_DELEGATED_RUN;
    await one.get("before_agent_start")?.({ prompt: "invalid depth" }, {
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "invalid-depth", getHeader: () => ({ id: "invalid-depth", rlmDepth: -1 }) },
    });
    await one.get("before_agent_start")?.({ prompt: "missing session id" }, {
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "", getHeader: () => ({ rlmDepth: 1 }) },
    });
    assert.equal(captured.length, quietCount);

    // Root completion stays deferred across independently evaluated child
    // extensions until every nested session is idle. A queued child continuation
    // remains a member and never causes a false completion flicker.
    await one.get("before_agent_start")?.({ prompt: "Coordinate children" }, context(0, false, "root-aggregate"));
    const aggregateRunId = captured.at(-1)?.runId;
    await childOneA.get("before_agent_start")?.({ prompt: "child a" }, context(1, false, "child-a"));
    await childOneB.get("before_agent_start")?.({ prompt: "child b" }, context(1, false, "child-b"));
    const aggregateRunningCount = captured.length;
    await one.get("agent_end")?.({ messages: [{ role: "assistant", content: "parent result" }] }, context(0, false, "root-aggregate"));
    assert.equal(captured.length, aggregateRunningCount);
    await childOneB.get("session_shutdown")?.({ reason: "reload" }, context(1, false, "child-b"));
    assert.equal(captured.length, aggregateRunningCount);
    await childOneA.get("agent_end")?.({ messages: [] }, context(1, true, "child-a"));
    await childOneA.get("before_agent_start")?.({ prompt: "child a continuation" }, context(1, false, "child-a"));
    await childOneA.get("agent_end")?.({ messages: [] }, context(1, false, "child-a"));
    assert.equal(captured.length, aggregateRunningCount);
    await childOneReloaded.get("agent_end")?.({ messages: [] }, context(1, false, "child-b"));
    assert.equal(captured.at(-1)?.status, "completed");
    assert.equal(captured.at(-1)?.runId, aggregateRunId);
    assert.equal(captured.at(-1)?.message, "parent result");

    // A child that starts after the root already became idle gets a bounded
    // synthetic lifecycle, and shutdown drains it rather than leaking a spinner.
    const lateCount = captured.length;
    await childOneA.get("before_agent_start")?.({ prompt: "late child" }, context(1, false, "child-late"));
    assert.equal(captured.length, lateCount + 1);
    assert.equal(captured.at(-1)?.status, "running");
    const lateRunId = captured.at(-1)?.runId;
    await childOneA.get("session_shutdown")?.({ reason: "quit" }, context(1, false, "child-late"));
    assert.equal(captured.at(-1)?.status, "completed");
    assert.equal(captured.at(-1)?.runId, lateRunId);

    // Non-reload root shutdown cannot poison the process-wide registry. It
    // interrupts immediately when alone and waits for descendants otherwise.
    await one.get("before_agent_start")?.({ prompt: "Root quits" }, context(0, false, "root-quits"));
    const quittingRunId = captured.at(-1)?.runId;
    await one.get("session_shutdown")?.({ reason: "quit" }, context(0, false, "root-quits"));
    assert.equal(captured.at(-1)?.status, "interrupted");
    assert.equal(captured.at(-1)?.runId, quittingRunId);

    await one.get("before_agent_start")?.({ prompt: "Root replaced" }, context(0, false, "root-replaced"));
    const replacedRunId = captured.at(-1)?.runId;
    await childOneA.get("before_agent_start")?.({ prompt: "replacement child" }, context(1, false, "replacement-child"));
    const replacementCount = captured.length;
    await one.get("session_shutdown")?.({ reason: "new" }, context(0, false, "root-replaced"));
    assert.equal(captured.length, replacementCount);
    await childOneA.get("session_shutdown")?.({ reason: "quit" }, context(1, false, "replacement-child"));
    assert.equal(captured.at(-1)?.status, "interrupted");
    assert.equal(captured.at(-1)?.runId, replacedRunId);

    await one.get("before_agent_start")?.({ prompt: "Fail after child" }, context(0, false, "root-error-deferred"));
    const deferredErrorRunId = captured.at(-1)?.runId;
    await childOneA.get("before_agent_start")?.({ prompt: "error child" }, context(1, false, "error-child"));
    const deferredErrorCount = captured.length;
    await one.get("agent_end")?.({ messages: [{
      role: "assistant", stopReason: "error", errorMessage: "Root provider failed.",
    }] }, context(0, false, "root-error-deferred"));
    assert.equal(captured.length, deferredErrorCount);
    await childOneA.get("agent_end")?.({ messages: [] }, context(1, false, "error-child"));
    assert.equal(captured.at(-1)?.status, "failed");
    assert.equal(captured.at(-1)?.runId, deferredErrorRunId);
    assert.equal(captured.at(-1)?.message, "Root provider failed.");

    await one.get("before_agent_start")?.({ prompt: "Fail visibly" }, context());
    await one.get("agent_end")?.({ messages: [{
      role: "assistant", content: [{ type: "text", text: "Partial answer" }], stopReason: "error", errorMessage: "Provider failed.",
    }] }, context());
    const errorEvents = captured.slice(-2);
    assert.deepEqual(errorEvents.map((event) => [event.paneId, event.status, event.message]), [
      ["pane_11111111", "running", undefined],
      ["pane_11111111", "failed", "Provider failed."],
    ]);

    await one.get("before_agent_start")?.({ prompt: "Abort visibly" }, context());
    await one.get("agent_end")?.({ messages: [{
      role: "assistant", content: [{ type: "text", text: "Partial answer" }], stopReason: "aborted", errorMessage: "Cancelled by user.",
    }] }, context());
    const abortedEvents = captured.slice(-2);
    assert.deepEqual(abortedEvents.map((event) => [event.paneId, event.status, event.message]), [
      ["pane_11111111", "running", undefined],
      ["pane_11111111", "interrupted", "Cancelled by user."],
    ]);
    assert.ok(captured.every((event) => event.paneId !== "pane_aaaaaaaa"));
    assert.ok(captured.every((event) => typeof event.runId === "string" && event.runId));
    await childOneA.get("agent_end")?.({ messages: [] }, context(1, false, "already-finished"));
    await childOneA.get("session_shutdown")?.({ reason: "quit" }, context(1, false, "already-finished"));
    await one.get("agent_end")?.({ messages: [] }, context(0, false, "already-finished-root"));
    const sharedActivity = (globalThis as any)[Symbol.for("wmux.prime-agent.pane-activity.v1")] as Map<string, unknown>;
    assert.equal(sharedActivity.has("pane_11111111"), false);
    assert.equal(sharedActivity.has("pane_22222222"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Prime Agent extension periodically refreshes contextual titles and preserves manual session names", { skip: process.platform === "win32", concurrency: false }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-prime-agent-titles-"));
  const captured: Record<string, unknown>[] = [];
  const titleCaptured: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const isTitle = request.url?.endsWith("/auto-title") === true;
      (isTitle ? titleCaptured : captured).push(body);
      response.writeHead(isTitle ? 200 : 201, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const saved = Object.fromEntries([
    "HOME", "WMUX_URL", "WMUX_HELPER_URL", "WMUX_PUBLIC_URL", "WMUX_TOKEN", "WMUX_TOKEN_PATH",
    "WMUX_HELPER_TOKEN", "WMUX_HELPER_TOKEN_PATH", "WMUX_BROWSER_AUTH_MODE",
    "WMUX_WORKSPACE_ID", "WMUX_TAB_ID", "WMUX_PANE_ID",
    "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "WMUX_DELEGATED_RUN",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER",
  ].map((key) => [key, process.env[key]]));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    Object.assign(process.env, {
      HOME: home,
      WMUX_URL: `http://127.0.0.1:${address.port}`,
      WMUX_TOKEN: "",
      WMUX_TOKEN_PATH: path.join(home, "missing-token"),
      WMUX_BROWSER_AUTH_MODE: "shared-or-login",
      HERDR_WORKSPACE_ID: "ws_33333333",
      HERDR_TAB_ID: "tab_33333333",
      HERDR_PANE_ID: "pane_33333333",
      PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
    });
    delete process.env.WMUX_HELPER_URL;
    delete process.env.WMUX_PUBLIC_URL;
    delete process.env.WMUX_HELPER_TOKEN;
    delete process.env.WMUX_HELPER_TOKEN_PATH;
    delete process.env.WMUX_DELEGATED_RUN;

    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "prime-agent"], { env: process.env });
    const installed = path.join(home, ".prime", "agent", "extensions", "wmux.ts");
    const entries: any[] = [];
    const mainBranchEntries: any[] = [];
    let activeBranchEntries = mainBranchEntries;
    const appendSessionEntry = (entry: any) => {
      entries.push(entry);
      activeBranchEntries.push(entry);
    };
    let sessionName: string | undefined;
    const titleStates: unknown[] = [];
    const context = {
      hasPendingMessages: () => false,
      sessionManager: {
        getSessionId: () => "title-root",
        getHeader: () => ({ id: "title-root", rlmDepth: 0 }),
        getBranch: () => activeBranchEntries,
        getEntries: () => entries,
      },
    };
    const loadHandlers = async (suffix: string) => {
      const extensionPath = path.join(home, `.prime-title-${suffix}-${Date.now()}-${Math.random()}.ts`);
      fs.copyFileSync(installed, extensionPath);
      const module = await import(pathToFileURL(extensionPath).href);
      const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
      module.default({
        on: (name: string, handler: (event: any, ctx: any) => Promise<void>) => handlers.set(name, handler),
        getSessionName: () => sessionName,
        setSessionName: (name: string) => { sessionName = name; },
        appendEntry: (customType: string, data: unknown) => {
          appendSessionEntry({ type: "custom", customType, data });
          titleStates.push(data);
        },
      });
      return handlers;
    };
    let handlers = await loadHandlers("initial");
    const runTurn = async (prompt: string, summary: string) => {
      await handlers.get("before_agent_start")?.({ prompt }, context);
      appendSessionEntry({ type: "message", message: { role: "user", content: prompt } });
      await handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: summary }] }, context);
      appendSessionEntry({ type: "agent_status", status: { summary, basedOnMessageCount: entries.length } });
    };

    await runTurn("Please repair the wmux naming lifecycle now.", "Initial naming repair underway.");
    assert.equal(sessionName, "repair the wmux naming lifecycle now");
    const forkBranchEntries = [...mainBranchEntries];
    for (let turn = 2; turn <= 6; turn += 1) {
      await runTurn("Continue", `Progress checkpoint ${turn}.`);
    }
    await runTurn("Keep going", "Prime wmux title synchronization");
    assert.equal(sessionName, "Progress checkpoint 6");
    assert.equal(titleStates.length, 7);

    const runningTitles = captured
      .filter((event) => event.status === "running")
      .map((event) => event.title);
    assert.deepEqual(runningTitles, ["", "", "", "", "", "", ""]);
    assert.deepEqual(titleCaptured.map((request) => request.title), [
      "repair the wmux naming lifecycle now",
      "repair the wmux naming lifecycle now",
      "repair the wmux naming lifecycle now",
      "repair the wmux naming lifecycle now",
      "repair the wmux naming lifecycle now",
      "repair the wmux naming lifecycle now",
      "Progress checkpoint 6",
    ]);
    assert.ok(titleCaptured.every((request) => request.tabOnlyIfMultiple === false));
    assert.ok(titleCaptured.every((request) => request.tabId === "tab_33333333"));

    // A global automatic name from another branch must not be mistaken for a
    // manual override when navigating the session tree in either direction.
    activeBranchEntries = forkBranchEntries;
    await runTurn("Resume the old branch", "Old branch naming context.");
    assert.equal(sessionName, "Initial naming repair underway");
    assert.equal((titleStates.at(-1) as any)?.ownership, "auto");
    activeBranchEntries = mainBranchEntries;
    await runTurn("Return to the main branch", "Main branch naming context.");
    assert.equal(sessionName, "Prime wmux title synchronization");
    assert.equal((titleStates.at(-1) as any)?.ownership, "auto");
    assert.equal(titleStates.length, 9);

    // A same-text manual name is session-global even if navigation happens
    // before that branch gets another agent turn to write an external marker.
    activeBranchEntries = forkBranchEntries;
    appendSessionEntry({ type: "session_info", name: sessionName });
    activeBranchEntries = mainBranchEntries;
    await runTurn("Navigate immediately after naming", "Global manual ownership follows the session.");
    assert.equal((titleStates.at(-1) as any)?.ownership, "external");
    assert.equal(sessionName, "Prime wmux title synchronization");
    assert.equal(titleStates.length, 10);
    activeBranchEntries = forkBranchEntries;
    await runTurn("Navigate again after ownership transfer", "External ownership remains session-global.");
    assert.equal((titleStates.at(-1) as any)?.ownership, "external");
    assert.equal(sessionName, "Prime wmux title synchronization");
    assert.equal(titleStates.length, 11);
    activeBranchEntries = mainBranchEntries;

    // Simulate an extension reload with only the persisted custom entry left.
    const shared = (globalThis as any)[Symbol.for("wmux.prime-agent.title-state.v1")] as Map<string, unknown>;
    shared.delete("pane_33333333:title-root");
    handlers = await loadHandlers("reloaded");
    await runTurn("Continue after reload", "Reloaded title work continues.");
    assert.equal(captured.filter((event) => event.status === "running").at(-1)?.title, "");
    assert.equal(titleStates.length, 12);

    // Reasserting the generated text through Prime /name still transfers
    // ownership because the newer session_info entry follows the title marker.
    appendSessionEntry({ type: "session_info", name: sessionName });
    await runTurn("Keep this exact name", "The matching manual title is authoritative.");
    assert.equal((titleStates.at(-1) as any)?.ownership, "external");
    assert.equal(titleStates.length, 13);

    sessionName = "User Chosen Session";
    appendSessionEntry({ type: "session_info", name: sessionName });
    await runTurn("Respect my title", "Manual title remains authoritative.");
    assert.equal(captured.filter((event) => event.status === "running").at(-1)?.title, "");
    assert.equal(titleCaptured.at(-1)?.title, "User Chosen Session");
    assert.equal(sessionName, "User Chosen Session");
    assert.equal(titleStates.length, 14);

    const titleRequestCount = titleCaptured.length;
    sessionName = undefined;
    appendSessionEntry({ type: "session_info", name: "" });
    await runTurn("Clear the title", "The cleared manual title remains authoritative.");
    await runTurn("Continue unnamed", "Automatic naming stays disabled.");
    assert.equal(sessionName, undefined);
    assert.equal(titleCaptured.length, titleRequestCount);
    assert.equal(titleStates.length, 16);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Claude installer adds a managed delegation skill without overwriting an unmanaged skill", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-claude-hooks-"));
  const hooks = path.join(repoRoot, "scripts", "wmux-hooks");
  const env = { ...process.env, HOME: home };
  const skillPath = path.join(home, ".claude", "skills", "wmux", "SKILL.md");
  try {
    await execFileAsync(hooks, ["install", "claude"], { env });
    const skill = fs.readFileSync(skillPath, "utf8");
    assert.match(skill, /Generated by wmux-hooks/);
    assert.match(skill, /wmuxctl delegate codex MACHINE/);
    assert.match(skill, /--write-access/);
    assert.match(skill, /--unattended/);

    const before = fs.statSync(skillPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await execFileAsync(hooks, ["install", "claude"], { env });
    assert.equal(fs.statSync(skillPath).mtimeMs, before);
    const { stdout } = await execFileAsync(hooks, ["status"], { env });
    const status = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(status.claude, "installed");
    assert.equal(status.claudeHooks, "installed");
    assert.equal(status.claudeSkill, "installed");
    assert.equal(status.claudeSkillPath, skillPath);

    fs.writeFileSync(skillPath, "user-owned Claude skill\n");
    const reinstall = await execFileAsync(hooks, ["install", "claude"], { env });
    assert.match(reinstall.stdout, /Preserved existing unmanaged Claude skill/);
    assert.equal(fs.readFileSync(skillPath, "utf8"), "user-owned Claude skill\n");
    const after = JSON.parse((await execFileAsync(hooks, ["status"], { env })).stdout) as Record<string, unknown>;
    assert.equal(after.claudeHooks, "installed");
    assert.equal(after.claudeSkill, "not_installed");
    assert.equal(after.claude, "not_installed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Codex installer covers prompt, tool, and stop lifecycle hooks idempotently", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-hooks-"));
  const hooks = path.join(repoRoot, "scripts", "wmux-hooks");
  const env = { ...process.env, HOME: home };
  const settingsPath = path.join(home, ".codex", "hooks.json");
  try {
    await execFileAsync(hooks, ["install", "codex"], { env });
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const eventName of ["UserPromptSubmit", "PreToolUse", "Stop"]) {
      assert.equal(settings.hooks[eventName]?.length, 1);
      assert.match(settings.hooks[eventName][0].hooks[0].command, /wmux-agent-event.*--codex-hook/);
    }

    const before = fs.statSync(settingsPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await execFileAsync(hooks, ["install", "codex"], { env });
    assert.equal(fs.statSync(settingsPath).mtimeMs, before);
    const status = JSON.parse((await execFileAsync(hooks, ["status"], { env })).stdout) as Record<string, unknown>;
    assert.equal(status.codex, "installed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("generated OpenCode plugin forwards a complete top-level lifecycle", { skip: process.platform === "win32" }, async () => {
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
    WMUX_AGENT_INPUT_CAPABILITY_PATH: process.env.WMUX_AGENT_INPUT_CAPABILITY_PATH,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: process.env.WMUX_AGENT_INPUT_CREDENTIAL_PATH,
  };
  try {
    delete process.env.WMUX_AGENT_INPUT_CAPABILITY_PATH;
    delete process.env.WMUX_AGENT_INPUT_CREDENTIAL_PATH;
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
    let topLevelSessionTitle: unknown = "OpenCode integration";
    const client = {
      session: {
        get: async ({ path: { id } }: { path: { id: string } }) => {
          if (id === "session-unavailable") throw new Error("session unavailable");
          if (id === "child-session") return { data: { title: "Child title", parentID: "session-1" } };
          return { data: { title: topLevelSessionTitle, parentID: undefined } };
        },
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
      plugin.event({ event: { id: "event-question-1", type: "question.asked", properties: { sessionID: "session-1", id: "question-1" } } }),
      plugin.event({ event: { id: "event-question-1", type: "question.asked", properties: { sessionID: "session-1", id: "question-1" } } }),
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

    topLevelSessionTitle = "Renamed in OpenCode";
    await plugin.event({ event: { type: "session.updated", properties: { info: { id: "session-1", title: "Renamed in OpenCode" } } } });
    assert.equal(captured.length, 5, "session.updated only caches title metadata");
    await plugin["chat.message"](
      { sessionID: "session-1" },
      { message: { id: "user-2" }, parts: [{ type: "text", text: "continue" }] },
    );
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
    topLevelSessionTitle = "Authoritative newer title";
    await plugin.event({ event: { type: "session.updated", properties: { info: { id: "session-1", title: "Renamed in OpenCode" } } } });
    await plugin["chat.message"](
      { sessionID: "session-1" },
      { message: { id: "user-3" }, parts: [{ type: "text", text: "continue again" }] },
    );
    topLevelSessionTitle = undefined;
    await plugin.event({ event: { type: "session.updated", properties: { info: { id: "session-1" } } } });
    assert.equal(captured.length, 8, "partial session.updated preserves cached metadata until the next prompt fetch");
    await plugin["chat.message"](
      { sessionID: "session-1" },
      { message: { id: "user-4" }, parts: [{ type: "text", text: "missing authoritative title" }] },
    );
    await plugin.event({ event: { type: "session.updated", properties: { info: { id: "session-1", title: "" } } } });
    await plugin["chat.message"](
      { sessionID: "session-1" },
      { message: { id: "user-5" }, parts: [{ type: "text", text: "empty title" }] },
    );
    await plugin.event({ event: { type: "session.updated", properties: { info: { id: "session-1", title: "New session - 2026-07-23T03:56:00Z" } } } });
    await plugin["chat.message"](
      { sessionID: "session-1" },
      { message: { id: "user-6" }, parts: [{ type: "text", text: "default title" }] },
    );
    await assert.doesNotReject(plugin["chat.message"](
      { sessionID: "session-unavailable" },
      { message: { id: "user-7" }, parts: [{ type: "text", text: "unavailable" }] },
    ));
    await plugin.event({ event: { type: "session.updated", properties: { info: { id: "child-session", title: "Child rename", parentID: "session-1" } } } });
    await plugin["chat.message"](
      { sessionID: "child-session" },
      { message: { id: "user-8" }, parts: [{ type: "text", text: "child prompt" }] },
    );
    assert.deepEqual(
      captured.slice(5).map(({ status, title }) => ({ status, title })),
      [
        { status: "running", title: "Renamed in OpenCode" },
        { status: "completed", title: "Renamed in OpenCode" },
        { status: "running", title: "Authoritative newer title" },
        { status: "running", title: "missing authoritative title" },
        { status: "running", title: "empty title" },
        { status: "running", title: "default title" },
      ],
    );
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
