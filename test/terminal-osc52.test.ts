import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_OSC52_DECODED_BYTES,
  Osc52ClipboardController,
  Osc52Parser,
} from "../src/client/src/terminal-osc52.ts";

const osc = (body: string, terminator = "\x07") => `\x1b]52;${body}${terminator}`;
const collect = (chunks: string[]) => {
  const parser = new Osc52Parser();
  return chunks.reduce(
    (result, chunk) => {
      const next = parser.push(chunk);
      return { text: result.text + next.text, writes: [...result.writes, ...next.writes.map((write) => write.text)] };
    },
    { text: "", writes: [] as string[] },
  );
};

test("OSC 52 accepts canonical clipboard and tmux default writes with BEL and ST across every boundary", () => {
  for (const selection of ["c", ""]) {
    for (const terminator of ["\x07", "\x1b\\"]) {
      const sequence = `before${osc(`${selection};aGVsbG8=`, terminator)}after`;
      for (let index = 0; index <= sequence.length; index += 1) {
        assert.deepEqual(collect([sequence.slice(0, index), sequence.slice(index)]), { text: "beforeafter", writes: ["hello"] });
      }
    }
  }
});

test("OSC 52 strips invalid, unsupported, query, and adjacent requests without changing other OSC", () => {
  const other = "\x1b]777;wmux;cursor=1\x07";
  assert.deepEqual(
    collect([`a${other}${osc("p;aGVsbG8=")}${osc("c;?")}${osc(";?")}${osc("c;YQ=")}${osc("c;")}b${osc("c;eA==")}c`]),
    { text: `a${other}bc`, writes: ["x"] },
  );
});

test("OSC 52 rejects malformed alphabet, padding, invalid UTF-8, and oversize while recovering", () => {
  const invalidUtf8 = Buffer.from([0xc3, 0x28]).toString("base64");
  const oversized = Buffer.alloc(MAX_OSC52_DECODED_BYTES + 1, 97).toString("base64");
  assert.deepEqual(collect([`${osc("c;AA=A")}${osc(`c;${invalidUtf8}`)}${osc(`c;${oversized}`)}ok${osc("c;eQ==")}`]), {
    text: "ok",
    writes: ["y"],
  });
});

test("OSC 52 accepts the exact decoded cap and bounds unterminated payload memory", () => {
  const exact = Buffer.alloc(MAX_OSC52_DECODED_BYTES, 97).toString("base64");
  assert.equal(collect([osc(`c;${exact}`)]).writes[0].length, MAX_OSC52_DECODED_BYTES);
  const parser = new Osc52Parser();
  parser.push("\x1b]52;c;" + "A".repeat(exact.length + 100));
  assert.deepEqual(parser.push("\x07z"), { text: "z", writes: [] });
});

test("reset prevents a replay OSC 52 fragment from completing in live output", () => {
  const parser = new Osc52Parser();
  assert.deepEqual(parser.push("replay\x1b]52;c;aGVsbG8="), { text: "replay", writes: [] });
  parser.reset();
  assert.deepEqual(parser.push("\x07live"), { text: "\x07live", writes: [] });
});

test("OSC 52 clipboard wiring owns immediate, pending, and explicit writes", async () => {
  let immediate = true;
  let now = 2_000;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const writes: string[] = [];
  const pending: boolean[] = [];
  const controller = new Osc52ClipboardController({
    pendingMs: 60_000,
    isImmediateWriteAllowed: () => immediate,
    writeClipboard: async (text) => {
      writes.push(text);
    },
    onPendingChange: (value) => pending.push(value),
    now: () => now,
    setTimer: (callback) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimer: (timer) => {
      timers.delete(timer);
    },
  });

  assert.equal(controller.push(osc("c;b25l")).text, "");
  await Promise.resolve();
  assert.deepEqual(writes, ["one"]);
  assert.equal(pending.at(-1), false);

  immediate = false;
  now += 2_000;
  controller.push(osc("c;dHdv"));
  assert.equal(pending.at(-1), true);
  controller.copyPending();
  await Promise.resolve();
  assert.deepEqual(writes, ["one", "two"]);
  assert.equal(pending.at(-1), false);
  controller.dispose();
});

test("OSC 52 replay filtering never writes or retains clipboard data", () => {
  const writes: string[] = [];
  const pending: boolean[] = [];
  const controller = new Osc52ClipboardController({
    pendingMs: 60_000,
    isImmediateWriteAllowed: () => true,
    writeClipboard: async (text) => {
      writes.push(text);
    },
    onPendingChange: (value) => pending.push(value),
    now: () => 2_000,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  assert.deepEqual(controller.push(`before${osc("c;c2VjcmV0")}after`, false), {
    text: "beforeafter",
    writes: [{ text: "secret" }],
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(pending, []);
});
