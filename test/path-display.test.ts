import assert from "node:assert/strict";
import { test } from "node:test";
import { compactMiddlePath, normalizeUserPath } from "../src/client/src/path-display.ts";

test("normalizeUserPath collapses common user home directories", () => {
  assert.equal(normalizeUserPath("/home/operator/git/wmux"), "~/git/wmux");
  assert.equal(normalizeUserPath("/Users/operator/git/wmux"), "~/git/wmux");
  assert.equal(normalizeUserPath("C:\\Users\\operator\\git\\wmux"), "~/git/wmux");
  assert.equal(normalizeUserPath("/var/tmp/wmux"), "/var/tmp/wmux");
});

test("compactMiddlePath preserves the front and tail of long paths", () => {
  const compact = compactMiddlePath("~/git/operator/wmux/ef3", 16);
  assert.equal(compact.text, "~/git/oper../ef3");
  assert.equal(compact.prefix, "~/git/oper");
  assert.equal(compact.marker, "..");
  assert.equal(compact.suffix, "/ef3");
});

test("compactMiddlePath leaves short paths unchanged", () => {
  const compact = compactMiddlePath("~/wmux", 24);
  assert.equal(compact.text, "~/wmux");
  assert.equal(compact.compacted, false);
});
