export interface Osc52Write {
  text: string;
}

export interface Osc52Result {
  text: string;
  writes: Osc52Write[];
}

export interface Osc52ClipboardControllerOptions {
  pendingMs: number;
  isImmediateWriteAllowed: () => boolean;
  writeClipboard: (text: string) => Promise<void>;
  onPendingChange: (pending: boolean) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => number;
  clearTimer?: (timer: number) => void;
}

interface Osc52ClipboardRequest {
  text: string;
  generation: number;
  expiresAt: number;
}

const PREFIX = "\x1b]52;";
export const MAX_OSC52_DECODED_BYTES = 1024 * 1024;
// Four base64 characters encode three bytes; this also bounds an unterminated
// request without retaining its payload indefinitely.
export const MAX_OSC52_ENCODED_CHARS = Math.ceil(MAX_OSC52_DECODED_BYTES / 3) * 4;

/** Streaming OSC 52 write filter. Only clipboard/default BASE64 writes are surfaced. */
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
      const selection = separator === -1 ? undefined : this.body.slice(0, separator);
      if (separator !== -1 && (selection === "c" || selection === "")) {
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

export class Osc52ClipboardController {
  private readonly parser = new Osc52Parser();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => number;
  private readonly clearTimer: (timer: number) => void;
  private pending: Osc52ClipboardRequest | undefined;
  private pendingTimer: number | undefined;
  private generation = 0;
  private lastWriteAt = 0;

  constructor(private readonly options: Osc52ClipboardControllerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => window.clearTimeout(timer));
  }

  push(chunk: string, allowWrites = true): Osc52Result {
    const result = this.parser.push(chunk);
    if (allowWrites) {
      for (const write of result.writes) this.tryWrite(this.nextRequest(write.text));
    }
    return result;
  }

  resetParser(): void {
    this.parser.reset();
  }

  clearPending(): void {
    if (this.pendingTimer !== undefined) this.clearTimer(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pending = undefined;
    this.options.onPendingChange(false);
  }

  copyPending(): void {
    const request = this.pending;
    if (!request || request.expiresAt < this.now()) {
      this.clearPending();
      return;
    }
    void this.options.writeClipboard(request.text).then(() => {
      if (this.pending?.generation === request.generation) this.clearPending();
    });
  }

  dispose(): void {
    this.resetParser();
    this.clearPending();
  }

  private nextRequest(text: string): Osc52ClipboardRequest {
    return {
      text,
      generation: ++this.generation,
      expiresAt: this.now() + this.options.pendingMs,
    };
  }

  private retain(request: Osc52ClipboardRequest): void {
    if (this.pendingTimer !== undefined) this.clearTimer(this.pendingTimer);
    this.pending = request;
    this.options.onPendingChange(true);
    this.pendingTimer = this.setTimer(() => {
      if (this.pending?.generation === request.generation) this.clearPending();
    }, this.options.pendingMs);
  }

  private tryWrite(request: Osc52ClipboardRequest): void {
    const now = this.now();
    if (!this.options.isImmediateWriteAllowed() || now - this.lastWriteAt < 1000) {
      this.retain(request);
      return;
    }
    this.lastWriteAt = now;
    void this.options.writeClipboard(request.text).then(
      () => {
        if (!this.pending || this.pending.generation <= request.generation) this.clearPending();
      },
      () => {
        if (!this.pending || this.pending.generation <= request.generation) this.retain(request);
      },
    );
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
