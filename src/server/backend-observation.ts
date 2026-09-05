import { randomBytes } from "node:crypto";

export type ObservedMultiplexer = "pending" | "raw" | "tmux" | "screen";

/** A per-attachment startup report, consumed before terminal replay/checkpoints. */
export class BackendObservation {
  readonly nonce = randomBytes(16).toString("hex");
  mode: ObservedMultiplexer = "pending";
  private readonly prefix = `\x1b]777;wmux-backend;${this.nonce};`;
  private pending = "";

  consume(chunk: string): string {
    let input = this.pending + chunk;
    this.pending = "";
    let output = "";
    while (input) {
      const start = input.indexOf(this.prefix);
      if (start < 0) {
        let keep = Math.min(input.length, this.prefix.length - 1);
        while (keep > 0 && !this.prefix.startsWith(input.slice(-keep))) keep -= 1;
        this.pending = keep ? input.slice(-keep) : "";
        return output + (keep ? input.slice(0, -keep) : input);
      }
      output += input.slice(0, start);
      input = input.slice(start);
      const end = input.indexOf("\x07", this.prefix.length);
      if (end < 0 && input.length < this.prefix.length + 8) {
        this.pending = input;
        return output;
      }
      const mode = end < 0 ? "" : input.slice(this.prefix.length, end);
      if (mode === "raw" || mode === "tmux" || mode === "screen") {
        this.mode = mode;
        input = input.slice(end + 1);
      } else {
        output += input[0];
        input = input.slice(1);
      }
    }
    return output;
  }
}
