// Control bytes that native Ghostty (after xterm) replaces with a space in
// pasted text. Bracketed paste alone is not enough: ESC could close the paste
// early with ESC[201~, and the line discipline acts on these characters even
// inside the brackets (CVE-2026-26982). ghostty-web applies the same list to
// Terminal.paste(); this covers input wmux brackets itself.
const UNSAFE_PASTE_CODE_POINTS = new Set([
  0x00, 0x04, 0x05, 0x08, 0x1b, 0x7f,
  // Default termios characters: VINTR, VQUIT, VKILL, VSUSP, VSTART, VSTOP,
  // VWERASE, VLNEXT, VREPRINT and VDISCARD.
  0x03, 0x1c, 0x15, 0x1a, 0x11, 0x13, 0x17, 0x16, 0x12, 0x0f,
]);

export const sanitizePastedText = (text: string): string => {
  let result = "";
  for (const character of text) result += UNSAFE_PASTE_CODE_POINTS.has(character.codePointAt(0) ?? 0) ? " " : character;
  return result;
};

export const bracketPastedText = (text: string): string => `\x1b[200~${sanitizePastedText(text)}\x1b[201~`;
