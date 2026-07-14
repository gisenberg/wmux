import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, loadConfig } from "../src/server/config.js";

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
    fs.writeFileSync(configPath, JSON.stringify(machine({ id: "isolated", name: "Isolated" })));
    process.env.WMUX_CONFIG_PATH = configPath;
    assert.deepEqual(loadConfig().machines.map((entry) => entry.id), ["local", "isolated"]);
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
