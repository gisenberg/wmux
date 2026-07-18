import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileKeybindings,
  defaultKeybindings,
  displayBindingForAction,
  eventMatchesAction,
  parseKeyChord,
  resolveKeybindings,
  KEYBINDING_ACTIONS,
} from "../src/shared/keybindings.js";

const keyboardEvent = (overrides: Partial<{
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}> = {}) => ({
  code: "KeyK",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...overrides,
});

test("keybinding overrides replace only named actions", () => {
  const resolved = resolveKeybindings({
    "commandPalette.open": ["Ctrl+Shift+KeyP"],
    "sidebar.toggle": [],
  });
  assert.deepEqual(resolved["commandPalette.open"], ["Ctrl+Shift+KeyP"]);
  assert.deepEqual(resolved["sidebar.toggle"], []);
  assert.deepEqual(resolved["workspace.new"], defaultKeybindings["workspace.new"]);
  assert.notEqual(resolved["workspace.new"], defaultKeybindings["workspace.new"]);
});

test("the default map covers every configurable action", () => {
  assert.deepEqual(Object.keys(defaultKeybindings).sort(), [...KEYBINDING_ACTIONS].sort());
});

test("missing and empty keybinding sections preserve every default", () => {
  assert.deepEqual(resolveKeybindings(), defaultKeybindings);
  assert.deepEqual(resolveKeybindings({}), defaultKeybindings);
});

test("key chords match exact modifiers and resolve Primary by platform", () => {
  const bindings = resolveKeybindings({ "commandPalette.open": ["Primary+KeyK"] });
  const compiled = compileKeybindings(bindings);
  assert.equal(eventMatchesAction(keyboardEvent({ ctrlKey: true }), compiled, "commandPalette.open", false), true);
  assert.equal(eventMatchesAction(keyboardEvent({ metaKey: true }), compiled, "commandPalette.open", true), true);
  assert.equal(eventMatchesAction(keyboardEvent({ ctrlKey: true, shiftKey: true }), compiled, "commandPalette.open", false), false);
  assert.equal(eventMatchesAction(keyboardEvent({ metaKey: true }), compiled, "commandPalette.open", false), false);
});

test("replacing the command palette binding releases Ctrl+K", () => {
  const bindings = compileKeybindings(resolveKeybindings({
    "commandPalette.open": ["Ctrl+Shift+KeyP"],
  }));
  assert.equal(eventMatchesAction(keyboardEvent({ ctrlKey: true }), bindings, "commandPalette.open", false), false);
  assert.equal(eventMatchesAction(
    keyboardEvent({ code: "KeyP", ctrlKey: true, shiftKey: true }),
    bindings,
    "commandPalette.open",
    false,
  ), true);
});

test("key chord parser rejects ambiguous and malformed chords", () => {
  assert.throws(() => parseKeyChord("Ctrl+K"), /unknown key code/);
  assert.throws(() => parseKeyChord("Ctrl+Ctrl+KeyK"), /duplicate modifier/);
  assert.throws(() => parseKeyChord("Primary+Ctrl+KeyK"), /cannot be combined/);
  assert.throws(() => parseKeyChord("Hyper+KeyK"), /unknown modifier/);
});

test("display labels prefer the platform-conventional current default", () => {
  assert.equal(displayBindingForAction(defaultKeybindings, "commandPalette.open", true), "Cmd+K");
  assert.equal(displayBindingForAction(defaultKeybindings, "commandPalette.open", false), "Ctrl+K");
  assert.equal(displayBindingForAction(defaultKeybindings, "settings.open", false), undefined);
});
