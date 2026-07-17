import { useCallback, useEffect, useRef } from "react";
import { api } from "./api";
import type { AppStore } from "./app-store";
import { reconcileIncomingRevision } from "./reconcile";
import {
  activatePaneInState,
  activateWorkspaceTabInState,
  applyClientViewToState,
  findWorkspaceTab,
  loadActivePaneSelections,
  loadActiveTabSelections,
  parseRouteTarget,
  saveActivePaneSelections,
  saveActiveTabSelections,
  workspaceTabPath,
} from "./route-state";
import type { BootstrapPayload, SurfaceTab, Workspace } from "./types";

export interface ActivateWorkspaceTabOptions {
  focusTerminal?: boolean;
  replaceHistory?: boolean;
}

interface UseAppRoutingOptions {
  store: AppStore;
  openTuiMode: boolean;
  activeWorkspace: Workspace | undefined;
  activeTab: SurfaceTab | undefined;
  onError: (message: string) => void;
  // Called when activation navigates while on a mobile viewport (collapse the
  // sidebar, settle the visual viewport).
  onMobileNavigate: () => void;
  isMobile: boolean;
  clearBellPanes: (paneIds: string[]) => void;
  requestTerminalFocus: (workspaceId: string, tabId: string) => void;
}

// Owns browser-local workspace/tab/pane selection. Durable server state keeps
// compatibility fallback ids, but navigation never writes them back, so two
// browsers can view the same wmux state independently.
export function useAppRouting(options: UseAppRoutingOptions) {
  const { store, openTuiMode, activeWorkspace, activeTab } = options;
  const lastSyncedPath = useRef("");
  const activePaneSelections = useRef(loadActivePaneSelections());
  const activeTabSelections = useRef(loadActiveTabSelections());
  // Latest callbacks/flags for the []-dep popstate effect and stable callbacks.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const chromePath = useCallback(
    (path: string) => (openTuiMode ? path : `${path}?legacy=1`),
    [openTuiMode],
  );

  const refresh = useCallback(
    async (nextState?: BootstrapPayload) => {
      const incoming = nextState ?? (await api.bootstrap());
      const routed = applyClientViewToState(
        incoming,
        parseRouteTarget(window.location.pathname),
        activeTabSelections.current,
        activePaneSelections.current,
      );
      // Structural sharing: keep previous object identities for unchanged
      // subtrees so memoized panes/tabs skip re-rendering on resyncs.
      const current = store.get();
      const next = reconcileIncomingRevision(current, routed);
      if (next !== current) store.set(next);
    },
    [store],
  );

  const activateWorkspaceTab = useCallback(
    (workspaceId: string, tabId: string | undefined, activateOptions: ActivateWorkspaceTabOptions = {}) => {
      const { onError, onMobileNavigate, isMobile, clearBellPanes, requestTerminalFocus } = optionsRef.current;
      const current = store.get();
      if (!current) return;
      const target = findWorkspaceTab(current, workspaceId, tabId);
      if (!target) return;
      const shouldMarkWorkspaceRead = current.notifications.some(
        (notification) => notification.workspaceId === workspaceId && !notification.read,
      );

      const nextPath = chromePath(workspaceTabPath(workspaceId, target.tab.id));
      if (currentChromePath() !== nextPath) {
        window.history[activateOptions.replaceHistory ? "replaceState" : "pushState"](null, "", nextPath);
        lastSyncedPath.current = nextPath;
      }
      if (isMobile) onMobileNavigate();
      clearBellPanes(target.tab.panes.map((pane) => pane.id));
      activeTabSelections.current = { ...activeTabSelections.current, [workspaceId]: target.tab.id };
      saveActiveTabSelections(activeTabSelections.current);

      store.update((snapshot) =>
        snapshot ? activateWorkspaceTabInState(snapshot, workspaceId, target.tab.id) : snapshot,
      );
      if (activateOptions.focusTerminal) requestTerminalFocus(workspaceId, target.tab.id);

      if (shouldMarkWorkspaceRead) {
        void api.markWorkspaceNotificationsRead(workspaceId)
          .then((payload) => refresh(activateWorkspaceTabInState(payload, workspaceId, target.tab.id)))
          .catch((nextError) => onError(String(nextError)));
      }
    },
    [chromePath, refresh, store],
  );

  const activatePane = useCallback(
    (tabId: string, paneId: string) => {
      const { onError } = optionsRef.current;
      const current = store.get();
      if (!current) return;
      const tab = current.workspaces.flatMap((workspace) => workspace.tabs).find((candidate) => candidate.id === tabId);
      if (!tab?.panes.some((pane) => pane.id === paneId)) return;
      const next = activatePaneInState(current, tabId, paneId);
      const shouldMarkPaneRead = current.notifications.some(
        (notification) => notification.paneId === paneId && !notification.read,
      );
      activePaneSelections.current = { ...activePaneSelections.current, [tabId]: paneId };
      saveActivePaneSelections(activePaneSelections.current);
      if (next !== current) store.set(next);
      if (shouldMarkPaneRead) {
        void api.markPaneNotificationsRead(paneId)
          .then((payload) => refresh(activatePaneInState(payload, tabId, paneId)))
          .catch((nextError) => onError(String(nextError)));
      }
    },
    [refresh, store],
  );

  // Keep the address bar in sync with the active workspace/tab.
  useEffect(() => {
    if (!store.get()) return;
    if (!activeWorkspace || !activeTab) {
      const nextPath = chromePath("/");
      if (currentChromePath() !== nextPath) {
        window.history.replaceState(null, "", nextPath);
        lastSyncedPath.current = nextPath;
      }
      return;
    }
    activeTabSelections.current = { ...activeTabSelections.current, [activeWorkspace.id]: activeTab.id };
    saveActiveTabSelections(activeTabSelections.current);
    if (activeTab.activePaneId) {
      activePaneSelections.current = { ...activePaneSelections.current, [activeTab.id]: activeTab.activePaneId };
      saveActivePaneSelections(activePaneSelections.current);
    }
    const nextChromePath = chromePath(workspaceTabPath(activeWorkspace.id, activeTab.id));
    const currentPath = currentChromePath();
    if (currentPath === nextChromePath) {
      lastSyncedPath.current = nextChromePath;
      return;
    }
    const replace = lastSyncedPath.current === "" || currentPath !== lastSyncedPath.current;
    window.history[replace ? "replaceState" : "pushState"](null, "", nextChromePath);
    lastSyncedPath.current = nextChromePath;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is read, not depended on
  }, [activeWorkspace, activeTab, chromePath]);

  useEffect(() => {
    const onPopState = () => {
      const target = parseRouteTarget(window.location.pathname);
      if (target) activateWorkspaceTab(target.workspaceId, target.tabId, { replaceHistory: true });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [activateWorkspaceTab]);

  return { refresh, activateWorkspaceTab, activatePane, chromePath };
}

const currentChromePath = () => `${window.location.pathname}${window.location.search}`;
