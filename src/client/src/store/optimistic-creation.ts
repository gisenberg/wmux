import type {
  BootstrapPayload,
  LayoutNode,
  PaneState,
  SplitDirection,
  SurfaceTab,
  Workspace,
} from "../types";

export interface ClientWorkspaceIds {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface ClientTabIds {
  tabId: string;
  paneId: string;
}

export interface ClientSplitIds {
  paneId: string;
}

export type OptimisticCreation =
  | { kind: "workspace"; key: string; paneId: string; workspace: Workspace }
  | { kind: "tab"; key: string; paneId: string; workspaceId: string; tab: SurfaceTab }
  | {
      kind: "split";
      key: string;
      paneId: string;
      tabId: string;
      sourcePaneId: string;
      direction: SplitDirection;
      pane: PaneState;
    };

export const createClientWorkspaceIds = (): ClientWorkspaceIds => ({
  workspaceId: clientId("ws"),
  tabId: clientId("tab"),
  paneId: clientId("pane"),
});

export const createClientTabIds = (): ClientTabIds => ({ tabId: clientId("tab"), paneId: clientId("pane") });

export const createClientSplitIds = (): ClientSplitIds => ({ paneId: clientId("pane") });

export const optimisticWorkspaceCreation = (
  payload: BootstrapPayload,
  machineId: string,
  ids: ClientWorkspaceIds,
  cwd?: string,
): OptimisticCreation => {
  const createdAt = new Date().toISOString();
  const pane = createPane(ids.paneId, machineId, cwd, createdAt);
  const tab = createTab(ids.tabId, pane, createdAt);
  const machine = payload.machines.find((candidate) => candidate.id === machineId);
  const count = payload.workspaces.length + 1;
  const workspace: Workspace = {
    id: ids.workspaceId,
    name: machineId === "local" ? `Local ${count}` : `${machineId} ${count}`,
    nameSource: "default",
    descriptor: machine?.name ?? machineId,
    descriptorSource: "default",
    machineId,
    activeTabId: tab.id,
    tabs: [tab],
    createdAt,
    updatedAt: createdAt,
  };
  return { kind: "workspace", key: ids.workspaceId, paneId: pane.id, workspace };
};

export const optimisticTabCreation = (
  payload: BootstrapPayload,
  workspaceId: string,
  machineId: string,
  ids: ClientTabIds,
  cwd?: string,
): OptimisticCreation | undefined => {
  if (!payload.workspaces.some((workspace) => workspace.id === workspaceId)) return undefined;
  const createdAt = new Date().toISOString();
  const pane = createPane(ids.paneId, machineId, cwd, createdAt);
  return {
    kind: "tab",
    key: ids.tabId,
    paneId: pane.id,
    workspaceId,
    tab: createTab(ids.tabId, pane, createdAt),
  };
};

export const optimisticSplitCreation = (
  payload: BootstrapPayload,
  tabId: string,
  sourcePaneId: string,
  direction: SplitDirection,
  machineId: string,
  ids: ClientSplitIds,
  cwd?: string,
): OptimisticCreation | undefined => {
  const tab = payload.workspaces.flatMap((workspace) => workspace.tabs).find((candidate) => candidate.id === tabId);
  if (!tab?.panes.some((pane) => pane.id === sourcePaneId)) return undefined;
  return {
    kind: "split",
    key: ids.paneId,
    paneId: ids.paneId,
    tabId,
    sourcePaneId,
    direction,
    pane: createPane(ids.paneId, machineId, cwd, new Date().toISOString()),
  };
};

export const applyOptimisticCreations = (
  payload: BootstrapPayload,
  creations: Iterable<OptimisticCreation>,
): BootstrapPayload => {
  let next = payload;
  for (const creation of creations) next = applyOptimisticCreation(next, creation);
  return next;
};

const applyOptimisticCreation = (payload: BootstrapPayload, creation: OptimisticCreation): BootstrapPayload => {
  if (creation.kind === "workspace") {
    const existing = payload.workspaces.find((workspace) => workspace.id === creation.workspace.id);
    const workspace = existing ?? creation.workspace;
    return {
      ...payload,
      activeWorkspaceId: workspace.id,
      workspaces: existing
        ? payload.workspaces.map((candidate) => candidate.id === existing.id
          ? { ...candidate, activeTabId: creation.workspace.activeTabId }
          : candidate)
        : [workspace, ...payload.workspaces],
    };
  }

  if (creation.kind === "tab") {
    return {
      ...payload,
      activeWorkspaceId: creation.workspaceId,
      workspaces: payload.workspaces.map((workspace) => {
        if (workspace.id !== creation.workspaceId) return workspace;
        const existing = workspace.tabs.some((tab) => tab.id === creation.tab.id);
        return {
          ...workspace,
          activeTabId: creation.tab.id,
          tabs: existing ? workspace.tabs : [...workspace.tabs, creation.tab],
        };
      }),
    };
  }

  return {
    ...payload,
    workspaces: payload.workspaces.map((workspace) => {
      if (!workspace.tabs.some((tab) => tab.id === creation.tabId)) return workspace;
      return {
        ...workspace,
        activeTabId: creation.tabId,
        tabs: workspace.tabs.map((tab) => {
          if (tab.id !== creation.tabId) return tab;
          const existing = tab.panes.some((pane) => pane.id === creation.pane.id);
          return {
            ...tab,
            activePaneId: creation.pane.id,
            panes: existing ? tab.panes : [...tab.panes, creation.pane],
            layout: existing ? tab.layout : replacePane(tab.layout, creation.sourcePaneId, {
              type: "split",
              direction: creation.direction,
              ratio: 0.5,
              first: { type: "pane", paneId: creation.sourcePaneId },
              second: { type: "pane", paneId: creation.pane.id },
            }),
          };
        }),
      };
    }),
  };
};

const createPane = (id: string, machineId: string, cwd: string | undefined, createdAt: string): PaneState => ({
  id,
  machineId,
  title: "Shell",
  cwd,
  status: "idle",
  createdAt,
});

const createTab = (id: string, pane: PaneState, createdAt: string): SurfaceTab => ({
  id,
  title: "Shell",
  titleSource: "default",
  activePaneId: pane.id,
  layout: { type: "pane", paneId: pane.id },
  panes: [pane],
  createdAt,
});

const replacePane = (node: LayoutNode, paneId: string, replacement: LayoutNode): LayoutNode => {
  if (node.type === "pane") return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    first: replacePane(node.first, paneId, replacement),
    second: replacePane(node.second, paneId, replacement),
  };
};

const clientId = (prefix: "ws" | "tab" | "pane"): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
