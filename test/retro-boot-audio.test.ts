import assert from "node:assert/strict";
import test from "node:test";
import { RETRO_POST_SOUNDS } from "../src/client/src/retro-boot-audio";
import { RETRO_BOOT_PROFILES } from "../src/client/src/retro-boot-profiles";

test("only explicitly supported approximations have short boot sounds", () => {
  const profileIds = RETRO_BOOT_PROFILES.map((profile) => profile.id);
  assert.deepEqual(Object.keys(RETRO_POST_SOUNDS).sort(), ["amiga-workbench", "apple-iie", "ibm-pc-at"]);

  for (const [profileId, tones] of Object.entries(RETRO_POST_SOUNDS)) {
    assert.ok(profileIds.includes(profileId));
    assert.ok(tones);
    assert.ok(tones.length > 0, profileId);
    const finishMs = Math.max(...tones.map((postTone) => (postTone.offsetMs ?? 0) + postTone.durationMs));
    assert.ok(finishMs <= 1_000, `${profileId} cue lasts ${finishMs}ms`);
    for (const postTone of tones) {
      assert.ok(postTone.frequency >= 100 && postTone.frequency <= 4_000, profileId);
      assert.ok((postTone.volume ?? 0.025) <= 0.04, profileId);
    }
  }
});

test("recognizable POST cues use the machine-specific tone shape", () => {
  assert.deepEqual(RETRO_POST_SOUNDS["apple-iie"], [
    { frequency: 1000, durationMs: 100, offsetMs: 0, type: "square" },
  ]);
  assert.equal(RETRO_POST_SOUNDS["atari-st"], undefined);
  assert.equal(RETRO_POST_SOUNDS["amiga-guru-meditation"], undefined);
  assert.equal(RETRO_POST_SOUNDS["amiga-workbench"]?.length, 3);
  assert.ok(
    RETRO_POST_SOUNDS["amiga-workbench"]?.every(
      (postTone) => postTone.filterFrequency === 520 && postTone.volume === 0.012,
    ),
  );
});
