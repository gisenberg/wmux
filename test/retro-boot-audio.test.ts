import assert from "node:assert/strict";
import test from "node:test";
import { RETRO_POST_SOUNDS } from "../src/client/src/retro-boot-audio";
import { RETRO_BOOT_PROFILES } from "../src/client/src/retro-boot-profiles";

test("every retro boot profile has a short POST sound", () => {
  const profileIds = RETRO_BOOT_PROFILES.map((profile) => profile.id).sort();
  assert.deepEqual(Object.keys(RETRO_POST_SOUNDS).sort(), profileIds);

  for (const [profileId, tones] of Object.entries(RETRO_POST_SOUNDS)) {
    assert.ok(tones.length > 0, profileId);
    const finishMs = Math.max(...tones.map((postTone) => (postTone.offsetMs ?? 0) + postTone.durationMs));
    assert.ok(finishMs <= 1_000, `${profileId} cue lasts ${finishMs}ms`);
    for (const postTone of tones) {
      assert.ok(postTone.frequency >= 100 && postTone.frequency <= 4_000, profileId);
      assert.ok((postTone.volume ?? 0.025) <= 0.04, profileId);
    }
  }
});
