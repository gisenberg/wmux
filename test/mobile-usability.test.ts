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
import { mobileTerminalKeySequences, oneShotControlSequence } from "../src/client/src/mobile-terminal-keys.ts";

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
    arrowUp: "\x1b[A",
    arrowDown: "\x1b[B",
    arrowRight: "\x1b[C",
    arrowLeft: "\x1b[D",
  });
  assert.equal(oneShotControlSequence("c"), "\x03");
  assert.equal(oneShotControlSequence("D"), "\x04");
  assert.equal(oneShotControlSequence("["), "\x1b");
  assert.equal(oneShotControlSequence("ab"), undefined);
  assert.equal(oneShotControlSequence("1"), undefined);
});
