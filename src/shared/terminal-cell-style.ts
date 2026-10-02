import { CellFlags, type GhosttyCell } from "ghostty-web";

export type StyledCell = Pick<
  GhosttyCell,
  "flags" | "fgIsDefault" | "bgIsDefault" | "fg_r" | "fg_g" | "fg_b" | "bg_r" | "bg_g" | "bg_b"
>;

export const cellStyleKey = (cell: StyledCell): string =>
  `${cell.flags}:${cell.fgIsDefault ? "default" : `${cell.fg_r},${cell.fg_g},${cell.fg_b}`}`
  + `:${cell.bgIsDefault ? "default" : `${cell.bg_r},${cell.bg_g},${cell.bg_b}`}`;

/** The SGR that reproduces a cell's rendition from a reset pen. */
export const cellStyleSequence = (cell: StyledCell): string => {
  const codes = [0];
  if (cell.flags & CellFlags.BOLD) codes.push(1);
  if (cell.flags & CellFlags.FAINT) codes.push(2);
  if (cell.flags & CellFlags.ITALIC) codes.push(3);
  if (cell.flags & CellFlags.UNDERLINE) codes.push(4);
  if (cell.flags & CellFlags.BLINK) codes.push(5);
  if (cell.flags & CellFlags.INVERSE) codes.push(7);
  if (cell.flags & CellFlags.INVISIBLE) codes.push(8);
  if (cell.flags & CellFlags.STRIKETHROUGH) codes.push(9);
  // Keep semantic defaults as defaults so a restored screen still follows a
  // later color-scheme change instead of freezing the palette of one theme.
  if (cell.fgIsDefault) codes.push(39);
  else codes.push(38, 2, cell.fg_r, cell.fg_g, cell.fg_b);
  if (cell.bgIsDefault) codes.push(49);
  else codes.push(48, 2, cell.bg_r, cell.bg_g, cell.bg_b);
  return `\x1b[${codes.join(";")}m`;
};
