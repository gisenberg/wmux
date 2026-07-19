import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, "scripts", "wmux-agent-run");

const decodeResult = (stdout: string) => {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("WMUX_AGENT_RESULT "));
  assert.ok(line);
  return JSON.parse(Buffer.from(line.slice("WMUX_AGENT_RESULT ".length), "base64").toString("utf8"));
};

test("wmux-agent-run adapts OpenCode, Codex, and Claude without putting prompts in argv", () => {
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
    json.dump({'runtime':runtime,'argv':sys.argv[1:],'stdin':sys.stdin.read(),'cwd':os.getcwd(),'delegated':os.environ.get('WMUX_DELEGATED_RUN')},handle)
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

test("wmux-agent-run requires explicit write access for OpenCode delegation", () => {
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
