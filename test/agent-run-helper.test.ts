import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, "scripts", "wmux-agent-run");
const posixTest = process.platform === "win32" ? test.skip : test;

const decodeResult = (stdout: string) => {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("WMUX_AGENT_RESULT "));
  assert.ok(line);
  return JSON.parse(Buffer.from(line.slice("WMUX_AGENT_RESULT ".length), "base64").toString("utf8"));
};

posixTest("wmux-agent-run ignores the command-submit newline before a Windows request", () => {
  const probe = `
import base64
import importlib.machinery
import importlib.util
import json
import sys
import types

loader = importlib.machinery.SourceFileLoader("wmux_agent_run", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
request = {"runId": "windows-input", "runtime": "codex", "prompt": "inspect", "directory": "C:\\\\repo"}
encoded = base64.b64encode(json.dumps(request).encode()).decode()
characters = iter("\\r\\n" + encoded + "\\r")
sys.modules["msvcrt"] = types.SimpleNamespace(getwch=lambda: next(characters))

class TtyInput:
    def isatty(self):
        return True

module.os.name = "nt"
sys.stdin = TtyInput()
print(json.dumps(module.request_from_stdin(), sort_keys=True))
print(json.dumps(module.prepare_windows_command(
    ["C:\\\\tools\\\\codex.CMD", "--sandbox", "danger-full-access", "exec", "-"],
    platform="nt",
    exists=lambda value: value.endswith("codex.ps1"),
    which=lambda value: "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" if value == "pwsh" else None,
)))
`;
  const completed = spawnSync("python3", ["-c", probe, helper], { encoding: "utf8" });
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stdout, /WMUX_AGENT_READY/);
  assert.match(completed.stdout, /"runId": "windows-input"/);
  assert.match(completed.stdout, /pwsh\.exe/);
  assert.match(completed.stdout, /codex\.ps1/);
  assert.match(completed.stdout, /false/);
});

posixTest("wmux-agent-run ignores blank TTY lines before a POSIX request", () => {
  const probe = `
import base64
import importlib.machinery
import importlib.util
import io
import json
import sys
import types

loader = importlib.machinery.SourceFileLoader("wmux_agent_run", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
request = {"runId": "posix-input", "runtime": "codex", "prompt": "inspect", "directory": "/repo"}
encoded = base64.b64encode(json.dumps(request).encode()).decode()

class TtyInput:
    buffer = io.BytesIO(("\\r\\n\\n" + encoded + "\\n").encode())

    def isatty(self):
        return True

    def fileno(self):
        return 0

sys.modules["termios"] = types.SimpleNamespace(
    ECHO=8,
    TCSADRAIN=1,
    tcgetattr=lambda _descriptor: [0, 0, 0, 8],
    tcsetattr=lambda *_args: None,
)
sys.stdin = TtyInput()
print(json.dumps(module.request_from_stdin("WMUX_AGENT_READY posix-input"), sort_keys=True))
`;
  const completed = spawnSync("python3", ["-c", probe, helper], { encoding: "utf8" });
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stdout, /WMUX_AGENT_READY posix-input/);
  assert.match(completed.stdout, /"runId": "posix-input"/);
});

posixTest("wmux-agent-run correlates request startup failures with the expected run", () => {
  const runId = "startup-failure";
  const completed = spawnSync(helper, ["request", runId], {
    encoding: "utf8",
    input: "\n".repeat(9),
  });
  assert.equal(completed.status, 2, completed.stderr);
  assert.match(completed.stdout, new RegExp(`^WMUX_AGENT_READY ${runId}$`, "m"));
  assert.deepEqual(decodeResult(completed.stdout), {
    runId,
    ok: false,
    error: "request must be Base64 JSON",
  });
  assert.match(completed.stdout, new RegExp(`^WMUX_AGENT_DONE ${runId} 2$`, "m"));
});

const waitFor = async (predicate: () => boolean, message: string, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

posixTest("wmux-agent-run adapts OpenCode, Codex, and Claude without putting prompts in argv", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-run-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const fakeSource = `#!/usr/bin/env python3
import json,os,sys
runtime=os.path.basename(sys.argv[0])
if runtime == 'opencode' and sys.argv[1:] == ['run','--help']:
    print('  --auto  automatically approve permissions')
    raise SystemExit(0)
with open(os.environ['CAPTURE_PATH'],'w',encoding='utf-8') as handle:
    json.dump({'runtime':runtime,'argv':sys.argv[1:],'stdin':sys.stdin.read(),'cwd':os.getcwd(),'delegated':os.environ.get('WMUX_DELEGATED_RUN'),'delegationRunId':os.environ.get('WMUX_DELEGATION_RUN_ID')},handle)
prompt=os.environ['SECRET_PROMPT']
if runtime == 'opencode':
    print(json.dumps({'type':'text','part':{'text':'OpenCode done'}}))
elif runtime == 'codex':
    print(json.dumps({'type':'debug','echo':prompt}))
    print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Codex done'}}))
else:
    print(json.dumps({'type':'result','subtype':'success','is_error':False,'result':'Claude done'}))
`;
  for (const runtime of ["opencode", "codex", "claude"]) {
    const executable = path.join(bin, runtime);
    fs.writeFileSync(executable, fakeSource);
    fs.chmodSync(executable, 0o755);
  }
  const prompt = "private delegated prompt Ω";
  const cases = [
    {
      runtime: "opencode",
      request: { writeAccess: true, unattended: true, title: "Visible task", agent: "build", model: "open-model" },
      argv: ["run", "--format", "json", "--dir", dir, "--title", "Visible task", "--agent", "build", "--model", "open-model", "--auto"],
      result: "OpenCode done",
    },
    {
      runtime: "codex",
      request: { writeAccess: false, unattended: false, model: "codex-model" },
      argv: ["--sandbox", "read-only", "--model", "codex-model", "exec", "--json", "-C", dir, "-"],
      result: "Codex done",
    },
    {
      runtime: "claude",
      request: { writeAccess: true, unattended: true, model: "claude-model" },
      argv: ["-p", "--verbose", "--input-format", "text", "--output-format", "stream-json", "--permission-mode", "acceptEdits", "--dangerously-skip-permissions", "--model", "claude-model"],
      result: "Claude done",
    },
  ];
  try {
    for (const [index, entry] of cases.entries()) {
      const capture = path.join(dir, `capture-${index}.json`);
      const request = { runId: `run-${index}`, runtime: entry.runtime, prompt, directory: dir, ...entry.request };
      const completed = spawnSync(helper, [], {
        input: `${Buffer.from(JSON.stringify(request)).toString("base64")}\n`,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE_PATH: capture, SECRET_PROMPT: prompt },
      });
      assert.equal(completed.status, 0, completed.stderr);
      assert.match(completed.stdout, /WMUX_AGENT_READY/);
      assert.match(completed.stdout, new RegExp(`WMUX_AGENT_DONE run-${index} 0`));
      assert.equal(completed.stdout.includes(prompt), false);
      const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
      assert.deepEqual(captured.argv, entry.argv);
      assert.equal(captured.stdin, prompt);
      assert.equal(captured.cwd, entry.runtime === "claude" ? dir : root);
      assert.equal(captured.delegated, "1");
      assert.equal(captured.delegationRunId, `run-${index}`);
      assert.deepEqual(decodeResult(completed.stdout), {
        runId: `run-${index}`,
        runtime: entry.runtime,
        ok: true,
        result: entry.result,
        error: "",
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run requires explicit write access for OpenCode delegation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-run-readonly-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "opencode");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 99\n");
  fs.chmodSync(executable, 0o755);
  try {
    const request = { runId: "run-readonly", runtime: "opencode", prompt: "review only", directory: dir };
    const completed = spawnSync(helper, [], {
      input: `${Buffer.from(JSON.stringify(request)).toString("base64")}\n`,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(completed.status, 2);
    assert.deepEqual(decodeResult(completed.stdout), {
      runId: "run-readonly",
      ok: false,
      error: "OpenCode delegation cannot enforce read-only mode; explicitly enable writeAccess",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run enforces a structured blocked outcome without sandboxing Codex", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-run-outcome-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "codex");
  fs.writeFileSync(executable, `#!/usr/bin/env python3
import json,os,sys
schema_path=sys.argv[sys.argv.index('--output-schema')+1]
with open(os.environ['CAPTURE_PATH'],'w',encoding='utf-8') as handle:
    json.dump({'argv':sys.argv[1:],'stdin':sys.stdin.read(),'schema':json.load(open(schema_path,encoding='utf-8'))},handle)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps({'outcome':'blocked','summary':'remote service unavailable'})}}))
`);
  fs.chmodSync(executable, 0o755);
  const capture = path.join(dir, "capture.json");
  const prompt = "private structured task";
  try {
    const request = {
      runId: "run-outcome",
      runtime: "codex",
      prompt,
      directory: dir,
      writeAccess: true,
      unattended: false,
      sandboxMode: "danger-full-access",
      resultFormat: "outcome-v1",
    };
    const completed = spawnSync(helper, [], {
      input: `${Buffer.from(JSON.stringify(request)).toString("base64")}\n`,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE_PATH: capture },
    });
    assert.equal(completed.status, 0, completed.stderr);
    const result = decodeResult(completed.stdout);
    assert.deepEqual(result, {
      runId: "run-outcome",
      runtime: "codex",
      ok: false,
      outcome: "blocked",
      result: "remote service unavailable",
      error: "remote service unavailable",
    });
    const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.deepEqual(captured.argv.slice(0, 3), ["--sandbox", "danger-full-access", "exec"]);
    assert.equal(captured.argv.includes("--ask-for-approval"), false);
    assert.equal(captured.stdin, prompt);
    assert.deepEqual(captured.schema.properties.outcome.enum, ["completed", "blocked", "failed"]);
    assert.equal(captured.argv.includes(prompt), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run tui validates a prompt-free request and execs in the requested directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-tui-"));
  const bin = path.join(dir, "bin");
  const capture = path.join(dir, "capture.json");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "codex");
  fs.writeFileSync(executable, `#!/usr/bin/env python3
import json,os,sys
json.dump({'argv':sys.argv[1:],'cwd':os.getcwd(),'interactive':os.environ.get('WMUX_INTERACTIVE_TUI')},open(os.environ['CAPTURE_PATH'],'w'))
print('interactive ready')
`);
  fs.chmodSync(executable, 0o755);
  try {
    const request = {
      runId: "tui-1",
      runtime: "codex",
      directory: dir,
      model: "model-x",
      writeAccess: true,
      unattended: false,
      sandboxMode: "danger-full-access",
    };
    const completed = spawnSync(helper, ["tui", "tui-1"], {
      input: `${Buffer.from(JSON.stringify(request)).toString("base64")}\nWMUX_AGENT_TUI_ACK tui-1\nWMUX_AGENT_TUI_RELEASE tui-1\n`, encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE_PATH: capture },
    });
    assert.equal(completed.status, 0, completed.stderr);
    assert.match(completed.stdout, /WMUX_AGENT_TUI_READY tui-1/);
    assert.match(completed.stdout, /WMUX_AGENT_TUI_LAUNCH tui-1/);
    assert.match(completed.stdout, /WMUX_AGENT_TUI_EXIT tui-1 0/);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), {
      argv: [
        "--config", "check_for_update_on_startup=false",
        "--sandbox", "danger-full-access",
        "--model", "model-x",
      ],
      cwd: dir,
      interactive: "1",
    });
    assert.equal(completed.stdout.includes("prompt"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run tui rejects mismatched ids, forbidden or unknown fields, invalid options, and unavailable runtimes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-tui-invalid-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  try {
    const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    fs.symlinkSync(python.stdout.trim(), path.join(bin, "python3"));
    const cases = [
      [{ runId: "other", runtime: "codex", directory: dir }, "runId does not match"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir, prompt: "secret" }, "must not contain prompt"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir, unattended: "yes" }, "invalid unattended"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir, writeAccess: "yes" }, "invalid writeAccess"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir, sandboxMode: "host" }, "sandboxMode must be"],
      [{ runId: "tui-invalid", runtime: "opencode", directory: dir, sandboxMode: "read-only" }, "sandbox mode is only valid for codex"],
      [{ runId: "tui-invalid", runtime: "claude", directory: dir, unattended: true }, "unattended mode is only valid for codex"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir, title: "not transported" }, "forbidden key: title"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir, surprise: true }, "forbidden key: surprise"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir, agent: "build" }, "only valid for opencode"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir, model: 7 }, "invalid model"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir, model: "x".repeat(513) }, "invalid model"],
      [{ runId: "tui-invalid", runtime: "codex", directory: "/" + "x".repeat(4097) }, "invalid directory"],
      [{ runId: "tui-invalid", runtime: "codex", directory: `${dir}/missing` }, "directory does not exist"],
      [{ runId: "tui-invalid", runtime: "codex", directory: dir }, "executable not found"],
    ] as const;
    for (const [request, message] of cases) {
      const completed = spawnSync(helper, ["tui", "tui-invalid"], {
        input: `${Buffer.from(JSON.stringify(request)).toString("base64")}\n`, encoding: "utf8",
        env: { ...process.env, PATH: bin },
      });
      assert.notEqual(completed.status, 0);
      assert.match(String(decodeResult(completed.stdout).error), new RegExp(message));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run tui preserves runtime-specific argv and exact cwd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-tui-runtimes-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const fake = `#!/usr/bin/env python3
import json,os,sys
json.dump({'argv':sys.argv[1:],'cwd':os.getcwd()},open(os.environ['CAPTURE_PATH'],'w'))
`;
  for (const runtime of ["opencode", "codex", "claude"]) {
    const executable = path.join(bin, runtime);
    fs.writeFileSync(executable, fake);
    fs.chmodSync(executable, 0o755);
  }
  const cases = [
    ["opencode", { agent: "review", model: "model-o" }, ["--agent", "review", "--model", "model-o"]],
    ["codex", { model: "model-c" }, ["--model", "model-c"]],
    ["claude", {}, []],
  ] as const;
  try {
    for (const [runtime, extra, argv] of cases) {
      const capture = path.join(dir, `${runtime}.json`);
      const request = { runId: `tui-${runtime}`, runtime, directory: dir, ...extra };
      const completed = spawnSync(helper, ["tui", `tui-${runtime}`], {
        input: `${Buffer.from(JSON.stringify(request)).toString("base64")}\nWMUX_AGENT_TUI_ACK tui-${runtime}\nWMUX_AGENT_TUI_RELEASE tui-${runtime}\n`, encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE_PATH: capture },
      });
      assert.equal(completed.status, 0, completed.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), { argv, cwd: dir });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run tui resolves relative PATH entries before changing directory", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-tui-path-"));
  const originalBin = path.join(rootDir, "relative-bin");
  const requested = path.join(rootDir, "requested");
  const replacementBin = path.join(requested, "relative-bin");
  const capture = path.join(rootDir, "capture.txt");
  fs.mkdirSync(originalBin);
  fs.mkdirSync(replacementBin, { recursive: true });
  fs.writeFileSync(path.join(originalBin, "codex"), `#!/bin/sh\nprintf original > "$CAPTURE_PATH"\n`);
  fs.writeFileSync(path.join(replacementBin, "codex"), `#!/bin/sh\nprintf replacement > "$CAPTURE_PATH"\n`);
  fs.chmodSync(path.join(originalBin, "codex"), 0o755);
  fs.chmodSync(path.join(replacementBin, "codex"), 0o755);
  try {
    const request = { runId: "tui-relative", runtime: "codex", directory: requested };
    const completed = spawnSync(helper, ["tui", "tui-relative"], {
      cwd: rootDir,
      input: `${Buffer.from(JSON.stringify(request)).toString("base64")}\nWMUX_AGENT_TUI_ACK tui-relative\nWMUX_AGENT_TUI_RELEASE tui-relative\n`,
      encoding: "utf8",
      env: { ...process.env, PATH: `relative-bin:${process.env.PATH}`, CAPTURE_PATH: capture },
    });
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(fs.readFileSync(capture, "utf8"), "original");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run tui requires the exact ACK before starting the child", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-tui-ack-"));
  const bin = path.join(dir, "bin");
  const capture = path.join(dir, "started");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nprintf started > "$CAPTURE_PATH"\n`);
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  const child = spawn(helper, ["tui", "tui-ack"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE_PATH: capture },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  try {
    const request = { runId: "tui-ack", runtime: "codex", directory: dir };
    child.stdin.write(`${Buffer.from(JSON.stringify(request)).toString("base64")}\n`);
    await waitFor(() => stdout.includes("WMUX_AGENT_TUI_LAUNCH tui-ack"), "launch marker was not emitted");
    assert.equal(fs.existsSync(capture), false, "child started before controller ACK");
    child.stdin.write("WMUX_AGENT_TUI_ACK tui-ack\n");
    await waitFor(() => stdout.includes("WMUX_AGENT_TUI_EXIT tui-ack 0"), "exit marker was not emitted");
    assert.equal(fs.readFileSync(capture, "utf8"), "started");
    assert.equal(child.exitCode, null, "helper returned to the shell instead of quarantining");
    child.stdin.end("WMUX_AGENT_TUI_RELEASE tui-ack\n");
    assert.equal(await closed, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run tui rejects a wrong ACK and quarantines following shell input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-tui-wrong-ack-"));
  const bin = path.join(dir, "bin");
  const childStarted = path.join(dir, "child-started");
  const shellExecuted = path.join(dir, "shell-executed");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nprintf started > "$CAPTURE_PATH"\n`);
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  const child = spawn(helper, ["tui", "tui-wrong"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE_PATH: childStarted },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  try {
    const request = { runId: "tui-wrong", runtime: "codex", directory: dir };
    child.stdin.write(`${Buffer.from(JSON.stringify(request)).toString("base64")}\n`);
    await waitFor(() => stdout.includes("WMUX_AGENT_TUI_LAUNCH tui-wrong"), "launch marker was not emitted");
    child.stdin.write(`WMUX_AGENT_TUI_ACK other\ntouch ${shellExecuted}\n`);
    await waitFor(() => stdout.includes("WMUX_AGENT_DONE tui-wrong 2"), "wrong ACK failure was not emitted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(childStarted), false);
    assert.equal(fs.existsSync(shellExecuted), false);
    assert.equal(child.exitCode, null, "wrong ACK returned to the invoking shell");
    child.stdin.end("WMUX_AGENT_TUI_RELEASE tui-wrong\n");
    assert.equal(await closed, 2);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run tui emits an exact exit marker and quarantines racing prompt text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-tui-exit-"));
  const bin = path.join(dir, "bin");
  const shellExecuted = path.join(dir, "shell-executed");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 7\n");
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  const child = spawn(helper, ["tui", "tui-exit"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  try {
    const request = { runId: "tui-exit", runtime: "codex", directory: dir };
    child.stdin.write(`${Buffer.from(JSON.stringify(request)).toString("base64")}\nWMUX_AGENT_TUI_ACK tui-exit\n`);
    await waitFor(() => stdout.includes("WMUX_AGENT_TUI_EXIT tui-exit 7"), "exact exit marker was not emitted");
    child.stdin.write(`touch ${shellExecuted}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(shellExecuted), false);
    assert.equal(child.exitCode, null, "helper returned to the invoking shell after child exit");
    child.stdin.end("WMUX_AGENT_TUI_RELEASE tui-exit\n");
    assert.equal(await closed, 7);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest("wmux-agent-run tui forwards termination to the complete child process group", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-tui-signal-"));
  const bin = path.join(dir, "bin");
  const pidPath = path.join(dir, "child.pid");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nprintf '%s' "$$" > "$PID_PATH"\nsleep 30\n`);
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  const child = spawn(helper, ["tui", "tui-signal"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PID_PATH: pidPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  try {
    const request = { runId: "tui-signal", runtime: "codex", directory: dir };
    child.stdin.write(`${Buffer.from(JSON.stringify(request)).toString("base64")}\nWMUX_AGENT_TUI_ACK tui-signal\n`);
    await waitFor(() => fs.existsSync(pidPath), "supervised child did not start");
    child.kill("SIGTERM");
    await waitFor(() => stdout.includes("WMUX_AGENT_TUI_EXIT tui-signal 143"), "forwarded termination did not emit exit marker");
    const runtimePid = Number(fs.readFileSync(pidPath, "utf8"));
    assert.throws(() => process.kill(runtimePid, 0), /ESRCH/);
    child.stdin.end("WMUX_AGENT_TUI_RELEASE tui-signal\n");
    assert.equal(await closed, 143);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
