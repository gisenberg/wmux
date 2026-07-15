/** URL used by staged helpers and agent callbacks, distinct from the browser URL. */
const environmentUrl = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value || undefined;
};

export const resolveHelperUrl = (fallback: string): string =>
  environmentUrl("WMUX_HELPER_URL") ?? environmentUrl("WMUX_PUBLIC_URL") ?? environmentUrl("WMUX_URL") ?? fallback;
