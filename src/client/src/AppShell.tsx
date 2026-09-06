import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { GripVertical, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { api, modalSettingsUpdate, UnauthorizedError, WorkspaceReorderConflictError } from "./api";
import { DiagnosticsModal } from "./DiagnosticsModal";
import { ActivityPanel, buildActivityItems } from "./ActivityPanel";
import { AgentFleet, type AgentFleetRow } from "./AgentFleet";
import { buildSessionRows, sessionActivities } from "./session-inventory";
import { HostInspector } from "./HostInspector";
import { directionalPane, type PaneDirection } from "./pane-navigation";
import { AgentInputRequestShelf } from "./AgentInputRequestShelf";
import { isAgentInputRequestVisible } from "./agent-input-reference";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { WorkspaceRenameDialog } from "./WorkspaceRenameDialog";
import { SettingsModal, cleanAlias, defaultSettings } from "./SettingsModal";
import { MachineManagerModal } from "./MachineManagerModal";
import { ColorSchemeProvider } from "./color-scheme-context";
import { colorSchemeById, colorSchemeCssVariables } from "./color-schemes";

// The full pane surface (Ghostty + Kitty graphics) stays lazy; the lightweight
// boot screen owns the initial Ghostty startup while the API bootstrap runs.
const LayoutView = lazy(() => import("./LayoutView").then((m) => ({ default: m.LayoutView })));
import { useAppState, useAppStore } from "./app-store";
import { RetroBootScreen } from "./RetroBootScreen";
import { EmptyWorkspaceView } from "./EmptyWorkspaceView";
import { MobileAgentSurface } from "./MobileAgentSurface";
import { MobileCloseDialog, type MobileCloseRequest } from "./MobileCloseDialog";
import { OpenTuiActivityPanel } from "./OpenTuiActivityPanel";
import { OpenTuiMobileChrome } from "./OpenTuiMobileChrome";
import type { OpenTuiActivityRow } from "./OpenTuiActivityPanel";
import { OpenTuiCommandPalette } from "./OpenTuiCommandPalette";
import { OpenTuiSidebar } from "./OpenTuiSidebar";
import { aggregateAgentActivityByWorkspace, agentLifecycleStatus, latestAgentActivityByPane } from "./workspace-agent-activity";
import type { OpenTuiSidebarMachine, OpenTuiSidebarWorkspace } from "./OpenTuiSidebar";
import { OpenTuiTopbar } from "./OpenTuiTopbar";
import { applyClientViewToState, loadActivePaneSelections, loadActiveTabSelections, markWorkspaceNotificationsReadInState, parseRouteTarget, workspaceTabPath } from "./route-state";
import { compactMiddlePath, normalizeUserPath } from "./path-display";
import { formatSessionReference } from "./session-reference";
import { ScreenStreamViewer } from "./ScreenStream";
import { Toasts, useToasts } from "./Toasts";
import { hidePendingWorkspaceCloses } from "./workspace-close";
import { WORKSPACE_CLOSE_GRACE_MS } from "../../shared/workspace-close";
import { useAppRouting } from "./useAppRouting";
import { useStoreLifecycle } from "./store/use-store-lifecycle";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { isApplePlatform } from "./keybinding-platform";
import { defaultKeybindings, displayBindingForAction, type KeybindingAction } from "../../shared/keybindings";
import { usePaneActions } from "./usePaneActions";
import { maxSidebarWidth, useSidebar } from "./useSidebar";
import { writeBrowserClipboard } from "./clipboard";
import { summarizeWorkspaceVersion } from "./workspace-version";
import { useMobileViewportState } from "./mobile-viewport";
import { loadMachineTargetId, persistMachineTargetId, resolveMachineTargetId } from "./machine-target";
import {
  workspacePresentationDescriptor,
  workspacePresentationMachineId,
  workspacePresentationTarget,
} from "./workspace-presentation";
import {
  contextMobileSurfaceMode,
  legacyMobileSurfaceModeStorageKey,
  loadLegacyMobileSurfaceMode,
  loadMobileSurfaceModes,
  pruneMobileSurfaceModes,
  sameMobileSurfaceModes,
  saveMobileSurfaceModes,
  type MobileSurfaceMode,
} from "./mobile-surface-mode";
import {
  deriveWorkspaceTree,
  expandWorkspaceAncestors,
  orderWorkspaceRowsForDisplay,
  pruneCollapsedWorkspaceIds,
  pruneFavoriteWorkspaceIds,
  rebaseCollapsedWorkspaceIds,
  rebaseFavoriteWorkspaceIds,
  sameWorkspaceIds,
  type WorkspaceActivityAggregate,
  type WorkspaceAgentStatus,
} from "./workspace-tree";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "./types";
import {
  applyOptimisticCreations,
  createClientSplitIds,
  createClientTabIds,
  createClientWorkspaceIds,
  optimisticSplitCreation,
  optimisticTabCreation,
  optimisticWorkspaceCreation,
} from "./store/optimistic-creation";
import { useOptimisticCreations } from "./store/use-optimistic-creations";
import type {
  AgentActivity,
  BootstrapPayload,
  DoctorReport,
  DurableSessionAudit,
  LayoutNode,
  MachineStatus,
  SplitDirection,
  SurfaceTab,
  TerminalMedia,
  TerminalNotification,
  TerminalRun,
  WorkspaceReorderPosition,
  WmuxSettings,
} from "./types";

const maxMountedTabViews = 6;

const currentAgentInputDeepLink = (): { id: string; generation?: number } | null => {
  const query = new URLSearchParams(window.location.search);
  const id = query.get("agentInput");
  if (!id) return null;
  const rawGeneration = query.get("generation");
  const generation = rawGeneration && /^\d+$/.test(rawGeneration) ? Number(rawGeneration) : undefined;
  return { id, ...(generation && Number.isSafeInteger(generation) ? { generation } : {}) };
};

const removeCurrentAgentInputDeepLink = (): void => {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("agentInput") && !url.searchParams.has("generation")) return;
  url.searchParams.delete("agentInput");
  url.searchParams.delete("generation");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
};

interface MountedTabView {
  key: string;
  tabId: string;
  tab: SurfaceTab;
}

interface TerminalFocusRequest {
  key: string;
  token: number;
}

interface PendingAction {
  key: string;
  label: string;
}

interface PendingWorkspaceClose {
  request: ReturnType<typeof api.scheduleWorkspaceClose>;
  toastId: number;
  restoreTabId?: string;
}

export function AppShell() {
  const mobileViewport = useMobileViewportState();
  const store = useAppStore();
  const authoritativeState = useAppState();
  const [pendingWorkspaceIds, setPendingWorkspaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingWorkspaceCloses = useRef(new Map<string, PendingWorkspaceClose>());
  const state = useMemo(
    () => hidePendingWorkspaceCloses(authoritativeState, pendingWorkspaceIds),
    [authoritativeState, pendingWorkspaceIds],
  );
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("legacy")) return;
    url.searchParams.delete("legacy");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const [newMachineId, setNewMachineId] = useState(() => loadMachineTargetId(window.localStorage));
  const [bootComplete, setBootComplete] = useState(false);
  const { toasts, pushToast, dismissToast } = useToasts();
  useEffect(() => {
    if (!authoritativeState) return;
    const authoritativeWorkspaceIds = new Set(
      authoritativeState.workspaces.map((workspace) => workspace.id),
    );
    const closedWorkspaceIds = [...pendingWorkspaceCloses.current.keys()].filter(
      (workspaceId) => !authoritativeWorkspaceIds.has(workspaceId),
    );
    if (closedWorkspaceIds.length === 0) return;
    for (const workspaceId of closedWorkspaceIds) {
      const pending = pendingWorkspaceCloses.current.get(workspaceId);
      if (pending) dismissToast(pending.toastId);
      pendingWorkspaceCloses.current.delete(workspaceId);
    }
    setPendingWorkspaceIds((current) => {
      const next = new Set(current);
      for (const workspaceId of closedWorkspaceIds) next.delete(workspaceId);
      return next;
    });
  }, [authoritativeState, dismissToast]);
  const {
    sidebarCollapsed,
    sidebarWidth,
    toggleSidebar,
    collapseSidebar,
    expandSidebar,
    startSidebarResize,
    onSidebarResizerKeyDown,
  } = useSidebar(mobileViewport.isMobile);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [machineManagerOpen, setMachineManagerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [renameWorkspaceDialog, setRenameWorkspaceDialog] = useState<{ id: string; title: string } | null>(null);
  const [previewSettings, setPreviewSettings] = useState<WmuxSettings | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [agentFleetOpen, setAgentFleetOpen] = useState(false);
  const [fleetDocked, setFleetDocked] = useState(false);
  const [zoomedTabId, setZoomedTabId] = useState<string | null>(null);
  const [inspectedHostId, setInspectedHostId] = useState<string | null>(null);
  const [streamOpen, setStreamOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState("");
  const [mobileSurfaceModes, setMobileSurfaceModes] = useState<Record<string, MobileSurfaceMode>>(() =>
    loadMobileSurfaceModes(window.sessionStorage),
  );
  const [legacyMobileSurfaceMode, setLegacyMobileSurfaceMode] = useState<MobileSurfaceMode | undefined>(() =>
    loadLegacyMobileSurfaceMode(window.localStorage),
  );
  const [pendingMobileClose, setPendingMobileClose] = useState<MobileCloseRequest | null>(null);
  const [bellPaneIds, setBellPaneIds] = useState<Set<string>>(() => new Set());
  const [mountedTabKeys, setMountedTabKeys] = useState<string[]>([]);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<TerminalFocusRequest | null>(null);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const {
    begin: beginOptimisticCreation,
    creations: optimisticCreations,
    finish: finishOptimisticCreation,
    pendingPaneLabels,
  } = useOptimisticCreations(store);
  const pendingActionKeys = useRef(new Set<string>());
  const collapseWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const collapseWriteVersion = useRef(0);
  const desiredCollapsedWorkspaceIds = useRef<string[] | null>(null);
  const favoriteWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const favoriteWriteVersion = useRef(0);
  const desiredFavoriteWorkspaceIds = useRef<string[] | null>(null);
  const terminalFocusToken = useRef(0);
  const [agentInputDeepLink, setAgentInputDeepLink] = useState(() => currentAgentInputDeepLink());
  const mobileSidebarRef = useRef<HTMLElement | null>(null);
  const mobileSidebarCloseRef = useRef<HTMLButtonElement | null>(null);
  const finishBoot = useCallback(() => setBootComplete(true), []);
  const dismissMobileClose = useCallback(() => setPendingMobileClose(null), []);
  const openMobileNavigation = useCallback(() => {
    if (!sidebarCollapsed) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    mobileViewport.dispatchInteraction("drawer-opened");
    expandSidebar();
  }, [expandSidebar, mobileViewport.dispatchInteraction, sidebarCollapsed]);
  const toggleMobileNavigation = useCallback(() => {
    if (sidebarCollapsed) openMobileNavigation();
    else collapseSidebar();
  }, [collapseSidebar, openMobileNavigation, sidebarCollapsed]);

  const rebaseIncomingState = useCallback((payload: BootstrapPayload): BootstrapPayload =>
    rebaseFavoriteWorkspaceIds(
      rebaseCollapsedWorkspaceIds(
        applyOptimisticCreations({ ...payload, agentInputRequests: payload.agentInputRequests ?? [] }, optimisticCreations.current.values()),
        desiredCollapsedWorkspaceIds.current,
      ),
      desiredFavoriteWorkspaceIds.current,
    ), []);

  useEffect(() => {
    if (!mobileViewport.isMobile || sidebarCollapsed) return;
    const closeNavigation = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapseSidebar();
    };
    window.addEventListener("keydown", closeNavigation);
    return () => window.removeEventListener("keydown", closeNavigation);
  }, [collapseSidebar, mobileViewport.isMobile, sidebarCollapsed]);

  useEffect(() => {
    if (mobileSidebarRef.current) mobileSidebarRef.current.inert = mobileViewport.isMobile && sidebarCollapsed;
  }, [mobileViewport.isMobile, sidebarCollapsed]);

  useEffect(() => {
    if (!mobileViewport.isMobile) return;
    mobileViewport.dispatchInteraction(sidebarCollapsed ? "drawer-closed" : "drawer-opened");
  }, [mobileViewport.dispatchInteraction, mobileViewport.isMobile, sidebarCollapsed]);

  useEffect(() => {
    if (!mobileViewport.isMobile) return;
    if (mobileViewport.interactionState === "drawer-open") {
      mobileSidebarCloseRef.current?.focus({ preventScroll: true });
      return;
    }
    if (mobileViewport.interactionState !== "drawer-closing-focus-return") return;
    const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-controls="wmux-sidebar"]'));
    triggers.find((trigger) => trigger.getClientRects().length > 0)?.focus({ preventScroll: true });
    mobileViewport.dispatchInteraction("drawer-focus-restored");
  }, [
    mobileViewport.dispatchInteraction,
    mobileViewport.interactionState,
    mobileViewport.isMobile,
  ]);

  const runPending = useCallback(
    async <T,>(key: string, label: string, action: () => Promise<T>): Promise<T | undefined> => {
      if (pendingActionKeys.current.has(key)) return undefined;
      pendingActionKeys.current.add(key);
      setPendingActions((current) => [...current, { key, label }]);
      try {
        return await action();
      } catch (nextError) {
        pushToast(`${label.replace(/\.{3}$/, "")} failed: ${describeActionError(nextError)}`);
        return undefined;
      } finally {
        pendingActionKeys.current.delete(key);
        setPendingActions((current) => current.filter((candidate) => candidate.key !== key));
      }
    },
    [pushToast],
  );

  const refreshDiagnostics = useCallback(async () => {
    setDoctorLoading(true);
    setDoctorError("");
    try {
      setDoctorReport(await api.doctor());
    } catch (nextError) {
      setDoctorError(describeActionError(nextError));
    } finally {
      setDoctorLoading(false);
    }
  }, []);

  const openDiagnostics = useCallback(() => {
    setDiagnosticsOpen(true);
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  const {
    authRequired,
    dismissMedia,
    load: loadBootstrap,
    loadError,
    loadRef: loadBootstrapRef,
    mediaItems,
    refreshRef,
    sendEventSocketMessage,
    serviceConnection,
  } = useStoreLifecycle({
    store,
    rebaseIncomingState,
    activateRouteTarget,
    describeError: describeActionError,
  });

  const activeWorkspace = useMemo(
    () => state?.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? state?.workspaces[0],
    [state],
  );
  const activeTab = activeWorkspace?.tabs.find((tab) => tab.id === activeWorkspace.activeTabId) ?? activeWorkspace?.tabs[0];
  const activePane = activeTab?.panes.find((pane) => pane.id === activeTab.activePaneId) ?? activeTab?.panes[0];
  const activeTabKey = activeWorkspace && activeTab ? mountedTabViewKey(activeWorkspace.id, activeTab.id) : null;
  const tabViewsByKey = useMemo(() => {
    const views = new Map<string, MountedTabView>();
    for (const workspace of state?.workspaces ?? []) {
      for (const tab of workspace.tabs) {
        const key = mountedTabViewKey(workspace.id, tab.id);
        views.set(key, { key, tabId: tab.id, tab });
      }
    }
    return views;
  }, [state?.workspaces]);
  const renderedTabKeys = useMemo(() => {
    if (!activeTabKey || mountedTabKeys.includes(activeTabKey)) return mountedTabKeys;
    return [activeTabKey, ...mountedTabKeys].slice(0, maxMountedTabViews);
  }, [activeTabKey, mountedTabKeys]);
  const mountedTabViews = useMemo(
    () => renderedTabKeys.flatMap((key) => {
      const view = tabViewsByKey.get(key);
      return view ? [view] : [];
    }),
    [renderedTabKeys, tabViewsByKey],
  );
  const machines = state?.machines ?? [];
  const keybindings = state?.keybindings ?? defaultKeybindings;
  const appleKeybindings = useMemo(isApplePlatform, []);
  const shortcutFor = useCallback(
    (action: KeybindingAction) => displayBindingForAction(keybindings, action, appleKeybindings),
    [appleKeybindings, keybindings],
  );
  const persistedSettings = state?.settings ?? defaultSettings;
  const settingsDefaults = state?.settingsDefaults ?? defaultSettings;
  const settings = previewSettings ?? persistedSettings;
  const displayMachines = useMemo(() => machines.map((machine) => withMachineAlias(machine, settings)), [machines, settings]);
  const targetMachineId = resolveMachineTargetId(newMachineId, displayMachines);
  const selectedMachine = displayMachines.find((machine) => machine.id === targetMachineId);
  const notifications = state?.notifications ?? [];
  const unreadNotifications = notifications.filter((notification) => !notification.read);
  const unreadByPaneId = useMemo(() => countUnreadBy(notifications, "paneId"), [notifications]);
  const unreadByTabId = useMemo(() => countUnreadBy(notifications, "tabId"), [notifications]);
  const unreadByWorkspaceId = useMemo(() => countUnreadBy(notifications, "workspaceId"), [notifications]);
  const latestUnreadByWorkspaceId = useMemo(() => latestUnreadByWorkspace(notifications), [notifications]);
  const mediaByPaneId = useMemo(() => groupMediaByPane(mediaItems), [mediaItems]);
  const sessionRows = useMemo(() => state ? buildSessionRows(state, displayMachines) : [], [state, displayMachines]);
  const agentEvents = useMemo(() => sessionActivities(sessionRows), [sessionRows]);
  const runs = state?.runs ?? [];
  const streams = state?.streams ?? [];
  const bellByWorkspaceId = useMemo(() => bellWorkspaces(state, bellPaneIds), [bellPaneIds, state]);
  const agentActivityByWorkspaceId = useMemo(() => aggregateAgentActivityByWorkspace(agentEvents), [agentEvents]);
  const latestAgentByPaneId = useMemo(() => latestAgentActivityByPane(agentEvents), [agentEvents]);
  const latestRunByPaneId = useMemo(() => latestRunByPane(runs), [runs]);
  const activePaneHasAgentContext = paneHasAgentContext(
    activePane,
    activePane ? latestAgentByPaneId.get(activePane.id) : undefined,
  );
  const mobileSurfaceMode = activePane
    ? mobileSurfaceModes[activePane.id] ?? legacyMobileSurfaceMode ?? contextMobileSurfaceMode(activePaneHasAgentContext)
    : "terminal";
  const setMobileSurfaceMode = useCallback((mode: MobileSurfaceMode) => {
    if (!activePane) return;
    setMobileSurfaceModes((current) => current[activePane.id] === mode ? current : { ...current, [activePane.id]: mode });
  }, [activePane]);

  useEffect(() => {
    if (!mobileViewport.isMobile || !activePane || mobileSurfaceModes[activePane.id]) return;
    const initial = legacyMobileSurfaceMode ?? contextMobileSurfaceMode(activePaneHasAgentContext);
    setMobileSurfaceModes((current) => current[activePane.id] ? current : { ...current, [activePane.id]: initial });
    if (legacyMobileSurfaceMode) {
      window.localStorage.removeItem(legacyMobileSurfaceModeStorageKey);
      setLegacyMobileSurfaceMode(undefined);
    }
  }, [activePane, activePaneHasAgentContext, legacyMobileSurfaceMode, mobileSurfaceModes, mobileViewport.isMobile]);

  useEffect(() => {
    if (!state) return;
    const paneIds = (state?.workspaces ?? []).flatMap((workspace) =>
      workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.id)),
    );
    setMobileSurfaceModes((current) => {
      const next = pruneMobileSurfaceModes(current, paneIds);
      return sameMobileSurfaceModes(current, next) ? current : next;
    });
  }, [state?.workspaces]);

  useEffect(() => {
    saveMobileSurfaceModes(window.sessionStorage, mobileSurfaceModes);
  }, [mobileSurfaceModes]);

  useEffect(() => {
    if (!mobileViewport.isMobile) setPendingMobileClose(null);
  }, [mobileViewport.isMobile]);

  useEffect(() => {
    setMountedTabKeys((current) => {
      const validKeys = current.filter((key) => tabViewsByKey.has(key));
      const next = activeTabKey
        ? [activeTabKey, ...validKeys.filter((key) => key !== activeTabKey)]
        : validKeys;
      const limited = next.slice(0, maxMountedTabViews);
      return sameStringList(current, limited) ? current : limited;
    });
  }, [activeTabKey, tabViewsByKey]);

  useEffect(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest(".layout-cache-item.hidden")) {
      activeElement.blur();
    }
  }, [activeTabKey]);

  const workspaceActivity = useMemo(() => {
    const activity = new Map<string, WorkspaceActivityAggregate>();
    for (const workspace of state?.workspaces ?? []) {
      const agent = agentActivityByWorkspaceId.get(workspace.id)?.representative;
      activity.set(workspace.id, {
        unreadCount: unreadByWorkspaceId.get(workspace.id) ?? 0,
        bell: bellByWorkspaceId.has(workspace.id),
        agentStatus: agent ? workspaceAgentStatusClass(agent.status, agent.heartbeatActive) : undefined,
      });
    }
    return activity;
  }, [agentActivityByWorkspaceId, bellByWorkspaceId, state?.workspaces, unreadByWorkspaceId]);
  const openTuiWorkspaceTree = useMemo(() => deriveWorkspaceTree({
    workspaces: state?.workspaces ?? [],
    activeWorkspaceId: activeWorkspace?.id,
    collapsedWorkspaceIds: persistedSettings.collapsedWorkspaceIds,
    activityByWorkspaceId: workspaceActivity,
  }), [activeWorkspace?.id, persistedSettings.collapsedWorkspaceIds, state?.workspaces, workspaceActivity]);
  const openTuiWorkspaces = useMemo<OpenTuiSidebarWorkspace[]>(
    () =>
      openTuiWorkspaceTree.rows.flatMap((treeRow) => {
        const workspace = treeRow.workspace;
        const agentActivity = agentActivityByWorkspaceId.get(workspace.id);
        const latestAgent = agentActivity?.representative;
        const presentation = workspacePresentationTarget(workspace, latestAgent);
        const presentationMachineId = presentation.machineId;
        const machine = machineFor(displayMachines, presentationMachineId);
        const sourceMachine = machineFor(machines, presentationMachineId);
        const affinityMachine = machineFor(machines, workspace.machineId);
        const latestUnread = latestUnreadByWorkspaceId.get(workspace.id);
        const latestAgentName = latestAgent ? workspaceAgentName(latestAgent) : undefined;
        const latestAgentStatusLabel = latestAgent ? workspaceAgentStatusLabel(latestAgent) : undefined;
        const tab = presentation.tab;
        if (!tab) return [];
        const pane = presentation.pane;
        const cwd = normalizeUserPath(pane?.cwd);
        const descriptor = dedupeAgentDescriptor(
          latestUnread?.body ||
            latestUnread?.subtitle ||
            workspaceAgentSummary(latestAgent) ||
            displayWorkspaceDescriptor(
              workspacePresentationDescriptor(workspace, machine?.name ?? presentationMachineId, affinityMachine?.name),
              machine,
              sourceMachine,
              presentationMachineId,
              workspace.machineId,
            ),
          latestAgentStatusLabel,
        );
        const host = displayWorkspaceHost(machine, sourceMachine, presentationMachineId);
        const visibleDescriptor = compactWorkspaceDescription(descriptor, 72);
        const version = summarizeWorkspaceVersion(workspace, displayMachines);
        return [
          {
            id: workspace.id,
            tabId: tab.id,
            title: workspace.name,
            descriptor: visibleDescriptor && visibleDescriptor !== host ? visibleDescriptor : "",
            machineId: presentationMachineId,
            host,
            cwd,
            reachable: Boolean(machine?.reachable),
            active: workspace.id === activeWorkspace?.id,
            unreadCount: treeRow.ownActivity.unreadCount,
            agentCreated: workspace.createdBy === "agent",
            agentName: latestAgentName,
            agentStatus: latestAgent ? workspaceAgentStatusClass(latestAgent.status, latestAgent.heartbeatActive) : undefined,
            agentPaneCount: agentActivity?.paneCount ?? 0,
            activeAgentPaneCount: agentActivity?.activePaneCount ?? 0,
            heartbeatAgentPaneCount: agentActivity?.heartbeatPaneCount ?? 0,
            paneCount: workspace.tabs.reduce((count, candidate) => count + candidate.panes.length, 0),
            sessionId: pane?.id,
            versionStatus: version?.status,
            versionLabel: version?.label,
            versionDetail: version?.detail,
            bell: treeRow.ownActivity.bell,
            depth: treeRow.depth,
            hasChildren: treeRow.hasChildren,
            expanded: treeRow.effectiveExpanded,
            hiddenUnreadCount: treeRow.hiddenActivity.unreadCount,
            hiddenBell: treeRow.hiddenActivity.bell,
            hiddenAgentStatus: treeRow.hiddenActivity.agentStatus,
            canOutdent: Boolean(treeRow.parentId),
            parentId: treeRow.parentId,
            favorite: (persistedSettings.favoriteWorkspaceIds ?? []).includes(workspace.id),
          },
        ];
      }),
    [
      activeWorkspace?.id,
      bellByWorkspaceId,
      displayMachines,
      agentActivityByWorkspaceId,
      latestUnreadByWorkspaceId,
      machines,
      unreadByWorkspaceId,
      openTuiWorkspaceTree.rows,
      persistedSettings.favoriteWorkspaceIds,
    ],
  );
  const openTuiMachines = useMemo<OpenTuiSidebarMachine[]>(
    () =>
      displayMachines.map((machine) => {
        const machineWorkspaces = (state?.workspaces ?? []).filter(
          (workspace) => workspacePresentationTarget(
            workspace,
            agentActivityByWorkspaceId.get(workspace.id)?.representative,
          ).machineId === machine.id,
        );
        const activeAgentCount = machineWorkspaces.filter((workspace) => {
          const agent = agentActivityByWorkspaceId.get(workspace.id)?.representative;
          if (!agent) return false;
          const status = agentLifecycleStatus(agent.status);
          return status === "running" || status === "waiting";
        }).length;
        return {
          id: machine.id,
          name: machine.name,
          version: machine.releaseVersion,
          reachable: machine.reachable,
          detail: machineStatusDetail(machine),
          workspaceCount: machineWorkspaces.length,
          activeAgentCount,
        };
      }),
    [agentActivityByWorkspaceId, displayMachines, state?.workspaces],
  );
  // The same visible order the sidebar renders; digit and previous/next
  // workspace shortcuts index into this list.
  const displayOrderedWorkspaces = useMemo(
    () => orderWorkspaceRowsForDisplay(
      openTuiWorkspaces,
      openTuiMachines.map((machine) => machine.id),
      settings.groupSidebarSessionsByHost,
    ),
    [openTuiMachines, openTuiWorkspaces, settings.groupSidebarSessionsByHost],
  );
  const openTuiActivityRows = useMemo<OpenTuiActivityRow[]>(
    () => {
      if (!state) return [];
      return buildActivityItems(state.agentEvents, state.runs)
        .slice(0, 100)
        .map((item): OpenTuiActivityRow => {
          if (item.kind === "agent") {
            const workspace = state.workspaces.find((candidate) => candidate.id === item.event.workspaceId);
            const machine = workspace ? machineFor(displayMachines, workspace.machineId) : undefined;
            const title = item.event.title || workspace?.name || item.event.agent;
            const summary = compactWorkspaceDescription(item.event.summary, 140);
            return {
              id: item.id,
              kind: item.event.agent,
              title,
              summary,
              meta: [item.event.status, workspace?.name ?? "workspace removed", machine?.name ?? workspace?.machineId ?? "host unknown", formatRelativeTime(item.event.createdAt)]
                .filter(Boolean)
                .join(" / "),
              status: openTuiActivityStatus(item.event.status),
            };
          }
          const workspace = state.workspaces.find((candidate) => candidate.id === item.run.workspaceId);
          const tab = workspace?.tabs.find((candidate) => candidate.id === item.run.tabId);
          const machine = workspace ? machineFor(displayMachines, workspace.machineId) : undefined;
          return {
            id: item.id,
            kind: "run",
            title: item.run.command,
            summary: `${item.run.status === "started" ? "running" : `exit ${item.run.exitCode ?? "?"}`}${item.run.completedAt ? ` / ${formatDuration(item.run.startedAt, item.run.completedAt)}` : ""}`,
            meta: [workspace?.name ?? "workspace removed", tab?.title ?? "tab removed", machine?.name ?? workspace?.machineId ?? "host unknown", formatRelativeTime(item.run.completedAt ?? item.run.startedAt)]
              .filter(Boolean)
              .join(" / "),
            status: openTuiActivityStatus(item.run.status),
          };
        });
    },
    [displayMachines, state],
  );

  const clearBellPanes = useCallback((paneIds: string[]) => {
    if (paneIds.length === 0) return;
    setBellPaneIds((current) => {
      if (paneIds.every((paneId) => !current.has(paneId))) return current;
      const next = new Set(current);
      for (const paneId of paneIds) next.delete(paneId);
      return next;
    });
  }, []);

  const requestTerminalFocus = useCallback((workspaceId: string, tabId: string) => {
    setTerminalFocusRequest({
      key: mountedTabViewKey(workspaceId, tabId),
      token: ++terminalFocusToken.current,
    });
  }, []);

  // Nothing focuses the active terminal while the boot overlay covers the
  // shell, so request focus once when the overlay lifts. This is a fallback:
  // if another surface (an agent-input question card opened from a deep link)
  // already holds focus, it must keep it.
  useEffect(() => {
    if (!bootComplete || mobileViewport.isMobile) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !focused.closest(".retro-boot-screen")) return;
    if (activeWorkspace && activeTab) requestTerminalFocus(activeWorkspace.id, activeTab.id);
  }, [bootComplete]);

  const { refresh, activateWorkspaceTab, activatePane } = useAppRouting({
    store,
    activeWorkspace,
    activeTab,
    onError: (message) => pushToast(`Sync failed: ${message}`),
    onMobileNavigate: () => {
      collapseSidebar();
      settleMobileViewportAfterNavigation();
    },
    isMobile: mobileViewport.isMobile,
    clearBellPanes,
    requestTerminalFocus,
    rebaseIncomingState,
  });
  refreshRef.current = refresh;

  useEffect(() => {
    const update = () => setAgentInputDeepLink(currentAgentInputDeepLink());
    const notificationNavigate = () => update();
    window.addEventListener("popstate", update);
    window.addEventListener("wmux-notification-navigate", notificationNavigate);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("wmux-notification-navigate", notificationNavigate);
    };
  }, []);

  const clearAgentInputDeepLink = useCallback(() => {
    removeCurrentAgentInputDeepLink();
    setAgentInputDeepLink(null);
  }, []);

  useEffect(() => {
    const requestId = agentInputDeepLink?.id;
    if (!requestId || !state) return;
    const request = (state.agentInputRequests ?? []).find((candidate) => candidate.id === requestId);
    if (!request || (agentInputDeepLink.generation !== undefined
      && request.generation !== agentInputDeepLink.generation)) return;
    const requestVisible = isAgentInputRequestVisible(request.state);
    if (activeWorkspace?.id !== request.workspaceId || activeTab?.id !== request.tabId) {
      activateWorkspaceTab(request.workspaceId, request.tabId);
      return;
    }
    if (activePane?.id !== request.paneId) {
      activatePane(request.tabId, request.paneId);
      if (!requestVisible) clearAgentInputDeepLink();
      return;
    }
    if (!requestVisible) {
      clearAgentInputDeepLink();
      return;
    }
    // The navigation above also queued a terminal focus request. Drop it so a
    // terminal that finishes mounting after the reassert window below cannot
    // steal focus from the question card on slow hardware.
    setTerminalFocusRequest(null);
    let settleTimer: number | undefined;
    let focusInterval: number | undefined;
    const focusCard = (settled: boolean) => {
      const card = document.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(requestId)}"]`);
      const focusTarget = card?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? card;
      focusTarget?.focus({ preventScroll: false });
      card?.scrollIntoView({ block: "nearest" });
      if (card && settled) clearAgentInputDeepLink();
    };
    const frame = window.requestAnimationFrame(() => {
      focusCard(false);
      // Terminal startup also requests focus in several mount phases. Reassert
      // through that bounded window so the stable request generation wins.
      focusInterval = window.setInterval(() => focusCard(false), 50);
      settleTimer = window.setTimeout(() => {
        if (focusInterval) window.clearInterval(focusInterval);
        focusInterval = undefined;
        focusCard(true);
      }, 500);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (focusInterval) window.clearInterval(focusInterval);
      if (settleTimer) window.clearTimeout(settleTimer);
    };
  }, [activatePane, activateWorkspaceTab, activePane?.id, activeTab?.id, activeWorkspace?.id, agentInputDeepLink, clearAgentInputDeepLink, state]);

  const persistCollapsedWorkspaceIds = useCallback((collapsedWorkspaceIds: string[]): Promise<void> => {
    const version = ++collapseWriteVersion.current;
    desiredCollapsedWorkspaceIds.current = collapsedWorkspaceIds;
    store.update((current) => current ? { ...current, settings: { ...current.settings, collapsedWorkspaceIds } } : current);
    const request = collapseWriteQueue.current
      .catch(() => undefined)
      .then(async () => {
        const response = await api.updateCollapsedWorkspaceIds(collapsedWorkspaceIds);
        if (version === collapseWriteVersion.current) {
          desiredCollapsedWorkspaceIds.current = null;
          await refresh(response.state);
        }
      })
      .catch((error) => {
        if (version === collapseWriteVersion.current) {
          desiredCollapsedWorkspaceIds.current = null;
          pushToast(`Workspace collapse sync failed: ${describeActionError(error)}`);
          void loadBootstrapRef.current();
        }
      });
    collapseWriteQueue.current = request;
    return request;
  }, [pushToast, refresh, store]);

  const toggleWorkspaceCollapsed = useCallback((workspaceId: string) => {
    const current = store.get();
    if (!current) return;
    const currentIds = desiredCollapsedWorkspaceIds.current ?? current.settings.collapsedWorkspaceIds;
    const nextIds = currentIds.includes(workspaceId)
      ? currentIds.filter((id) => id !== workspaceId)
      : [...currentIds, workspaceId];
    void persistCollapsedWorkspaceIds(nextIds);
  }, [persistCollapsedWorkspaceIds, store]);

  const persistFavoriteWorkspaceIds = useCallback((favoriteWorkspaceIds: string[]): Promise<void> => {
    const version = ++favoriteWriteVersion.current;
    desiredFavoriteWorkspaceIds.current = favoriteWorkspaceIds;
    store.update((current) => current ? { ...current, settings: { ...current.settings, favoriteWorkspaceIds } } : current);
    const request = favoriteWriteQueue.current
      .catch(() => undefined)
      .then(async () => {
        const response = await api.updateFavoriteWorkspaceIds(favoriteWorkspaceIds);
        if (version === favoriteWriteVersion.current) {
          desiredFavoriteWorkspaceIds.current = null;
          await refresh(response.state);
        }
      })
      .catch((error) => {
        if (version === favoriteWriteVersion.current) {
          desiredFavoriteWorkspaceIds.current = null;
          pushToast(`Favorite sync failed: ${describeActionError(error)}`);
          void loadBootstrapRef.current();
        }
      });
    favoriteWriteQueue.current = request;
    return request;
  }, [pushToast, refresh, store]);

  const toggleFavoriteWorkspace = useCallback((workspaceId: string) => {
    const current = store.get();
    if (!current) return;
    const currentIds = desiredFavoriteWorkspaceIds.current ?? current.settings.favoriteWorkspaceIds ?? [];
    const nextIds = currentIds.includes(workspaceId)
      ? currentIds.filter((id) => id !== workspaceId)
      : [...currentIds, workspaceId];
    void persistFavoriteWorkspaceIds(nextIds);
  }, [persistFavoriteWorkspaceIds, store]);

  useEffect(() => {
    if (!authoritativeState) return;
    if (desiredCollapsedWorkspaceIds.current) return;
    let desired = pruneCollapsedWorkspaceIds(
      authoritativeState.workspaces,
      authoritativeState.settings.collapsedWorkspaceIds,
    );
    if (activeWorkspace) {
      desired = expandWorkspaceAncestors(
        authoritativeState.workspaces,
        desired,
        activeWorkspace.id,
      );
    }
    if (!sameWorkspaceIds(desired, authoritativeState.settings.collapsedWorkspaceIds)) {
      void persistCollapsedWorkspaceIds(desired);
    }
  }, [
    activeWorkspace?.id,
    authoritativeState?.settings.collapsedWorkspaceIds,
    authoritativeState?.workspaces,
    persistCollapsedWorkspaceIds,
  ]);

  useEffect(() => {
    if (!authoritativeState || desiredFavoriteWorkspaceIds.current) return;
    const currentIds = authoritativeState.settings.favoriteWorkspaceIds ?? [];
    const desired = pruneFavoriteWorkspaceIds(authoritativeState.workspaces, currentIds);
    if (!sameWorkspaceIds(desired, currentIds)) void persistFavoriteWorkspaceIds(desired);
  }, [
    authoritativeState?.settings.favoriteWorkspaceIds,
    authoritativeState?.workspaces,
    persistFavoriteWorkspaceIds,
  ]);

  const activeWorkspaceUnreadCount = activeWorkspace ? unreadByWorkspaceId.get(activeWorkspace.id) ?? 0 : 0;
  useEffect(() => {
    if (!activeWorkspace || activeWorkspaceUnreadCount === 0) return;
    const workspaceId = activeWorkspace.id;
    store.update((current) => current ? markWorkspaceNotificationsReadInState(current, workspaceId) : current);
    void api.markWorkspaceNotificationsRead(workspaceId)
      .then((payload) => refresh(payload))
      .catch((nextError) => pushToast(`Mark notifications read failed: ${describeActionError(nextError)}`));
  }, [activeWorkspace?.id, activeWorkspaceUnreadCount, pushToast, refresh, store]);

  const updateSettings = async (nextSettings: WmuxSettings) => {
    await runPending("settings:save", "Saving settings...", async () => {
      const response = await api.updateSettings(modalSettingsUpdate(nextSettings));
      setPreviewSettings(null);
      await refresh(response.state);
      setSettingsOpen(false);
    });
  };

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const cancelSettings = () => {
    setPreviewSettings(null);
    setSettingsOpen(false);
  };

  const openMachineManager = useCallback(() => {
    setPreviewSettings(null);
    setSettingsOpen(false);
    setMachineManagerOpen(true);
  }, []);

  useEffect(() => {
    if (!state) return;
    if (targetMachineId !== newMachineId) {
      setNewMachineId(targetMachineId);
      return;
    }
    persistMachineTargetId(window.localStorage, targetMachineId);
  }, [newMachineId, state, targetMachineId]);
  const activeStreamMachineId = activePane?.machineId
    ?? (activeWorkspace ? workspacePresentationMachineId(activeWorkspace) : undefined)
    ?? selectedMachine?.id
    ?? targetMachineId;
  const activeStreamMachine = machineFor(displayMachines, activeStreamMachineId);
  const activeStream = streams.find((stream) => stream.machineId === activeStreamMachineId);
  const canOpenStream = !mobileViewport.isMobile && Boolean(activeStream);
  const activeColorScheme = colorSchemeById(settings.colorScheme);
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [property, value] of Object.entries(colorSchemeCssVariables(activeColorScheme))) {
      root.style.setProperty(property, value);
    }
    root.dataset.colorScheme = activeColorScheme.id;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      "content",
      activeColorScheme.terminal.background,
    );
  }, [activeColorScheme]);
  const appStyle = {
    "--wmux-sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;
  const showMobileModeBar = mobileViewport.isMobile;
  const showMobileAgentSurface = showMobileModeBar && mobileSurfaceMode === "agent";
  const activeAgentInputRequests = activePane
    ? (state?.agentInputRequests ?? []).filter((request) => (
      request.paneId === activePane.id && isAgentInputRequestVisible(request.state)
    ))
    : [];
  const mobileHeaderMachine = activePane
    ? machineFor(displayMachines, activePane.machineId)
    : activeWorkspace
      ? machineFor(displayMachines, activeWorkspace.machineId)
      : undefined;
  const mobileHeaderAgent = activePane ? latestAgentByPaneId.get(activePane.id) : undefined;
  const mobileHeaderStatus = mobileHeaderAgent
    ? workspaceAgentStatusClass(mobileHeaderAgent.status, mobileHeaderAgent.heartbeatActive)
    : activePane?.status === "running"
      ? "running"
      : activePane?.status === "exited"
        ? "failed"
        : "updated";
  const mobileHeaderStatusLabel = mobileHeaderStatus === "heartbeat"
    ? "prime-agent heartbeat"
    : mobileHeaderAgent?.status ?? activePane?.status ?? "idle";
  const mobilePaneIndex = activeTab && activePane
    ? activeTab.panes.findIndex((candidate) => candidate.id === activePane.id)
    : -1;
  const mobilePaneContext = activeTab && activeTab.panes.length > 1 && mobilePaneIndex >= 0
    ? `pane ${mobilePaneIndex + 1}/${activeTab.panes.length}`
    : "";
  const mobileHeaderSubtitle = [activeTab?.title, mobilePaneContext, mobileHeaderMachine?.name ?? activeWorkspace?.machineId]
    .filter(Boolean)
    .join(" / ");
  const mobileHeaderVersion = activeWorkspace
    ? summarizeWorkspaceVersion(activeWorkspace, displayMachines)
    : undefined;

  const activatePaneInTab = useCallback((tabId: string, paneId: string) => {
    clearBellPanes([paneId]);
    activatePane(tabId, paneId);
  }, [activatePane, clearBellPanes]);

  const optimisticSplitPaneRequest = useCallback(async (
    tabId: string,
    paneId: string,
    direction: SplitDirection,
    machineId?: string,
  ): ReturnType<typeof api.splitPane> => {
    const snapshot = store.get();
    const sourcePane = snapshot?.workspaces
      .flatMap((workspace) => workspace.tabs)
      .flatMap((tab) => tab.panes)
      .find((pane) => pane.id === paneId);
    if (!snapshot || !sourcePane) return api.splitPane(tabId, paneId, direction, machineId);
    const targetMachineId = machineId ?? sourcePane.machineId;
    const ids = createClientSplitIds();
    const creation = optimisticSplitCreation(
      snapshot,
      tabId,
      paneId,
      direction,
      targetMachineId,
      ids,
      targetMachineId === sourcePane.machineId ? sourcePane.cwd : undefined,
    );
    if (!creation) return api.splitPane(tabId, paneId, direction, machineId, ids);
    beginOptimisticCreation(creation, `Creating shell on ${targetMachineId}…`);
    try {
      const response = await api.splitPane(tabId, paneId, direction, machineId, ids);
      finishOptimisticCreation(creation);
      return response;
    } catch (error) {
      finishOptimisticCreation(creation);
      await refresh().catch(() => undefined);
      throw error;
    }
  }, [beginOptimisticCreation, finishOptimisticCreation, refresh, store]);

  const { splitPaneInTab, resizeSplitInTab, closePaneInTab, splitPane } = usePaneActions({
    activeTabId: activeTab?.id,
    refresh,
    activatePane,
    runPending,
    splitPaneRequest: optimisticSplitPaneRequest,
  });
  const requestClosePaneInTab = useCallback((tabId: string, paneId: string) => {
    if (!mobileViewport.isMobile) {
      void closePaneInTab(tabId, paneId);
      return;
    }
    const snapshot = store.get();
    const pane = snapshot?.workspaces
      .flatMap((workspace) => workspace.tabs)
      .find((tab) => tab.id === tabId)
      ?.panes.find((candidate) => candidate.id === paneId);
    setPendingMobileClose({
      kind: "pane",
      title: pane?.title ?? "this pane",
      sessionCount: 1,
      run: () => closePaneInTab(tabId, paneId),
    });
  }, [closePaneInTab, mobileViewport.isMobile, store]);

  const recordPaneBell = useCallback((paneId: string) => {
    const snapshot = store.get();
    if (!snapshot) return;
    const context = findPaneContextInState(snapshot, paneId);
    if (!context) return;
    const sessionIsCurrent =
      snapshot.activeWorkspaceId === context.workspace.id &&
      context.workspace.activeTabId === context.tab.id;
    if (sessionIsCurrent) return;
    setBellPaneIds((current) => {
      if (current.has(paneId)) return current;
      const next = new Set(current);
      next.add(paneId);
      return next;
    });
  }, [store]);

  // Wrap a mutation with duplicate suppression, visible progress, and a toast
  // on failure. The key can include the target so unrelated work may proceed.
  const guard = <A extends unknown[]>(keyFor: (...args: A) => string, pendingLabel: string, fn: (...args: A) => Promise<void>) => (
    async (...args: A): Promise<void> => {
      await runPending(keyFor(...args), pendingLabel, () => fn(...args));
    }
  );

  const createWorkspace = guard((machineId: string) => `machine:${machineId}:create-workspace`, "Creating workspace...", async (machineId: string) => {
    if (!machineId) return;
    const snapshot = store.get();
    if (!snapshot) return;
    const ids = createClientWorkspaceIds();
    const creation = optimisticWorkspaceCreation(
      snapshot,
      machineId,
      ids,
      activePane?.machineId === machineId ? activePane.cwd : undefined,
    );
    beginOptimisticCreation(creation, `Creating shell on ${machineId}…`);
    try {
      const response = await api.createWorkspace(machineId, activePane?.id, ids);
      finishOptimisticCreation(creation);
      await refresh(response.state);
      activateWorkspaceTab(response.workspace.id, response.workspace.activeTabId);
      if (mobileViewport.isMobile) collapseSidebar();
    } catch (error) {
      finishOptimisticCreation(creation);
      await refresh().catch(() => undefined);
      throw error;
    }
  });

  const activateWorkspaceLink = (
    event: React.MouseEvent<HTMLAnchorElement>,
    workspaceId: string,
    tabId: string,
    options: { focusTerminal?: boolean } = {},
  ) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    activateWorkspaceTab(workspaceId, tabId, options);
    if (mobileViewport.isMobile) collapseSidebar();
  };

  const activateWorkspaceFromChrome = (workspaceId: string, tabId: string) => {
    activateWorkspaceTab(workspaceId, tabId, { focusTerminal: true });
    if (mobileViewport.isMobile) collapseSidebar();
  };

  const activateTabFromChrome = (tabId: string) => {
    if (!activeWorkspace) return;
    activateWorkspaceTab(activeWorkspace.id, tabId);
  };

  const copyActiveLink = async () => {
    if (!activeWorkspace || !activeTab) return;
    const url = new URL(workspaceTabPath(activeWorkspace.id, activeTab.id), window.location.origin);
    await writeBrowserClipboard(url.toString());
  };

  const createTab = guard((machineId: string) => `machine:${machineId}:create-tab`, "Creating tab...", async (machineId: string) => {
    if (!activeWorkspace || !machineId) return;
    const snapshot = store.get();
    if (!snapshot) return;
    const ids = createClientTabIds();
    const creation = optimisticTabCreation(
      snapshot,
      activeWorkspace.id,
      machineId,
      ids,
      activePane?.machineId === machineId ? activePane.cwd : undefined,
    );
    if (!creation) return;
    beginOptimisticCreation(creation, `Creating shell on ${machineId}…`);
    try {
      const response = await api.createTab(activeWorkspace.id, machineId, activePane?.id, ids);
      finishOptimisticCreation(creation);
      await refresh(response.state);
      activateWorkspaceTab(activeWorkspace.id, response.tab.id);
      if (mobileViewport.isMobile) collapseSidebar();
    } catch (error) {
      finishOptimisticCreation(creation);
      await refresh().catch(() => undefined);
      throw error;
    }
  });

  const closeTabById = guard((workspaceId: string, tabId: string) => `tab:${tabId}:close`, "Closing tab...", async (workspaceId: string, tabId: string) => {
    const response = await api.closeTab(workspaceId, tabId);
    await refresh(response.state);
  });

  const closeWorkspaceById = guard((workspaceId: string) => `workspace:${workspaceId}:close`, "Closing workspace...", async (workspaceId: string) => {
    const response = await api.closeWorkspace(workspaceId);
    await refresh(response.state);
  });

  const revealPendingWorkspace = useCallback((workspaceId: string) => {
    setPendingWorkspaceIds((current) => {
      if (!current.has(workspaceId)) return current;
      const next = new Set(current);
      next.delete(workspaceId);
      return next;
    });
  }, []);

  const undoWorkspaceClose = useCallback(async (workspaceId: string): Promise<void> => {
    const pending = pendingWorkspaceCloses.current.get(workspaceId);
    if (!pending) return;
    pendingWorkspaceCloses.current.delete(workspaceId);
    revealPendingWorkspace(workspaceId);
    dismissToast(pending.toastId);

    await pending.request.catch(() => undefined);
    try {
      const response = await api.cancelWorkspaceClose(workspaceId);
      await refresh(response.state);
      if (response.cancelled && pending.restoreTabId) {
        activateWorkspaceTab(workspaceId, pending.restoreTabId, { replaceHistory: true });
      } else if (!response.cancelled) {
        pushToast("The workspace close deadline had already passed.", "info", {
          status: "closed",
        });
      }
    } catch (error) {
      pushToast(`Undo close failed: ${describeActionError(error)}`);
      void loadBootstrapRef.current();
    }
  }, [activateWorkspaceTab, dismissToast, pushToast, refresh, revealPendingWorkspace]);

  const scheduleWorkspaceClose = useCallback((workspaceId: string): void => {
    if (pendingWorkspaceCloses.current.has(workspaceId)) return;
    const workspace = store.get()?.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) return;

    setPendingWorkspaceIds((current) => new Set(current).add(workspaceId));
    const request = api.scheduleWorkspaceClose(workspaceId);
    const toastId = pushToast(
      `${workspace.name} hidden. Closing in 10 seconds.`,
      "info",
      {
        action: {
          label: "[U] UNDO",
          accessibleLabel: `Undo close ${workspace.name}`,
          run: () => void undoWorkspaceClose(workspaceId),
        },
        dismissible: false,
        durationMs: WORKSPACE_CLOSE_GRACE_MS,
        status: "pending",
      },
    );
    pendingWorkspaceCloses.current.set(workspaceId, {
      request,
      toastId,
      ...(store.get()?.activeWorkspaceId === workspaceId
        ? { restoreTabId: workspace.activeTabId }
        : {}),
    });

    void request.catch((error) => {
      const pending = pendingWorkspaceCloses.current.get(workspaceId);
      if (!pending || pending.request !== request) return;
      pendingWorkspaceCloses.current.delete(workspaceId);
      revealPendingWorkspace(workspaceId);
      dismissToast(toastId);
      pushToast(`Close workspace failed: ${describeActionError(error)}`);
    });
  }, [dismissToast, pushToast, revealPendingWorkspace, store, undoWorkspaceClose]);

  const closeActiveTab = () => {
    if (!activeWorkspace || !activeTab) return;
    const run = () => closeTabById(activeWorkspace.id, activeTab.id);
    if (!mobileViewport.isMobile) {
      void run();
      return;
    }
    setPendingMobileClose({
      kind: "tab",
      title: activeTab.title,
      sessionCount: activeTab.panes.length,
      run,
    });
  };

  const requestCloseWorkspace = (workspaceId: string, returnFocus?: HTMLElement | null) => {
    const workspace = store.get()?.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    const run = () => scheduleWorkspaceClose(workspace.id);
    if (!mobileViewport.isMobile) {
      void run();
      return;
    }
    setPendingMobileClose({
      kind: "workspace",
      title: workspace.name,
      sessionCount: workspace.tabs.reduce((count, tab) => count + tab.panes.length, 0),
      run,
      returnFocus,
    });
  };

  const closeWorkspaceGroup = guard(
    (machineId: string) => `machine:${machineId}:close-workspaces`,
    "Closing agent group...",
    async (machineId: string) => {
      const workspaceIds = (store.get()?.workspaces ?? [])
        .filter((workspace) => workspacePresentationTarget(
          workspace,
          agentActivityByWorkspaceId.get(workspace.id)?.representative,
        ).machineId === machineId)
        .map((workspace) => workspace.id);
      let latestState: BootstrapPayload | undefined;
      try {
        for (const workspaceId of workspaceIds) {
          const response = await api.closeWorkspace(workspaceId);
          latestState = response.state;
        }
      } finally {
        if (latestState) await refresh(latestState);
      }
    },
  );

  const closeActiveWorkspace = () => {
    if (!activeWorkspace) return;
    requestCloseWorkspace(activeWorkspace.id);
  };

  const renameWorkspace = guard(
    (workspaceId: string, _title: string) => `workspace:${workspaceId}:rename`,
    "Renaming workspace...",
    async (workspaceId: string, title: string) => {
      const response = await api.setWorkspaceTitle(workspaceId, title);
      await refresh(response.state);
    },
  );

  const reorderWorkspace = guard(
    (workspaceId: string, _targetWorkspaceId: string | undefined, _position: WorkspaceReorderPosition) => `workspace:${workspaceId}:reorder`,
    "Reordering workspace...",
    async (workspaceId: string, targetWorkspaceId: string | undefined, position: WorkspaceReorderPosition) => {
      if (workspaceId === targetWorkspaceId) return;
      const current = store.get();
      if (!current || openTuiWorkspaceTree.movesDisabled) return;
      try {
        const response = await api.reorderWorkspace(workspaceId, targetWorkspaceId, position, current.workspaceTreeRevision);
        await refresh(response.state);
      } catch (error) {
        if (error instanceof WorkspaceReorderConflictError) {
          await refresh(error.state);
          pushToast("Workspace tree changed; move canceled.");
          return;
        }
        throw error;
      }
    },
  );

  const sendPaneInput = async (
    paneId: string,
    data: string,
    timelinePrompt?: string,
  ): Promise<void> => {
    try {
      await refresh(
        await api.sendPaneInput(paneId, data, timelinePrompt),
      );
    } catch (nextError) {
      pushToast(`Send input failed: ${describeActionError(nextError)}`);
      throw nextError;
    }
  };

  const activateWorkspaceAt = (index: number) => {
    if (!state) return;
    const row = displayOrderedWorkspaces[index];
    const workspace = row ? state.workspaces.find((candidate) => candidate.id === row.id) : undefined;
    const tab = workspace?.tabs.find((candidate) => candidate.id === workspace.activeTabId) ?? workspace?.tabs[0];
    if (workspace && tab) activateWorkspaceTab(workspace.id, tab.id);
  };

  const activateWorkspaceRelative = (delta: number) => {
    if (!activeWorkspace || displayOrderedWorkspaces.length === 0) return;
    const current = displayOrderedWorkspaces.findIndex((row) => row.id === activeWorkspace.id);
    if (current === -1) return;
    const next = modulo(current + delta, displayOrderedWorkspaces.length);
    activateWorkspaceAt(next);
  };

  const activateTabAt = (index: number) => {
    if (!activeWorkspace) return;
    const tab = activeWorkspace.tabs[index];
    if (tab) activateWorkspaceTab(activeWorkspace.id, tab.id);
  };

  const activateTabRelative = (delta: number) => {
    if (!activeWorkspace || !activeTab) return;
    const current = activeWorkspace.tabs.findIndex((tab) => tab.id === activeTab.id);
    if (current === -1) return;
    const next = modulo(current + delta, activeWorkspace.tabs.length);
    activateTabAt(next);
  };

  const focusPaneRelative = async (delta: number) => {
    if (!activeTab) return;
    const paneIds = flattenPaneIds(activeTab.layout);
    const current = paneIds.indexOf(activeTab.activePaneId);
    if (current === -1 || paneIds.length < 2) return;
    const nextPaneId = paneIds[modulo(current + delta, paneIds.length)];
    await activatePaneInTab(activeTab.id, nextPaneId);
  };

  const jumpLatestUnread = async () => {
    const latest = notifications.find((notification) => !notification.read);
    if (!latest) return;
    activateWorkspaceTab(latest.workspaceId, latest.tabId);
    await activatePaneInTab(latest.tabId, latest.paneId);
    if (latest.href && latest.agentInputRequestId) {
      window.history.pushState(null, "", latest.href);
      setAgentInputDeepLink(currentAgentInputDeepLink());
    }
  };

  const openCommandPalette = () => {
    setCommandPaletteQuery("");
    setCommandPaletteOpen(true);
  };

  const activePaneForSplit = activeTab?.panes.find((candidate) => candidate.id === activeTab.activePaneId);
  useKeyboardShortcuts({
    keybindings,
    apple: appleKeybindings,
    modalOpen: !bootComplete || settingsOpen || machineManagerOpen || commandPaletteOpen || Boolean(renameWorkspaceDialog) || diagnosticsOpen || agentFleetOpen,
    openCommandPalette,
    openSettings,
    toggleSidebar,
    createWorkspace: () => createWorkspace(targetMachineId),
    createTab: () => createTab(targetMachineId),
    closeActiveTab,
    closeActiveWorkspace,
    splitActivePane: activePaneForSplit
      ? (direction) => splitPane(activePaneForSplit.id, direction)
      : null,
    focusPaneRelative,
    activateWorkspaceRelative,
    activateTabRelative,
    activateWorkspaceAtDigit: state && displayOrderedWorkspaces.length > 0
      ? (digit) => activateWorkspaceAt(digit === 9 ? displayOrderedWorkspaces.length - 1 : digit - 1)
      : null,
    activateTabAtDigit: activeWorkspace
      ? (digit) => activateTabAt(digit === 9 ? activeWorkspace.tabs.length - 1 : digit - 1)
      : null,
    jumpLatestUnread,
  });

  const enableBrowserNotifications = async () => {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    await Notification.requestPermission();
  };

  const markWorkspaceRead = async () => {
    if (!activeWorkspace) return;
    await runPending(`workspace:${activeWorkspace.id}:mark-read`, "Marking notifications read...", async () => {
      await refresh(await api.markWorkspaceNotificationsRead(activeWorkspace.id));
    });
  };

  const requestStream = useCallback(
    (machineId: string, requestId: string, ttlMs: number) => {
      const sent = sendEventSocketMessage({ type: "stream-request", machineId, requestId, ttlMs });
      if (sent) return;
      api
        .requestStream(machineId, requestId, ttlMs)
        .then((response) =>
          store.update((current) => (current ? { ...current, streams: response.streams } : current)),
        )
        .catch(() => undefined);
    },
    [sendEventSocketMessage, store],
  );

  const releaseStream = useCallback(
    (machineId: string, requestId: string) => {
      const sent = sendEventSocketMessage({ type: "stream-release", machineId, requestId });
      if (sent) return;
      api
        .releaseStream(machineId, requestId)
        .then((response) =>
          store.update((current) => (current ? { ...current, streams: response.streams } : current)),
        )
        .catch(() => undefined);
    },
    [sendEventSocketMessage, store],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    const activePane = activeTab?.panes.find((pane) => pane.id === activeTab.activePaneId);
    const activePaneMachine = activePane ? displayMachines.find((machine) => machine.id === activePane.machineId) : undefined;
    const activePaneCount = activeTab?.panes.length ?? 0;
    const workspaceUnreadCount = activeWorkspace ? unreadByWorkspaceId.get(activeWorkspace.id) ?? 0 : 0;
    const base: PaletteCommand[] = [
      {
        id: "open-settings",
        title: "Open settings",
        subtitle: "Ghostty settings, host aliases, durable session audit",
        section: "System",
        shortcut: shortcutFor("settings.open"),
        run: openSettings,
      },
      {
        id: "audit-sessions",
        title: "Open session audit",
        subtitle: "Review local tmux/screen durable sessions",
        section: "System",
        run: openSettings,
        keywords: ["tmux", "screen", "durable", "orphan", "duplicate"],
      },
      {
        id: "manage-machines",
        title: "Manage machines",
        subtitle: "Add static hosts or manage dynamic registrations",
        section: "System",
        run: openMachineManager,
        keywords: ["hosts", "registry", "ssh", "machines"],
      },
      {
        id: "open-diagnostics",
        title: "Open diagnostics",
        subtitle: "Pane drivers, restart durability, and session health",
        section: "System",
        run: openDiagnostics,
        keywords: ["doctor", "health", "driver", "restart", "reconnect"],
      },
      {
        id: "open-agent-fleet",
        title: "Open agent fleet",
        subtitle: "Runtime, host, state, elapsed time, and latest agent turn",
        section: "View",
        run: () => setAgentFleetOpen(true),
        keywords: ["agents", "delegations", "waiting", "blocked", "control plane"],
      },
      {
        id: "open-activity",
        title: "Open activity",
        subtitle: "Agent events and tracked terminal runs",
        section: "View",
        run: () => setActivityOpen(true),
        keywords: ["timeline", "agent", "runs", "history"],
      },
      {
        id: "open-stream",
        title: `Open stream: ${activeStreamMachine?.name ?? activeStreamMachineId}`,
        subtitle:
          activeStream?.provider === "moonlight-gateway"
            ? activeStream.live
              ? "Moonlight gateway ready"
              : activeStream.reason
                ? "Moonlight upstream offline"
                : "Moonlight gateway offline"
            : activeStream?.live
              ? `${activeStream.viewerCount} viewers`
              : "Waiting for native-agent capture",
        section: "View",
        disabled: !canOpenStream,
        run: () => setStreamOpen(true),
        keywords: ["screen", "display", "webrtc", "pixels", "moonlight", "sunshine"],
      },
      {
        id: "rename-workspace",
        title: "Rename current workspace",
        subtitle: "Set a custom workspace name",
        section: "Actions",
        disabled: !activeWorkspace,
        run: () => {
          if (activeWorkspace) setRenameWorkspaceDialog({ id: activeWorkspace.id, title: activeWorkspace.name });
        },
        keywords: ["name", "title", "sidebar", "agent"],
      },
      {
        id: "copy-link",
        title: "Copy active session link",
        subtitle: "Copy a direct link to this tab",
        section: "Actions",
        disabled: !activeWorkspace || !activeTab,
        run: copyActiveLink,
        keywords: ["url", "share", "link"],
      },
      {
        id: "toggle-sidebar",
        title: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
        subtitle: "Toggle workspace and host navigation",
        section: "View",
        shortcut: shortcutFor("sidebar.toggle"),
        run: toggleSidebar,
        keywords: ["left", "navigation", "panel"],
      },
      {
        id: "mark-read",
        title: "Mark workspace notifications read",
        subtitle: `${workspaceUnreadCount} unread in current workspace`,
        section: "Actions",
        disabled: workspaceUnreadCount === 0 || !activeWorkspace,
        run: markWorkspaceRead,
        keywords: ["notification", "inbox", "unread"],
      },
      {
        id: "enable-notifications",
        title: "Enable browser notifications",
        subtitle: "Request notification permission",
        section: "System",
        disabled: !("Notification" in window) || Notification.permission !== "default",
        run: enableBrowserNotifications,
        keywords: ["alerts"],
      },
      {
        id: "new-workspace-selected",
        title: `New workspace on ${selectedMachine?.name ?? targetMachineId}`,
        subtitle: "Create a new workspace on the target host",
        section: "Create",
        shortcut: shortcutFor("workspace.new"),
        disabled: !selectedMachine?.reachable,
        run: () => createWorkspace(targetMachineId),
        keywords: ["session"],
      },
      {
        id: "new-tab-selected",
        title: `New tab on ${selectedMachine?.name ?? targetMachineId}`,
        subtitle: "Add a tab to the current workspace",
        section: "Create",
        shortcut: shortcutFor("tab.new"),
        disabled: !selectedMachine?.reachable || !activeWorkspace,
        run: () => createTab(targetMachineId),
        keywords: ["session"],
      },
      {
        id: "split-right",
        title: `Split right on ${activePaneMachine?.name ?? activePane?.machineId ?? "current host"}`,
        subtitle: "Create a pane to the right of the active pane",
        section: "Pane",
        shortcut: shortcutFor("pane.splitRight"),
        disabled: !activePane || !activePaneMachine?.reachable,
        run: () => activePane && splitPane(activePane.id, "vertical"),
        keywords: ["vertical", "pane"],
      },
      {
        id: "split-down",
        title: `Split down on ${activePaneMachine?.name ?? activePane?.machineId ?? "current host"}`,
        subtitle: "Create a pane below the active pane",
        section: "Pane",
        shortcut: shortcutFor("pane.splitDown"),
        disabled: !activePane || !activePaneMachine?.reachable,
        run: () => activePane && splitPane(activePane.id, "horizontal"),
        keywords: ["horizontal", "pane"],
      },
      {
        id: "focus-next-pane",
        title: "Focus next pane",
        section: "Pane",
        disabled: activePaneCount < 2,
        run: () => focusPaneRelative(1),
        keywords: ["navigate"],
      },
      {
        id: "focus-prev-pane",
        title: "Focus previous pane",
        section: "Pane",
        disabled: activePaneCount < 2,
        run: () => focusPaneRelative(-1),
        keywords: ["navigate"],
      },
      {
        id: "rectangular-terminal-selection",
        title: "Rectangular terminal selection",
        subtitle: "Alt/Option+drag; use Ctrl+Alt+drag when a Linux window manager reserves Alt+drag",
        section: "Terminal",
        shortcut: "Alt/Option+Drag",
        disabled: !activeWorkspace || !activeTab || !activePane,
        run: () => {
          if (!activeWorkspace || !activeTab) return;
          requestTerminalFocus(activeWorkspace.id, activeTab.id);
        },
        keywords: ["copy", "column", "block", "mouse", "drag"],
      },
      {
        id: "close-tab",
        title: "Close current tab",
        subtitle: "Close every pane in the current tab",
        section: "Close",
        shortcut: shortcutFor("tab.close"),
        disabled: !activeWorkspace || !activeTab,
        run: closeActiveTab,
      },
      {
        id: "close-workspace",
        title: "Close current workspace",
        subtitle: "Close every tab and pane in the current workspace",
        section: "Close",
        shortcut: shortcutFor("workspace.close"),
        disabled: !state || !activeWorkspace,
        run: closeActiveWorkspace,
      },
      {
        id: "latest-unread",
        title: "Jump to latest unread",
        subtitle: `${unreadNotifications.length} unread notifications`,
        section: "Navigate",
        shortcut: shortcutFor("notification.latestUnread"),
        disabled: unreadNotifications.length === 0,
        run: jumpLatestUnread,
        keywords: ["notification"],
      },
    ];

    const hostCommands = displayMachines.flatMap((machine): PaletteCommand[] => [
      {
        id: `inspect-host:${machine.id}`, title: `Inspect host: ${machine.name}`,
        subtitle: `${machine.host ?? machine.id} / ${machine.reachable ? "online" : "offline"}`,
        section: "Hosts", keywords: [machine.id, machine.host ?? ""],
        run: () => setInspectedHostId(machine.id),
      },
      {
        id: `target-host:${machine.id}`,
        title: `Set target host: ${machine.name}`,
        subtitle: machine.reachable ? machine.kind : machine.reason ?? "Offline",
        section: "Hosts",
        disabled: !machine.reachable,
        run: () => setNewMachineId(machine.id),
        keywords: [machine.id, machine.host ?? ""],
      },
      {
        id: `workspace-host:${machine.id}`,
        title: `New workspace on ${machine.name}`,
        subtitle: machine.reachable ? machine.kind : machine.reason ?? "Offline",
        section: "Hosts",
        disabled: !machine.reachable,
        run: () => createWorkspace(machine.id),
        keywords: [machine.id, machine.host ?? ""],
      },
    ]);

    const workspaceCommands =
      state?.workspaces.flatMap((workspace): PaletteCommand[] => {
        const presentationMachineId = workspacePresentationMachineId(workspace);
        const host = displayWorkspaceHost(
          machineFor(displayMachines, presentationMachineId),
          machineFor(machines, presentationMachineId),
          presentationMachineId,
        );
        const activeWorkspaceTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? workspace.tabs[0];
        const workspaceCommand: PaletteCommand[] = activeWorkspaceTab
          ? [
              {
                id: `workspace:${workspace.id}`,
                title: `Open workspace: ${workspace.name}`,
                subtitle: host,
                section: "Workspaces",
                run: () => activateWorkspaceTab(workspace.id, activeWorkspaceTab.id),
                keywords: [host, workspace.descriptor ?? ""],
              },
            ]
          : [];
        const tabCommands = workspace.tabs.map((tab): PaletteCommand => ({
          id: `tab:${workspace.id}:${tab.id}`,
          title: `Open tab: ${tab.title}`,
          subtitle: workspace.name,
          section: "Tabs",
          run: () => activateWorkspaceTab(workspace.id, tab.id),
          keywords: [host],
        }));
        return [...workspaceCommand, ...tabCommands];
      }) ?? [];

    for (const direction of ["left", "right", "up", "down"] as PaneDirection[]) {
      const next = activeTab ? directionalPane(activeTab.layout, activeTab.activePaneId, direction) : undefined;
      base.push({ id: `focus-pane-${direction}`, title: `Focus pane ${direction}`, section: "Navigate", disabled: !next,
        run: () => { if (next && activeTab) void activatePaneInTab(activeTab.id, next); } });
    }
    base.push({
      id: "pane-zoom", title: zoomedTabId === activeTab?.id ? "Restore split layout" : "Zoom active pane",
      section: "Pane", disabled: !activeTab || activeTab.panes.length < 2,
      run: () => setZoomedTabId(zoomedTabId === activeTab?.id ? null : activeTab?.id ?? null),
      keywords: ["maximize", "restore", "zoom"],
    });
    const orderedBase = mobileViewport.isMobile
      ? [...base].sort((first, second) => mobileCommandSectionPriority(first.section) - mobileCommandSectionPriority(second.section))
      : base;
    const sessions = state ? buildSessionRows(state, displayMachines) : [];
    const openSession = (row: AgentFleetRow) => {
      activateWorkspaceTab(row.workspaceId, row.tabId);
      void activatePaneInTab(row.tabId, row.paneId);
    };
    const sessionCommands: PaletteCommand[] = sessions.map((row) => ({
      id: `session:${row.id}`,
      title: `Open session: ${row.title}`,
      subtitle: `${row.workspaceName} / ${row.machineName} / [${row.state.toUpperCase()}] / ${row.source}`,
      section: "Sessions", disabled: !row.available,
      keywords: [row.runtime, row.cwd ?? "", row.machineName],
      filters: { host: [row.machineId, row.machineName], state: [row.state, row.attentionReason ?? ""], runtime: [row.runtime] },
      run: () => openSession(row),
    }));
    const attention = sessions.filter((row) => row.available && (row.attentionReason || row.state === "waiting"));
    const completions = sessions.filter((row) => row.available && row.state === "completed" && row.unread);
    for (const [id, title, candidates] of [
      ["next-attention", "Next session needing attention", attention],
      ["next-completion", "Next unseen completion", completions],
    ] as const) {
      const next = candidates[(candidates.findIndex((row) => row.paneId === activeTab?.activePaneId) + 1) % candidates.length];
      sessionCommands.unshift({ id, title, section: "Navigate", disabled: !next, run: () => { if (next) openSession(next); } });
    }
    return [...orderedBase, ...sessionCommands, ...hostCommands, ...workspaceCommands];
  }, [
    zoomedTabId,
    activeTab,
    activeWorkspace,
    requestTerminalFocus,
    displayMachines,
    machines,
    targetMachineId,
    openSettings,
    openMachineManager,
    openDiagnostics,
    activeStream,
    activeStreamMachine,
    activeStreamMachineId,
    canOpenStream,
    selectedMachine,
    sidebarCollapsed,
    state,
    unreadByWorkspaceId,
    unreadNotifications.length,
    shortcutFor,
    mobileViewport.isMobile,
  ]);

  if (!state && loadError && !authRequired) {
    return (
      <div className="load-state" role="status" aria-live="polite">
        <div className="load-state-card">
          <strong>Reconnecting to wmux</strong>
          <span>The network may still be waking up. Retrying automatically.</span>
          <small>{loadError}</small>
          <button type="button" onClick={() => void loadBootstrap()}>Retry now</button>
        </div>
      </div>
    );
  }
  const appClassName = [
    "app-shell",
    agentFleetOpen && fleetDocked && !mobileViewport.isMobile ? "fleet-docked" : "",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    "open-tui-mode",
    mobileViewport.isMobile ? "mobile-viewport" : "",
    mobileViewport.keyboardOpen ? "mobile-keyboard-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // The shell mounts as soon as state is available so terminals attach while
  // the boot overlay still covers the screen. RetroBootScreen must keep a
  // stable position in this fragment; remounting it would restart the boot
  // sequence with a fresh profile mid-transition.
  return (
    <>
    {state && !authRequired ? (
    <ColorSchemeProvider id={settings.colorScheme}>
    <main
      className={appClassName}
      style={appStyle}
      aria-busy={pendingActions.length > 0}
      aria-hidden={!bootComplete || undefined}
    >
      <Toasts toasts={toasts} dismissToast={dismissToast} />
      {pendingActions.length > 0 ? (
        <div className="mutation-status" role="status" aria-live="polite">
          <span aria-hidden="true">[BUSY]</span>
          <span>{pendingActions[pendingActions.length - 1].label}</span>
          {pendingActions.length > 1 ? <span className="mutation-status-count">+{pendingActions.length - 1}</span> : null}
        </div>
      ) : null}
      {!mobileViewport.isMobile ? (
        <OpenTuiSidebar
          targetMachineId={targetMachineId}
          targetMachineName={selectedMachine ? versionedMachineName(selectedMachine) : targetMachineId}
          targetMachineReachable={Boolean(selectedMachine?.reachable)}
          workspaces={openTuiWorkspaces}
          machines={openTuiMachines}
          groupSidebarSessionsByHost={settings.groupSidebarSessionsByHost}
          onTargetMachineChange={setNewMachineId}
          onCreateWorkspace={() => createWorkspace(targetMachineId)}
          onActivateWorkspace={activateWorkspaceFromChrome}
          onReorderWorkspace={reorderWorkspace}
          onToggleWorkspace={toggleWorkspaceCollapsed}
          onToggleFavoriteWorkspace={toggleFavoriteWorkspace}
          onRenameWorkspace={renameWorkspace}
          onRequestCloseWorkspace={requestCloseWorkspace}
          onRequestCloseWorkspaceGroup={closeWorkspaceGroup}
          movesDisabled={openTuiWorkspaceTree.movesDisabled}
          allWorkspaces={state.workspaces}
        />
      ) : (
        <OpenTuiSidebar
          containerRef={mobileSidebarRef}
          className="mobile-open-tui-sidebar"
          ariaHidden={sidebarCollapsed}
          targetMachineId={targetMachineId}
          targetMachineName={selectedMachine ? versionedMachineName(selectedMachine) : targetMachineId}
          targetMachineReachable={Boolean(selectedMachine?.reachable)}
          workspaces={openTuiWorkspaces}
          machines={openTuiMachines}
          groupSidebarSessionsByHost={settings.groupSidebarSessionsByHost}
          onTargetMachineChange={setNewMachineId}
          onCreateWorkspace={() => createWorkspace(targetMachineId)}
          onActivateWorkspace={activateWorkspaceFromChrome}
          onReorderWorkspace={reorderWorkspace}
          onToggleWorkspace={toggleWorkspaceCollapsed}
          movesDisabled={openTuiWorkspaceTree.movesDisabled}
          pointerReorderDisabled
          workspaceActions
          onRequestCloseWorkspace={requestCloseWorkspace}
          allWorkspaces={state.workspaces}
        >
          {activeWorkspace ? (
            <nav
              className="mobile-session-navigation"
              aria-label={`Sessions in ${activeWorkspace.name}`}
            >
              <div className="mobile-session-navigation-header">
                <span>Sessions</span>
                <button
                  type="button"
                  title={`New tab on ${selectedMachine?.name ?? targetMachineId}`}
                  aria-label={`New tab on ${selectedMachine?.name ?? targetMachineId}`}
                  disabled={!selectedMachine?.reachable}
                  onClick={() => createTab(targetMachineId)}
                >
                  [+]
                </button>
              </div>
              <div className="mobile-tab-navigation">
                {activeWorkspace.tabs.map((tab) => (
                  <a
                    key={tab.id}
                    href={workspaceTabPath(activeWorkspace.id, tab.id)}
                    className={tab.id === activeTab?.id ? "active" : ""}
                    aria-current={tab.id === activeTab?.id ? "page" : undefined}
                    onClick={(event) => activateWorkspaceLink(
                      event,
                      activeWorkspace.id,
                      tab.id,
                    )}
                  >
                    <span aria-hidden="true">[T]</span>
                    <span>{tab.title}</span>
                    {(unreadByTabId.get(tab.id) ?? 0) > 0 ? (
                      <span className="badge">{unreadByTabId.get(tab.id)}</span>
                    ) : null}
                  </a>
                ))}
              </div>
              {activeTab && activeTab.panes.length > 1 ? (
                <div
                  className="mobile-pane-navigation"
                  aria-label={`Panes in ${activeTab.title}`}
                >
                  <span className="mobile-pane-navigation-label">Panes</span>
                  {activeTab.panes.map((pane, index) => {
                    const paneMachine = machineFor(displayMachines, pane.machineId);
                    const paneActive = pane.id === activePane?.id;
                    return (
                      <button
                        key={pane.id}
                        type="button"
                        className={paneActive ? "active" : ""}
                        aria-pressed={paneActive}
                        onClick={() => {
                          activatePaneInTab(activeTab.id, pane.id);
                          collapseSidebar();
                          if (mobileSurfaceMode === "terminal") {
                            requestTerminalFocus(
                              activeWorkspace.id,
                              activeTab.id,
                            );
                          }
                        }}
                      >
                        <span>Pane {index + 1}</span>
                        <strong>{pane.title}</strong>
                        <small>{paneMachine?.name ?? pane.machineId}</small>
                        {(unreadByPaneId.get(pane.id) ?? 0) > 0 ? (
                          <span className="badge">{unreadByPaneId.get(pane.id)}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </nav>
          ) : null}
        </OpenTuiSidebar>
      )}
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label={sidebarCollapsed ? "Show sidebar" : "Resize sidebar"}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={maxSidebarWidth}
        aria-valuenow={sidebarCollapsed ? 0 : sidebarWidth}
        tabIndex={0}
        onPointerDown={startSidebarResize}
        onKeyDown={onSidebarResizerKeyDown}
        onDoubleClick={toggleSidebar}
      >
        <button
          type="button"
          className="sidebar-collapse-button"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-expanded={!sidebarCollapsed}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
        <GripVertical size={13} className="sidebar-resize-icon" aria-hidden="true" />
      </div>
      {mobileViewport.isMobile ? (
        <>
          {!sidebarCollapsed ? (
            <>
              <button
                type="button"
                className="mobile-sidebar-backdrop"
                aria-label="Close navigation"
                onClick={collapseSidebar}
              />
              <button
                ref={mobileSidebarCloseRef}
                type="button"
                className="mobile-sidebar-close"
                title="Close navigation"
                aria-label="Close navigation"
                aria-controls="wmux-sidebar"
                onClick={collapseSidebar}
              >
                <X size={20} />
              </button>
            </>
          ) : null}
        </>
      ) : null}
      <section className={`workspace ${showMobileModeBar ? "mobile-workspace mobile-open-tui" : ""} ${showMobileAgentSurface ? "mobile-agent-active" : ""}`}>
        {showMobileModeBar ? (
          <OpenTuiMobileChrome
            workspaceName={activeWorkspace?.name ?? "wmux"}
            subtitle={mobileHeaderSubtitle}
            status={mobileHeaderStatus}
            statusLabel={mobileHeaderStatusLabel}
            versionStatus={mobileHeaderVersion?.status}
            versionLabel={mobileHeaderVersion?.label}
            versionDetail={mobileHeaderVersion?.detail}
            serviceConnection={serviceConnection}
            surfaceMode={mobileSurfaceMode}
            navigationOpen={!sidebarCollapsed}
            onToggleNavigation={toggleMobileNavigation}
            onSurfaceModeChange={setMobileSurfaceMode}
          />
        ) : null}
        {!showMobileModeBar ? (
          <OpenTuiTopbar
            tabs={
              activeWorkspace?.tabs.map((tab) => ({
                id: tab.id,
                href: workspaceTabPath(activeWorkspace.id, tab.id),
                title: tab.title,
                active: tab.id === activeTab?.id,
                unreadCount: unreadByTabId.get(tab.id) ?? 0,
              })) ?? []
            }
            serviceConnection={serviceConnection}
            targetLabel={selectedMachine?.name ?? targetMachineId}
            canCreate={Boolean(selectedMachine?.reachable)}
            canCopyLink={Boolean(activeWorkspace && activeTab)}
            canOpenStream={canOpenStream}
            streamLive={Boolean(activeStream?.live)}
            streamViewerCount={activeStream?.viewerCount ?? 0}
            unreadNotifications={unreadNotifications.length}
            canMarkRead={Boolean(activeWorkspace && (unreadByWorkspaceId.get(activeWorkspace.id) ?? 0) > 0)}
            canEnableNotifications={"Notification" in window && Notification.permission === "default"}
            activityOpen={activityOpen}
            onActivateTab={activateTabFromChrome}
            onCreate={() => (activeWorkspace ? createTab(targetMachineId) : createWorkspace(targetMachineId))}
            onOpenCommandPalette={openCommandPalette}
            onOpenSettings={openSettings}
            onToggleActivity={() => setActivityOpen((value) => !value)}
            onOpenStream={() => setStreamOpen(true)}
            onCopyLink={copyActiveLink}
            onEnableNotifications={enableBrowserNotifications}
            onMarkRead={markWorkspaceRead}
          />
        ) : null}
        {!showMobileModeBar && activeAgentInputRequests.length > 0 ? (
          <AgentInputRequestShelf
            requests={activeAgentInputRequests}
            onOpenTerminal={() => {
              if (activeWorkspace && activeTab) requestTerminalFocus(activeWorkspace.id, activeTab.id);
            }}
          />
        ) : null}
        {showMobileAgentSurface ? (
          <MobileAgentSurface
            state={state}
            machines={displayMachines}
            workspace={activeWorkspace}
            tab={activeTab}
            pane={activePane}
            onSendInput={sendPaneInput}
            onUploadAttachment={async (paneId, attachment) => (await api.uploadPaneAttachment(paneId, attachment)).attachment}
            onFollowUp={async (sessionId, request) => {
              const result = await api.createAgentFollowUp(sessionId, request);
              await refresh(result.state);
            }}
            onFocusTerminal={() => {
              if (activeWorkspace && activeTab) requestTerminalFocus(activeWorkspace.id, activeTab.id);
              setMobileSurfaceMode("terminal");
            }}
            onOpenActions={openCommandPalette}
          />
        ) : activeTab ? (
          <div className="layout-cache">
            <Suspense fallback={null}>
            {mountedTabViews.map((view) => {
              const isActive = view.key === activeTabKey;
              return (
                <div
                  key={view.key}
                  className={`layout-cache-item ${isActive ? "active" : "hidden"}`}
                  aria-hidden={!isActive}
                >
                  <LayoutView
                    zoomed={zoomedTabId === view.tab.id}
                    tab={view.tab}
                    viewActive={isActive}
                    inactiveTabStreaming={settings.inactiveTabStreaming}
                    tuiFrameRate={settings.tuiFrameRate}
                    terminalScrollMode={settings.terminalScrollMode}
                    keybindings={keybindings}
                    appleKeybindings={appleKeybindings}
                    machines={displayMachines}
                    terminalFontFamily={state?.terminalFontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY}
                    terminalFontSize={settings.terminalFontSize}
                    terminalScrollbackRows={persistedSettings.terminalScrollbackRows}
                    unreadByPaneId={unreadByPaneId}
                    mediaByPaneId={mediaByPaneId}
                    focusActivePaneSignal={terminalFocusRequest?.key === view.key ? terminalFocusRequest.token : 0}
                    onActivatePane={activatePaneInTab}
                    onBell={recordPaneBell}
                    onSplit={splitPaneInTab}
                    onResizeSplit={resizeSplitInTab}
                    onClosePane={requestClosePaneInTab}
                    onDismissMedia={dismissMedia}
                    runsByPaneId={latestRunByPaneId}
                    pendingPaneLabels={pendingPaneLabels}
                  />
                </div>
              );
            })}
            </Suspense>
          </div>
        ) : (
          <EmptyWorkspaceView
            machines={displayMachines}
            targetId={targetMachineId}
            onTarget={setNewMachineId}
            onCreate={() => createWorkspace(targetMachineId)}
            onNavigate={openCommandPalette}
            onManage={openMachineManager}
          />
        )}
      </section>
      {activityOpen ? (
        !mobileViewport.isMobile ? (
          <OpenTuiActivityPanel
            rows={openTuiActivityRows}
            onClose={() => setActivityOpen(false)}
          />
        ) : (
          <ActivityPanel
            state={state}
            machines={displayMachines}
            onClose={() => setActivityOpen(false)}
          />
        )
      ) : null}
      {mobileViewport.isMobile && pendingMobileClose ? (
        <MobileCloseDialog request={pendingMobileClose} onCancel={dismissMobileClose} />
      ) : null}
      {streamOpen ? (
        <ScreenStreamViewer
          machine={activeStreamMachine}
          stream={activeStream}
          onRequest={requestStream}
          onRelease={releaseStream}
          onClose={() => setStreamOpen(false)}
        />
      ) : null}
      {diagnosticsOpen ? (
        <DiagnosticsModal
          report={doctorReport}
          loading={doctorLoading}
          error={doctorError}
          onRefresh={() => void refreshDiagnostics()}
          onClose={() => setDiagnosticsOpen(false)}
        />
      ) : null}
      {agentFleetOpen ? (
        <AgentFleet
          docked={fleetDocked && !mobileViewport.isMobile}
          onToggleDock={!mobileViewport.isMobile ? () => setFleetDocked((value) => !value) : undefined}
          state={state}
          machines={displayMachines}
          onClose={() => setAgentFleetOpen(false)}
          onOpenSession={(row: AgentFleetRow) => {
            if (!fleetDocked || mobileViewport.isMobile) setAgentFleetOpen(false);
            activateWorkspaceTab(row.workspaceId, row.tabId);
            void activatePaneInTab(row.tabId, row.paneId);
          }}
        />
      ) : null}
      {displayMachines.find((machine) => machine.id === inspectedHostId) ? (
        <HostInspector machine={displayMachines.find((machine) => machine.id === inspectedHostId)!} sessions={sessionRows}
          onClose={() => setInspectedHostId(null)}
          onManage={() => { setInspectedHostId(null); openMachineManager(); }}
          onCreate={() => { if (inspectedHostId) void createWorkspace(inspectedHostId); setInspectedHostId(null); }} />
      ) : null}
      {settingsOpen ? (
        <SettingsModal
          machines={machines}
          settings={persistedSettings}
          keybindings={keybindings}
          appleKeybindings={appleKeybindings}
          defaults={settingsDefaults}
          onPreview={setPreviewSettings}
          onSave={updateSettings}
          onCancel={cancelSettings}
          onManageMachines={openMachineManager}
        />
      ) : null}
      {machineManagerOpen ? (
        <MachineManagerModal
          onClose={() => setMachineManagerOpen(false)}
          onState={refresh}
        />
      ) : null}
      {renameWorkspaceDialog ? (
        <WorkspaceRenameDialog
          workspaceId={renameWorkspaceDialog.id}
          title={renameWorkspaceDialog.title}
          onRename={renameWorkspace}
          onClose={() => setRenameWorkspaceDialog(null)}
        />
      ) : null}
      {commandPaletteOpen ? (
        !mobileViewport.isMobile ? (
          <OpenTuiCommandPalette
            commands={commands}
            query={commandPaletteQuery}
            onQueryChange={setCommandPaletteQuery}
            onClose={() => setCommandPaletteOpen(false)}
          />
        ) : (
          <CommandPalette
            commands={commands}
            query={commandPaletteQuery}
            onQueryChange={setCommandPaletteQuery}
            onClose={() => setCommandPaletteOpen(false)}
            autoFocus={!mobileViewport.isMobile}
          />
        )
      ) : null}
    </main>
    </ColorSchemeProvider>
    ) : null}
    {!state || !bootComplete || authRequired ? (
      <RetroBootScreen
        authRequired={authRequired}
        isMobile={mobileViewport.isMobile}
        ready={Boolean(state) && !authRequired}
        onAuthenticated={() => void loadBootstrap()}
        onComplete={finishBoot}
      />
    ) : null}
    </>
  );
}

const settleMobileViewportAfterNavigation = (): void => {
  const sync = () => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event("resize"));
  };
  window.requestAnimationFrame(sync);
  window.setTimeout(sync, 120);
  window.setTimeout(sync, 320);
};

const paneHasAgentContext = (pane: { title?: string } | undefined, event: AgentActivity | undefined): boolean => {
  if (/\b(codex|claude|prime[ -]agent)\b/i.test(pane?.title ?? "")) return true;
  if (!event) return false;
  const ageMs = Date.now() - Date.parse(event.createdAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 12 * 60 * 60 * 1000;
};

const mobileCommandSectionPriority = (section: string): number => ({
  Pane: 0,
  Create: 1,
  Actions: 2,
  Navigate: 3,
  View: 4,
  System: 5,
  Close: 6,
}[section] ?? 5);

const machineFor = (machines: MachineStatus[], machineId: string): MachineStatus | undefined =>
  machines.find((machine) => machine.id === machineId);

const withMachineAlias = (machine: MachineStatus, settings: WmuxSettings): MachineStatus => {
  const alias = cleanAlias(settings.machineAliases[machine.id] ?? "");
  return alias ? { ...machine, name: alias } : machine;
};

const compactRuntimeVersion = (version: string): string =>
  /^[0-9a-f]{12,}$/i.test(version) ? version.slice(0, 8) : version;

const versionedMachineName = (machine: MachineStatus): string =>
  `${machine.name}@${compactRuntimeVersion(machine.releaseVersion)}`;

const displayWorkspaceDescriptor = (
  descriptor: string | undefined,
  displayMachine: MachineStatus | undefined,
  sourceMachine: MachineStatus | undefined,
  machineId: string,
  affinityMachineId = machineId,
): string => {
  const raw = descriptor?.trim();
  if (!raw) return displayMachine?.name ?? machineId;
  if (raw === machineId || raw === affinityMachineId || raw === sourceMachine?.name || raw === displayMachine?.id) {
    return displayMachine?.name ?? raw;
  }
  return raw;
};

const displayWorkspaceHost = (
  displayMachine: MachineStatus | undefined,
  sourceMachine: MachineStatus | undefined,
  machineId: string,
): string => displayMachine
  ? versionedMachineName(displayMachine)
  : sourceMachine
    ? versionedMachineName(sourceMachine)
    : machineId;

const compactWorkspaceDescription = (value: string | undefined, limit: number): string => {
  const cleaned = stripMarkdown(value ?? "");
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
};

const stripMarkdown = (value: string): string =>
  value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[\s>*+-]+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const workspaceAgentName = (event: AgentActivity): string => event.agent.trim();

const workspaceAgentStatusLabel = (event: AgentActivity): string => `${event.agent} ${event.status}`.trim();

const workspaceAgentSummary = (event: AgentActivity | undefined): string => {
  if (!event?.summary) return "";
  const summary = event.summary.trim();
  return summary.toLowerCase() === workspaceAgentStatusLabel(event).toLowerCase() ? "" : summary;
};

const dedupeAgentDescriptor = (descriptor: string, agentStatusLabel: string | undefined): string => {
  const cleaned = descriptor.trim();
  if (!agentStatusLabel) return cleaned;
  return cleaned.toLowerCase() === agentStatusLabel.trim().toLowerCase() ? "" : cleaned;
};

const latestRunByPane = (runs: TerminalRun[]): Map<string, TerminalRun> => {
  const latest = new Map<string, TerminalRun>();
  for (const run of runs) {
    if (!latest.has(run.paneId)) latest.set(run.paneId, run);
  }
  return latest;
};

const workspaceAgentStatusClass = (
  status: string,
  heartbeatActive = false,
): WorkspaceAgentStatus => {
  const lifecycle = agentLifecycleStatus(status);
  return heartbeatActive && ["completed", "updated"].includes(lifecycle)
    ? "heartbeat"
    : lifecycle;
};

const openTuiActivityStatus = (status: string): OpenTuiActivityRow["status"] => {
  const normalized = status.toLowerCase();
  if (["failed", "error", "cancelled", "stopped"].includes(normalized)) return "failed";
  if (["completed", "done", "success"].includes(normalized)) return "completed";
  if (normalized === "waiting") return "waiting";
  if (["running", "started", "working"].includes(normalized)) return "running";
  return "updated";
};

const machineStatusDetail = (machine: MachineStatus): string => {
  const endpoint = machine.endpoint ?? machine.host ?? machine.kind;
  const checked = machine.checkedAt ? `checked ${formatRelativeTime(machine.checkedAt)}` : "";
  const helpers = machine.helperBundleVersion ? `helpers ${machine.helperBundleVersion.slice(0, 8)}` : "";
  return [machine.reachable ? endpoint : machine.reason ?? endpoint, helpers, machine.backendDetail, checked]
    .filter(Boolean)
    .join(" / ");
};

const formatRelativeTime = (iso: string): string => {
  const elapsedMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsedMs)) return "";
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const formatDuration = (startedAt: string, completedAt: string): string => {
  const elapsedMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "unknown";
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)}s`;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};


const mountedTabViewKey = (workspaceId: string, tabId: string): string => `${workspaceId}:${tabId}`;

const sameStringList = (first: string[], second: string[]): boolean =>
  first.length === second.length && first.every((value, index) => value === second[index]);

const describeActionError = (error: unknown): string => {
  if (error instanceof UnauthorizedError) return "access token rejected — reopen the URL with ?token=…";
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
};

const activateRouteTarget = (payload: BootstrapPayload): BootstrapPayload =>
  applyClientViewToState(
    payload,
    parseRouteTarget(window.location.pathname),
    loadActiveTabSelections(),
    loadActivePaneSelections(),
  );

const countUnreadBy = (
  notifications: TerminalNotification[],
  field: "paneId" | "tabId" | "workspaceId",
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const notification of notifications) {
    if (notification.read) continue;
    counts.set(notification[field], (counts.get(notification[field]) ?? 0) + 1);
  }
  return counts;
};

const latestUnreadByWorkspace = (notifications: TerminalNotification[]): Map<string, TerminalNotification> => {
  const latest = new Map<string, TerminalNotification>();
  for (const notification of notifications) {
    if (notification.read || latest.has(notification.workspaceId)) continue;
    latest.set(notification.workspaceId, notification);
  }
  return latest;
};

const bellWorkspaces = (payload: BootstrapPayload | null, paneIds: Set<string>): Set<string> => {
  const workspaceIds = new Set<string>();
  if (!payload || paneIds.size === 0) return workspaceIds;
  for (const workspace of payload.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.panes.some((pane) => paneIds.has(pane.id))) {
        workspaceIds.add(workspace.id);
        break;
      }
    }
  }
  return workspaceIds;
};

const findPaneContextInState = (payload: BootstrapPayload, paneId: string) => {
  for (const workspace of payload.workspaces) {
    for (const tab of workspace.tabs) {
      const pane = tab.panes.find((candidate) => candidate.id === paneId);
      if (pane) return { workspace, tab, pane };
    }
  }
  return null;
};

const groupMediaByPane = (items: TerminalMedia[]): Map<string, TerminalMedia[]> => {
  const grouped = new Map<string, TerminalMedia[]>();
  for (const item of items) {
    grouped.set(item.paneId, [...(grouped.get(item.paneId) ?? []), item]);
  }
  return grouped;
};

const modulo = (value: number, length: number): number => ((value % length) + length) % length;

const flattenPaneIds = (node: LayoutNode): string[] => {
  if (node.type === "pane") return [node.paneId];
  return [...flattenPaneIds(node.first), ...flattenPaneIds(node.second)];
};
