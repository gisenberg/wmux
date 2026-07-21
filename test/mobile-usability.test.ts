import assert from "node:assert/strict";
import test from "node:test";
import {
  contextMobileSurfaceMode,
  legacyMobileSurfaceModeStorageKey,
  loadLegacyMobileSurfaceMode,
  loadMobileSurfaceModes,
  mobileSurfaceModesStorageKey,
  pruneMobileSurfaceModes,
  saveMobileSurfaceModes,
} from "../src/client/src/mobile-surface-mode.ts";
import {
  canApplyMobileClipboardRead,
  mobileTerminalArrowSequence,
  mobileTerminalKeySequences,
  oneShotControlSequence,
} from "../src/client/src/mobile-terminal-keys.ts";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
};

test("mobile surfaces default to terminal without agent context and chat with it", () => {
  assert.equal(contextMobileSurfaceMode(false), "terminal");
  assert.equal(contextMobileSurfaceMode(true), "agent");
});

test("mobile surface choices load, save, migrate, and prune per pane", () => {
  const storage = memoryStorage({
    [legacyMobileSurfaceModeStorageKey]: "agent",
    [mobileSurfaceModesStorageKey]: JSON.stringify({ pane1: "terminal", pane2: "agent", invalid: "other" }),
  });
  assert.equal(loadLegacyMobileSurfaceMode(storage), "agent");
  assert.deepEqual(loadMobileSurfaceModes(storage), { pane1: "terminal", pane2: "agent" });
  assert.deepEqual(pruneMobileSurfaceModes(loadMobileSurfaceModes(storage), ["pane2"]), { pane2: "agent" });
  saveMobileSurfaceModes(storage, { pane3: "terminal" });
  assert.equal(storage.values.get(mobileSurfaceModesStorageKey), JSON.stringify({ pane3: "terminal" }));
});

test("mobile terminal keys use exact escape sequences and one-shot control bytes", () => {
  assert.deepEqual(mobileTerminalKeySequences, {
    escape: "\x1b",
    tab: "\t",
  });
  assert.deepEqual(
    (["up", "down", "right", "left"] as const).map((arrow) => [
      mobileTerminalArrowSequence(arrow, false),
      mobileTerminalArrowSequence(arrow, true),
    ]),
    [["\x1b[A", "\x1bOA"], ["\x1b[B", "\x1bOB"], ["\x1b[C", "\x1bOC"], ["\x1b[D", "\x1bOD"]],
  );
  assert.equal(oneShotControlSequence("a"), "\x01");
  assert.equal(oneShotControlSequence("c"), "\x03");
  assert.equal(oneShotControlSequence("D"), "\x04");
  assert.equal(oneShotControlSequence("Z"), "\x1a");
  assert.equal(oneShotControlSequence("ß"), undefined);
  assert.equal(oneShotControlSequence("é"), undefined);
  assert.equal(oneShotControlSequence("@"), undefined);
  assert.equal(oneShotControlSequence("["), undefined);
  assert.equal(oneShotControlSequence("ab"), undefined);
  assert.equal(oneShotControlSequence("1"), undefined);
});

test("mobile clipboard reads apply only to the unchanged active pane", () => {
  const captured = { paneId: "pane-1", inputEpoch: 4 };
  const current = {
    paneId: "pane-1",
    inputEpoch: 4,
    mounted: true,
    active: true,
    visible: true,
    connected: true,
  };
  assert.equal(canApplyMobileClipboardRead(captured, current), true);
  for (const stale of [
    { ...current, paneId: "pane-2" },
    { ...current, inputEpoch: 5 },
    { ...current, mounted: false },
    { ...current, active: false },
    { ...current, visible: false },
    { ...current, connected: false },
  ]) {
    assert.equal(canApplyMobileClipboardRead(captured, stale), false);
  }
});
