import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalColorResponse,
  isTerminalProtocolResponse,
} from "../src/shared/terminal-protocol.js";

test("terminal protocol replies are distinguished from keyboard input", () => {
  assert.equal(isTerminalProtocolResponse("\x1b[?62;22c"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[>1;2;3c"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[0n"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[24;80R"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[?62;22c\x1b[?62;22c"), true);
  assert.equal(isTerminalProtocolResponse("\x1bP>|libghostty\x1b\\"), true);
  assert.equal(isTerminalProtocolResponse("\x1bP>|libghostty 0.1.0-dev\x1b\\"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[>1;0;0c\x1bP>|libghostty 0.1.0-dev\x1b\\"), true);
  assert.equal(isTerminalProtocolResponse("\x1b]10;rgb:c0c0/caca/f5f5\x1b\\"), true);
  assert.equal(isTerminalProtocolResponse("\x1b]11;rgb:1a/1b/26\x07"), true);
  assert.equal(isTerminalProtocolResponse("\x1b]4;0;rgb:1515/1616/1e1e\x1b\\"), true);
  assert.equal(isTerminalProtocolResponse("\x1b]4;0;rgb:1515/1616/1e1e;1;rgb:f7f7/7676/8e8e\x07"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[>1;0;0c\x1b]10;rgb:c0c0/caca/f5f5\x1b\\"), true);
  assert.equal(isTerminalProtocolResponse("\x1b[A"), false);
  assert.equal(isTerminalProtocolResponse("\x1bf"), false);
  assert.equal(isTerminalProtocolResponse("\x1bP>|other-terminal 1.0\x1b\\"), false);
  assert.equal(isTerminalProtocolResponse("\x1bP>|libghostty 0.1.0-dev"), false);
  assert.equal(isTerminalProtocolResponse(`\x1bP>|libghostty ${"x".repeat(65)}\x1b\\`), false);
  assert.equal(isTerminalProtocolResponse("\x1b]10;?\x07"), false);
  assert.equal(isTerminalProtocolResponse("\x1b]12;rgb:ffff/ffff/ffff\x07"), false);
  assert.equal(isTerminalProtocolResponse("\x1b]4;0;rgb:ffff/ffff/ffff"), false);
  assert.equal(isTerminalProtocolResponse(`\x1b]4;0;rgb:ffff/ffff/ffff;${"1;rgb:ffff/ffff/ffff;".repeat(500)}2;rgb:ffff/ffff/ffff\x07`), false);
  assert.equal(isTerminalProtocolResponse("text"), false);
});

test("terminal color replies are identifiable for server-owned query handling", () => {
  assert.equal(isTerminalColorResponse("\x1b]10;rgb:c0c0/caca/f5f5\x1b\\"), true);
  assert.equal(isTerminalColorResponse("\x1b]11;rgb:1a/1b/26\x07"), true);
  assert.equal(isTerminalColorResponse("\x1b]4;0;rgb:1515/1616/1e1e;1;rgb:f7f7/7676/8e8e\x07"), true);
  assert.equal(isTerminalColorResponse("\x1b[>1;0;0c\x1b]10;rgb:c0c0/caca/f5f5\x1b\\"), false);
  assert.equal(isTerminalColorResponse("\x1b]10;?\x07"), false);
});
