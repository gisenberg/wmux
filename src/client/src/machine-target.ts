export const machineTargetStorageKey = "wmux.targetMachineId";
export const machineTargetPickerExpandedStorageKey = "wmux.targetMachinePickerExpanded";

interface MachineTargetStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const loadMachineTargetId = (storage: Pick<MachineTargetStorage, "getItem">): string => {
  try {
    return storage.getItem(machineTargetStorageKey)?.trim() ?? "";
  } catch {
    return "";
  }
};

export const persistMachineTargetId = (
  storage: Pick<MachineTargetStorage, "setItem" | "removeItem">,
  machineId: string,
): void => {
  try {
    const normalized = machineId.trim();
    if (normalized) storage.setItem(machineTargetStorageKey, normalized);
    else storage.removeItem(machineTargetStorageKey);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
};

export const loadMachineTargetPickerExpanded = (storage: Pick<MachineTargetStorage, "getItem">): boolean => {
  try {
    return storage.getItem(machineTargetPickerExpandedStorageKey) === "true";
  } catch {
    return false;
  }
};

export const persistMachineTargetPickerExpanded = (
  storage: Pick<MachineTargetStorage, "setItem">,
  expanded: boolean,
): void => {
  try {
    storage.setItem(machineTargetPickerExpandedStorageKey, String(expanded));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
};

export const resolveMachineTargetId = (
  currentMachineId: string,
  machines: ReadonlyArray<{ id: string; source?: "config" | "registered"; online?: boolean }>,
): string => {
  const current = machines.find((machine) => machine.id === currentMachineId);
  if (current && !(current.source === "registered" && current.online === false)) return currentMachineId;
  return machines.find((machine) => machine.source !== "registered")?.id
    ?? machines.find((machine) => machine.online !== false)?.id
    ?? "";
};
