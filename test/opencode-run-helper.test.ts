import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const waitFor = async (predicate: () => boolean, timeoutMs: number, detail: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(detail);
};

test("wmux-opencode-run uses argv/stdin and emits opaque markers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-opencode-run-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const capture = path.join(dir, "capture.json");
  const fake = path.join(bin, "opencode");
  fs.writeFileSync(fake, `#!/usr/bin/env python3\nimport json,os,sys\nif sys.argv[1:] == ['run','--help']:\n print('  \\033[36m--auto\\033[0m  automatically approve permissions')\n raise SystemExit(0)\njson.dump({'argv':sys.argv[1:],'stdin':sys.stdin.read(),'delegated':os.environ.get('WMUX_DELEGATED_RUN')},open(${JSON.stringify(capture)},'w'))\nprint(json.dumps({'type':'text','part':{'text':'completed ✓'}}))\n`);
  fs.chmodSync(fake, 0o755);
  const prompt = "secret prompt must not be echoed";
  const input = Buffer.from(JSON.stringify({ runId: "run-1", prompt, directory: dir, agent: "build", title: "Test", autoApprove: true })).toString("base64") + "\n";
  try {
    const completed = spawnSync(path.join(root, "scripts", "wmux-opencode-run"), [], { input, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(completed.status, 0, completed.stderr);
    const stdout = completed.stdout;
    const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.deepEqual(captured.argv, ["run", "--format", "json", "--dir", dir, "--title", "Test", "--agent", "build", "--auto"]);
    assert.equal(captured.stdin, prompt);
    assert.equal(captured.delegated, "1");
    assert.equal(stdout.includes(prompt), false);
    assert.match(stdout, /WMUX_OPENCODE_READY/);
    assert.match(stdout, /WMUX_OPENCODE_RESULT /);
    assert.match(stdout, /WMUX_OPENCODE_DONE run-1 0/);
    const marker = stdout.split(/\r?\n/).find((line) => line.startsWith("WMUX_OPENCODE_RESULT "));
    assert.ok(marker);
    assert.deepEqual(JSON.parse(Buffer.from(marker.slice("WMUX_OPENCODE_RESULT ".length), "base64").toString("utf8")), {
      runId: "run-1",
      ok: true,
      result: "completed ✓",
      error: "",
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("wmux-opencode-run captures nested JSONL errors and enforces the 128 KiB prompt contract", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-opencode-error-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const fake = path.join(bin, "opencode");
  fs.writeFileSync(fake, "#!/usr/bin/env python3\nimport json,sys\nsys.stdin.read()\nprint(json.dumps({'type':'error','error':{'data':{'message':'nested failure ✓'}}}))\nraise SystemExit(7)\n");
  fs.chmodSync(fake, 0o755);
  const invoke = (prompt: string) => spawnSync(path.join(root, "scripts", "wmux-opencode-run"), [], {
    input: Buffer.from(JSON.stringify({ runId: "run-error", prompt, directory: dir })).toString("base64") + "\n",
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  try {
    const failed = invoke("valid prompt");
    assert.equal(failed.status, 7, failed.stderr);
    const marker = failed.stdout.split(/\r?\n/).find((line) => line.startsWith("WMUX_OPENCODE_RESULT "));
    assert.ok(marker);
    const result = JSON.parse(Buffer.from(marker.slice("WMUX_OPENCODE_RESULT ".length), "base64").toString("utf8"));
    assert.deepEqual(result, { runId: "run-error", ok: false, result: "", error: "nested failure ✓" });

    const oversized = invoke("x".repeat(128 * 1024 + 1));
    assert.equal(oversized.status, 2);
    assert.match(oversized.stdout, /WMUX_OPENCODE_DONE run-error 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wmux-opencode-run selects the advertised long auto-approval flag and fails closed when unsupported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-opencode-auto-probe-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const capture = path.join(dir, "capture.json");
  const fake = path.join(bin, "opencode");
  fs.writeFileSync(fake, `#!/usr/bin/env python3
import json,os,sys
if sys.argv[1:] == ['run','--help']:
    if os.environ.get('HELP_VARIANT') == 'long':
        print('  --dangerously-skip-permissions  approve permissions')
    else:
        print('Usage: opencode run')
    raise SystemExit(0)
json.dump({'argv':sys.argv[1:]},open(${JSON.stringify(capture)},'w'))
sys.stdin.read()
print(json.dumps({'type':'text','part':{'text':'done'}}))
`);
  fs.chmodSync(fake, 0o755);
  const input = Buffer.from(JSON.stringify({ runId: "run-auto", prompt: "probe secret", directory: dir, autoApprove: true })).toString("base64") + "\n";
  const invoke = (variant: string) => spawnSync(path.join(root, "scripts", "wmux-opencode-run"), [], {
    input,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HELP_VARIANT: variant },
  });
  try {
    const supported = invoke("long");
    assert.equal(supported.status, 0, supported.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")).argv, [
      "run", "--format", "json", "--dir", dir, "--dangerously-skip-permissions",
    ]);
    fs.rmSync(capture);

    const unsupported = invoke("none");
    assert.equal(unsupported.status, 2, unsupported.stderr);
    assert.equal(fs.existsSync(capture), false, "normal OpenCode run must not start after an unsupported probe");
    assert.equal(unsupported.stdout.includes("Usage: opencode run"), false);
    const marker = unsupported.stdout.split(/\r?\n/).find((line) => line.startsWith("WMUX_OPENCODE_RESULT "));
    assert.ok(marker);
    assert.deepEqual(JSON.parse(Buffer.from(marker.slice("WMUX_OPENCODE_RESULT ".length), "base64").toString("utf8")), {
      runId: "run-auto",
      ok: false,
      error: "installed OpenCode does not advertise an auto-approval option",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wmux-opencode-run forwards SIGTERM and reaps a resistant OpenCode child", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-opencode-sigterm-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const ready = path.join(dir, "child-ready.json");
  const fake = path.join(bin, "opencode");
  fs.writeFileSync(fake, `#!/usr/bin/env python3
import json,os,signal,sys
signal.signal(signal.SIGTERM, lambda _signum, _frame: None)
signal.signal(signal.SIGHUP, lambda _signum, _frame: None)
with open(${JSON.stringify(ready)}, "w", encoding="utf-8") as handle:
    json.dump({"pid": os.getpid()}, handle)
sys.stdin.read()
while True:
    signal.pause()
`);
  fs.chmodSync(fake, 0o755);
  const input = Buffer.from(JSON.stringify({ runId: "run-term", prompt: "terminate", directory: dir })).toString("base64") + "\n";
  const helper = spawn(path.join(root, "scripts", "wmux-opencode-run"), [], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let childPid: number | undefined;
  let helperClosed = false;
  try {
    helper.stdin.end(input);
    await waitFor(() => fs.existsSync(ready), 5_000, "fake OpenCode child did not report readiness");
    childPid = (JSON.parse(fs.readFileSync(ready, "utf8")) as { pid: number }).pid;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("helper did not exit after SIGTERM")), 6_000);
      helper.once("close", (code, signalName) => {
        clearTimeout(timer);
        resolve({ code, signal: signalName });
      });
    });
    assert.equal(helper.kill("SIGTERM"), true);
    const result = await closed;
    helperClosed = true;
    assert.deepEqual(result, { code: 143, signal: null });
    await waitFor(() => {
      try {
        process.kill(childPid as number, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, 2_000, "fake OpenCode child remained after helper exit");
  } finally {
    if (!helperClosed) helper.kill("SIGKILL");
    if (childPid !== undefined) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
