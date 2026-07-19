export const isApplePlatform = (): boolean => {
  const navigatorWithData = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = navigatorWithData.userAgentData?.platform || navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
};
