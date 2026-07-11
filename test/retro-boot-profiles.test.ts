import assert from "node:assert/strict";
import test from "node:test";
import { RETRO_BOOT_PROFILES, selectRetroBootProfile } from "../src/client/src/retro-boot-profiles";

test("retro boot profiles cover the requested computer families", () => {
  const ids = new Set(RETRO_BOOT_PROFILES.map((profile) => profile.id));
  assert.deepEqual(
    [
      "acorn-archimedes",
      "amiga-workbench",
      "amstrad-cpc",
      "apple-iie",
      "apple-lisa",
      "atari-st",
      "bbc-micro",
      "commodore-128",
      "commodore-64",
      "ibm-pc-at",
      "ibm-3270-mvs",
      "msx2",
      "nextcube",
      "osborne-1",
      "pdp-11-rt11",
      "pico-8",
      "sgi-irix",
      "sinclair-ql",
      "sun-sparcstation",
      "trs-80-model-4",
      "vax-vms",
      "zx-spectrum",
    ].filter((id) => !ids.has(id)),
    [],
  );
});

test("every retro profile has a complete keyboard authentication loop", () => {
  for (const profile of RETRO_BOOT_PROFILES) {
    assert.ok(profile.boot.length > 0, profile.id);
    assert.match(profile.auth.usernamePrompt, /USER|LOGIN/i, profile.id);
    assert.match(profile.auth.passwordPrompt, /PASS/i, profile.id);
    assert.ok(profile.auth.failed.length > 0, profile.id);
    assert.ok(profile.auth.granted.length > 0, profile.id);
    assert.ok(profile.fontFamily.includes("monospace"), profile.id);
  }
});

test("profile selection spans the pool and avoids an immediate repeat", () => {
  assert.equal(selectRetroBootProfile(0).id, RETRO_BOOT_PROFILES[0].id);
  assert.equal(selectRetroBootProfile(0.999999).id, RETRO_BOOT_PROFILES.at(-1)?.id);

  const previousId = RETRO_BOOT_PROFILES[0].id;
  assert.notEqual(selectRetroBootProfile(0, previousId).id, previousId);
  assert.notEqual(selectRetroBootProfile(0.999999, previousId).id, previousId);
});

test("boot text stays within each machine's native line width", () => {
  for (const profile of RETRO_BOOT_PROFILES) {
    const longestLine = Math.max(...profile.boot.flatMap((bootStep) => bootStep.text.split("\n").map((line) => line.length)));
    assert.ok(longestLine <= profile.columns, `${profile.id} emits ${longestLine} columns into ${profile.columns}`);
  }
});
