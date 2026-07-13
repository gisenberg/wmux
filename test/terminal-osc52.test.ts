import assert from "node:assert/strict";
import test from "node:test";
import { MAX_OSC52_DECODED_BYTES, Osc52Parser } from "../src/client/src/terminal-osc52.ts";

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

test("OSC 52 accepts canonical c writes with BEL and ST across every boundary", () => {
  for (const terminator of ["\x07", "\x1b\\"]) {
    const sequence = `before${osc("c;aGVsbG8=", terminator)}after`;
    for (let index = 0; index <= sequence.length; index += 1) {
      assert.deepEqual(collect([sequence.slice(0, index), sequence.slice(index)]), { text: "beforeafter", writes: ["hello"] });
    }
  }
});

test("OSC 52 strips invalid, unsupported, query, and adjacent requests without changing other OSC", () => {
  const other = "\x1b]777;wmux;cursor=1\x07";
  assert.deepEqual(
    collect([`a${other}${osc("p;aGVsbG8=")}${osc("c;?")}${osc("c;YQ=")}${osc("c;")}b${osc("c;eA==")}c`]),
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
