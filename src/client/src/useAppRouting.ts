import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api } from "./api";
import { reconcile } from "./reconcile";
import {
  activateWorkspaceTabInState,
  applyRouteTargetToState,
  findWorkspaceTab,
  parseRouteTarget,
  workspaceTabPath,
} from "./route-state";
import type { BootstrapPayload, SurfaceTab, Workspace } from "./types";

interface PendingActiveRoute {
  requestId: number;
  workspaceId: string;
  tabId: string;
}

export interface ActivateWorkspaceTabOptions {
  focusTerminal?: boolean;
  replaceHistory?: boolean;
}

interface UseAppRoutingOptions {
  stateRef: MutableRefObject<BootstrapPayload | null>;
  setState: Dispatch<SetStateAction<BootstrapPayload | null>>;
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

// Owns the URL <-> active-workspace/tab machine: optimistic activation with
// request-id guarded persistence, history push/replace bookkeeping, and
// popstate handling. The pure state transforms live in route-state.ts.
export function useAppRouting(options: UseAppRoutingOptions) {
  const { stateRef, setState, openTuiMode, activeWorkspace, activeTab } = options;
  const lastSyncedPath = useRef("");
  const activeRouteRequestId = useRef(0);
  const pendingActiveRoute = useRef<PendingActiveRoute | null>(null);
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
      const pending = pendingActiveRoute.current;
      const routed = applyRouteTargetToState(incoming, pending ?? parseRouteTarget(window.location.pathname));
      // Structural sharing: keep previous object identities for unchanged
      // subtrees so memoized panes/tabs skip re-rendering on resyncs.
      const applied = reconcile(stateRef.current, routed);
      stateRef.current = applied;
      setState(applied);
    },
    [setState, stateRef],
  );

  const persistActiveRoute = useCallback(
    async (
      workspaceId: string,
      tabId: string,
      requestId: number,
      shouldActivateWorkspace: boolean,
      shouldActivateTab: boolean,
    ) => {
      let nextState: BootstrapPayload | null = null;
      try {
        if (shouldActivateWorkspace) nextState = await api.activateWorkspace(workspaceId);
        if (shouldActivateTab) nextState = await api.activateTab(workspaceId, tabId);
      } catch (nextError) {
        if (activeRouteRequestId.current === requestId) {
          pendingActiveRoute.current = null;
          optionsRef.current.onError(String(nextError));
          void refresh();
        }
        return;
      }

      if (activeRouteRequestId.current !== requestId) return;
      pendingActiveRoute.current = null;
      if (nextState) {
        const applied = activateWorkspaceTabInState(nextState, workspaceId, tabId);
        stateRef.current = applied;
        setState(applied);
      }
    },
    [refresh, setState, stateRef],
  );

  const activateWorkspaceTab = useCallback(
    (workspaceId: string, tabId: string | undefined, activateOptions: ActivateWorkspaceTabOptions = {}) => {
      const { onError, onMobileNavigate, isMobile, clearBellPanes, requestTerminalFocus } = optionsRef.current;
      const current = stateRef.current;
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

      const optimistic = activateWorkspaceTabInState(current, workspaceId, target.tab.id);
      stateRef.current = optimistic;
      setState((snapshot) => {
        if (!snapshot) return snapshot;
        const next = activateWorkspaceTabInState(snapshot, workspaceId, target.tab.id);
        stateRef.current = next;
        return next;
      });
      if (activateOptions.focusTerminal) requestTerminalFocus(workspaceId, target.tab.id);

      const shouldActivateWorkspace = current.activeWorkspaceId !== workspaceId;
      const shouldActivateTab = target.workspace.activeTabId !== target.tab.id;
      if (!shouldActivateWorkspace && !shouldActivateTab) {
        if (shouldMarkWorkspaceRead) {
          void api.markWorkspaceNotificationsRead(workspaceId)
            .then((payload) => refresh(activateWorkspaceTabInState(payload, workspaceId, target.tab.id)))
            .catch((nextError) => onError(String(nextError)));
        }
        return;
      }

      const requestId = ++activeRouteRequestId.current;
      pendingActiveRoute.current = { requestId, workspaceId, tabId: target.tab.id };
      void persistActiveRoute(workspaceId, target.tab.id, requestId, shouldActivateWorkspace, shouldActivateTab);
    },
    [chromePath, persistActiveRoute, refresh, setState, stateRef],
  );

  // Keep the address bar in sync with the active workspace/tab.
  useEffect(() => {
    if (!stateRef.current) return;
    if (!activeWorkspace || !activeTab) {
      const nextPath = chromePath("/");
      if (currentChromePath() !== nextPath) {
        window.history.replaceState(null, "", nextPath);
        lastSyncedPath.current = nextPath;
      }
      return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stateRef is read, not depended on
  }, [activeWorkspace, activeTab, chromePath]);

  useEffect(() => {
    const onPopState = () => {
      const target = parseRouteTarget(window.location.pathname);
      if (target) activateWorkspaceTab(target.workspaceId, target.tabId, { replaceHistory: true });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [activateWorkspaceTab]);

  return { refresh, activateWorkspaceTab, chromePath };
}

const currentChromePath = () => `${window.location.pathname}${window.location.search}`;
