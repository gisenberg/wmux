import { TERMINAL_RESET } from "../shared/terminal-protocol.js";

const RIS = "\x1bc";

/**
 * Keep a terminal model measuring text the way ConPTY does.
 *
 * ConPTY clusters graphemes regardless of what its client application does.
 * A reset (RIS) that an application sends through it would return Ghostty to
 * its power-on legacy widths, and every later emoji sequence would then move
 * the model's cursor differently than ConPTY's. Re-enable clustering right
 * after each reset, including one split across output chunks.
 */
export class ConptyMeasurementPin {
  private pendingEscape = false;

  push(data: string): string {
    if (!data) return data;
    let body = data;
    let prefix = "";
    if (this.pendingEscape && body.startsWith("c")) {
      prefix = `c${TERMINAL_RESET.slice(RIS.length)}`;
      body = body.slice(1);
    }
    const output = prefix + body.replaceAll(RIS, TERMINAL_RESET);
    this.pendingEscape = output.endsWith("\x1b");
    return output;
  }

  reset(): void {
    this.pendingEscape = false;
  }
}
