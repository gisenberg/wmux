export const mobileTerminalKeySequences = {
  escape: "\x1b",
  tab: "\t",
  arrowUp: "\x1b[A",
  arrowDown: "\x1b[B",
  arrowRight: "\x1b[C",
  arrowLeft: "\x1b[D",
} as const;

export const oneShotControlSequence = (data: string): string | undefined => {
  if (data.length !== 1) return undefined;
  const code = data.toUpperCase().charCodeAt(0);
  if (code < 64 || code > 95) return undefined;
  return String.fromCharCode(code & 0x1f);
};
