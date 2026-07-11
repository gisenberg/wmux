import assert from "node:assert/strict";
import test from "node:test";
import { RETRO_BOOT_ARTWORK } from "../src/client/src/RetroBootArtwork";
import { RETRO_BOOT_PROFILES } from "../src/client/src/retro-boot-profiles";

const ASSET_PROFILE_IDS = [
  "amiga-workbench",
  "msx2",
  "sgi-irix",
  "nextcube",
  "macintosh-system-6",
  "pico-8",
];

const GRAPHICAL_SHELL_PROFILE_IDS = [
  "acorn-archimedes",
  "atari-st",
  "apple-lisa",
  "sgi-irix",
  "nextcube",
  "macintosh-system-6",
  "os2-warp",
];

const TERMINAL_ARTWORK_PROFILE_IDS = ["amiga-workbench", "msx2", "pico-8"];

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
  assert.equal(Object.values(RETRO_BOOT_ARTWORK).filter((artwork) => artwork.asset).length, 6);
  assert.equal(RETRO_BOOT_ARTWORK["commodore-64"].asset, undefined);
  assert.equal(RETRO_BOOT_ARTWORK["bbc-micro"].asset, undefined);
  assert.deepEqual(RETRO_BOOT_ARTWORK["commodore-64"].framebuffer, [320, 200]);
  assert.deepEqual(RETRO_BOOT_ARTWORK["ibm-pc-at"].framebuffer, [720, 400]);
  assert.deepEqual(RETRO_BOOT_ARTWORK["bbc-micro"].framebuffer, [320, 256]);
  assert.deepEqual(RETRO_BOOT_ARTWORK.msx2.framebuffer, [256, 212]);
  assert.deepEqual(RETRO_BOOT_ARTWORK["amiga-workbench"].framebuffer, [640, 400]);
  assert.equal(RETRO_BOOT_ARTWORK["amiga-workbench"].fullFrame, true);
  assert.deepEqual(RETRO_BOOT_ARTWORK["macintosh-system-6"].framebuffer, [512, 342]);
  assert.equal(RETRO_BOOT_ARTWORK["macintosh-system-6"].fullFrame, true);
  assert.deepEqual(RETRO_BOOT_ARTWORK["commodore-vic-20"].framebuffer, [176, 184]);
  assert.deepEqual(RETRO_BOOT_ARTWORK["pico-8"].framebuffer, [128, 128]);
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
