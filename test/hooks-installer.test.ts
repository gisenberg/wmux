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
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const saved = Object.fromEntries([
    "HOME", "WMUX_URL", "WMUX_TOKEN", "WMUX_TOKEN_PATH", "WMUX_WORKSPACE_ID", "WMUX_TAB_ID", "WMUX_PANE_ID",
    "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "WMUX_DELEGATED_RUN", "RLM_DEPTH",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER",
  ].map((key) => [key, process.env[key]]));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    delete process.env.WMUX_DELEGATED_RUN;
    delete process.env.RLM_DEPTH;
    Object.assign(process.env, {
      HOME: home,
      WMUX_URL: `http://127.0.0.1:${address.port}`,
      WMUX_TOKEN: "",
      WMUX_TOKEN_PATH: path.join(home, "missing-token"),
      WMUX_WORKSPACE_ID: "ws_aaaaaaaa",
      WMUX_TAB_ID: "tab_aaaaaaaa",
      WMUX_PANE_ID: "pane_aaaaaaaa",
      PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
    });
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-hooks"), ["install", "prime-agent"], { env: process.env });
    const extensionPath = path.join(home, ".prime", "agent", "extensions", "wmux.ts");
    const context = (rlmDepth = 0, pending = false) => ({
      hasPendingMessages: () => pending,
      sessionManager: { getHeader: () => ({ rlmDepth }) },
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
      ["ws_11111111", "tab_11111111", "pane_11111111", "running", "Name workspace one"],
      ["ws_22222222", "tab_22222222", "pane_22222222", "running", "Name workspace two"],
      ["ws_11111111", "tab_11111111", "pane_11111111", "completed", ""],
      ["ws_22222222", "tab_22222222", "pane_22222222", "completed", ""],
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
    // variables contain another pane. Nested and delegated sessions are silent.
    const quietCount = captured.length;
    await missing.get("before_agent_start")?.({ prompt: "ambient must not route" }, context());
    await missing.get("agent_end")?.({ messages: [] }, context());
    await one.get("before_agent_start")?.({ prompt: "nested" }, context(1));
    await one.get("agent_end")?.({ messages: [] }, context(1));
    process.env.WMUX_DELEGATED_RUN = "1";
    await one.get("before_agent_start")?.({ prompt: "delegated" }, context());
    await one.get("agent_end")?.({ messages: [] }, context());
    delete process.env.WMUX_DELEGATED_RUN;
    assert.equal(captured.length, quietCount);

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
