import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Activity, Bell, BellRing, CheckCheck, ChevronDown, ChevronRight, CirclePlus, Command as CommandIcon, GripVertical, Link2, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeft, PanelLeftClose, PanelLeftOpen, Plus, ScreenShare, Server, Settings, TerminalSquare, X } from "lucide-react";
import { api, modalSettingsUpdate, UnauthorizedError, WorkspaceReorderConflictError } from "./api";
import { DiagnosticsModal } from "./DiagnosticsModal";
import { ActivityPanel, buildActivityItems } from "./ActivityPanel";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { SettingsModal, cleanAlias, defaultSettings, type SettingsSurface } from "./SettingsModal";
import { ColorSchemeProvider } from "./color-scheme-context";
import { colorSchemeById, colorSchemeCssVariables } from "./color-schemes";

// The full pane surface (Ghostty + Kitty graphics) stays lazy; the lightweight
// boot screen owns the initial Ghostty startup while the API bootstrap runs.
const LayoutView = lazy(() => import("./LayoutView").then((m) => ({ default: m.LayoutView })));
import { createAppStore, useAppState } from "./app-store";
import { RetroBootScreen } from "./RetroBootScreen";
import { EmptyWorkspaceView } from "./EmptyWorkspaceView";
import { MobileAgentSurface } from "./MobileAgentSurface";
import { OpenTuiActivityPanel } from "./OpenTuiActivityPanel";
import { OpenTuiMobileChrome } from "./OpenTuiMobileChrome";
import type { OpenTuiActivityRow } from "./OpenTuiActivityPanel";
import { OpenTuiCommandPalette } from "./OpenTuiCommandPalette";
import { OpenTuiSettingsModal } from "./OpenTuiSettingsModal";
import { OpenTuiSidebar } from "./OpenTuiSidebar";
import type { OpenTuiSidebarMachine, OpenTuiSidebarWorkspace } from "./OpenTuiSidebar";
import { OpenTuiTopbar } from "./OpenTuiTopbar";
import { applyClientViewToState, loadActivePaneSelections, loadActiveTabSelections, markWorkspaceNotificationsReadInState, parseRouteTarget, workspaceTabPath } from "./route-state";
import { compactMiddlePath, normalizeUserPath } from "./path-display";
import { formatSessionReference } from "./session-reference";
import {
  applyHealthDelta,
  bootstrapSatisfiesHealthDelta,
  healthDeltaRequiresResync,
  isIncomingRevisionNewer,
  reconcileIncomingRevision,
} from "./reconcile";
import { ScreenStreamViewer } from "./ScreenStream";
import { Toasts, useToasts } from "./Toasts";
import { useAppRouting } from "./useAppRouting";
import { useEventStream } from "./useEventStream";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { isApplePlatform } from "./keybinding-platform";
import { defaultKeybindings, displayBindingForAction, type KeybindingAction } from "../../shared/keybindings";
import { usePaneActions } from "./usePaneActions";
import { maxSidebarWidth, useSidebar } from "./useSidebar";
import { writeBrowserClipboard } from "./clipboard";
import { summarizeWorkspaceVersion } from "./workspace-version";
import { useMobileViewportState } from "./mobile-viewport";
import { loadMachineTargetId, persistMachineTargetId, resolveMachineTargetId } from "./machine-target";
import { workspacePresentationDescriptor, workspacePresentationMachineId } from "./workspace-presentation";
import { WorkspaceMoveDialog } from "./WorkspaceMoveDialog";
import {
  deriveWorkspaceTree,
  expandWorkspaceAncestors,
  pruneCollapsedWorkspaceIds,
  rebaseCollapsedWorkspaceIds,
  sameWorkspaceIds,
  workspacePointerMovePosition,
  type WorkspaceActivityAggregate,
  type WorkspaceMoveIntent,
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
  type OptimisticCreation,
} from "./optimistic-creation";
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

type MobileSurfaceMode = "agent" | "terminal";
const maxMountedTabViews = 6;
const mobileSurfaceModeStorageKey = "wmux.mobileSurfaceMode";

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

interface WorkspaceDropPreview {
  workspaceId: string;
  targetWorkspaceId?: string;
  position: WorkspaceReorderPosition;
}

export function App() {
  const openTuiMode = useMemo(() => new URLSearchParams(window.location.search).get("legacy") !== "1", []);
  const mobileViewport = useMobileViewportState();
  const store = useMemo(createAppStore, []);
  const state = useAppState(store);
  const [newMachineId, setNewMachineId] = useState(() => loadMachineTargetId(window.localStorage));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [bootComplete, setBootComplete] = useState(false);
  const { toasts, pushToast, dismissToast } = useToasts();
  const {
    sidebarCollapsed,
    sidebarWidth,
    toggleSidebar,
    collapseSidebar,
    startSidebarResize,
    onSidebarResizerKeyDown,
  } = useSidebar(mobileViewport.isMobile);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSurface, setSettingsSurface] = useState<SettingsSurface>("dom");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [previewSettings, setPreviewSettings] = useState<WmuxSettings | null>(null);
  const [workspaceHostFilter, setWorkspaceHostFilter] = useState("all");
  const [workspaceDropPreview, setWorkspaceDropPreview] = useState<WorkspaceDropPreview | null>(null);
  const [moveWorkspace, setMoveWorkspace] = useState<{ workspaceId: string; returnFocus: HTMLElement | null } | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [streamOpen, setStreamOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState("");
  const [mobileSurfaceMode, setMobileSurfaceMode] = useState<MobileSurfaceMode>(loadMobileSurfaceMode);
  const [bellPaneIds, setBellPaneIds] = useState<Set<string>>(() => new Set());
  const [mountedTabKeys, setMountedTabKeys] = useState<string[]>([]);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<TerminalFocusRequest | null>(null);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [pendingPaneLabels, setPendingPaneLabels] = useState<Map<string, string>>(() => new Map());
  const optimisticCreations = useRef(new Map<string, OptimisticCreation>());
  const pendingActionKeys = useRef(new Set<string>());
  const collapseWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const collapseWriteVersion = useRef(0);
  const desiredCollapsedWorkspaceIds = useRef<string[] | null>(null);
  const draggedWorkspaceId = useRef<string | null>(null);
  const workspaceDropPreviewRef = useRef<WorkspaceDropPreview | null>(null);
  const terminalFocusToken = useRef(0);
  const bootstrapRetryTimer = useRef<number | undefined>(undefined);
  const bootstrapRetryAttempt = useRef(0);
  const bootstrapRequestId = useRef(0);
  const loadBootstrapRef = useRef<() => Promise<void>>(async () => undefined);
  const pendingHealthResync = useRef<Pick<BootstrapPayload, "revision" | "healthEpoch"> | null>(null);
  const mobileSidebarRef = useRef<HTMLElement | null>(null);
  const mobileSidebarCloseRef = useRef<HTMLButtonElement | null>(null);
  const previousMobileSidebarCollapsed = useRef(sidebarCollapsed);
  const finishBoot = useCallback(() => setBootComplete(true), []);

  const rebaseIncomingState = useCallback((payload: BootstrapPayload): BootstrapPayload =>
    rebaseCollapsedWorkspaceIds(
      applyOptimisticCreations(payload, optimisticCreations.current.values()),
      desiredCollapsedWorkspaceIds.current,
    ), []);

  const beginOptimisticCreation = useCallback((creation: OptimisticCreation, label: string) => {
    optimisticCreations.current.set(creation.key, creation);
    setPendingPaneLabels((current) => new Map(current).set(creation.paneId, label));
    store.update((current) => current ? applyOptimisticCreations(current, [creation]) : current);
  }, [store]);

  const finishOptimisticCreation = useCallback((creation: OptimisticCreation) => {
    optimisticCreations.current.delete(creation.key);
    setPendingPaneLabels((current) => {
      if (!current.has(creation.paneId)) return current;
      const next = new Map(current);
      next.delete(creation.paneId);
      return next;
    });
  }, []);

  useEffect(() => {
    window.localStorage.setItem(mobileSurfaceModeStorageKey, mobileSurfaceMode);
  }, [mobileSurfaceMode]);

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
    const wasCollapsed = previousMobileSidebarCollapsed.current;
    previousMobileSidebarCollapsed.current = sidebarCollapsed;
    if (!mobileViewport.isMobile || wasCollapsed === sidebarCollapsed) return;
    const frame = window.requestAnimationFrame(() => {
      if (!sidebarCollapsed) {
        mobileSidebarCloseRef.current?.focus();
        return;
      }
      const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-controls="wmux-sidebar"]'));
      triggers.find((trigger) => trigger.getClientRects().length > 0)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mobileViewport.isMobile, sidebarCollapsed]);

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

  const loadBootstrap = useCallback(async () => {
    const requestId = ++bootstrapRequestId.current;
    if (bootstrapRetryTimer.current) window.clearTimeout(bootstrapRetryTimer.current);
    bootstrapRetryTimer.current = undefined;
    try {
      const payload = await api.bootstrap();
      const routed = rebaseIncomingState(activateRouteTarget(payload));
      if (requestId !== bootstrapRequestId.current) return;
      if (!bootstrapSatisfiesHealthDelta(pendingHealthResync.current, routed)) {
        void loadBootstrapRef.current();
        return;
      }
      pendingHealthResync.current = null;
      bootstrapRetryAttempt.current = 0;
      setLoadError(null);
      setAuthRequired(false);
      const current = store.get();
      const next = reconcileIncomingRevision(current, routed);
      if (next !== current) store.set(next);
    } catch (nextError) {
      if (requestId !== bootstrapRequestId.current) return;
      // An auth failure routes to the login screen instead of the fatal overlay.
      if (nextError instanceof UnauthorizedError) {
        bootstrapRetryAttempt.current = 0;
        setLoadError(null);
        setAuthRequired(true);
        return;
      }
      bootstrapRetryAttempt.current += 1;
      if (!store.get()) setLoadError(describeActionError(nextError));
      const delay = Math.min(15_000, 500 * (2 ** Math.min(bootstrapRetryAttempt.current, 5)));
      bootstrapRetryTimer.current = window.setTimeout(() => void loadBootstrapRef.current(), delay);
    }
  }, [rebaseIncomingState, store]);
  loadBootstrapRef.current = loadBootstrap;

  useEffect(() => {
    void loadBootstrap();
    const resume = () => {
      if (document.visibilityState === "hidden" || store.get()) return;
      void loadBootstrapRef.current();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      bootstrapRequestId.current += 1;
      if (bootstrapRetryTimer.current) window.clearTimeout(bootstrapRetryTimer.current);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [loadBootstrap, store]);

  const { serviceConnection, mediaItems, dismissMedia, sendEventSocketMessage } = useEventStream({
    enabled: !authRequired,
    onResync: (payload) => {
      if (!bootstrapSatisfiesHealthDelta(pendingHealthResync.current, payload)) return;
      pendingHealthResync.current = null;
      void refresh(payload);
    },
    onHealth: (delta) => {
      const current = store.get();
      if (healthDeltaRequiresResync(current, delta)) {
        const pending = pendingHealthResync.current;
        if (!pending || isIncomingRevisionNewer(pending, delta)) {
          pendingHealthResync.current = delta;
          void loadBootstrapRef.current();
        }
        return;
      }
      store.update((snapshot) => applyHealthDelta(snapshot, delta) ?? null);
    },
    onAuthRequired: () => setAuthRequired(true),
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
  const notifications = state?.notifications ?? [];
  const unreadNotifications = notifications.filter((notification) => !notification.read);
  const unreadByPaneId = useMemo(() => countUnreadBy(notifications, "paneId"), [notifications]);
  const unreadByTabId = useMemo(() => countUnreadBy(notifications, "tabId"), [notifications]);
  const unreadByWorkspaceId = useMemo(() => countUnreadBy(notifications, "workspaceId"), [notifications]);
  const latestUnreadByWorkspaceId = useMemo(() => latestUnreadByWorkspace(notifications), [notifications]);
  const mediaByPaneId = useMemo(() => groupMediaByPane(mediaItems), [mediaItems]);
  const agentEvents = state?.agentEvents ?? [];
  const runs = state?.runs ?? [];
  const streams = state?.streams ?? [];
  const bellByWorkspaceId = useMemo(() => bellWorkspaces(state, bellPaneIds), [bellPaneIds, state]);
  const latestAgentByWorkspaceId = useMemo(() => latestAgentByWorkspace(agentEvents), [agentEvents]);
  const latestAgentByPaneId = useMemo(() => latestAgentByPane(agentEvents), [agentEvents]);
  const latestRunByPaneId = useMemo(() => latestRunByPane(runs), [runs]);

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
      const agent = latestAgentByWorkspaceId.get(workspace.id);
      activity.set(workspace.id, {
        unreadCount: unreadByWorkspaceId.get(workspace.id) ?? 0,
        bell: bellByWorkspaceId.has(workspace.id),
        agentStatus: agent ? agentStatusClass(agent.status) : undefined,
      });
    }
    return activity;
  }, [bellByWorkspaceId, latestAgentByWorkspaceId, state?.workspaces, unreadByWorkspaceId]);
  const workspaceTree = useMemo(() => deriveWorkspaceTree({
    workspaces: state?.workspaces ?? [],
    activeWorkspaceId: activeWorkspace?.id,
    hostFilter: workspaceHostFilter,
    collapsedWorkspaceIds: persistedSettings.collapsedWorkspaceIds,
    activityByWorkspaceId: workspaceActivity,
  }), [activeWorkspace?.id, persistedSettings.collapsedWorkspaceIds, state?.workspaces, workspaceActivity, workspaceHostFilter]);
  const openTuiWorkspaces = useMemo<OpenTuiSidebarWorkspace[]>(
    () =>
      workspaceTree.rows.flatMap((treeRow) => {
        const workspace = treeRow.workspace;
        const presentationMachineId = workspacePresentationMachineId(workspace);
        const machine = machineFor(displayMachines, presentationMachineId);
        const sourceMachine = machineFor(machines, presentationMachineId);
        const affinityMachine = machineFor(machines, workspace.machineId);
        const latestUnread = latestUnreadByWorkspaceId.get(workspace.id);
        const latestAgent = latestAgentByWorkspaceId.get(workspace.id);
        const latestAgentName = latestAgent ? workspaceAgentName(latestAgent) : undefined;
        const latestAgentStatusLabel = latestAgent ? workspaceAgentStatusLabel(latestAgent) : undefined;
        const tab = workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId) ?? workspace.tabs[0];
        if (!tab) return [];
        const pane = tab.panes.find((candidate) => candidate.id === tab.activePaneId) ?? tab.panes[0];
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
            host,
            cwd,
            reachable: Boolean(machine?.reachable),
            active: workspace.id === activeWorkspace?.id,
            unreadCount: treeRow.ownActivity.unreadCount,
            agentCreated: workspace.createdBy === "agent",
            agentName: latestAgentName,
            agentStatus: latestAgent ? agentStatusClass(latestAgent.status) : undefined,
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
          },
        ];
      }),
    [
      activeWorkspace?.id,
      bellByWorkspaceId,
      displayMachines,
      latestAgentByWorkspaceId,
      latestUnreadByWorkspaceId,
      machines,
      unreadByWorkspaceId,
      workspaceTree.rows,
    ],
  );
  const openTuiMachines = useMemo<OpenTuiSidebarMachine[]>(
    () =>
      displayMachines.map((machine) => ({
        id: machine.id,
        name: machine.name,
        version: machine.releaseVersion,
        reachable: machine.reachable,
        detail: machineStatusDetail(machine),
      })),
    [displayMachines],
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

  const { refresh, activateWorkspaceTab, activatePane, chromePath } = useAppRouting({
    store,
    openTuiMode,
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

  useEffect(() => {
    if (!state) return;
    if (desiredCollapsedWorkspaceIds.current) return;
    let desired = pruneCollapsedWorkspaceIds(state.workspaces, state.settings.collapsedWorkspaceIds);
    if (activeWorkspace) desired = expandWorkspaceAncestors(state.workspaces, desired, activeWorkspace.id);
    if (!sameWorkspaceIds(desired, state.settings.collapsedWorkspaceIds)) void persistCollapsedWorkspaceIds(desired);
  }, [activeWorkspace?.id, persistCollapsedWorkspaceIds, state?.settings.collapsedWorkspaceIds, state?.workspaces]);

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
    setSettingsSurface(openTuiMode && !mobileViewport.isMobile ? "opentui" : "dom");
    setSettingsOpen(true);
  }, [mobileViewport.isMobile, openTuiMode]);

  const cancelSettings = () => {
    setPreviewSettings(null);
    setSettingsOpen(false);
  };

  const switchChromeMode = (enabled: boolean) => {
    const params = new URLSearchParams(window.location.search);
    params.delete("opentui");
    if (enabled) params.delete("legacy");
    else params.set("legacy", "1");
    const query = params.toString();
    window.location.assign(`${window.location.pathname}${query ? `?${query}` : ""}`);
  };

  const targetMachineId = resolveMachineTargetId(newMachineId, displayMachines);
  const selectedMachine = displayMachines.find((machine) => machine.id === targetMachineId);
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
  const mobileHeaderMachine = activePane
    ? machineFor(displayMachines, activePane.machineId)
    : activeWorkspace
      ? machineFor(displayMachines, activeWorkspace.machineId)
      : undefined;
  const mobileHeaderAgent = activePane ? latestAgentByPaneId.get(activePane.id) : undefined;
  const mobileHeaderStatus = mobileHeaderAgent
    ? agentStatusClass(mobileHeaderAgent.status)
    : activePane?.status === "running"
      ? "running"
      : activePane?.status === "exited"
        ? "failed"
        : "updated";
  const mobileHeaderStatusLabel = mobileHeaderAgent?.status ?? activePane?.status ?? "idle";
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

  const { splitPaneInTab, resizeSplitInTab, closePaneInTab, splitPane, resizeSplit, closePane } = usePaneActions({
    activeTabId: activeTab?.id,
    refresh,
    activatePane,
    runPending,
    splitPaneRequest: optimisticSplitPaneRequest,
  });

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
      activateWorkspaceTab(response.workspace.id, response.workspace.activeTabId, { replaceHistory: false });
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
    const url = new URL(chromePath(workspaceTabPath(activeWorkspace.id, activeTab.id)), window.location.origin);
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
      activateWorkspaceTab(activeWorkspace.id, response.tab.id, { replaceHistory: false });
      if (mobileViewport.isMobile) collapseSidebar();
    } catch (error) {
      finishOptimisticCreation(creation);
      await refresh().catch(() => undefined);
      throw error;
    }
  });

  const closeActiveTab = guard(() => `tab:${activeTab?.id ?? "unknown"}:close`, "Closing tab...", async () => {
    if (!activeWorkspace || !activeTab) return;
    const response = await api.closeTab(activeWorkspace.id, activeTab.id);
    await refresh(response.state);
  });

  const closeActiveWorkspace = guard(() => `workspace:${activeWorkspace?.id ?? "unknown"}:close`, "Closing workspace...", async () => {
    if (!state || !activeWorkspace) return;
    const response = await api.closeWorkspace(activeWorkspace.id);
    await refresh(response.state);
  });

  const reorderWorkspace = guard(
    (workspaceId: string, _targetWorkspaceId: string | undefined, _position: WorkspaceReorderPosition) => `workspace:${workspaceId}:reorder`,
    "Reordering workspace...",
    async (workspaceId: string, targetWorkspaceId: string | undefined, position: WorkspaceReorderPosition) => {
      if (workspaceId === targetWorkspaceId) return;
      const current = store.get();
      if (!current || workspaceTree.movesDisabled) return;
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

  const sendPaneInput = async (paneId: string, data: string): Promise<void> => {
    try {
      await refresh(await api.sendPaneInput(paneId, data));
    } catch (nextError) {
      pushToast(`Send input failed: ${describeActionError(nextError)}`);
      throw nextError;
    }
  };

  const activateWorkspaceAt = (index: number) => {
    if (!state) return;
    const workspace = state.workspaces[index];
    const tab = workspace?.tabs.find((candidate) => candidate.id === workspace.activeTabId) ?? workspace?.tabs[0];
    if (workspace && tab) activateWorkspaceTab(workspace.id, tab.id);
  };

  const activateWorkspaceRelative = (delta: number) => {
    if (!state || !activeWorkspace) return;
    const current = state.workspaces.findIndex((workspace) => workspace.id === activeWorkspace.id);
    if (current === -1) return;
    const next = modulo(current + delta, state.workspaces.length);
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
  };

  const openCommandPalette = () => {
    setCommandPaletteQuery("");
    setCommandPaletteOpen(true);
  };

  const activePaneForSplit = activeTab?.panes.find((candidate) => candidate.id === activeTab.activePaneId);
  useKeyboardShortcuts({
    keybindings,
    apple: appleKeybindings,
    modalOpen: settingsOpen || commandPaletteOpen || diagnosticsOpen,
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
    activateWorkspaceAtDigit: state
      ? (digit) => activateWorkspaceAt(digit === 9 ? state.workspaces.length - 1 : digit - 1)
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
        id: "open-diagnostics",
        title: "Open diagnostics",
        subtitle: "Pane drivers, restart durability, and session health",
        section: "System",
        run: openDiagnostics,
        keywords: ["doctor", "health", "driver", "restart", "reconnect"],
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
              : "Waiting for wmux-stream-agent",
        section: "View",
        disabled: !canOpenStream,
        run: () => setStreamOpen(true),
        keywords: ["screen", "display", "webrtc", "pixels", "moonlight", "sunshine"],
      },
      {
        id: "switch-chrome-mode",
        title: openTuiMode ? "Use legacy browser chrome" : "Use canvas chrome",
        subtitle: openTuiMode ? "Reload with the original React controls" : "Reload with the canvas-grid interface",
        section: "View",
        run: () => switchChromeMode(!openTuiMode),
        keywords: ["canvas", "grid", "chrome", "ui", "legacy"],
      },
      {
        id: "copy-link",
        title: "Copy active session link",
        subtitle: activeWorkspace && activeTab ? `${activeWorkspace.name} / ${activeTab.title}` : undefined,
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
        subtitle: activeWorkspace?.name,
        section: "Create",
        shortcut: shortcutFor("tab.new"),
        disabled: !selectedMachine?.reachable || !activeWorkspace,
        run: () => createTab(targetMachineId),
        keywords: ["session"],
      },
      {
        id: "split-right",
        title: `Split right on ${activePaneMachine?.name ?? activePane?.machineId ?? "current host"}`,
        subtitle: activeTab?.title,
        section: "Pane",
        shortcut: shortcutFor("pane.splitRight"),
        disabled: !activePane || !activePaneMachine?.reachable,
        run: () => activePane && splitPane(activePane.id, "vertical"),
        keywords: ["vertical", "pane"],
      },
      {
        id: "split-down",
        title: `Split down on ${activePaneMachine?.name ?? activePane?.machineId ?? "current host"}`,
        subtitle: activeTab?.title,
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
        subtitle: activeTab?.title,
        section: "Close",
        shortcut: shortcutFor("tab.close"),
        disabled: !activeWorkspace || !activeTab,
        run: closeActiveTab,
      },
      {
        id: "close-workspace",
        title: "Close current workspace",
        subtitle: activeWorkspace?.name,
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
        id: `target-host:${machine.id}`,
        title: `Set target host: ${machine.name}`,
        subtitle: machine.reachable ? machine.kind : machine.reason ?? "Offline",
        section: "Hosts",
        disabled: !machine.reachable,
        run: () => setNewMachineId(machine.id),
        keywords: [machine.id, machine.host ?? ""],
      },
      {
        id: `filter-host:${machine.id}`,
        title: `Filter workspaces: ${machine.name}`,
        subtitle: "Show only workspaces with this host affinity",
        section: "Hosts",
        run: () => setWorkspaceHostFilter(machine.id),
        keywords: [machine.id, machine.host ?? "", "filter"],
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

    hostCommands.unshift({
      id: "filter-host:all",
      title: "Filter workspaces: all hosts",
      subtitle: "Show every workspace",
      section: "Hosts",
      run: () => setWorkspaceHostFilter("all"),
      keywords: ["filter", "hosts", "all"],
    });

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

    return [...base, ...hostCommands, ...workspaceCommands];
  }, [
    activeTab,
    activeWorkspace,
    requestTerminalFocus,
    displayMachines,
    machines,
    targetMachineId,
    openTuiMode,
    openSettings,
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
  if (!state || !bootComplete || authRequired) {
    return (
      <RetroBootScreen
        authRequired={authRequired}
        ready={Boolean(state) && !authRequired}
        onAuthenticated={() => void loadBootstrap()}
        onComplete={finishBoot}
      />
    );
  }

  const appClassName = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    openTuiMode ? "open-tui-mode" : "",
    mobileViewport.isMobile ? "mobile-viewport" : "",
    mobileViewport.keyboardOpen ? "mobile-keyboard-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <ColorSchemeProvider id={settings.colorScheme}>
    <main className={appClassName} style={appStyle} aria-busy={pendingActions.length > 0}>
      <Toasts toasts={toasts} dismissToast={dismissToast} />
      {pendingActions.length > 0 ? (
        <div className="mutation-status" role="status" aria-live="polite">
          <LoaderCircle size={15} aria-hidden="true" />
          <span>{pendingActions[pendingActions.length - 1].label}</span>
          {pendingActions.length > 1 ? <span className="mutation-status-count">+{pendingActions.length - 1}</span> : null}
        </div>
      ) : null}
      {openTuiMode && !mobileViewport.isMobile ? (
        <OpenTuiSidebar
          targetMachineId={targetMachineId}
          targetMachineName={selectedMachine ? versionedMachineName(selectedMachine) : targetMachineId}
          targetMachineReachable={Boolean(selectedMachine?.reachable)}
          workspaces={openTuiWorkspaces}
          machines={openTuiMachines}
          onTargetMachineChange={setNewMachineId}
          onCreateWorkspace={() => createWorkspace(targetMachineId)}
          onActivateWorkspace={activateWorkspaceFromChrome}
          onReorderWorkspace={reorderWorkspace}
          onToggleWorkspace={toggleWorkspaceCollapsed}
          movesDisabled={workspaceTree.movesDisabled}
          allWorkspaces={state.workspaces}
          hostFilter={workspaceHostFilter}
          onHostFilterChange={setWorkspaceHostFilter}
        />
      ) : (
      <aside
        ref={mobileSidebarRef}
        id="wmux-sidebar"
        className={`sidebar ${openTuiMode ? "mobile-open-tui-sidebar" : ""}`}
        aria-label="Workspace navigation"
        aria-hidden={mobileViewport.isMobile && sidebarCollapsed}
      >
        <div className="brand">
          <PanelLeft size={18} />
          <span>wmux</span>
        </div>
        <div className="target-host">
          <div className="target-host-label">
            <span>Target host</span>
            <span className={`reach-dot ${selectedMachine?.reachable ? "on" : ""}`} />
          </div>
          <div className="new-session">
            <select title="Target host for new workspaces and tabs" value={targetMachineId} onChange={(event) => setNewMachineId(event.target.value)}>
            {displayMachines.map((machine) => (
              <option key={machine.id} value={machine.id} disabled={!machine.reachable}>
                {versionedMachineName(machine)}
              </option>
              ))}
            </select>
            <button
              title={`New workspace on ${selectedMachine?.name ?? targetMachineId}`}
              disabled={!selectedMachine?.reachable}
              onClick={() => createWorkspace(targetMachineId)}
            >
              <CirclePlus size={17} />
            </button>
          </div>
        </div>
        <div className="sidebar-label workspace-toolbar">
          <span>Workspaces</span>
          <select
            title="Filter workspace list by host"
            value={workspaceHostFilter}
            onChange={(event) => setWorkspaceHostFilter(event.target.value)}
          >
            <option value="all">All hosts</option>
            {displayMachines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {versionedMachineName(machine)}
              </option>
            ))}
          </select>
        </div>
        <nav className="workspace-list" role="tree" aria-label="Workspace tree">
            {workspaceTree.rows.length === 0 ? <div className="workspace-empty">No workspaces</div> : null}
            {workspaceTree.rows.map((treeRow) => {
              const workspace = treeRow.workspace;
              const presentationMachineId = workspacePresentationMachineId(workspace);
              const machine = machineFor(displayMachines, presentationMachineId);
              const sourceMachine = machineFor(machines, presentationMachineId);
              const affinityMachine = machineFor(machines, workspace.machineId);
              const unreadCount = treeRow.ownActivity.unreadCount + treeRow.hiddenActivity.unreadCount;
              const latestUnread = latestUnreadByWorkspaceId.get(workspace.id);
              const latestAgent = latestAgentByWorkspaceId.get(workspace.id);
              const latestAgentName = latestAgent ? workspaceAgentName(latestAgent) : undefined;
              const latestAgentStatusLabel = latestAgent ? workspaceAgentStatusLabel(latestAgent) : undefined;
              const tab = workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId) ?? workspace.tabs[0];
              if (!tab) return null;
              const pane = tab.panes.find((candidate) => candidate.id === tab.activePaneId) ?? tab.panes[0];
              const cwd = normalizeUserPath(pane?.cwd);
              const cwdDisplay = cwd ? compactMiddlePath(cwd, 24) : undefined;
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
              const hostContext = latestAgentName ? `${host} / ${latestAgentName}` : host;
              const visibleDescriptor = compactWorkspaceDescription(descriptor, 72);
              const tooltipDescriptor = compactWorkspaceDescription(descriptor, 200);
              const version = summarizeWorkspaceVersion(workspace, displayMachines);
              const showDescriptor = visibleDescriptor && visibleDescriptor !== host && visibleDescriptor !== hostContext;
              const tooltip = [
                workspace.name,
                workspace.createdBy === "agent" ? "Agent-created" : "",
                showDescriptor ? tooltipDescriptor : "",
                hostContext,
                version?.detail,
                cwd,
                formatSessionReference(pane?.id),
              ].filter(Boolean).join(" / ");
              const latestAgentStatus = latestAgent ? agentStatusClass(latestAgent.status) : "";
              const hasBell = treeRow.ownActivity.bell || treeRow.hiddenActivity.bell;
              const workspaceStateClass = latestAgentStatus || (machine?.reachable ? "reachable" : "offline");
              const workspaceStateTitle = latestAgent
                ? `${latestAgent.agent} ${latestAgent.status}`
                : machine?.reachable
                  ? "Host reachable"
                  : "Host offline";
              return (
              <div
                key={workspace.id}
                className="workspace-tree-row"
                role="none"
                style={{ "--workspace-tree-depth": treeRow.depth } as CSSProperties}
              >
              {treeRow.hasChildren ? (
                <button
                  type="button"
                  className="workspace-disclosure"
                  aria-label={`${treeRow.effectiveExpanded ? "Collapse" : "Expand"} ${workspace.name}`}
                  onClick={() => toggleWorkspaceCollapsed(workspace.id)}
                >
                  {treeRow.effectiveExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : <span className="workspace-disclosure-spacer" aria-hidden="true" />}
              <a
                href={workspaceTabPath(workspace.id, tab.id)}
                title={`${tooltip}${workspaceTree.movesDisabled ? "" : " / Drag to reorder"}`}
                draggable={!workspaceTree.movesDisabled}
                role="treeitem"
                aria-level={treeRow.depth + 1}
                aria-expanded={treeRow.hasChildren ? treeRow.effectiveExpanded : undefined}
                aria-current={workspace.id === activeWorkspace?.id ? "page" : undefined}
                className={`workspace-item ${workspace.id === activeWorkspace?.id ? "active" : ""} ${
                  machine?.reachable ? "" : "disabled"
                } ${workspace.createdBy === "agent" ? "agent-created" : ""} ${
                  latestAgentStatus ? `agent-${latestAgentStatus}` : ""
                } ${workspaceDropPreview?.workspaceId === workspace.id ? "dragging" : ""} ${
                  workspaceDropPreview?.targetWorkspaceId === workspace.id
                    ? `drop-${workspaceDropPreview.position}`
                    : ""
                }`}
                onClick={(event) => activateWorkspaceLink(event, workspace.id, tab.id, { focusTerminal: true })}
                onDragStart={(event) => {
                  if (workspaceTree.movesDisabled) {
                    event.preventDefault();
                    return;
                  }
                  draggedWorkspaceId.current = workspace.id;
                  workspaceDropPreviewRef.current = null;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", workspace.id);
                  setWorkspaceDropPreview(null);
                }}
                onDragOver={(event) => {
                  if (workspaceTree.movesDisabled) return;
                  const sourceWorkspaceId = draggedWorkspaceId.current;
                  if (!sourceWorkspaceId || sourceWorkspaceId === workspace.id) {
                    workspaceDropPreviewRef.current = null;
                    setWorkspaceDropPreview(null);
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect();
                  const position = workspacePointerMovePosition((event.clientY - rect.top) / rect.height);
                  workspaceDropPreviewRef.current = { workspaceId: sourceWorkspaceId, targetWorkspaceId: workspace.id, position };
                  setWorkspaceDropPreview((current) =>
                    current?.workspaceId === sourceWorkspaceId &&
                    current.targetWorkspaceId === workspace.id &&
                    current.position === position
                      ? current
                      : { workspaceId: sourceWorkspaceId, targetWorkspaceId: workspace.id, position },
                  );
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const preview = workspaceDropPreviewRef.current;
                  draggedWorkspaceId.current = null;
                  workspaceDropPreviewRef.current = null;
                  setWorkspaceDropPreview(null);
                  if (preview) void reorderWorkspace(preview.workspaceId, preview.targetWorkspaceId, preview.position);
                }}
                onDragEnd={() => {
                  draggedWorkspaceId.current = null;
                  workspaceDropPreviewRef.current = null;
                  setWorkspaceDropPreview(null);
                }}
                >
                  <span className={`workspace-state-dot ${workspaceStateClass}`} title={workspaceStateTitle} />
                  {hasBell ? <Bell size={10} className="workspace-bell-indicator" aria-label="Terminal bell" /> : null}
                  <span className="workspace-title">
                    {workspace.createdBy === "agent" ? (
                      <span className="workspace-origin-badge" title="Created by an agent">AI</span>
                    ) : null}
                    <span className="workspace-title-text">{workspace.name}</span>
                    {version?.status === "outdated" ? (
                      <span
                        className={`workspace-version-badge ${version.status}`}
                        title={version.detail}
                        aria-label={version.detail}
                        data-version-status={version.status}
                      >
                        {version.label}
                      </span>
                    ) : null}
                  </span>
                  {unreadCount > 0 ? <span className="badge workspace-badge">{unreadCount}{treeRow.hiddenActivity.unreadCount ? "*" : ""}</span> : null}
                  {treeRow.hiddenActivity.agentStatus ? (
                    <span
                      className={`workspace-hidden-branch-status ${treeRow.hiddenActivity.agentStatus}`}
                      title={`Hidden descendant agent status: ${treeRow.hiddenActivity.agentStatus}`}
                      aria-label={`Hidden descendant agent status: ${treeRow.hiddenActivity.agentStatus}`}
                    >
                      ↳ {treeRow.hiddenActivity.agentStatus}
                    </span>
                  ) : null}
                  <span className="workspace-meta">
                    {showDescriptor ? <span className="workspace-descriptor">{visibleDescriptor}</span> : null}
                    <span className="workspace-host">{hostContext}</span>
                  </span>
                  {cwdDisplay ? (
                    <span className="workspace-cwd" title={cwdDisplay.full}>
                      <span className="workspace-cwd-edge">{cwdDisplay.prefix}</span>
                      {cwdDisplay.marker ? <span className="workspace-cwd-marker">{cwdDisplay.marker}</span> : null}
                      {cwdDisplay.suffix ? <span className="workspace-cwd-edge">{cwdDisplay.suffix}</span> : null}
                    </span>
                  ) : null}
                </a>
                {!workspaceTree.movesDisabled ? (
                  <button
                    type="button"
                    className="workspace-move-button"
                    title={`Move ${workspace.name}`}
                    aria-label={`Move ${workspace.name}`}
                    onClick={(event) => setMoveWorkspace({ workspaceId: workspace.id, returnFocus: event.currentTarget })}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                ) : null}
              </div>
              );
            })}
            {mobileViewport.isMobile && activeWorkspace ? (
              <div className="mobile-session-navigation" aria-label={`Sessions in ${activeWorkspace.name}`}>
                <div className="mobile-session-navigation-header">
                  <span>Tabs</span>
                  <button
                    type="button"
                    title={`New tab on ${selectedMachine?.name ?? targetMachineId}`}
                    aria-label={`New tab on ${selectedMachine?.name ?? targetMachineId}`}
                    disabled={!selectedMachine?.reachable}
                    onClick={() => createTab(targetMachineId)}
                  >
                    <Plus size={16} />
                  </button>
                </div>
                <div className="mobile-tab-navigation">
                  {activeWorkspace.tabs.map((tab) => (
                    <a
                      key={tab.id}
                      href={workspaceTabPath(activeWorkspace.id, tab.id)}
                      className={tab.id === activeTab?.id ? "active" : ""}
                      aria-current={tab.id === activeTab?.id ? "page" : undefined}
                      onClick={(event) => activateWorkspaceLink(event, activeWorkspace.id, tab.id)}
                    >
                      <TerminalSquare size={16} aria-hidden="true" />
                      <span>{tab.title}</span>
                      {(unreadByTabId.get(tab.id) ?? 0) > 0 ? <span className="badge">{unreadByTabId.get(tab.id)}</span> : null}
                    </a>
                  ))}
                </div>
                {activeTab && activeTab.panes.length > 1 ? (
                  <div className="mobile-pane-navigation" aria-label={`Panes in ${activeTab.title}`}>
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
                              requestTerminalFocus(activeWorkspace.id, activeTab.id);
                            }
                          }}
                        >
                          <span>Pane {index + 1}</span>
                          <strong>{pane.title}</strong>
                          <small>{paneMachine?.name ?? pane.machineId}</small>
                          {(unreadByPaneId.get(pane.id) ?? 0) > 0 ? <span className="badge">{unreadByPaneId.get(pane.id)}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
        </nav>
        <div className="sidebar-label host-label">Host status</div>
        <div className="machine-list">
          {displayMachines.map((machine) => (
            <div
              key={machine.id}
              className={`machine-row ${machine.reachable ? "" : "offline"}`}
              title={[machine.name, machine.reason, machine.backendDetail, machine.endpoint].filter(Boolean).join(" / ") || machine.kind}
            >
              <Server size={14} />
              <span className="machine-name">{versionedMachineName(machine)}</span>
              <span className={`reach-dot ${machine.reachable ? "on" : ""}`} />
              <span className="machine-detail">{machineStatusDetail(machine)}</span>
            </div>
          ))}
        </div>
        {moveWorkspace ? (
          <WorkspaceMoveDialog
            workspaceId={moveWorkspace.workspaceId}
            workspaces={state.workspaces}
            returnFocus={moveWorkspace.returnFocus}
            onClose={() => setMoveWorkspace(null)}
            onMove={(intent: WorkspaceMoveIntent) => reorderWorkspace(intent.workspaceId, intent.targetWorkspaceId, intent.position)}
          />
        ) : null}
      </aside>
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
      <section className={`workspace ${showMobileModeBar ? "mobile-workspace" : ""} ${showMobileAgentSurface ? "mobile-agent-active" : ""} ${showMobileModeBar && openTuiMode ? "mobile-open-tui" : ""}`}>
        {showMobileModeBar && openTuiMode ? (
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
            onToggleNavigation={toggleSidebar}
            onSurfaceModeChange={setMobileSurfaceMode}
            onOpenActions={openCommandPalette}
          />
        ) : null}
        {showMobileModeBar && !openTuiMode ? (
          <header className="mobile-shell-header">
            <button
              type="button"
              className="mobile-header-nav"
              title={sidebarCollapsed ? "Show navigation" : "Hide navigation"}
              aria-label={sidebarCollapsed ? "Show navigation" : "Hide navigation"}
              aria-expanded={!sidebarCollapsed}
              aria-controls="wmux-sidebar"
              onClick={toggleSidebar}
            >
              <PanelLeft size={20} />
            </button>
            <div className="mobile-header-identity">
              <strong>{activeWorkspace?.name ?? "wmux"}</strong>
              <span>
                <span className={`mobile-header-status ${mobileHeaderStatus}`} aria-hidden="true" />
                <span className={`mobile-header-status-label ${mobileHeaderStatus}`}>{mobileHeaderStatusLabel}</span>
                {mobileHeaderVersion?.status === "outdated" ? (
                  <span
                    className={`workspace-version-badge mobile ${mobileHeaderVersion.status}`}
                    title={mobileHeaderVersion.detail}
                    aria-label={mobileHeaderVersion.detail}
                    data-version-status={mobileHeaderVersion.status}
                  >
                    {mobileHeaderVersion.label}
                  </span>
                ) : null}
                {mobileHeaderSubtitle ? <span className="mobile-header-divider">|</span> : null}
                {mobileHeaderSubtitle ? <span>{mobileHeaderSubtitle}</span> : null}
              </span>
            </div>
            <div className="mobile-header-actions">
              <button type="button" title="Open actions" aria-label="Open actions" onClick={openCommandPalette}>
                <CommandIcon size={17} />
              </button>
            </div>
          </header>
        ) : null}
        {showMobileModeBar && !openTuiMode ? (
          <div className="mobile-mode-bar">
            <button
              type="button"
              className="mobile-mode-navigation"
              title="Workspaces and hosts"
              aria-label="Open workspaces and hosts"
              aria-expanded={!sidebarCollapsed}
              aria-controls="wmux-sidebar"
              onClick={toggleSidebar}
            >
              <PanelLeft size={17} />
              <span>Workspaces</span>
            </button>
            <div className="mobile-mode-tabs" role="tablist" aria-label="Mobile surface">
              <button
                type="button"
                className={mobileSurfaceMode === "agent" ? "active" : ""}
                aria-selected={mobileSurfaceMode === "agent"}
                onClick={() => setMobileSurfaceMode("agent")}
              >
                <MessageSquare size={15} />
                <span>Chat</span>
              </button>
              <button
                type="button"
                className={mobileSurfaceMode === "terminal" ? "active" : ""}
                aria-selected={mobileSurfaceMode === "terminal"}
                onClick={() => setMobileSurfaceMode("terminal")}
              >
                <TerminalSquare size={15} />
                <span>Term</span>
              </button>
            </div>
          </div>
        ) : null}
        {!showMobileModeBar && (openTuiMode ? (
          <OpenTuiTopbar
            tabs={
              activeWorkspace?.tabs.map((tab) => ({
                id: tab.id,
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
        ) : (
        <header className="topbar">
          <div className="tabs">
            {activeWorkspace
              ? activeWorkspace.tabs.map((tab) => (
              <a
                key={tab.id}
                href={workspaceTabPath(activeWorkspace.id, tab.id)}
                className={`tab ${tab.id === activeTab?.id ? "active" : ""} ${(unreadByTabId.get(tab.id) ?? 0) > 0 ? "unread" : ""}`}
                onClick={(event) => activateWorkspaceLink(event, activeWorkspace.id, tab.id)}
              >
                <TerminalSquare size={15} />
                <span>{tab.title}</span>
                {(unreadByTabId.get(tab.id) ?? 0) > 0 ? <span className="badge">{unreadByTabId.get(tab.id)}</span> : null}
              </a>
                ))
              : null}
            <button
              className="icon-button"
              title={`${activeWorkspace ? "New tab" : "New workspace"} on ${selectedMachine?.name ?? targetMachineId}`}
              disabled={!selectedMachine?.reachable}
              onClick={() => (activeWorkspace ? createTab(targetMachineId) : createWorkspace(targetMachineId))}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="machine-picker">
            <div className={`service-status ${serviceConnection}`} title={`wmux service ${serviceConnection}`}>
              <span className={`status-dot ${serviceConnection === "online" ? "on" : ""}`} />
              <span>wmux {serviceConnection}</span>
            </div>
            <button
              title="Open command palette"
              onClick={openCommandPalette}
            >
              <CommandIcon size={16} />
            </button>
            <button
              title="Settings"
              onClick={openSettings}
            >
              <Settings size={16} />
            </button>
            <button
              className={activityOpen ? "active-tool" : ""}
              title="Activity"
              onClick={() => setActivityOpen((value) => !value)}
            >
              <Activity size={16} />
            </button>
            <button
              className={`desktop-stream-button ${activeStream?.live ? "active-tool" : ""}`}
              title={`${activeStreamMachine?.name ?? activeStreamMachineId} screen stream`}
              disabled={!canOpenStream}
              onClick={() => setStreamOpen(true)}
            >
              <ScreenShare size={16} />
            </button>
            <button
              title="Copy active session link"
              disabled={!activeWorkspace || !activeTab}
              onClick={copyActiveLink}
            >
              <Link2 size={16} />
            </button>
            <button
              title="Enable browser notifications"
              disabled={!("Notification" in window) || Notification.permission !== "default"}
              onClick={enableBrowserNotifications}
            >
              {unreadNotifications.length > 0 ? <BellRing size={16} /> : <Bell size={16} />}
            </button>
            <button
              title="Mark workspace notifications read"
              disabled={!activeWorkspace || (unreadByWorkspaceId.get(activeWorkspace.id) ?? 0) === 0}
              onClick={markWorkspaceRead}
            >
              <CheckCheck size={16} />
            </button>
          </div>
        </header>
        ))}
        {showMobileAgentSurface ? (
          <MobileAgentSurface
            state={state}
            machines={displayMachines}
            workspace={activeWorkspace}
            tab={activeTab}
            pane={activePane}
            onSendInput={sendPaneInput}
            onUploadAttachment={async (paneId, attachment) => (await api.uploadPaneAttachment(paneId, attachment)).attachment}
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
                    onClosePane={closePaneInTab}
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
          <EmptyWorkspaceView />
        )}
      </section>
      {activityOpen ? (
        openTuiMode && !mobileViewport.isMobile ? (
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
      {settingsOpen ? (
        <SettingsModal
          machines={machines}
          settings={persistedSettings}
          keybindings={keybindings}
          appleKeybindings={appleKeybindings}
          defaults={settingsDefaults}
          surface={openTuiMode && !mobileViewport.isMobile ? settingsSurface : "dom"}
          onPreview={setPreviewSettings}
          onSave={updateSettings}
          onCancel={cancelSettings}
          onUseDomFallback={openTuiMode && !mobileViewport.isMobile ? () => setSettingsSurface("dom") : undefined}
          onUseOpenTui={openTuiMode && !mobileViewport.isMobile ? () => setSettingsSurface("opentui") : undefined}
        />
      ) : null}
      {commandPaletteOpen ? (
        openTuiMode && !mobileViewport.isMobile ? (
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

const loadMobileSurfaceMode = (): MobileSurfaceMode =>
  window.localStorage.getItem(mobileSurfaceModeStorageKey) === "terminal" ? "terminal" : "agent";

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

const latestAgentByWorkspace = (events: AgentActivity[]): Map<string, AgentActivity> => {
  const latest = new Map<string, AgentActivity>();
  for (const event of events) {
    if (!latest.has(event.workspaceId)) latest.set(event.workspaceId, event);
  }
  return latest;
};

const latestAgentByPane = (events: AgentActivity[]): Map<string, AgentActivity> => {
  const latest = new Map<string, AgentActivity>();
  for (const event of events) {
    if (!latest.has(event.paneId)) latest.set(event.paneId, event);
  }
  return latest;
};

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

const agentStatusClass = (status: string): "running" | "waiting" | "completed" | "failed" | "updated" => {
  const normalized = status.toLowerCase();
  if (["failed", "error", "cancelled", "stopped"].includes(normalized)) return "failed";
  if (["completed", "done", "success"].includes(normalized)) return "completed";
  if (normalized === "waiting") return "waiting";
  if (["running", "started", "working"].includes(normalized)) return "running";
  return "updated";
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
