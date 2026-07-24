export const minimumTerminalRendererDevicePixelRatio = 2;

export const terminalRendererDevicePixelRatio = (
  browserDevicePixelRatio: number | undefined,
): number => {
  const scale =
    browserDevicePixelRatio !== undefined &&
    Number.isFinite(browserDevicePixelRatio) &&
    browserDevicePixelRatio > 0
      ? browserDevicePixelRatio
      : 1;
  return Math.max(minimumTerminalRendererDevicePixelRatio, scale);
};
