import type { AgentActivity, PaneState, SurfaceTab, Workspace } from "./types";

export interface WorkspacePresentationTarget {
  machineId: string;
  tab?: SurfaceTab;
  pane?: PaneState;
}

export const workspacePresentationTarget = (
  workspace: Workspace,
  agent?: Pick<AgentActivity, "tabId" | "paneId">,
): WorkspacePresentationTarget => {
  const agentTab = workspace.tabs.find(
    (candidate) => candidate.id === agent?.tabId,
  );
  const agentPane = agentTab?.panes.find(
    (candidate) => candidate.id === agent?.paneId,
  );
  if (agentTab && agentPane) {
    return { machineId: agentPane.machineId, tab: agentTab, pane: agentPane };
  }

  const tab = workspace.tabs.find(
    (candidate) => candidate.id === workspace.activeTabId,
  ) ?? workspace.tabs[0];
  const pane = tab?.panes.find(
    (candidate) => candidate.id === tab.activePaneId,
  ) ?? tab?.panes[0];
  return { machineId: pane?.machineId || workspace.machineId, tab, pane };
};

/** The active pane is the workspace's current host context; machineId remains its filter affinity. */
export const workspacePresentationMachineId = (workspace: Workspace): string =>
  workspacePresentationTarget(workspace).machineId;

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
