import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, loadConfig } from "../src/server/config.js";
import { defaultKeybindings } from "../src/shared/keybindings.js";
import {
  DEFAULT_DELEGATION_NOTIFICATION_BUDGET_SECONDS,
  DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS,
} from "../src/shared/protocol.js";

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
    host: "100.64.0.7",
    sessionBackend: "agent",
    agentPort,
  });
  assert.ok(configSchema.safeParse(windowsAgent(65527)).success);
  assert.equal(configSchema.safeParse(windowsAgent(65528)).success, false);
});

test("session agents with DNS SSH hosts require an explicit private agent endpoint", () => {
  const dnsAgent = machine({
    kind: "powershell-ssh",
    host: "box.ts.net",
    sessionBackend: "agent",
    agentPort: 3481,
  });
  const missingEndpoint = configSchema.safeParse(dnsAgent);
  assert.equal(missingEndpoint.success, false);
  if (!missingEndpoint.success) {
    assert.match(missingEndpoint.error.issues[0]?.message ?? "", /agentUrl with an explicit private\/internal IPv4 address/);
  }
  assert.ok(configSchema.safeParse(machine({
    kind: "powershell-ssh",
    host: "box.ts.net",
    sessionBackend: "agent",
    agentUrl: "http://100.64.0.7:3481",
    agentToken: "secret",
  })).success);
  assert.equal(configSchema.safeParse(machine({
    kind: "powershell-ssh",
    host: "box.ts.net",
    sessionBackend: "agent",
    agentUrl: "http://100.64.0.7:3482",
    agentPort: 3481,
  })).success, false);
  assert.equal(configSchema.safeParse(machine({
    kind: "powershell-ssh",
    host: "box.ts.net",
    sessionBackend: "agent",
    agentUrl: "http://203.0.113.7:3481",
  })).success, false);
  for (const agentUrl of [
    "not-a-url",
    "http://100.64.0.7",
    "https://100.64.0.7:3481",
    "http://user:secret@100.64.0.7:3481",
    "http://100.64.0.7:3481/agent",
    "http://100.64.0.7:3481/?query=1",
    "http://[fd7a:115c:a1e0::7]:3481",
  ]) {
    assert.doesNotThrow(() => configSchema.safeParse({
      machines: [{
        id: "windows-agent",
        name: "Windows agent",
        kind: "powershell-ssh",
        host: "box.ts.net",
        sessionBackend: "agent",
        agentUrl,
      }],
    }));
    assert.equal(configSchema.safeParse({
      machines: [{
        id: "windows-agent",
        name: "Windows agent",
        kind: "powershell-ssh",
        host: "box.ts.net",
        sessionBackend: "agent",
        agentUrl,
      }],
    }).success, false, agentUrl);
  }
});

test("native session agents are limited to supported machine transports", () => {
  assert.equal(configSchema.safeParse(machine({
    kind: "ssh",
    sessionBackend: "agent",
    agentPort: 3481,
    agentToken: "secret",
  })).success, false);
  assert.ok(configSchema.safeParse(machine({
    kind: "ssh",
    sessionBackend: "agent",
    agentUrl: "http://100.64.0.8:3481",
    agentToken: "secret",
  })).success);
  assert.ok(configSchema.safeParse({
    machines: [{
      id: "local-agent",
      name: "Local agent",
      kind: "local",
      sessionBackend: "agent",
      agentUrl: "http://127.0.0.1:3481",
      agentToken: "secret",
    }],
  }).success);
  for (const kind of ["powershell", "service"]) {
    assert.equal(configSchema.safeParse(machine({
      kind,
      sessionBackend: "agent",
    })).success, false);
  }
});

test("every session-agent transport rejects public callback origins", () => {
  for (const kind of ["local", "ssh", "powershell-ssh"] as const) {
    const candidate = kind === "local"
      ? { machines: [{ id: "agent", name: "Agent", kind, sessionBackend: "agent", agentUrl: "http://203.0.113.9:3481" }] }
      : machine({ kind, sessionBackend: "agent", agentUrl: "http://203.0.113.9:3481" });
    assert.equal(configSchema.safeParse(candidate).success, false, kind);
  }
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

test("shell command tracking is opt-in", () => {
  assert.equal(loadConfig().shellCommandTracking, false);
  assert.equal(configSchema.parse({ shellCommandTracking: true }).shellCommandTracking, true);
  assert.equal(configSchema.safeParse({ shellCommandTracking: "true" }).success, false);
});

test("delegation wait defaults are mode-aware and config overrides are bounded", () => {
  assert.deepEqual(loadConfig().delegation.waitTimeoutSeconds, DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS);
  assert.deepEqual(
    loadConfig().delegation.notificationBudgetSeconds,
    DEFAULT_DELEGATION_NOTIFICATION_BUDGET_SECONDS,
  );
  assert.equal(loadConfig().delegation.preferHeadless, false);
  const parsed = configSchema.parse({
    delegation: {
      preferHeadless: true,
      waitTimeoutSeconds: {
        review: 900,
        change: 7_200,
        deploy: 10_800,
      },
      notificationBudgetSeconds: {
        running: 3_600,
        waiting: 120,
      },
    },
  });
  assert.equal(parsed.delegation?.preferHeadless, true);
  assert.equal(parsed.delegation?.waitTimeoutSeconds?.review, 900);
  assert.equal(
    parsed.delegation?.notificationBudgetSeconds?.waiting,
    120,
  );
  for (const timeout of [0, 14_401, Number.POSITIVE_INFINITY, "7200"]) {
    assert.equal(configSchema.safeParse({
      delegation: { waitTimeoutSeconds: { change: timeout } },
    }).success, false);
  }
  assert.equal(configSchema.safeParse({
    delegation: { waitTimeoutSeconds: { review: 0.1 } },
  }).success, true);
  assert.equal(configSchema.safeParse({
    delegation: { waitTimeoutSeconds: { review: 1_800, arbitrary: 60 } },
  }).success, false);
  for (const budget of [0, 604_801, Number.POSITIVE_INFINITY, "300"]) {
    assert.equal(configSchema.safeParse({
      delegation: { notificationBudgetSeconds: { waiting: budget } },
    }).success, false);
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
      shellCommandTracking: true,
    }));
    process.env.WMUX_CONFIG_PATH = configPath;
    const config = loadConfig();
    assert.deepEqual(config.machines.map((entry) => entry.id), ["local", "isolated"]);
    assert.equal(config.terminalFontFamily, '"JetBrains Mono"');
    assert.equal(config.terminalFontSize, 16);
    assert.equal(config.shellCommandTracking, true);
    process.env.WMUX_CONFIG_PATH = path.join(dir, "missing.json");
    assert.throws(() => loadConfig(), /WMUX_CONFIG_PATH does not exist/);
  } finally {
    if (previous === undefined) delete process.env.WMUX_CONFIG_PATH;
    else process.env.WMUX_CONFIG_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the managed home catalog overrides only checkout-local machines", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-managed-config-"));
  const checkout = path.join(directory, "checkout");
  const home = path.join(directory, "home");
  const previousDirectory = process.cwd();
  const previousHome = process.env.HOME;
  const previousConfigPath = process.env.WMUX_CONFIG_PATH;
  fs.mkdirSync(checkout);
  fs.mkdirSync(path.join(home, ".wmux"), { recursive: true });

  try {
    delete process.env.WMUX_CONFIG_PATH;
    process.env.HOME = home;
    process.chdir(checkout);
    fs.writeFileSync(
      path.join(checkout, "wmux.config.json"),
      JSON.stringify({
        machines: [{ id: "checkout", name: "Checkout", kind: "local" }],
        localMachine: false,
        terminalFontSize: 17,
      }),
    );
    fs.writeFileSync(
      path.join(home, ".wmux", "config.json"),
      JSON.stringify({
        managedMachineCatalog: true,
        machines: [{ id: "managed", name: "Managed", kind: "local" }],
        localMachine: false,
        terminalFontSize: 22,
      }),
    );

    const config = loadConfig();
    assert.deepEqual(config.machines.map((configuredMachine) => configuredMachine.id), ["managed"]);
    assert.equal(config.terminalFontSize, 17);
  } finally {
    process.chdir(previousDirectory);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigPath === undefined) delete process.env.WMUX_CONFIG_PATH;
    else process.env.WMUX_CONFIG_PATH = previousConfigPath;
    fs.rmSync(directory, { recursive: true, force: true });
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
