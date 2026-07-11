import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RETRO_BOOT_PROFILES, selectRetroBootProfile } from "../src/client/src/retro-boot-profiles";

test("retro boot profiles cover the requested computer families", () => {
  const ids = new Set(RETRO_BOOT_PROFILES.map((profile) => profile.id));
  assert.deepEqual(
    [
      "acorn-archimedes",
      "amiga-workbench",
      "amstrad-cpc",
      "amstrad-pcw",
      "apple-iie",
      "apple-lisa",
      "atari-8-bit",
      "atari-st",
      "bbc-micro",
      "commodore-128",
      "commodore-64",
      "commodore-pet",
      "commodore-vic-20",
      "enterprise-128",
      "ibm-pc-at",
      "ibm-3270-mvs",
      "macintosh-system-6",
      "memotech-mtx",
      "msx2",
      "nec-pc-9801",
      "nextcube",
      "oric-atmos",
      "os2-warp",
      "osborne-1",
      "pdp-11-rt11",
      "pico-8",
      "sam-coupe",
      "sharp-x68000",
      "sgi-irix",
      "sinclair-ql",
      "sun-sparcstation",
      "tatung-einstein",
      "ti-99-4a",
      "trs-80-coco",
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

test("every configured retro font family has a matching local font-face", () => {
  const styles = readFileSync(new URL("../src/client/src/styles.css", import.meta.url), "utf8");
  for (const profile of RETRO_BOOT_PROFILES) {
    const family = profile.fontFamily.match(/^"([^"]+)"/)?.[1];
    assert.ok(family, `${profile.id} has a primary font family`);
    assert.match(styles, new RegExp(`font-family:\\s*"${family}"`), `${profile.id} declares ${family}`);
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

test("terminal command steps identify their prompt boundary for typing animation", () => {
  const typedSteps = RETRO_BOOT_PROFILES.flatMap((profile) =>
    profile.boot.filter((bootStep) => bootStep.typedFrom !== undefined).map((bootStep) => [profile.id, bootStep] as const),
  );
  assert.ok(typedSteps.length >= 35);
  for (const [profileId, bootStep] of typedSteps) {
    assert.ok(bootStep.typedFrom! >= 0 && bootStep.typedFrom! < bootStep.text.length, profileId);
    assert.ok(bootStep.text.endsWith("\n"), profileId);
  }
  assert.ok(
    RETRO_BOOT_PROFILES.find((profile) => profile.id === "atari-8-bit")?.boot.some(
      (bootStep) => bootStep.typedFrom === 0 && bootStep.text.includes('RUN "D:WMUX.BAS"'),
    ),
  );
  assert.ok(
    RETRO_BOOT_PROFILES.find((profile) => profile.id === "ibm-pc-at")?.boot.some(
      (bootStep) => bootStep.text === "C:\\>WMUX\n" && bootStep.typedFrom === 4,
    ),
  );
});
