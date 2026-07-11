import assert from "node:assert/strict";
import test from "node:test";
import {
  mobileKeyboardLikelyOpen,
  mobileViewportShapeChanged,
  type MobileViewportBaseline,
} from "../src/client/src/mobile-viewport";

const portrait: MobileViewportBaseline = { width: 390, height: 844 };

test("mobile viewport shape changes reset the keyboard baseline", () => {
  assert.equal(mobileViewportShapeChanged(portrait, 390), false);
  assert.equal(mobileViewportShapeChanged(portrait, 375), false);
  assert.equal(mobileViewportShapeChanged(portrait, 320), true);
  assert.equal(mobileViewportShapeChanged(portrait, 844), true);
});

test("mobile keyboard detection requires an editable focus target", () => {
  assert.equal(mobileKeyboardLikelyOpen({
    isMobile: true,
    layoutHeight: 844,
    viewportHeight: 520,
    viewportWidth: 390,
    editableFocused: false,
  }, portrait), false);
});

test("mobile keyboard detection handles visual and layout viewport resizing", () => {
  assert.equal(mobileKeyboardLikelyOpen({
    isMobile: true,
    layoutHeight: 844,
    viewportHeight: 520,
    viewportWidth: 390,
    editableFocused: true,
  }, portrait), true);

  assert.equal(mobileKeyboardLikelyOpen({
    isMobile: true,
    layoutHeight: 520,
    viewportHeight: 520,
    viewportWidth: 390,
    editableFocused: true,
  }, portrait), true);
});

test("orientation and responsive resizes are not mistaken for the keyboard", () => {
  assert.equal(mobileKeyboardLikelyOpen({
    isMobile: true,
    layoutHeight: 390,
    viewportHeight: 390,
    viewportWidth: 844,
    editableFocused: true,
  }, portrait), false);

  assert.equal(mobileKeyboardLikelyOpen({
    isMobile: true,
    layoutHeight: 568,
    viewportHeight: 568,
    viewportWidth: 320,
    editableFocused: true,
  }, portrait), false);
});
