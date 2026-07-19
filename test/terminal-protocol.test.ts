import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalProtocolResponse } from "../src/shared/terminal-protocol.js";

test("terminal protocol replies are distinguished from keyboard input", () => {
  assert.equal(isTerminalProtocolResponse("\x1b[?62;22c"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[>1;2;3c"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[0n"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[24;80R"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[?62;22c\x1b[?62;22c"), true);
  assert.equal(isTerminalProtocolResponse("\x1bP>|libghostty\x1b\\"), true);
  assert.equal(isTerminalProtocolResponse("\x1bP>|libghostty 0.1.0-dev\x1b\\"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[>1;0;0c\x1bP>|libghostty 0.1.0-dev\x1b\\"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[A"), false);
  assert.equal(isTerminalProtocolResponse("\x1bf"), false);
  assert.equal(isTerminalProtocolResponse("\x1bP>|other-terminal 1.0\x1b\\"), false);
  assert.equal(isTerminalProtocolResponse("\x1bP>|libghostty 0.1.0-dev"), false);
  assert.equal(isTerminalProtocolResponse(`\x1bP>|libghostty ${"x".repeat(65)}\x1b\\`), false);
  assert.equal(isTerminalProtocolResponse("text"), false);
});
