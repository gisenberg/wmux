import assert from "node:assert/strict";
import test from "node:test";
import { RETRO_BOOT_ARTWORK } from "../src/client/src/RetroBootArtwork";
import { fitRetroFramebuffer, retroFramebufferStyle } from "../src/client/src/retro-framebuffer";
import { RETRO_BOOT_PROFILES } from "../src/client/src/retro-boot-profiles";

const ASSET_PROFILE_IDS = [
  "amiga-workbench",
  "amiga-guru-meditation",
  "msx2",
  "nextcube",
];

const GRAPHICAL_SHELL_PROFILE_IDS = [
  "acorn-archimedes",
  "atari-st",
  "apple-lisa",
  "sgi-irix",
  "nextcube",
  "os2-warp",
];

const TERMINAL_ARTWORK_PROFILE_IDS = ["amiga-workbench", "amiga-guru-meditation", "msx2"];

test("every retro boot profile has an image placeholder", () => {
  assert.deepEqual(
    Object.keys(RETRO_BOOT_ARTWORK).sort(),
    RETRO_BOOT_PROFILES.map((profile) => profile.id).sort(),
  );
  for (const [profileId, artwork] of Object.entries(RETRO_BOOT_ARTWORK)) {
    assert.ok(artwork.label.length > 0, profileId);
    assert.ok(artwork.framebuffer[0] > 0, `${profileId} framebuffer width`);
    assert.ok(artwork.framebuffer[1] > 0, `${profileId} framebuffer height`);
  }
  assert.equal(Object.values(RETRO_BOOT_ARTWORK).filter((artwork) => artwork.asset).length, 4);
  assert.equal(RETRO_BOOT_ARTWORK["commodore-64"].asset, undefined);
  assert.equal(RETRO_BOOT_ARTWORK["bbc-micro"].asset, undefined);
  assert.deepEqual(RETRO_BOOT_ARTWORK["commodore-64"].framebuffer, [320, 200]);
  assert.deepEqual(RETRO_BOOT_ARTWORK["ibm-pc-at"].framebuffer, [720, 400]);
  assert.deepEqual(RETRO_BOOT_ARTWORK["bbc-micro"].framebuffer, [320, 256]);
  assert.deepEqual(RETRO_BOOT_ARTWORK.msx2.framebuffer, [256, 212]);
  assert.deepEqual(RETRO_BOOT_ARTWORK["amiga-workbench"].framebuffer, [640, 400]);
  assert.equal(RETRO_BOOT_ARTWORK["amiga-workbench"].fullFrame, true);
  assert.deepEqual(RETRO_BOOT_ARTWORK["amiga-guru-meditation"].framebuffer, [640, 400]);
  assert.deepEqual(RETRO_BOOT_ARTWORK["commodore-vic-20"].framebuffer, [176, 184]);
  assert.equal(RETRO_BOOT_PROFILES.find((profile) => profile.id === "commodore-64")?.showBootArtwork, false);
});

test("GUI systems stay graphical while native command consoles may use boot artwork", () => {
  const graphicalShells = RETRO_BOOT_PROFILES.filter((profile) => profile.graphicalShell).map((profile) => profile.id);
  const terminalArtworkBoots = RETRO_BOOT_PROFILES.filter(
    (profile) => !profile.graphicalShell && profile.showBootArtwork !== false,
  ).map((profile) => profile.id);
  const artworkAssets = Object.entries(RETRO_BOOT_ARTWORK)
    .filter(([, artwork]) => artwork.asset)
    .map(([profileId]) => profileId);
  assert.deepEqual(graphicalShells, GRAPHICAL_SHELL_PROFILE_IDS);
  assert.deepEqual(terminalArtworkBoots, TERMINAL_ARTWORK_PROFILE_IDS);
  assert.deepEqual(artworkAssets, ASSET_PROFILE_IDS);
});

test("framebuffer styles use each profile's displayed picture shape", () => {
  assert.deepEqual(retroFramebufferStyle("commodore-64"), { "--retro-framebuffer-aspect": "320 / 200" });
  // RISC OS 640x256 modes have double-height pixels, and 80-column text fills a 4:3 monitor.
  assert.deepEqual(retroFramebufferStyle("acorn-archimedes"), { "--retro-framebuffer-aspect": "5 / 4" });
  for (const profileId of ["ibm-pc-at", "trs-80-model-4", "vax-vms", "pdp-11-rt11", "amstrad-pcw", "amiga-workbench", "apple-lisa"]) {
    assert.deepEqual(retroFramebufferStyle(profileId), { "--retro-framebuffer-aspect": "4 / 3" }, profileId);
  }
  for (const [profileId, artwork] of Object.entries(RETRO_BOOT_ARTWORK)) {
    const [width, height] = artwork.displayAspect ?? artwork.framebuffer;
    assert.ok(width / height >= 0.9 && width / height <= 1.7, `${profileId} displays at ${width}:${height}`);
  }
});

test("framebuffer fitting preserves aspect ratio under both width and height constraints", () => {
  assert.deepEqual(fitRetroFramebuffer([320, 200], 1176, 696), { width: 920, height: 575 });
  assert.deepEqual(fitRetroFramebuffer([320, 200], 390, 844), { width: 390, height: 243.75 });
  assert.deepEqual(fitRetroFramebuffer([800, 240], 740, 286), { width: 740, height: 222 });
  const portrait = fitRetroFramebuffer([176, 184], 1176, 696);
  assert.equal(portrait.height, 696);
  assert.ok(Math.abs(portrait.width / portrait.height - 176 / 184) < 0.000_001);
});
