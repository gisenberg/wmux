import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { backendDetail, buildSpawnSpec, canRefreshDurableSessionClient } from "../src/server/machines.js";
import type { MachineConfig } from "../src/server/types.js";

// Golden-output regression guard for the transport dispatch. It pins the exact
// spawn spec (file/args/cwd/title/trackProcessTitle) and backend metadata for a
// matrix of machine kinds/backends so the Backend-interface refactor can be
// proven behavior-preserving. Delete the golden file to regenerate.

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "spawn-spec.golden.json");

// Fixed environment so generated bootstrap URLs / scripts are deterministic.
const fixedEnv: Record<string, string> = {
  WMUX_URL: "http://10.0.0.1:3478",
  WMUX_HOST: "10.0.0.1",
  WMUX_PORT: "3478",
  WMUX_STREAM_HOST: "10.0.0.1",
  WMUX_PUBLIC_URL: "http://10.0.0.1:3478",
  HOME: "/home/operator",
  XDG_RUNTIME_DIR: "/run/user/1000",
};

const extraEnv = {
  WMUX_PANE_ID: "pane_fixed001",
  WMUX_WORKSPACE_ID: "ws_fixed",
  WMUX_TOKEN: "fixed-token",
  WMUX_START_CWD: "/home/fixed/project",
  KITTY_WINDOW_ID: "wmux-pane_fixed001",
};

const machines: Array<{ label: string; machine: MachineConfig }> = [
  { label: "local-auto", machine: { id: "local", name: "Local Server", kind: "local", sessionBackend: "auto", cwd: "/home/fixed" } },
  { label: "local-pty", machine: { id: "local", name: "Local Server", kind: "local", sessionBackend: "pty", cwd: "/home/fixed" } },
  { label: "local-tmux", machine: { id: "local", name: "Local Server", kind: "local", sessionBackend: "tmux", cwd: "/home/fixed" } },
  { label: "local-screen", machine: { id: "local", name: "Local Server", kind: "local", sessionBackend: "screen", cwd: "/home/fixed" } },
  { label: "local-command", machine: { id: "svc", name: "svc", kind: "local", command: ["htop", "-d", "5"] } },
  { label: "ssh-auto", machine: { id: "away", name: "Away", kind: "ssh", host: "linux-box.internal", user: "operator", sessionBackend: "auto" } },
  { label: "ssh-port-screen", machine: { id: "away", name: "Away", kind: "ssh", host: "linux-box.internal", user: "operator", port: 2222, sessionBackend: "screen" } },
  { label: "powershell", machine: { id: "win", name: "Win", kind: "powershell", host: "win-host" } },
  { label: "powershell-ssh", machine: { id: "win2", name: "Win2", kind: "powershell-ssh", host: "windows-box", user: "operator" } },
];

const sampleSpecs = () => {
  const saved = { ...process.env };
  Object.assign(process.env, fixedEnv);
  try {
    return machines.map(({ label, machine }) => {
      const spec = buildSpawnSpec(machine, 120, 40, extraEnv);
      // Drop env — it's the full process.env and not what this guard covers.
      const { env: _env, ...rest } = spec;
      return {
        label,
        spec: rest,
        canRefresh: canRefreshDurableSessionClient(machine),
        backendDetail: backendDetail(machine),
      };
    });
  } finally {
    process.env = saved;
  }
};

test("spawn spec matrix matches the golden snapshot", () => {
  const current = sampleSpecs();
  if (!fs.existsSync(goldenPath)) {
    fs.writeFileSync(goldenPath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`spawn-spec: wrote golden snapshot (${current.length} cases)`);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
  assert.deepEqual(current, golden);
});

test("every machine kind produces a runnable file + cwd", () => {
  for (const { label, spec } of sampleSpecs()) {
    assert.ok(spec.file, `${label} has a spawn file`);
    assert.ok(spec.cwd, `${label} has a cwd`);
    assert.ok(Array.isArray(spec.args), `${label} has args`);
  }
});

test("local durable credentials are staged outside observable process arguments", () => {
  const spec = buildSpawnSpec(machines[0].machine, 120, 40, extraEnv);
  assert.equal(spec.args.join(" ").includes(extraEnv.WMUX_TOKEN), false);
  assert.match(spec.args[0], /wmux\/runtimes\/v1-wmux_pane_fixed001\.sh$/);
  assert.equal(fs.statSync(spec.args[0]).mode & 0o777, 0o700);
});
