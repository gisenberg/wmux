import assert from "node:assert/strict";
import test from "node:test";
import { RETRO_BOOT_ARTWORK } from "../src/client/src/RetroBootArtwork";
import { RETRO_BOOT_PROFILES } from "../src/client/src/retro-boot-profiles";

test("every retro boot profile has an image placeholder", () => {
  assert.deepEqual(
    Object.keys(RETRO_BOOT_ARTWORK).sort(),
    RETRO_BOOT_PROFILES.map((profile) => profile.id).sort(),
  );
  for (const [profileId, artwork] of Object.entries(RETRO_BOOT_ARTWORK)) {
    assert.ok(artwork.label.length > 0, profileId);
  }
  assert.equal(Object.values(RETRO_BOOT_ARTWORK).filter((artwork) => artwork.asset).length, 21);
  assert.equal(RETRO_BOOT_ARTWORK["bbc-micro"].asset, undefined);
});
