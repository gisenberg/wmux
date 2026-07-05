import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema } from "../src/server/config.js";

const machine = (overrides: Record<string, unknown>) => ({
  machines: [{ id: "box", name: "Box", kind: "ssh", host: "box.ts.net", user: "me", ...overrides }],
});

test("accepts normal machine configs", () => {
  assert.ok(configSchema.safeParse(machine({})).success);
  assert.ok(configSchema.safeParse(machine({ id: "away-team_2", name: "Away Team (9800x3d)" })).success);
  assert.ok(configSchema.safeParse(machine({ host: "100.64.0.7" })).success);
  assert.ok(configSchema.safeParse(machine({ host: "fd7a::1234" })).success);
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
