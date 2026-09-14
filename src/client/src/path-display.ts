import { sliceTextEndToCells, sliceTextToCells, textCellWidth } from "./opentui-grid";

export interface CompactPathParts {
  full: string;
  prefix: string;
  marker: string;
  suffix: string;
  text: string;
  compacted: boolean;
}

export const normalizeUserPath = (cwd: string | undefined): string => {
  let pathValue = cwd?.trim() ?? "";
  if (!pathValue) return "";
  pathValue = pathValue.replace(/\\/g, "/").replace(/\/+/g, "/");
  const windowsHome = pathValue.match(/^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/i);
  if (windowsHome) return pathValue.replace(windowsHome[0], "~");
  const posixHome = pathValue.match(/^\/(?:home|Users)\/[^/]+(?=\/|$)/);
  if (posixHome) return pathValue.replace(posixHome[0], "~");
  if (/^\/root(?=\/|$)/.test(pathValue)) return pathValue.replace(/^\/root/, "~");
  return pathValue;
};

export const compactMiddlePath = (pathValue: string, maxCells: number): CompactPathParts => {
  const full = pathValue.trim();
  const limit = Math.max(0, Math.floor(maxCells));
  if (!full || limit <= 0) return { full, prefix: "", marker: "", suffix: "", text: "", compacted: false };
  if (textCellWidth(full) <= limit) {
    return { full, prefix: full, marker: "", suffix: "", text: full, compacted: false };
  }
  if (limit <= 4) {
    const text = sliceTextToCells(full, limit);
    return { full, prefix: text, marker: "", suffix: "", text, compacted: true };
  }

  const marker = "..";
  const available = limit - textCellWidth(marker);
  let suffixLength = Math.max(3, Math.floor(available * 0.35));
  let prefixLength = available - suffixLength;
  if (prefixLength < 1) {
    prefixLength = 1;
    suffixLength = Math.max(0, available - prefixLength);
  }
  const prefix = sliceTextToCells(full, prefixLength);
  const suffix = sliceTextEndToCells(full, suffixLength);
  const text = `${prefix}${marker}${suffix}`;
  return { full, prefix, marker, suffix, text, compacted: true };
};
