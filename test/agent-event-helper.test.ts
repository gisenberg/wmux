import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    await execFileAsync(path.join(repoRoot, "scripts", "wmux-agent-event"), [
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--agent",
      "codex",
      "--status",
      "completed",
      "--transcript",
      transcriptPath,
      "--force",
    ], {
      env: { ...process.env, HOME: dir, WMUX_TOKEN: "", WMUX_TOKEN_PATH: path.join(dir, "missing-token") },
    });

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
    await execFileAsync(
      path.join(repoRoot, "scripts", "wmux-agent-event"),
      ["--url", `http://127.0.0.1:${address.port}`, "--agent", "codex", "--codex-hook", "--pane", "pane-1", "--force"],
      {
        env: {
          ...process.env,
          HOME: dir,
          WMUX_TOKEN: "",
          WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
          HOOK_INPUT: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            prompt: "new mobile prompt",
            transcript_path: transcriptPath,
            last_assistant_message: "response from the prior turn",
          }),
        },
      },
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

test("OpenCode hooks report running, failed, and completed lifecycles", async () => {
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
      { hook_event_name: "Error", prompt: "fix OpenCode hooks" },
      { hook_event_name: "Stop", prompt: "fix OpenCode hooks", last_assistant_message: "Done." },
    ]) {
      await execFileAsync(path.join(repoRoot, "scripts", "wmux-agent-event"), [
        "--url", `http://127.0.0.1:${address.port}`, "--agent", "opencode", "--opencode-hook", "--pane", "pane-1",
      ], {
        env: { ...process.env, HOME: dir, WMUX_TOKEN: "", WMUX_TOKEN_PATH: path.join(dir, "missing-token"), HOOK_INPUT: JSON.stringify(input) },
      });
    }
    assert.deepEqual(captured.map(({ status, summary, message }) => ({ status, summary, message })), [
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

test("OpenCode hooks warn but do not fail without wmux pane context", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-opencode-context-"));
  try {
    const { stderr } = await execFileAsync(
      path.join(repoRoot, "scripts", "wmux-agent-event"),
      ["--agent", "opencode", "--opencode-hook"],
      {
        env: {
          ...process.env,
          HOME: dir,
          WMUX_TOKEN: "",
          WMUX_TOKEN_PATH: path.join(dir, "missing-token"),
          WMUX_PANE_ID: "",
          WMUX_WORKSPACE_ID: "",
          HOOK_INPUT: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "no context" }),
        },
      },
    );
    assert.match(stderr, /hook is missing WMUX_PANE_ID and WMUX_WORKSPACE_ID/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
