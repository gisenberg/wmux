import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseRetroBootProfileHistory,
  RETRO_BOOT_PROFILES,
  selectRetroBootProfile,
  updateRetroBootProfileHistory,
} from "../src/client/src/retro-boot-profiles";

const profileById = (profileId: string) => {
  const profile = RETRO_BOOT_PROFILES.find((candidate) => candidate.id === profileId);
  assert.ok(profile, profileId);
  return profile;
};

test("retro boot profiles cover the requested computer families", () => {
  const ids = new Set(RETRO_BOOT_PROFILES.map((profile) => profile.id));
  assert.deepEqual(
    [
      "acorn-archimedes",
      "amiga-guru-meditation",
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
      "memotech-mtx",
      "msx2",
      "nec-pc-9801",
      "nextcube",
      "oric-atmos",
      "os2-warp",
      "osborne-1",
      "pdp-11-rt11",
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

test("Commodore startup banners are centered in their 40-column display", () => {
  for (const profileId of ["commodore-64", "commodore-128"]) {
    const profile = RETRO_BOOT_PROFILES.find((candidate) => candidate.id === profileId);
    assert.ok(profile);
    const bannerSteps = profileId === "commodore-64" ? profile.boot.slice(0, 2) : profile.boot.slice(0, 4);
    for (const bootStep of bannerSteps) {
      const line = bootStep.text.split("\n")[0];
      const content = line.trimStart();
      assert.equal(line.length - content.length, Math.floor((profile.columns - content.length) / 2), `${profileId}: ${content}`);
    }
  }
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

test("profile selection is deterministic, excludes recent profiles, and honors weights", () => {
  assert.equal(selectRetroBootProfile(0).id, RETRO_BOOT_PROFILES[0].id);
  assert.equal(selectRetroBootProfile(0.999999).id, RETRO_BOOT_PROFILES.at(-1)?.id);

  const previousIds = RETRO_BOOT_PROFILES.slice(0, 5).map((profile) => profile.id);
  assert.ok(!previousIds.includes(selectRetroBootProfile(0, previousIds).id));
  assert.ok(!previousIds.includes(selectRetroBootProfile(0.999999, previousIds).id));
  assert.equal(
    selectRetroBootProfile(0, RETRO_BOOT_PROFILES.map((profile) => profile.id)).id,
    RETRO_BOOT_PROFILES[0].id,
  );

  const guruIndex = RETRO_BOOT_PROFILES.findIndex((profile) => profile.id === "amiga-guru-meditation");
  const guru = RETRO_BOOT_PROFILES[guruIndex];
  assert.ok(guru);
  const guruWeight = guru.weight ?? 1;
  assert.equal(guruWeight, 0.25);
  const totalWeight = RETRO_BOOT_PROFILES.reduce((total, profile) => total + (profile.weight ?? 1), 0);
  const weightBeforeGuru = RETRO_BOOT_PROFILES.slice(0, guruIndex).reduce(
    (total, profile) => total + (profile.weight ?? 1),
    0,
  );
  assert.equal(selectRetroBootProfile((weightBeforeGuru + guruWeight / 2) / totalWeight).id, guru.id);
  assert.notEqual(selectRetroBootProfile((weightBeforeGuru + guruWeight + 0.01) / totalWeight).id, guru.id);
});

test("retro profile history migrates the legacy id and retains five unique choices", () => {
  assert.deepEqual(parseRetroBootProfileHistory("commodore-64"), ["commodore-64"]);
  assert.deepEqual(
    parseRetroBootProfileHistory('["zx-spectrum","commodore-64","zx-spectrum","bbc-micro","msx2","apple-iie","nextcube"]'),
    ["zx-spectrum", "commodore-64", "bbc-micro", "msx2", "apple-iie"],
  );
  assert.deepEqual(
    updateRetroBootProfileHistory(["zx-spectrum", "commodore-64", "bbc-micro", "msx2", "apple-iie"], "nextcube"),
    ["nextcube", "zx-spectrum", "commodore-64", "bbc-micro", "msx2"],
  );
  assert.deepEqual(updateRetroBootProfileHistory(["zx-spectrum", "commodore-64"], "commodore-64"), [
    "commodore-64",
    "zx-spectrum",
  ]);
});

test("historical boot details match the machines and operating-system eras", () => {
  assert.match(profileById("commodore-64").boot.map((bootStep) => bootStep.text).join(""), /624 BLOCKS FREE/);
  assert.match(profileById("commodore-128").boot.map((bootStep) => bootStep.text).join(""), /\(C\)1985 COMMODORE/);
  assert.deepEqual(profileById("commodore-128").colors, {
    page: "#b0e0b8",
    border: "#b0e0b8",
    background: "#5a5a5a",
    foreground: "#b0e0b8",
  });
  assert.equal(profileById("trs-80-model-4").columns, 80);
  assert.match(profileById("trs-80-model-4").boot.map((bootStep) => bootStep.text).join(""), /TRSDOS Ready/);
  assert.match(profileById("bbc-micro").boot.map((bootStep) => bootStep.text).join(""), /Option 0 \(off\)/);
  assert.match(profileById("msx2").boot.map((bootStep) => bootStep.text).join(""), /version 2\.0[\s\S]*23430 Bytes free/);
  assert.equal(profileById("sgi-irix").name, "SGI Indigo2 IRIX");
  assert.match(profileById("pdp-11-rt11").boot.map((bootStep) => bootStep.text).join(""), /MACHIN\.DAT[\s\S]*SESSON\.DAT/);
  assert.match(profileById("vax-vms").auth.granted, /version V5\.5-2/);
  assert.match(profileById("sun-sparcstation").auth.granted, /PDT 1998/);
  assert.match(profileById("ti-99-4a").boot.map((bootStep) => bootStep.text).join(""), /©1981[\s\S]*PRESS:/);
  assert.match(
    profileById("trs-80-coco").boot.map((bootStep) => bootStep.text).join(""),
    /COPR\. 1982 BY TANDY[\s\S]*UNDER LICENSE FROM MICROSOFT[\s\S]*CLOADM"WMUX"[\s\S]*EXEC/,
  );
  assert.match(
    profileById("amstrad-cpc").boot.map((bootStep) => bootStep.text).join(""),
    /Amstrad 64K Microcomputer  \(v1\)[\s\S]*Locomotive Software/,
  );
  for (const profileId of ["amiga-workbench", "amiga-guru-meditation"]) {
    const profile = profileById(profileId);
    assert.equal(profile.colors.background, "#0055aa");
    assert.equal(profile.colors.foreground, "#ffffff");
    assert.match(profile.boot.map((bootStep) => bootStep.text).join(""), /New Shell process 1[\s\S]*1\.SYS:>/);
  }
});

test("lower-confidence profiles use the verified native interpreter and prompt conventions", () => {
  assert.match(profileById("sam-coupe").boot.map((bootStep) => bootStep.text).join(""), /SAM BASIC[\s\S]*MILES GORDON/);
  const memotechCommand = profileById("memotech-mtx").boot.find((bootStep) => bootStep.typedFrom !== undefined);
  assert.equal(memotechCommand?.text, 'RUN "WMUX"\n');
  assert.match(profileById("tatung-einstein").boot.map((bootStep) => bootStep.text).join(""), /XTAL DOS SYSTEM DISC/);
  const sharpCommands = profileById("sharp-x68000").boot.filter((bootStep) => bootStep.typedFrom !== undefined);
  assert.ok(sharpCommands.every((bootStep) => bootStep.text.startsWith("A>")));
});

test("tape boots declare both border phases and styles honor reduced motion", () => {
  for (const profileId of ["zx-spectrum"]) {
    const phases = new Set(profileById(profileId).boot.map((bootStep) => bootStep.tapeBorder).filter(Boolean));
    assert.deepEqual([...phases].sort(), ["data", "header"], profileId);
  }
  for (const profileId of ["amstrad-cpc", "oric-atmos"]) {
    assert.ok(profileById(profileId).boot.every((step) => !step.tapeBorder));
  }
  const styles = readFileSync(new URL("../src/client/src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.retro-boot-framebuffer::after/);
  assert.doesNotMatch(styles, /\.retro-graphical-framebuffer::after/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*retro-tape-border-header/);
  assert.match(styles, /background-position: 0 -24px/);
});

test("POST counts in place, then beeps, and MODE 7 uses teletext geometry", () => {
  const pc = profileById("ibm-pc-at");
  const counts = pc.boot.filter((step) => step.overwrite);
  assert.equal(counts.length, 17);
  assert.equal(counts[0].text, "000000 KB OK");
  assert.equal(counts.at(-1)?.text, "016384 KB OK");
  assert.ok(counts.every((step) => !step.text.includes("\n")));
  assert.ok(pc.boot.indexOf(pc.boot.find((step) => step.postSound)!) > pc.boot.indexOf(counts.at(-1)!));
  const bbc = profileById("bbc-micro");
  assert.equal(bbc.rows, 25);
  assert.equal(bbc.columns, 40);
  assert.match(bbc.fontFamily, /SAA 5050/);
});

test("Spectrum uses bottom-line keyword entry and both tape blocks with a gap", () => {
  const spectrum = profileById("zx-spectrum");
  assert.equal(spectrum.boot[0].position?.row, 23);
  assert.equal(spectrum.boot[1].typedFrom, 5);
  assert.equal(spectrum.boot[1].clear, true);
  assert.deepEqual(spectrum.boot.slice(2, 7).map((step) => step.tapeBorder), ["header", "data", undefined, "header", "data"]);
  assert.ok(spectrum.boot.every((step) => !step.text.includes("Bytes:")));
  for (const profile of RETRO_BOOT_PROFILES) {
    for (const step of profile.boot) {
      if (!step.position) continue;
      assert.ok(step.position.row >= 1 && step.position.row <= profile.rows, profile.id);
      assert.ok(step.position.column >= 1 && step.position.column <= profile.columns, profile.id);
    }
  }
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
