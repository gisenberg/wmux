import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentEventScript = path.join(repoRoot, "scripts", "wmux-agent-event");
const agentEventEnv = (home: string, values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  for (const key of [
    "WMUX_AUTOMATION_TOKEN",
    "WMUX_AUTOMATION_TOKEN_PATH",
    "WMUX_E2E_TOKEN",
    "WMUX_HELPER_TOKEN",
    "WMUX_HELPER_TOKEN_PATH",
    "WMUX_BROWSER_AUTH_MODE",
    "WMUX_TOKEN",
    "WMUX_TOKEN_PATH",
  ]) delete environment[key];
  return Object.assign(environment, values);
};
const runAgentEvent = (args: string[], env: NodeJS.ProcessEnv) =>
  execFileAsync("python3", [agentEventScript, ...args], { env });
const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for agent event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const resolveHelperUrl = (env: Record<string, string>, persistedUrl?: string): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-event-url-"));
  try {
    if (persistedUrl) {
      fs.mkdirSync(path.join(home, ".wmux"));
      fs.writeFileSync(path.join(home, ".wmux", "url"), `${persistedUrl}\n`);
    }
    const childEnv = agentEventEnv(home, env);
    delete childEnv.WMUX_HELPER_URL;
    delete childEnv.WMUX_PUBLIC_URL;
    delete childEnv.WMUX_URL;
    Object.assign(childEnv, env);
    return execFileSync(
      "python3",
      ["-c", "import importlib.machinery, sys; print(importlib.machinery.SourceFileLoader('agent_event', sys.argv[1]).load_module()._wmux_url())", path.join(repoRoot, "scripts", "wmux-agent-event")],
      { encoding: "utf8", env: childEnv },
    ).trim();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

test("agent event callback URL prefers refreshed state, then helper/public/legacy fallbacks", () => {
  assert.equal(resolveHelperUrl({ WMUX_HELPER_URL: "http://stale-helper:3478", WMUX_URL: "http://stale-legacy:3478" }, "http://persisted:3478"), "http://persisted:3478");
  assert.equal(resolveHelperUrl({ WMUX_HELPER_URL: " http://helper:3478 " }), "http://helper:3478");
  assert.equal(resolveHelperUrl({ WMUX_HELPER_URL: " \t", WMUX_PUBLIC_URL: " https://public.example " }), "https://public.example");
  assert.equal(resolveHelperUrl({ WMUX_PUBLIC_URL: "https://public.example", WMUX_URL: "http://legacy:3478" }, "http://persisted:3478"), "http://persisted:3478");
  assert.equal(resolveHelperUrl({ WMUX_PUBLIC_URL: "https://public.example", WMUX_URL: "http://legacy:3478" }), "https://public.example");
  assert.equal(resolveHelperUrl({ WMUX_URL: "http://legacy:3478" }), "http://legacy:3478");
  assert.equal(resolveHelperUrl({}), "http://127.0.0.1:3478");
  assert.match(fs.readFileSync(path.join(repoRoot, "scripts", "wmux-agent-event"), "utf8"), /add_argument\("--url", default=_wmux_url\(\)\)/);
});

test("agent event helper prefers the refreshed token file over a stale environment token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-event-token-"));
  const authorizations: string[] = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? "");
    response.writeHead(201).end();
  });
  try {
    fs.mkdirSync(path.join(home, ".wmux"));
    fs.writeFileSync(path.join(home, ".wmux", "token"), "current-token\n", { mode: 0o600 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const invoke = () => runAgentEvent(
      ["--url", `http://127.0.0.1:${address.port}`, "--pane", "pane-1", "--force"],
      agentEventEnv(home, { WMUX_TOKEN: "stale-token" }),
    );
    await invoke();
    fs.rmSync(path.join(home, ".wmux", "token"));
    await invoke();
    assert.deepEqual(authorizations, ["Bearer current-token", "Bearer stale-token"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("agent event helper uses helper scope and never falls back in login-only mode", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-event-helper-token-"));
  const authorizations: string[] = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? "");
    response.writeHead(request.headers.authorization === `Bearer ${"H".repeat(43)}` ? 201 : 401).end();
  });
  try {
    fs.mkdirSync(path.join(home, ".wmux"));
    fs.writeFileSync(path.join(home, ".wmux", "helper-token"), `${"H".repeat(43)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".wmux", "token"), "legacy-token\n", { mode: 0o600 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await runAgentEvent(
      ["--url", `http://127.0.0.1:${address.port}`, "--pane", "pane-1", "--force"],
      agentEventEnv(home, { WMUX_BROWSER_AUTH_MODE: "login-only", WMUX_TOKEN: "stale-legacy" }),
    );
    assert.deepEqual(authorizations, [`Bearer ${"H".repeat(43)}`]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("agent event helper sends the full assistant response as structured JSON", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-event-"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please fix mobile chat" }] },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "First line of the response.\n\nSecond detailed line." },
            { type: "tool_call", text: '{"internal":"fragment"}' },
          ],
        },
      }),
    ].join("\n"),
  );

  let captured: Record<string, unknown> | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await runAgentEvent([
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--agent",
      "codex",
      "--status",
      "completed",
      "--transcript",
      transcriptPath,
      "--force",
    ], agentEventEnv(dir, {
        WMUX_TOKEN: "",
        WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
        WMUX_HELPER_URL: "http://127.0.0.1:1",
        WMUX_URL: "http://127.0.0.1:1",
        WMUX_DELEGATION_RUN_ID: "run-durable-1",
    }));

    assert.equal(captured?.runId, "run-durable-1");
    assert.equal(captured?.title, "fix mobile chat");
    assert.equal(captured?.summary, "First line of the response.");
    assert.equal(captured?.message, "First line of the response.\n\nSecond detailed line.");
    assert.equal(JSON.stringify(captured).includes("internal"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent start hooks never replay the previous assistant response", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-start-"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ message: { role: "user", content: "new mobile prompt" } }),
      JSON.stringify({ message: { role: "assistant", content: "response from the prior turn" } }),
    ].join("\n"),
  );
  let captured: Record<string, unknown> | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await runAgentEvent(
      ["--url", `http://127.0.0.1:${address.port}`, "--agent", "codex", "--codex-hook", "--pane", "pane-1", "--force"],
      agentEventEnv(dir, {
          WMUX_TOKEN: "",
          WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
          HOOK_INPUT: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            prompt: "new mobile prompt",
            transcript_path: transcriptPath,
            last_assistant_message: "response from the prior turn",
          }),
      }),
    );
    assert.equal(captured?.status, "running");
    assert.equal(captured?.title, "new mobile prompt");
    assert.equal(captured?.summary, "codex running");
    assert.equal("message" in (captured ?? {}), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex tool hooks restore running state without replaying prior output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-tool-"));
  const captured: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(201).end();
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await runAgentEvent(
      ["--url", `http://127.0.0.1:${address.port}`, "--agent", "codex", "--codex-hook", "--pane", "pane-1", "--force"],
      agentEventEnv(dir, {
        WMUX_TOKEN: "",
        WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
        HOOK_INPUT: JSON.stringify({
          hook_event_name: "PreToolUse",
          turn_id: "turn-continued",
          last_assistant_message: "response from the prior turn",
        }),
      }),
    );
    assert.equal(captured.length, 1);
    assert.deepEqual({
      agent: captured[0]?.agent,
      status: captured[0]?.status,
      title: captured[0]?.title,
      summary: captured[0]?.summary,
      body: captured[0]?.body,
      coalesce: captured[0]?.coalesce,
      paneId: captured[0]?.paneId,
    }, {
      agent: "codex",
      status: "running",
      title: "",
      summary: "codex running",
      body: "",
      coalesce: true,
      paneId: "pane-1",
    });
    assert.equal("message" in captured[0], false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex stop reconciliation observes an automatic continuation before completing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-reconcile-"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-first" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the goal" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished one step." }] } }),
    ].join("\n") + "\n",
  );
  const captured: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(201).end();
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await runAgentEvent(
      ["--url", `http://127.0.0.1:${address.port}`, "--agent", "codex", "--codex-hook", "--pane", "pane-1", "--force"],
      agentEventEnv(dir, {
        WMUX_TOKEN: "",
        WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
        WMUX_CODEX_RECONCILE_TIMEOUT_MS: "1000",
        WMUX_CODEX_RECONCILE_GRACE_MS: "50",
        HOOK_INPUT: JSON.stringify({
          hook_event_name: "Stop",
          turn_id: "turn-first",
          transcript_path: transcriptPath,
          last_assistant_message: "Finished one step.",
        }),
      }),
    );
    fs.appendFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-first" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-second" } }),
      ].join("\n") + "\n",
    );
    await waitFor(() => captured.length === 1);
    assert.equal(captured[0]?.status, "running");
    assert.equal(captured[0]?.summary, "codex running");
    assert.equal(captured[0]?.coalesce, true);
    assert.equal("message" in captured[0], false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex stop reconciliation emits one completion when no continuation starts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-complete-"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-final" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Finish the goal" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The goal is complete." }] } }),
    ].join("\n") + "\n",
  );
  const captured: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(201).end();
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await runAgentEvent(
      ["--url", `http://127.0.0.1:${address.port}`, "--agent", "codex", "--codex-hook", "--pane", "pane-1", "--force"],
      agentEventEnv(dir, {
        WMUX_TOKEN: "",
        WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
        WMUX_CODEX_RECONCILE_TIMEOUT_MS: "1000",
        WMUX_CODEX_RECONCILE_GRACE_MS: "50",
        HOOK_INPUT: JSON.stringify({
          hook_event_name: "Stop",
          turn_id: "turn-final",
          transcript_path: transcriptPath,
        }),
      }),
    );
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-final" } }) + "\n",
    );
    await waitFor(() => captured.length === 1);
    assert.equal(captured[0]?.status, "completed");
    assert.equal(captured[0]?.summary, "The goal is complete.");
    assert.equal(captured[0]?.message, "The goal is complete.");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode hooks report running, waiting, failed, and completed lifecycles", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-opencode-event-"));
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
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const input of [
      { hook_event_name: "UserPromptSubmit", title: "OpenCode session title", prompt: "fix OpenCode hooks", last_assistant_message: "stale response" },
      { hook_event_name: "Question", prompt: "fix OpenCode hooks", last_assistant_message: "stale response" },
      { hook_event_name: "Resume", prompt: "fix OpenCode hooks", last_assistant_message: "stale response" },
      { hook_event_name: "Error", prompt: "fix OpenCode hooks" },
      { hook_event_name: "Stop", prompt: "fix OpenCode hooks", last_assistant_message: "Done." },
    ]) {
      await runAgentEvent([
        "--url", `http://127.0.0.1:${address.port}`, "--agent", "opencode", "--opencode-hook", "--pane", "pane-1",
      ], agentEventEnv(dir, {
        WMUX_TOKEN: "",
        WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
        HOOK_INPUT: JSON.stringify(input),
      }));
    }
    assert.deepEqual(captured.map(({ status, summary, message }) => ({ status, summary, message })), [
      { status: "running", summary: "opencode running", message: undefined },
      { status: "waiting", summary: "opencode waiting for input", message: undefined },
      { status: "running", summary: "opencode running", message: undefined },
      { status: "failed", summary: "opencode failed", message: undefined },
      { status: "completed", summary: "Done.", message: "Done." },
    ]);
    assert.equal(captured[0]?.title, "OpenCode session title");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("Prime Agent hooks report running and completed lifecycles", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-prime-agent-event-"));
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
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const input of [
      { hook_event_name: "UserPromptSubmit", prompt: "add Prime Agent support" },
      { hook_event_name: "Stop", prompt: "add Prime Agent support", last_assistant_message: "Prime Agent done." },
    ]) {
      await runAgentEvent([
        "--url", `http://127.0.0.1:${address.port}`, "--agent", "prime-agent", "--prime-agent-hook", "--pane", "pane-1",
      ], agentEventEnv(dir, {
        WMUX_TOKEN: "",
        WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
        HOOK_INPUT: JSON.stringify(input),
      }));
    }
    assert.deepEqual(captured.map(({ agent, status, summary, message }) => ({ agent, status, summary, message })), [
      { agent: "prime-agent", status: "running", summary: "prime-agent running", message: undefined },
      { agent: "prime-agent", status: "completed", summary: "Prime Agent done.", message: "Prime Agent done." },
    ]);
    assert.equal(captured[0]?.title, "add Prime Agent support");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent harness hooks silently return without wmux pane context", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-hook-context-"));
  try {
    for (const agent of ["claude", "codex", "opencode", "prime-agent"]) {
      const { stdout, stderr } = await runAgentEvent(
        ["--agent", agent, `--${agent}-hook`],
        agentEventEnv(dir, {
            WMUX_TOKEN: "",
            WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
            WMUX_PANE_ID: "",
            WMUX_WORKSPACE_ID: "",
            HOOK_INPUT: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "no context" }),
        }),
      );
      assert.equal(stdout, "");
      assert.equal(stderr, "");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
