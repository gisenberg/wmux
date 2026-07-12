export const resolveMachineTargetId = (
  currentMachineId: string,
  machines: ReadonlyArray<{ id: string; online?: boolean }>,
): string => {
  if (machines.some((machine) => machine.id === currentMachineId)) return currentMachineId;
  return machines.find((machine) => machine.online !== false)?.id ?? machines[0]?.id ?? "";
};
