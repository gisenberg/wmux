// ghostty-web emits terminal-generated answers through the same onData event as
// keyboard input. Tag only the bounded reply forms we understand so transports
// do not mistake ordinary escape-prefixed key sequences for terminal responses.
const CSI_TERMINAL_RESPONSE = String.raw`\x1b\[[?>]?[0-9;]*c|\x1b\[(?:0n|[0-9]+;[0-9]+R)`;
const GHOSTTY_XTVERSION_RESPONSE = String.raw`\x1bP>\|libghostty(?: [\x20-\x7e]{1,64})?\x1b\\`;
const TERMINAL_PROTOCOL_RESPONSES = new RegExp(
  `^(?:(?:${CSI_TERMINAL_RESPONSE})|(?:${GHOSTTY_XTVERSION_RESPONSE}))+$`,
);

export const isTerminalProtocolResponse = (data: string): boolean => TERMINAL_PROTOCOL_RESPONSES.test(data);
