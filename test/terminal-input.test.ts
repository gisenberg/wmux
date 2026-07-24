import assert from "node:assert/strict";
import test from "node:test";
import {
  configureTerminalInput,
  isBareShiftEnter,
  type TerminalKeyModifiers,
} from "../src/client/src/terminal-input.js";

const keyEvent = (overrides: Partial<TerminalKeyModifiers> = {}): TerminalKeyModifiers => ({
  key: "Enter",
  shiftKey: true,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});

test("bare Shift+Enter is recognized as terminal newline input", () => {
  assert.equal(isBareShiftEnter(keyEvent()), true);
});

test("Shift+Enter matching rejects other keys and additional modifiers", () => {
  assert.equal(isBareShiftEnter(keyEvent({ key: "a" })), false);
  assert.equal(isBareShiftEnter(keyEvent({ shiftKey: false })), false);
  assert.equal(isBareShiftEnter(keyEvent({ ctrlKey: true })), false);
  assert.equal(isBareShiftEnter(keyEvent({ altKey: true })), false);
  assert.equal(isBareShiftEnter(keyEvent({ metaKey: true })), false);
});

test("terminal input disables browser writing assistance", () => {
  const attributes = new Map<string, string>();
  configureTerminalInput({
    textarea: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    },
  } as never);
  assert.equal(attributes.get("autocomplete"), "off");
  assert.equal(attributes.get("autocorrect"), "off");
  assert.equal(attributes.get("autocapitalize"), "off");
  assert.equal(attributes.get("spellcheck"), "false");
});
