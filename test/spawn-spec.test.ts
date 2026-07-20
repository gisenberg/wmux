import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
const snapshotRuntimeDir = "/run/user/1000";

// Fixed environment so generated bootstrap URLs / scripts are deterministic.
const fixedEnv: Record<string, string> = {
  WMUX_HELPER_URL: "",
  WMUX_URL: "http://10.0.0.1:3478",
  WMUX_HOST: "10.0.0.1",
  WMUX_PORT: "3478",
  WMUX_STREAM_HOST: "10.0.0.1",
  WMUX_PUBLIC_URL: "http://10.0.0.1:3478",
  HOME: "/home/operator",
  SHELL: "/bin/bash",
};

const extraEnv = {
  WMUX_PANE_ID: "pane_fixed001",
  WMUX_WORKSPACE_ID: "ws_fixed",
  WMUX_TOKEN: "fixed-token",
  WMUX_START_CWD: "/home/fixed/project",
  KITTY_WINDOW_ID: "wmux-pane_fixed001",
};

const stableBackendDetail = (machine: MachineConfig) =>
  backendDetail(machine)
    .replace(/tmux (?:available|missing)/, "tmux available")
    .replace(/screen (?:available|missing)/, "screen missing");

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
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-spawn-spec-"));
  const touchedKeys = [...Object.keys(fixedEnv), "XDG_RUNTIME_DIR"];
  const saved = new Map(touchedKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, fixedEnv, { XDG_RUNTIME_DIR: runtimeDir });
  try {
    return machines.map(({ label, machine }) => {
      const spec = buildSpawnSpec(machine, 120, 40, extraEnv);
      // Drop env — it's the full process.env and not what this guard covers.
      const { env: _env, ...rest } = spec;
      return {
        label,
        spec: {
          ...rest,
          args: rest.args.map((arg) => arg.replaceAll(runtimeDir, snapshotRuntimeDir)),
        },
        canRefresh: canRefreshDurableSessionClient(machine),
        backendDetail: stableBackendDetail(machine),
      };
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
};

test("spawn spec matrix matches the golden snapshot", { skip: process.platform === "win32" }, () => {
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

test("pane spawn environments do not inherit server-scoped credentials", () => {
  const keys = [
    "WMUX_AUTOMATION_TOKEN",
    "WMUX_AUTOMATION_TOKEN_PATH",
    "WMUX_HELPER_TOKEN",
    "WMUX_HELPER_TOKEN_PATH",
    "WMUX_REGISTRATION_TOKEN",
    "WMUX_REGISTRATION_TOKEN_PATH",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = `server-only-${key}`;
    const spec = buildSpawnSpec(machines[1].machine, 120, 40, { WMUX_HELPER_TOKEN: "pane-helper" });
    assert.equal(spec.env.WMUX_HELPER_TOKEN, "pane-helper");
    for (const key of keys.filter((key) => key !== "WMUX_HELPER_TOKEN")) {
      assert.equal(spec.env[key], undefined, key);
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("local durable credentials are staged outside observable process arguments", { skip: process.platform === "win32" }, () => {
  const spec = buildSpawnSpec(machines[0].machine, 120, 40, extraEnv);
  assert.equal(spec.args.join(" ").includes(extraEnv.WMUX_TOKEN), false);
  assert.match(spec.args[0], /wmux\/runtimes\/v1-wmux_pane_fixed001\.sh$/);
  assert.equal(fs.statSync(spec.args[0]).mode & 0o777, 0o700);
});

test("local durable reattach uses a fresh systemd scope", () => {
  const first = buildSpawnSpec(machines[0].machine, 120, 40, extraEnv);
  const firstRuntime = fs.readFileSync(first.args[0], "utf8");
  const second = buildSpawnSpec(machines[0].machine, 120, 40, extraEnv);
  const secondRuntime = fs.readFileSync(second.args[0], "utf8");
  const unitPattern = /--unit '(wmux-pane-wmux_pane_fixed001-[0-9a-f-]+)'/;
  const firstUnit = firstRuntime.match(unitPattern)?.[1];
  const secondUnit = secondRuntime.match(unitPattern)?.[1];

  assert.ok(firstUnit, "first attach has a pane-identifying scope name");
  assert.ok(secondUnit, "second attach has a pane-identifying scope name");
  assert.notEqual(firstUnit, secondUnit, "reattach cannot collide with the surviving tmux scope");
  assert.match(firstRuntime, /tmux set-option -t 'wmux_pane_fixed001' status off/);
});

test("raw local panes apply an available agent profile before the shell", () => {
  const spec = buildSpawnSpec(machines[1].machine, 120, 40, extraEnv);
  assert.equal(spec.file, "/bin/sh");
  assert.ok((spec.env.PATH ?? "").split(path.delimiter).includes(path.join(os.homedir(), ".local", "bin")));
  assert.match(spec.args.join(" "), /wmux-agent-profile apply --quiet/);
  assert.match(spec.args.join(" "), /exec/);
});

test("POSIX SSH staging includes the hook installer beside its event helper", { skip: process.platform === "win32" }, () => {
  const spec = buildSpawnSpec(machines[5].machine, 120, 40, extraEnv);
  assert.equal(spec.file, "/bin/sh");
  assert.equal(spec.args.length, 1);
  assert.match(spec.args[0], /wmux\/ssh-runtimes\/v1-wmux_pane_fixed001\.sh$/);
  assert.ok(Buffer.byteLength(spec.args[0]) < 1024, "spawn argv remains bounded");

  const wrapper = fs.readFileSync(spec.args[0], "utf8");
  assert.match(wrapper, /ControlPath=.*wmux\/ssh-control\/pane-[0-9a-f]{24}\.sock/);
  assert.match(wrapper, /ControlMaster=auto/);
  assert.match(wrapper, /ControlPersist=3600/);
  const payloadMatch = wrapper.match(/wmux_payload='([^']+)'/);
  assert.ok(payloadMatch, "wrapper identifies its staged payload");
  const command = fs.readFileSync(payloadMatch[1], "utf8");
  assert.match(command, /wmux-hooks/);
  assert.match(command, /wmux-agent-event/);
  assert.match(command, /wmux-opencode-run/);
  assert.match(command, /wmux-agent-run/);
  assert.match(command, /wmuxctl/);
  assert.match(command, /chmod \+x .*wmux-hooks/);
  assert.match(command, /chmod \+x .*wmux-opencode-run/);
  assert.match(command, /chmod \+x .*wmux-agent-run/);
  assert.match(command, /chmod \+x .*wmuxctl/);
  assert.match(command, /ln -sf .*wmux-hooks/);
  assert.match(command, /ln -sf .*wmux-opencode-run/);
  assert.match(command, /ln -sf .*wmux-agent-run/);
  assert.match(command, /ln -sf .*wmuxctl/);
  assert.match(command, /wmux-agent-profile/);
  assert.match(command, /wmux-agent-profile apply --quiet/);
  assert.match(command, /\$HOME\/\.local\/bin/);
  assert.match(command, /chmod 600 "\$HOME\/\.wmux\/(?:token|url)"/);
  assert.equal(wrapper.includes(extraEnv.WMUX_TOKEN), false, "credentials stay in the staged payload");
});

test("registered POSIX SSH panes make missing profile auth optional", { skip: process.platform === "win32" }, () => {
  const spec = buildSpawnSpec({ ...machines[5].machine, source: "registered" }, 120, 40, {
    ...extraEnv,
    WMUX_TOKEN: "",
  });
  const wrapper = fs.readFileSync(spec.args[0], "utf8");
  const payloadMatch = wrapper.match(/wmux_payload='([^']+)'/);
  assert.ok(payloadMatch, "wrapper identifies its staged payload");
  const command = fs.readFileSync(payloadMatch[1], "utf8");
  assert.match(command, /wmux-agent-profile apply --quiet --optional-auth/);
});

test("static POSIX and Windows panes stage helper auth without exposing it in argv", { skip: process.platform === "win32" }, () => {
  const helperEnv = { ...extraEnv, WMUX_TOKEN: "", WMUX_HELPER_TOKEN: "H".repeat(43), WMUX_BROWSER_AUTH_MODE: "login-only" };
  const posix = buildSpawnSpec(machines[5].machine, 120, 40, helperEnv);
  const posixWrapper = fs.readFileSync(posix.args[0], "utf8");
  const posixPayloadPath = posixWrapper.match(/wmux_payload='([^']+)'/)?.[1];
  assert.ok(posixPayloadPath);
  const posixPayload = fs.readFileSync(posixPayloadPath, "utf8");
  assert.match(posixPayload, /\.wmux\/helper-token/);
  assert.equal(posixWrapper.includes(helperEnv.WMUX_HELPER_TOKEN), false);
  assert.equal(posix.args.join(" ").includes(helperEnv.WMUX_HELPER_TOKEN), false);

  const windows = buildSpawnSpec(machines[8].machine, 120, 40, helperEnv);
  const windowsWrapper = fs.readFileSync(windows.args[0], "utf8");
  const windowsPayloadPath = windowsWrapper.match(/wmux_payload='([^']+)'/)?.[1];
  assert.ok(windowsPayloadPath);
  const windowsPayload = fs.readFileSync(windowsPayloadPath, "utf8");
  assert.match(windowsPayload, /Authorization/);
  assert.match(windowsPayload, /Invoke-RestMethod/);
  const bootstrapUrl = windowsPayload.match(/-Uri '([^']+)'/)?.[1];
  assert.ok(bootstrapUrl);
  assert.equal(new URL(bootstrapUrl).searchParams.has("token"), false);
  assert.equal(windowsWrapper.includes(helperEnv.WMUX_HELPER_TOKEN), false);
  assert.equal(windows.args.join(" ").includes(helperEnv.WMUX_HELPER_TOKEN), false);
});

test("login-only Windows bootstrap fails closed without helper auth", () => {
  assert.throws(
    () => buildSpawnSpec(machines[8].machine, 120, 40, { ...extraEnv, WMUX_TOKEN: "", WMUX_BROWSER_AUTH_MODE: "login-only" }),
    /requires a helper token/,
  );
});

test("PowerShell SSH panes create the same private per-pane control master", { skip: process.platform === "win32" }, () => {
  const spec = buildSpawnSpec(machines[8].machine, 120, 40, extraEnv);
  assert.ok(spec.args.some((arg) => arg.startsWith("ControlPath=") && arg.includes("/wmux/ssh-control/")));
  assert.ok(spec.args.includes("ControlMaster=auto"));
  assert.ok(spec.args.includes("ControlPersist=3600"));
});

test("PowerShell SSH bootstrap keeps static credentials out of argv and preserves registered capabilities", () => {
  const bootstrapUrl = (environment: Record<string, string>): URL => {
    const spec = buildSpawnSpec({ ...machines[8].machine, source: "registered" }, 120, 40, environment);
    const encodedIndex = spec.args.indexOf("-EncodedCommand");
    assert.ok(encodedIndex >= 0);
    const command = Buffer.from(spec.args[encodedIndex + 1], "base64").toString("utf16le");
    const match = command.match(/irm '([^']+)'/);
    assert.ok(match, "spawn command contains the quoted helper bootstrap URL");
    return new URL(match[1]);
  };

  const staticSpec = buildSpawnSpec(machines[8].machine, 120, 40, {
    ...extraEnv,
    WMUX_TOKEN: "",
    WMUX_HELPER_TOKEN: "H".repeat(43),
    WMUX_BROWSER_AUTH_MODE: "login-only",
    WMUX_BOOTSTRAP_TOKEN: "",
  });
  const staticWrapper = fs.readFileSync(staticSpec.args[0], "utf8");
  const payloadPath = staticWrapper.match(/wmux_payload='([^']+)'/)?.[1];
  assert.ok(payloadPath);
  const staticPayload = fs.readFileSync(payloadPath, "utf8");
  assert.equal(staticSpec.args.join(" ").includes("H".repeat(43)), false);
  assert.equal(staticWrapper.includes("H".repeat(43)), false);
  assert.ok(staticPayload.includes("H".repeat(43)));
  assert.match(staticPayload, /Authorization/);
  assert.equal(staticPayload.includes("?token="), false);

  const registeredUrl = bootstrapUrl({
    ...extraEnv,
    WMUX_TOKEN: "",
    WMUX_BOOTSTRAP_TOKEN: "registered-bootstrap-capability",
  });
  assert.equal(registeredUrl.searchParams.get("token"), "registered-bootstrap-capability");
});

test("PowerShell SSH profile loading is opt-in", () => {
  const defaultSpec = buildSpawnSpec(machines[8].machine, 120, 40, extraEnv);
  const profileSpec = buildSpawnSpec(
    { ...machines[8].machine, loadPowerShellProfile: true },
    120,
    40,
    extraEnv,
  );
  assert.ok(defaultSpec.args.includes("-NoProfile"));
  assert.equal(profileSpec.args.includes("-NoProfile"), false);
  assert.ok(profileSpec.args.includes("-NoExit"));
  assert.ok(profileSpec.args.includes("-EncodedCommand"));
});
