export type MobileSurfaceMode = "agent" | "terminal";

export const legacyMobileSurfaceModeStorageKey = "wmux.mobileSurfaceMode";
export const mobileSurfaceModesStorageKey = "wmux.mobileSurfaceModes";

export const contextMobileSurfaceMode = (hasAgentContext: boolean): MobileSurfaceMode =>
  hasAgentContext ? "agent" : "terminal";

export const loadMobileSurfaceModes = (storage: Pick<Storage, "getItem">): Record<string, MobileSurfaceMode> => {
  try {
    const parsed = JSON.parse(storage.getItem(mobileSurfaceModesStorageKey) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, MobileSurfaceMode] =>
        Boolean(entry[0]) && (entry[1] === "agent" || entry[1] === "terminal"),
      ),
    );
  } catch {
    return {};
  }
};

export const saveMobileSurfaceModes = (
  storage: Pick<Storage, "setItem">,
  modes: Record<string, MobileSurfaceMode>,
): void => {
  storage.setItem(mobileSurfaceModesStorageKey, JSON.stringify(modes));
};

export const loadLegacyMobileSurfaceMode = (
  storage: Pick<Storage, "getItem">,
): MobileSurfaceMode | undefined => {
  const value = storage.getItem(legacyMobileSurfaceModeStorageKey);
  return value === "agent" || value === "terminal" ? value : undefined;
};

export const pruneMobileSurfaceModes = (
  modes: Record<string, MobileSurfaceMode>,
  paneIds: Iterable<string>,
): Record<string, MobileSurfaceMode> => {
  const valid = new Set(paneIds);
  return Object.fromEntries(Object.entries(modes).filter(([paneId]) => valid.has(paneId)));
};

export const sameMobileSurfaceModes = (
  first: Record<string, MobileSurfaceMode>,
  second: Record<string, MobileSurfaceMode>,
): boolean => {
  const firstEntries = Object.entries(first);
  return firstEntries.length === Object.keys(second).length && firstEntries.every(([key, value]) => second[key] === value);
};
