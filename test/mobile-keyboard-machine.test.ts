import assert from "node:assert/strict";
import test from "node:test";
import {
  mobileInteractionTransitions,
  presentMobileInteraction,
  transitionMobileInteraction,
  type MobileInteractionEvent,
  type MobileInteractionState,
} from "../src/client/src/mobile/keyboard-machine.ts";

const walk = (
  initial: MobileInteractionState,
  events: MobileInteractionEvent[],
): MobileInteractionState[] => {
  const states = [initial];
  for (const event of events) states.push(transitionMobileInteraction(states.at(-1)!, event));
  return states;
};

test("every mobile interaction state has a declarative transition table", () => {
  assert.deepEqual(Object.keys(mobileInteractionTransitions), [
    "keyboard-closed",
    "keyboard-opening",
    "keyboard-open-chrome-collapsed",
    "keyboard-closing-anchor-restore",
    "drawer-open",
    "drawer-closing-focus-return",
  ]);
});

test("composer focus enters keyboard opening without an artificial delay", () => {
  assert.deepEqual(walk("keyboard-closed", [
    "editable-focused",
    "viewport-keyboard-opened",
  ]), [
    "keyboard-closed",
    "keyboard-opening",
    "keyboard-open-chrome-collapsed",
  ]);
  assert.equal(presentMobileInteraction("keyboard-opening").chromeCollapsed, true);
  assert.equal(presentMobileInteraction("keyboard-open-chrome-collapsed").chromeCollapsed, true);
});

test("keyboard close preserves collapsed chrome until its anchor is restored", () => {
  assert.deepEqual(walk("keyboard-open-chrome-collapsed", [
    "viewport-keyboard-closed",
    "keyboard-anchor-restored",
  ]), [
    "keyboard-open-chrome-collapsed",
    "keyboard-closing-anchor-restore",
    "keyboard-closed",
  ]);
  const closing = presentMobileInteraction("keyboard-closing-anchor-restore");
  assert.equal(closing.chromeCollapsed, true);
  assert.equal(closing.restoreKeyboardAnchor, true);
});

test("drawer close restores focus before returning to the closed state", () => {
  assert.deepEqual(walk("keyboard-closed", [
    "drawer-opened",
    "drawer-closed",
    "drawer-focus-restored",
  ]), [
    "keyboard-closed",
    "drawer-open",
    "drawer-closing-focus-return",
    "keyboard-closed",
  ]);
  assert.equal(presentMobileInteraction("drawer-open").drawerOpen, true);
  assert.equal(presentMobileInteraction("drawer-closing-focus-return").restoreDrawerFocus, true);
});

test("interrupted keyboard and drawer transitions remain deterministic", () => {
  assert.equal(
    transitionMobileInteraction("keyboard-closing-anchor-restore", "viewport-keyboard-opened"),
    "keyboard-open-chrome-collapsed",
  );
  assert.equal(
    transitionMobileInteraction("drawer-closing-focus-return", "drawer-opened"),
    "drawer-open",
  );
  assert.equal(transitionMobileInteraction("drawer-open", "reset"), "keyboard-closed");
});
