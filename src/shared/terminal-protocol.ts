// ghostty-web emits terminal-generated answers through the same onData event as
// keyboard input. Tag only the bounded reply forms we understand so transports
// do not mistake ordinary escape-prefixed key sequences for terminal responses.
const CSI_TERMINAL_RESPONSE = String.raw`\x1b\[[?>]?[0-9;]*c|\x1b\[(?:0n|[0-9]+;[0-9]+R)`;
const CSI_WINDOW_RESPONSE = String.raw`\x1b\[(?:[12]|(?:3|4|6|8|9);[0-9]+;[0-9]+)t`;
const GHOSTTY_XTVERSION_RESPONSE = String.raw`\x1bP>\|libghostty(?: [\x20-\x7e]{1,64})?\x1b\\`;
const OSC_RGB = String.raw`rgb:[0-9a-fA-F]{1,4}/[0-9a-fA-F]{1,4}/[0-9a-fA-F]{1,4}`;
const OSC_END = String.raw`(?:\x07|\x1b\\)`;
const OSC_DEFAULT_COLOR_RESPONSE = String.raw`\x1b\](?:10|11);${OSC_RGB}${OSC_END}`;
const OSC_PALETTE_COLOR_RESPONSE = String.raw`\x1b\]4;[0-9]{1,3};${OSC_RGB}(?:;[0-9]{1,3};${OSC_RGB})*${OSC_END}`;
const TERMINAL_COLOR_RESPONSES = new RegExp(
  `^(?:(?:${OSC_DEFAULT_COLOR_RESPONSE})|(?:${OSC_PALETTE_COLOR_RESPONSE}))+$`,
);
const TERMINAL_PROTOCOL_RESPONSES = new RegExp(
  `^(?:(?:${CSI_TERMINAL_RESPONSE})|(?:${CSI_WINDOW_RESPONSE})|(?:${GHOSTTY_XTVERSION_RESPONSE})|(?:${OSC_DEFAULT_COLOR_RESPONSE})|(?:${OSC_PALETTE_COLOR_RESPONSE}))+$`,
);
const MAX_TERMINAL_PROTOCOL_RESPONSE_CHARS = 8192;

export const isTerminalProtocolResponse = (data: string): boolean =>
  data.length <= MAX_TERMINAL_PROTOCOL_RESPONSE_CHARS && TERMINAL_PROTOCOL_RESPONSES.test(data);

export const isTerminalColorResponse = (data: string): boolean =>
  data.length <= MAX_TERMINAL_PROTOCOL_RESPONSE_CHARS && TERMINAL_COLOR_RESPONSES.test(data);
