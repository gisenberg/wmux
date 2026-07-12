import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

test("Windows agent stdio backend maps bare LF to CRLF", (t) => {
  const python = findPython();
  if (!python) {
    t.skip("python not available");
    return;
  }

  const script = String.raw`
import importlib.machinery
import importlib.util
import os

path = os.environ["WMUX_AGENT_PATH"]
loader = importlib.machinery.SourceFileLoader("wmux_agent_under_test", path)
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

cases = [
    (b"PS> cd ..\nPS> ", False, b"PS> cd ..\r\nPS> ", False),
    (b"already\r\nok", False, b"already\r\nok", False),
    (b"\nnext", True, b"\nnext", False),
    (b"split\r", False, b"split\r", True),
]

for data, previous, expected, expected_state in cases:
    actual, state = module.terminalize_stdio_output(data, previous)
    if actual != expected or state != expected_state:
        raise AssertionError((data, previous, actual, state, expected, expected_state))
print("ok")
`;
  const result = spawnSync(python.command, [...python.args, "-c", script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      WMUX_AGENT_PATH: path.resolve("scripts/wmux-windows-agent"),
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

test("Windows agent auto backend prefers ConPTY and falls back to stdio", (t) => {
  const python = findPython();
  if (!python) {
    t.skip("python not available");
    return;
  }

  const script = String.raw`
import importlib.machinery
import importlib.util
import os

path = os.environ["WMUX_AGENT_PATH"]
loader = importlib.machinery.SourceFileLoader("wmux_agent_backend_test", path)
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

cases = [
    ({"backend": "auto"}, True, "conpty"),
    ({"backend": "auto"}, False, "stdio"),
    ({"backend": "stdio"}, True, "stdio"),
    ({"backend": "conpty"}, False, "conpty"),
]

for config, available, expected in cases:
    module.conpty_available = lambda available=available: available
    actual = module.configured_backend(config)
    if actual != expected:
        raise AssertionError((config, available, actual, expected))
print("ok")
`;
  const result = spawnSync(python.command, [...python.args, "-c", script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      WMUX_AGENT_PATH: path.resolve("scripts/wmux-windows-agent"),
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

const findPython = (): { command: string; args: string[] } | null => {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3"] },
          { command: "python", args: [] },
        ]
      : [
          { command: "python3", args: [] },
          { command: "python", args: [] },
        ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, "--version"], { stdio: "ignore" });
    if (result.status === 0) return candidate;
  }
  return null;
};
