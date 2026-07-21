export const mobileTerminalKeySequences = {
  escape: "\x1b",
  tab: "\t",
} as const;

export type MobileTerminalArrow = "up" | "down" | "right" | "left";

const mobileTerminalArrowSuffix: Record<MobileTerminalArrow, string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

export const mobileTerminalArrowSequence = (
  arrow: MobileTerminalArrow,
  applicationCursorKeys: boolean,
): string => `\x1b${applicationCursorKeys ? "O" : "["}${mobileTerminalArrowSuffix[arrow]}`;

export const oneShotControlSequence = (data: string): string | undefined => {
  if (data.length !== 1) return undefined;
  const rawCode = data.charCodeAt(0);
  const code = rawCode >= 97 && rawCode <= 122 ? rawCode - 32 : rawCode;
  if (code < 65 || code > 90) return undefined;
  return String.fromCharCode(code & 0x1f);
};

export const canApplyMobileClipboardRead = (
  captured: { paneId: string; inputEpoch: number },
  current: {
    paneId: string;
    inputEpoch: number;
    mounted: boolean;
    active: boolean;
    visible: boolean;
    connected: boolean;
  },
): boolean => captured.paneId === current.paneId
  && captured.inputEpoch === current.inputEpoch
  && current.mounted
  && current.active
  && current.visible
  && current.connected;
