#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, [
  "--import",
  "tsx",
  "scripts/generate-agent-contract.mjs",
  "--check",
]);
run(process.execPath, ["scripts/generate-hooks.mjs", "--check"]);
run(process.execPath, ["scripts/build-codex-plugin-deps.mjs", "--check"]);

const python = [
  { command: "python3", args: [] },
  { command: "python", args: [] },
  { command: "py", args: ["-3"] },
].find(({ command, args }) =>
  spawnSync(command, [...args, "--version"], { cwd: repoRoot, stdio: "ignore" }).status === 0,
);

if (!python) throw new Error("Python 3 is required for script validation");

run(python.command, [
  ...python.args,
  "-m",
  "py_compile",
  "scripts/wmux-agent-event",
  "scripts/wmux-agent-run",
  "scripts/wmux_agent_contract.py",
  "scripts/wmux-copy",
  "scripts/wmux-run",
  "scripts/wmux-shell-run-event",
  "scripts/wmux-opencode-run",
  "scripts/wmux-stream-agent",
  "scripts/wmux-windows-agent",
  "scripts/windows/wmux_windows_agent_protocol.py",
  "skills/wmux/scripts/wmuxctl.py",
  "test/windows-agent-drain-smoke.py",
], {
  ...process.env,
  PYTHONPYCACHEPREFIX: path.join(repoRoot, "test-results", "pycache"),
});

for (const script of [
  "scripts/wmux-hooks",
  "scripts/verify-remote.mjs",
  "scripts/verification-runner.cjs",
  "scripts/wmux-agent-input-broker",
  "scripts/wmux-moonlight-gateway",
  "scripts/wmux-set-password",
  "scripts/wmux-provision-scoped-auth.mjs",
  "plugins/wmux/scripts/wmux-mcp.mjs",
  "plugins/wmux/scripts/wmux-context.mjs",
  "plugins/wmux/scripts/wmux-binding.mjs",
  "plugins/wmux/scripts/wmux-session.mjs",
  "plugins/wmux/scripts/wmux-title.mjs",
  "plugins/wmux/scripts/wmux-name-ownership.mjs",
  "plugins/wmux/scripts/codex-lifecycle.mjs",
  "plugins/wmux/scripts/codex-rpc.mjs",
  "plugins/wmux/scripts/wmux-observer.mjs",
  "scripts/build-codex-plugin-deps.mjs",
]) {
  run(process.execPath, ["--check", script]);
}

run("bash", [
  "-n",
  "scripts/install-user-service.sh",
  "scripts/install-stream-service.sh",
  "scripts/install-heartbeat-service.sh",
  "scripts/install-tailscale-cert-service.sh",
  "scripts/wmux-cert-renew",
  "scripts/wmux-heartbeat",
  "scripts/wmux-media",
  "scripts/wmux-notify",
  "scripts/wmux-title",
  "scripts/wmuxctl",
]);
