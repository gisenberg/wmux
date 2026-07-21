import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, loadConfig } from "../src/server/config.js";
import { defaultKeybindings } from "../src/shared/keybindings.js";

const machine = (overrides: Record<string, unknown>) => ({
  machines: [{ id: "box", name: "Box", kind: "ssh", host: "box.ts.net", user: "me", ...overrides }],
});

test("accepts normal machine configs", () => {
  assert.ok(configSchema.safeParse(machine({})).success);
  assert.ok(configSchema.safeParse(machine({ id: "remote-box_2", name: "Remote Box (Windows)" })).success);
  assert.ok(configSchema.safeParse(machine({ host: "100.64.0.7" })).success);
  assert.ok(configSchema.safeParse(machine({ host: "fd7a::1234" })).success);
  assert.ok(configSchema.safeParse(machine({ platform: "mac" })).success);
  assert.equal(configSchema.safeParse(machine({ platform: "darwin" })).success, false);
});

test("PowerShell profile loading is opt-in and limited to powershell-ssh machines", () => {
  const windowsMachine = machine({ kind: "powershell-ssh", loadPowerShellProfile: true });
  const parsed = configSchema.parse(windowsMachine);
  assert.equal(parsed.machines?.[0].loadPowerShellProfile, true);
  assert.equal(configSchema.safeParse(machine({ loadPowerShellProfile: true })).success, false);
  assert.ok(configSchema.safeParse(machine({ kind: "powershell-ssh" })).success);
});

test("Windows agent ports reserve the bounded rollout range", () => {
  const windowsAgent = (agentPort: number) => machine({
    kind: "powershell-ssh",
    sessionBackend: "agent",
    agentPort,
  });
  assert.ok(configSchema.safeParse(windowsAgent(65527)).success);
  assert.equal(configSchema.safeParse(windowsAgent(65528)).success, false);
});

test("validates terminal typography defaults", () => {
  assert.ok(configSchema.safeParse({
    terminalFontFamily: '"JetBrains Mono", "Cascadia Code"',
    terminalFontSize: 16,
  }).success);
  for (const terminalFontFamily of ["", "bad\nfont", "x".repeat(257)]) {
    assert.equal(configSchema.safeParse({ terminalFontFamily }).success, false);
  }
  for (const terminalFontSize of [9, 25, 14.5, "14"]) {
    assert.equal(configSchema.safeParse({ terminalFontSize }).success, false);
  }
});

test("rejects machine ids that could escape scripts, paths, or URLs", () => {
  for (const id of ["a b", "a;rm -rf /", "a/../b", "$(x)", "a'b", "", "-lead", "x".repeat(65)]) {
    assert.equal(configSchema.safeParse(machine({ id })).success, false, `id ${JSON.stringify(id)} should be rejected`);
  }
});

test("rejects machine names with control or shell metacharacters", () => {
  for (const name of ["a\nb", "a`b`", "a$b", "a\\b", 'a"b', "a'b", "\x07bell"]) {
    assert.equal(configSchema.safeParse(machine({ name })).success, false, `name ${JSON.stringify(name)} should be rejected`);
  }
});

test("rejects hosts and users with shell-significant characters", () => {
  assert.equal(configSchema.safeParse(machine({ host: "evil.com;rm -rf" })).success, false);
  assert.equal(configSchema.safeParse(machine({ host: "host name" })).success, false);
  assert.equal(configSchema.safeParse(machine({ user: "me;id" })).success, false);
  assert.equal(configSchema.safeParse(machine({ user: "me me" })).success, false);
});

test("WMUX_CONFIG_PATH isolates explicit runtime and test configuration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-config-"));
  const configPath = path.join(dir, "config.json");
  const previous = process.env.WMUX_CONFIG_PATH;
  try {
    fs.writeFileSync(configPath, JSON.stringify({
      ...machine({ id: "isolated", name: "Isolated" }),
      terminalFontFamily: '"JetBrains Mono"',
      terminalFontSize: 16,
    }));
    process.env.WMUX_CONFIG_PATH = configPath;
    const config = loadConfig();
    assert.deepEqual(config.machines.map((entry) => entry.id), ["local", "isolated"]);
    assert.equal(config.terminalFontFamily, '"JetBrains Mono"');
    assert.equal(config.terminalFontSize, 16);
    process.env.WMUX_CONFIG_PATH = path.join(dir, "missing.json");
    assert.throws(() => loadConfig(), /WMUX_CONFIG_PATH does not exist/);
  } finally {
    if (previous === undefined) delete process.env.WMUX_CONFIG_PATH;
    else process.env.WMUX_CONFIG_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validates the localMachine flag", () => {
  assert.ok(configSchema.safeParse({ machines: [], localMachine: false }).success);
  assert.ok(configSchema.safeParse({ localMachine: true }).success);
  assert.equal(configSchema.safeParse({ localMachine: "no" }).success, false);
});

test("localMachine false suppresses the implicit local machine", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-config-"));
  const configPath = path.join(directory, "config.json");
  const previousConfigPath = process.env.WMUX_CONFIG_PATH;

  try {
    process.env.WMUX_CONFIG_PATH = configPath;
    fs.writeFileSync(configPath, JSON.stringify({ machines: [], localMachine: false }));
    assert.deepEqual(loadConfig().machines, []);

    fs.writeFileSync(configPath, JSON.stringify({ machines: [] }));
    assert.deepEqual(loadConfig().machines.map((configuredMachine) => configuredMachine.id), ["local"]);
  } finally {
    if (previousConfigPath === undefined) delete process.env.WMUX_CONFIG_PATH;
    else process.env.WMUX_CONFIG_PATH = previousConfigPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keybinding config preserves missing defaults and supports explicit disable", () => {
  const parsed = configSchema.safeParse({
    keybindings: {
      "commandPalette.open": ["Ctrl+Shift+KeyP"],
      "sidebar.toggle": [],
    },
  });
  assert.equal(parsed.success, true);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-config-"));
  const configPath = path.join(directory, "config.json");
  const previousConfigPath = process.env.WMUX_CONFIG_PATH;
  try {
    process.env.WMUX_CONFIG_PATH = configPath;
    fs.writeFileSync(configPath, JSON.stringify({
      keybindings: {
        "commandPalette.open": ["Ctrl+Shift+KeyP"],
        "sidebar.toggle": [],
      },
    }));
    const loaded = loadConfig();
    assert.deepEqual(loaded.keybindings["commandPalette.open"], ["Ctrl+Shift+KeyP"]);
    assert.deepEqual(loaded.keybindings["sidebar.toggle"], []);
    assert.deepEqual(loaded.keybindings["workspace.new"], defaultKeybindings["workspace.new"]);

    fs.writeFileSync(configPath, JSON.stringify({ machines: [] }));
    assert.deepEqual(loadConfig().keybindings, defaultKeybindings);
  } finally {
    if (previousConfigPath === undefined) delete process.env.WMUX_CONFIG_PATH;
    else process.env.WMUX_CONFIG_PATH = previousConfigPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("example config lists every default keybinding", () => {
  const example = JSON.parse(fs.readFileSync(path.resolve("wmux.config.example.json"), "utf8")) as {
    keybindings?: unknown;
  };
  assert.deepEqual(example.keybindings, defaultKeybindings);
  assert.equal(configSchema.safeParse(example).success, true);
});

test("keybinding config rejects unknown actions, malformed chords, and collisions", () => {
  assert.equal(configSchema.safeParse({ keybindings: { "unknown.action": ["Ctrl+KeyK"] } }).success, false);
  assert.equal(configSchema.safeParse({ keybindings: { "commandPalette.open": ["Ctrl+K"] } }).success, false);
  assert.equal(configSchema.safeParse({ keybindings: { "commandPalette.open": ["Ctrl+KeyB"] } }).success, false);
});
