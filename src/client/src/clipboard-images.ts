export const supportedClipboardImageMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

interface ClipboardItemLike {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike>;
  files?: ArrayLike<File>;
}

export const isSupportedClipboardImageMimeType = (mimeType: string): boolean =>
  supportedClipboardImageMimeTypes.has(mimeType.toLowerCase());

export const imagesFromClipboard = (
  clipboardData: ClipboardDataLike,
  accepts: (mimeType: string) => boolean = isSupportedClipboardImageMimeType,
): File[] => {
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && accepts(file.type || item.type)) files.push(file);
  }
  if (files.length) return files;
  return Array.from(clipboardData.files ?? []).filter((file) => accepts(file.type));
};

export interface PasteImageRaceState {
  paneId: string;
  inputEpoch: number;
  mounted: boolean;
  active: boolean;
  visible: boolean;
  connected: boolean;
}

export const canApplyStagedPasteImage = (
  captured: Pick<PasteImageRaceState, "paneId" | "inputEpoch">,
  current: PasteImageRaceState,
): boolean =>
  captured.paneId === current.paneId
  && captured.inputEpoch === current.inputEpoch
  && current.mounted
  && current.active
  && current.visible
  && current.connected;

export const quoteStagedImagePath = (targetPath: string): string => {
  if (!targetPath || targetPath.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(targetPath)) {
    throw new Error("Invalid staged image path");
  }
  if (/^[A-Za-z]:[\\/]/.test(targetPath)) return `'${targetPath.replace(/'/g, "''")}'`;
  if (!targetPath.startsWith("/")) throw new Error("Staged image path is not absolute");
  return `'${targetPath.replace(/'/g, "'\\''")}'`;
};
