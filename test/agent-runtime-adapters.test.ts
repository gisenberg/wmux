import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_MARKERS,
  type DelegationRequest,
} from "../src/shared/agent-contract.js";
import {
  agentRuntimeAdapter,
} from "../src/server/agent-runtimes/index.js";
import {
  claudeHeadlessAdapter,
} from "../src/server/agent-runtimes/claude.js";
import {
  codexHeadlessAdapter,
  codexTuiAdapter,
} from "../src/server/agent-runtimes/codex.js";
import {
  opencodeHeadlessAdapter,
  opencodeTuiAdapter,
} from "../src/server/agent-runtimes/opencode.js";
import {
  primeAgentHeadlessAdapter,
  primeAgentTuiAdapter,
} from "../src/server/agent-runtimes/prime-agent.js";
import {
  createAdapterScanState,
} from "../src/server/agent-runtimes/adapter.js";

const request: DelegationRequest = {
  runId: "adapter-1",
  runtime: "codex",
  prompt: "private prompt",
  directory: "/work/repository",
  writeAccess: true,
  sandboxMode: "workspace-write",
};

test("TUI marker parsing survives chunks and terminal styling", () => {
  const state = createAdapterScanState();
  const first = codexTuiAdapter.classifyOutput(
    `\u001b[32m${AGENT_MARKERS.tuiLaunch} adapter`,
    state,
  );
  assert.deepEqual(first, []);
  const second = codexTuiAdapter.classifyOutput("-1\u001b[0m\r\n", state);
  assert.deepEqual(second, [{ type: "launch", runId: "adapter-1" }]);
});

test("runtime adapters keep prompts out of process arguments", () => {
  for (const adapter of [
    claudeHeadlessAdapter,
    codexHeadlessAdapter,
    opencodeHeadlessAdapter,
    primeAgentHeadlessAdapter,
  ]) {
    const launch = adapter.buildLaunch({
      ...request,
      runtime: adapter.runtime,
    });
    assert.equal(launch.stdin, "prompt");
    assert.equal(launch.args.some((arg) => arg.includes(request.prompt)), false);
  }
});

test("Claude unattended approval never grants write access by itself", () => {
  const readOnly = claudeHeadlessAdapter.buildLaunch({
    ...request,
    runtime: "claude",
    writeAccess: false,
    unattended: true,
    sandboxMode: "read-only",
  });
  assert.deepEqual(
    readOnly.args.slice(
      readOnly.args.indexOf("--permission-mode"),
      readOnly.args.indexOf("--permission-mode") + 2,
    ),
    ["--permission-mode", "plan"],
  );

  const writable = claudeHeadlessAdapter.buildLaunch({
    ...request,
    runtime: "claude",
    writeAccess: true,
    unattended: true,
  });
  assert.ok(writable.args.includes("bypassPermissions"));
});

test("headless adapters parse recorded structured output", () => {
  const codex = codexHeadlessAdapter.classifyOutput(
    '{"type":"item.completed","item":{"type":"agent_message","text":"Codex done"}}\n',
    createAdapterScanState(),
  );
  assert.deepEqual(codex, [{ type: "text", text: "Codex done" }]);

  const claude = claudeHeadlessAdapter.classifyOutput(
    '{"type":"result","result":"Claude done"}\n',
    createAdapterScanState(),
  );
  assert.deepEqual(claude, [{ type: "text", text: "Claude done" }]);

  const opencode = opencodeHeadlessAdapter.classifyOutput(
    '{"type":"text","part":{"text":"OpenCode done"}}\n',
    createAdapterScanState(),
  );
  assert.deepEqual(opencode, [{ type: "text", text: "OpenCode done" }]);

  const prime = primeAgentHeadlessAdapter.classifyOutput(
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Prime"},{"type":"text","text":"Agent done"}],"stopReason":"stop"}}\n',
    createAdapterScanState(),
  );
  assert.deepEqual(prime, [{ type: "text", text: "Prime\nAgent done" }]);
});

test("Codex and OpenCode TUI quirks are adapter-owned", () => {
  assert.deepEqual(
    codexTuiAdapter.classifyOutput(
      "OpenAI Codex\n› ",
      createAdapterScanState(),
    ),
    [{ type: "runtime-ready" }],
  );
  assert.deepEqual(
    opencodeTuiAdapter.classifyOutput(
      'session_title: "Fresh title"\n',
      createAdapterScanState(),
    ),
    [{ type: "title-refresh", title: "Fresh title" }],
  );
  assert.ok(
    codexTuiAdapter
      .buildLaunch(request)
      .args.includes("check_for_update_on_startup=false"),
  );
});

test("Prime Agent adapters use the documented native JSON and TUI interfaces", () => {
  assert.deepEqual(
    primeAgentHeadlessAdapter.buildLaunch({
      ...request,
      runtime: "prime-agent",
      model: "openai-codex/gpt-5.4",
    }),
    {
      file: "prime-agent",
      args: [
        "--print", "--mode", "json", "--cwd", request.directory,
        "--model", "openai-codex/gpt-5.4",
      ],
      stdin: "prompt",
    },
  );
  assert.deepEqual(
    primeAgentTuiAdapter.buildLaunch({ ...request, runtime: "prime-agent" }),
    {
      file: "prime-agent",
      args: [],
      cwd: request.directory,
      env: { WMUX_INTERACTIVE_TUI: "1" },
      stdin: "none",
    },
  );
});

test("selection keeps TUI default and always uses it for interactive work", () => {
  assert.equal(
    agentRuntimeAdapter("codex", {
      interactive: false,
      preferHeadless: false,
    }).mode,
    "tui",
  );
  assert.equal(
    agentRuntimeAdapter("codex", {
      interactive: false,
      preferHeadless: true,
    }).mode,
    "headless",
  );
  assert.equal(
    agentRuntimeAdapter("codex", {
      interactive: true,
      preferHeadless: true,
    }).mode,
    "tui",
  );
});
