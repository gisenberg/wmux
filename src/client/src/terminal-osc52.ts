export interface Osc52Write {
  text: string;
}

export interface Osc52Result {
  text: string;
  writes: Osc52Write[];
}

const PREFIX = "\x1b]52;";
export const MAX_OSC52_DECODED_BYTES = 1024 * 1024;
// Four base64 characters encode three bytes; this also bounds an unterminated
// request without retaining its payload indefinitely.
export const MAX_OSC52_ENCODED_CHARS = Math.ceil(MAX_OSC52_DECODED_BYTES / 3) * 4;

/** Streaming OSC 52 write filter. Only c;BASE64 requests are surfaced. */
export class Osc52Parser {
  private carry = "";
  private body = "";
  private inOsc = false;
  private discarded = false;

  reset(): void {
    this.carry = "";
    this.body = "";
    this.inOsc = false;
    this.discarded = false;
  }

  push(chunk: string): Osc52Result {
    let input = this.carry + chunk;
    this.carry = "";
    let text = "";
    const writes: Osc52Write[] = [];
    let offset = 0;

    while (offset < input.length) {
      if (!this.inOsc) {
        const start = input.indexOf(PREFIX, offset);
        if (start === -1) {
          const tail = partialPrefix(input.slice(offset));
          text += input.slice(offset, input.length - tail);
          this.carry = tail ? input.slice(-tail) : "";
          break;
        }
        text += input.slice(offset, start);
        this.inOsc = true;
        this.body = "";
        this.discarded = false;
        offset = start + PREFIX.length;
      }

      if (offset >= input.length) break;

      const character = input[offset++];
      if (character === "\x07") {
        this.finish(writes);
        continue;
      }
      if (character === "\x1b") {
        if (offset === input.length) {
          this.carry = "\x1b";
          break;
        }
        if (input[offset] === "\\") {
          offset += 1;
          this.finish(writes);
          continue;
        }
      }
      if (!this.discarded) {
        if (this.body.length >= MAX_OSC52_ENCODED_CHARS + 2) this.discarded = true;
        else this.body += character;
      }
    }
    return { text, writes };
  }

  private finish(writes: Osc52Write[]): void {
    if (!this.discarded) {
      const separator = this.body.indexOf(";");
      if (separator !== -1 && this.body.slice(0, separator) === "c") {
        const encoded = this.body.slice(separator + 1);
        const decoded = decodeCanonicalUtf8(encoded);
        if (decoded !== null) writes.push({ text: decoded });
      }
    }
    this.inOsc = false;
    this.body = "";
    this.discarded = false;
  }
}

const partialPrefix = (input: string): number => {
  for (let length = Math.min(input.length, PREFIX.length - 1); length > 0; length -= 1) {
    if (input.slice(-length) === PREFIX.slice(0, length)) return length;
  }
  return 0;
};

const decodeCanonicalUtf8 = (encoded: string): string | null => {
  if (!encoded || encoded.length > MAX_OSC52_ENCODED_CHARS || encoded.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    if (binary.length > MAX_OSC52_DECODED_BYTES) return null;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // This rejects non-canonical trailing bits accepted by some atob implementations.
    if (btoa(binary) !== encoded) return null;
    return text;
  } catch {
    return null;
  }
};
