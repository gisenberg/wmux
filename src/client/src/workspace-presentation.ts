import type { Workspace } from "./types";

/** The active pane is the workspace's current host context; machineId remains its filter affinity. */
export const workspacePresentationMachineId = (workspace: Workspace): string => {
  const tab = workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId) ?? workspace.tabs[0];
  const pane = tab?.panes.find((candidate) => candidate.id === tab.activePaneId) ?? tab?.panes[0];
  return pane?.machineId || workspace.machineId;
};

export const workspacePresentationDescriptor = (
  workspace: Workspace,
  presentationMachineName: string,
  affinityMachineName?: string,
): string | undefined => {
  const descriptor = workspace.descriptor?.trim();
  if (!descriptor) return descriptor;
  if (workspace.descriptorSource === "default") return presentationMachineName;
  // Older state has no descriptor source; only rewrite its recognizable affinity default.
  if (workspace.descriptorSource === undefined && (descriptor === workspace.machineId || descriptor === affinityMachineName)) {
    return presentationMachineName;
  }
  return descriptor;
};
