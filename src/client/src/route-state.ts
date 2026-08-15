import type { BootstrapPayload, SurfaceTab, TerminalNotification } from "./types";

export interface RouteTarget {
  workspaceId: string;
  tabId?: string;
}

export type ActivePaneSelections = Record<string, string>;
export type ActiveTabSelections = Record<string, string>;

const ACTIVE_PANES_STORAGE_KEY = "wmux.activePanes";
const ACTIVE_TABS_STORAGE_KEY = "wmux.activeTabs";

export const workspaceTabPath = (workspaceId: string, tabId: string): string =>
  `/workspaces/${encodeURIComponent(workspaceId)}/tabs/${encodeURIComponent(tabId)}`;

export const notificationTargetHref = (
  notification: Pick<TerminalNotification, "href" | "workspaceId" | "tabId">,
): string => notification.href || workspaceTabPath(notification.workspaceId, notification.tabId);

export const shouldReplaceWorkspaceHistory = (
  isMobile: boolean,
  requested?: boolean,
): boolean => requested ?? isMobile;

/** Parse a `/workspaces/:id(/tabs/:id)?` pathname into a route target, or null. */
export const parseRouteTarget = (pathname: string): RouteTarget | null => {
  const match = pathname.match(/^\/workspaces\/([^/]+)(?:\/tabs\/([^/]+))?\/?$/);
  if (!match) return null;
  return {
    workspaceId: decodeURIComponent(match[1]),
    tabId: match[2] ? decodeURIComponent(match[2]) : undefined,
  };
};

export const findWorkspaceTab = (
  payload: BootstrapPayload,
  workspaceId: string,
  tabId?: string,
): { workspace: BootstrapPayload["workspaces"][number]; tab: SurfaceTab } | null => {
  const workspace = payload.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return null;
  const tab = tabId
    ? workspace.tabs.find((candidate) => candidate.id === tabId)
    : workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId) ?? workspace.tabs[0];
  return tab ? { workspace, tab } : null;
};

export const markWorkspaceNotificationsReadInState = (
  payload: BootstrapPayload,
  workspaceId: string,
): BootstrapPayload => {
  let changed = false;
  const notifications = payload.notifications.map((notification) => {
    if (notification.workspaceId !== workspaceId || notification.read) return notification;
    changed = true;
    return { ...notification, read: true };
  });
  return changed ? { ...payload, notifications } : payload;
};

export const markPaneNotificationsReadInState = (
  payload: BootstrapPayload,
  paneId: string,
): BootstrapPayload => {
  let changed = false;
  const notifications = payload.notifications.map((notification) => {
    if (notification.paneId !== paneId || notification.read) return notification;
    changed = true;
    return { ...notification, read: true };
  });
  return changed ? { ...payload, notifications } : payload;
};

export const activateWorkspaceTabInState = (
  payload: BootstrapPayload,
  workspaceId: string,
  tabId: string,
): BootstrapPayload => {
  const selected = selectWorkspaceTabInState(payload, workspaceId, tabId);
  return selected === payload
    ? markWorkspaceNotificationsReadInState(payload, workspaceId)
    : markWorkspaceNotificationsReadInState(selected, workspaceId);
};

export const selectWorkspaceTabInState = (
  payload: BootstrapPayload,
  workspaceId: string,
  tabId: string,
): BootstrapPayload => {
  const target = findWorkspaceTab(payload, workspaceId, tabId);
  if (!target) return payload;
  if (payload.activeWorkspaceId === workspaceId && target.workspace.activeTabId === tabId) return payload;
  return {
    ...payload,
    activeWorkspaceId: workspaceId,
    workspaces: payload.workspaces.map((workspace) =>
      workspace.id === workspaceId ? { ...workspace, activeTabId: tabId } : workspace,
    ),
  };
};

export const applyRouteTargetToState = (
  payload: BootstrapPayload,
  target: RouteTarget | null,
): BootstrapPayload => {
  if (!target) return payload;
  const route = findWorkspaceTab(payload, target.workspaceId, target.tabId);
  return route ? selectWorkspaceTabInState(payload, route.workspace.id, route.tab.id) : payload;
};

export const activatePaneInState = (
  payload: BootstrapPayload,
  tabId: string,
  paneId: string,
): BootstrapPayload => {
  const selected = selectPaneInState(payload, tabId, paneId);
  return selected === payload
    ? markPaneNotificationsReadInState(payload, paneId)
    : markPaneNotificationsReadInState(selected, paneId);
};

export const selectPaneInState = (
  payload: BootstrapPayload,
  tabId: string,
  paneId: string,
): BootstrapPayload => {
  const workspace = payload.workspaces.find((candidate) => candidate.tabs.some((tab) => tab.id === tabId));
  const tab = workspace?.tabs.find((candidate) => candidate.id === tabId);
  if (!workspace || !tab || !tab.panes.some((pane) => pane.id === paneId)) return payload;
  if (tab.activePaneId === paneId) return payload;
  return {
    ...payload,
    workspaces: payload.workspaces.map((candidateWorkspace) =>
      candidateWorkspace.id !== workspace.id
        ? candidateWorkspace
        : {
            ...candidateWorkspace,
            tabs: candidateWorkspace.tabs.map((candidateTab) =>
              candidateTab.id === tabId ? { ...candidateTab, activePaneId: paneId } : candidateTab,
            ),
          },
    ),
  };
};

export const applyActivePaneSelectionsToState = (
  payload: BootstrapPayload,
  selections: ActivePaneSelections,
): BootstrapPayload => {
  let next = payload;
  for (const [tabId, paneId] of Object.entries(selections)) {
    next = selectPaneInState(next, tabId, paneId);
  }
  return next;
};

export const applyActiveTabSelectionsToState = (
  payload: BootstrapPayload,
  selections: ActiveTabSelections,
): BootstrapPayload => {
  let changed = false;
  const workspaces = payload.workspaces.map((workspace) => {
    const tabId = selections[workspace.id];
    if (!tabId || tabId === workspace.activeTabId || !workspace.tabs.some((tab) => tab.id === tabId)) {
      return workspace;
    }
    changed = true;
    return { ...workspace, activeTabId: tabId };
  });
  return changed ? { ...payload, workspaces } : payload;
};

export const applyClientViewToState = (
  payload: BootstrapPayload,
  target: RouteTarget | null,
  tabSelections: ActiveTabSelections,
  paneSelections: ActivePaneSelections,
): BootstrapPayload =>
  applyActivePaneSelectionsToState(
    applyRouteTargetToState(applyActiveTabSelectionsToState(payload, tabSelections), target),
    paneSelections,
  );

export const loadActivePaneSelections = (): ActivePaneSelections => {
  return loadBrowserSelections(ACTIVE_PANES_STORAGE_KEY);
};

export const saveActivePaneSelections = (selections: ActivePaneSelections): void => {
  saveBrowserSelections(ACTIVE_PANES_STORAGE_KEY, selections);
};

export const loadActiveTabSelections = (): ActiveTabSelections =>
  loadBrowserSelections(ACTIVE_TABS_STORAGE_KEY);

export const saveActiveTabSelections = (selections: ActiveTabSelections): void => {
  saveBrowserSelections(ACTIVE_TABS_STORAGE_KEY, selections);
};

const loadBrowserSelections = (key: string): Record<string, string> => {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .slice(-200),
    );
  } catch {
    return {};
  }
};

const saveBrowserSelections = (key: string, selections: Record<string, string>): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(selections).slice(-200))));
  } catch {
    /* Browser storage is optional; the current page still keeps its in-memory selection. */
  }
};
