import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bell, BellRing, CheckCheck, CirclePlus, Clipboard, Command as CommandIcon, Link2, PanelLeft, Plus, Search, Server, Settings, TerminalSquare, Trash2, X } from "lucide-react";
import { api } from "./api";
import { EmptyWorkspaceView } from "./EmptyWorkspaceView";
import { LayoutView } from "./LayoutView";
import { OpenTuiActivityPanel } from "./OpenTuiActivityPanel";
import type { OpenTuiActivityRow } from "./OpenTuiActivityPanel";
import { OpenTuiCommandPalette } from "./OpenTuiCommandPalette";
import { OpenTuiSidebar } from "./OpenTuiSidebar";
import type { OpenTuiSidebarMachine, OpenTuiSidebarWorkspace } from "./OpenTuiSidebar";
import { OpenTuiTopbar } from "./OpenTuiTopbar";
import type {
  AgentActivity,
  BootstrapPayload,
  DurableSessionAudit,
  LayoutNode,
  MachineStatus,
  SplitDirection,
  TerminalClipboard,
  TerminalMedia,
  TerminalNotification,
  TerminalRun,
  WmuxSettings,
} from "./types";

type ServiceConnection = "connecting" | "online" | "offline";

interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  section: string;
  shortcut?: string;
  keywords?: string[];
  disabled?: boolean;
  run: () => void | Promise<void>;
}

const defaultSettings: WmuxSettings = {
  terminalFontSize: 14,
  machineAliases: {},
};

export function App() {
  const openTuiMode = useMemo(() => new URLSearchParams(window.location.search).get("legacy") !== "1", []);
  const [state, setState] = useState<BootstrapPayload | null>(null);
  const [newMachineId, setNewMachineId] = useState("local");
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mediaItems, setMediaItems] = useState<TerminalMedia[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [previewSettings, setPreviewSettings] = useState<WmuxSettings | null>(null);
  const [serviceConnection, setServiceConnection] = useState<ServiceConnection>("connecting");
  const [workspaceHostFilter, setWorkspaceHostFilter] = useState("all");
  const [activityOpen, setActivityOpen] = useState(false);
  const [clipboardItem, setClipboardItem] = useState<TerminalClipboard | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState<"idle" | "copied" | "blocked">("idle");
  const seenNotificationIds = useRef(new Set<string>());
  const lastSyncedPath = useRef("");

  useEffect(() => {
    api
      .bootstrap()
      .then(async (payload) => {
        for (const notification of payload.notifications) seenNotificationIds.current.add(notification.id);
        const routed = await activateRouteTarget(payload);
        setState(routed);
      })
      .catch((nextError) => setError(String(nextError)));
  }, []);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | null = null;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      setServiceConnection("connecting");
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/events`);
      socket = ws;
      ws.onopen = () => setServiceConnection("online");
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "notification") {
          const notification = message.notification as TerminalNotification;
          seenNotificationIds.current.add(notification.id);
          showBrowserNotification(notification);
        }
        if (message.type === "media") {
          const media = message.media as TerminalMedia;
          setMediaItems((items) => [media, ...items.filter((item) => item.id !== media.id)].slice(0, 20));
        }
        if (message.type === "clipboard") {
          const clipboard = message.clipboard as TerminalClipboard;
          setClipboardItem(clipboard);
          setClipboardStatus("idle");
          writeBrowserClipboard(clipboard.text)
            .then(() => setClipboardStatus("copied"))
            .catch(() => setClipboardStatus("blocked"));
        }
        if (message.type === "state" || message.type === "notification") {
          api.bootstrap().then(setState).catch((nextError) => setError(String(nextError)));
        }
      };
      ws.onclose = () => {
        if (!closed) {
          setServiceConnection("offline");
          reconnectTimer = window.setTimeout(connect, 1500);
        }
      };
      ws.onerror = () => setServiceConnection("offline");
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const activeWorkspace = useMemo(
    () => state?.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? state?.workspaces[0],
    [state],
  );
  const activeTab = activeWorkspace?.tabs.find((tab) => tab.id === activeWorkspace.activeTabId) ?? activeWorkspace?.tabs[0];
  const machines = state?.machines ?? [];
  const persistedSettings = state?.settings ?? defaultSettings;
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
  const latestAgentByWorkspaceId = useMemo(() => latestAgentByWorkspace(agentEvents), [agentEvents]);
  const latestRunByPaneId = useMemo(() => latestRunByPane(runs), [runs]);
  const visibleWorkspaces = useMemo(
    () =>
      state?.workspaces.filter(
        (workspace) => workspaceHostFilter === "all" || workspace.machineId === workspaceHostFilter,
      ) ?? [],
    [state, workspaceHostFilter],
  );
  const openTuiWorkspaces = useMemo<OpenTuiSidebarWorkspace[]>(
    () =>
      visibleWorkspaces.flatMap((workspace) => {
        const machine = machineFor(displayMachines, workspace.machineId);
        const sourceMachine = machineFor(machines, workspace.machineId);
        const unreadCount = unreadByWorkspaceId.get(workspace.id) ?? 0;
        const latestUnread = latestUnreadByWorkspaceId.get(workspace.id);
        const latestAgent = latestAgentByWorkspaceId.get(workspace.id);
        const descriptor =
          latestUnread?.body ||
          latestUnread?.subtitle ||
          latestAgent?.summary ||
          displayWorkspaceDescriptor(workspace.descriptor, machine, sourceMachine, workspace.machineId);
        const host = displayWorkspaceHost(machine, sourceMachine, workspace.machineId);
        const visibleDescriptor = compactWorkspaceDescription(descriptor, 72);
        const tab = workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId) ?? workspace.tabs[0];
        if (!tab) return [];
        return [
          {
            id: workspace.id,
            tabId: tab.id,
            title: workspace.name,
            descriptor: visibleDescriptor && visibleDescriptor !== host ? visibleDescriptor : "",
            host,
            reachable: Boolean(machine?.reachable),
            active: workspace.id === activeWorkspace?.id,
            unreadCount,
            agentLabel: latestAgent ? `${latestAgent.agent} ${latestAgent.status}` : undefined,
          },
        ];
      }),
    [
      activeWorkspace?.id,
      displayMachines,
      latestAgentByWorkspaceId,
      latestUnreadByWorkspaceId,
      machines,
      unreadByWorkspaceId,
      visibleWorkspaces,
    ],
  );
  const openTuiMachines = useMemo<OpenTuiSidebarMachine[]>(
    () =>
      displayMachines.map((machine) => ({
        id: machine.id,
        name: machine.name,
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

  const refresh = async (nextState?: BootstrapPayload) => {
    setState(nextState ?? (await api.bootstrap()));
  };

  const updateSettings = async (nextSettings: WmuxSettings) => {
    const response = await api.updateSettings(nextSettings);
    setPreviewSettings(null);
    setState(response.state);
    setSettingsOpen(false);
  };

  const cancelSettings = () => {
    setPreviewSettings(null);
    setSettingsOpen(false);
  };

  const chromePath = (path: string) => (openTuiMode ? path : `${path}?legacy=1`);
  const currentChromePath = () => `${window.location.pathname}${window.location.search}`;
  const switchChromeMode = (enabled: boolean) => {
    const params = new URLSearchParams(window.location.search);
    params.delete("opentui");
    if (enabled) params.delete("legacy");
    else params.set("legacy", "1");
    const query = params.toString();
    window.location.assign(`${window.location.pathname}${query ? `?${query}` : ""}`);
  };

  useEffect(() => {
    if (!state) return;
    if (!activeWorkspace || !activeTab) {
      const nextPath = chromePath("/");
      if (currentChromePath() !== nextPath) {
        window.history.replaceState(null, "", nextPath);
        lastSyncedPath.current = nextPath;
      }
      return;
    }
    const nextPath = workspaceTabPath(activeWorkspace.id, activeTab.id);
    const nextChromePath = chromePath(nextPath);
    const currentPath = currentChromePath();
    if (currentPath === nextChromePath) {
      lastSyncedPath.current = nextChromePath;
      return;
    }
    const replace = lastSyncedPath.current === "" || currentPath !== lastSyncedPath.current;
    window.history[replace ? "replaceState" : "pushState"](null, "", nextChromePath);
    lastSyncedPath.current = nextChromePath;
  }, [state, activeWorkspace, activeTab, openTuiMode]);

  useEffect(() => {
    const onPopState = () => {
      api.bootstrap()
        .then(activateRouteTarget)
        .then(setState)
        .catch((nextError) => setError(String(nextError)));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectedMachine = displayMachines.find((machine) => machine.id === newMachineId) ?? displayMachines[0];
  const clipboardTitle = clipboardItem
    ? `${clipboardStatus === "blocked" ? "Click to copy wmux buffer" : "wmux clipboard buffer"} (${formatBytes(clipboardItem.text.length)})`
    : "No wmux clipboard buffer";

  const createWorkspace = async (machineId: string) => {
    await api.createWorkspace(machineId);
    await refresh();
  };

  const activateWorkspaceLink = async (event: React.MouseEvent<HTMLAnchorElement>, workspaceId: string, tabId: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    const nextPath = chromePath(workspaceTabPath(workspaceId, tabId));
    window.history.pushState(null, "", nextPath);
    lastSyncedPath.current = nextPath;
    await refresh(await activateRouteTarget(await api.bootstrap()));
  };

  const activateWorkspaceFromChrome = async (workspaceId: string, tabId: string) => {
    const nextPath = chromePath(workspaceTabPath(workspaceId, tabId));
    window.history.pushState(null, "", nextPath);
    lastSyncedPath.current = nextPath;
    await refresh(await activateRouteTarget(await api.bootstrap()));
  };

  const activateTabFromChrome = async (tabId: string) => {
    if (!activeWorkspace) return;
    const nextPath = chromePath(workspaceTabPath(activeWorkspace.id, tabId));
    window.history.pushState(null, "", nextPath);
    lastSyncedPath.current = nextPath;
    await refresh(await activateRouteTarget(await api.bootstrap()));
  };

  const copyActiveLink = async () => {
    if (!activeWorkspace || !activeTab) return;
    const url = new URL(chromePath(workspaceTabPath(activeWorkspace.id, activeTab.id)), window.location.origin);
    await writeBrowserClipboard(url.toString());
  };

  const copyWmuxClipboard = async () => {
    if (!clipboardItem) return;
    try {
      await writeBrowserClipboard(clipboardItem.text);
      setClipboardStatus("copied");
    } catch {
      setClipboardStatus("blocked");
    }
  };

  const createTab = async (machineId: string) => {
    if (!activeWorkspace) return;
    const response = await api.createTab(activeWorkspace.id, machineId);
    await refresh(response.state);
  };

  const splitPane = async (paneId: string, direction: SplitDirection, machineId: string) => {
    if (!activeTab) return;
    const response = await api.splitPane(activeTab.id, paneId, direction, machineId);
    await refresh(response.state);
  };

  const resizeSplit = async (path: string, ratio: number) => {
    if (!activeTab) return;
    const response = await api.updateSplitRatio(activeTab.id, path, ratio);
    await refresh(response.state);
  };

  const closePane = async (paneId: string) => {
    if (!activeTab || activeTab.panes.length <= 1) return;
    const response = await api.closePane(activeTab.id, paneId);
    await refresh(response.state);
  };

  const closeActiveTab = async () => {
    if (!activeWorkspace || !activeTab || activeWorkspace.tabs.length <= 1) return;
    const response = await api.closeTab(activeWorkspace.id, activeTab.id);
    await refresh(response.state);
  };

  const closeActiveWorkspace = async () => {
    if (!state || !activeWorkspace) return;
    const response = await api.closeWorkspace(activeWorkspace.id);
    await refresh(response.state);
  };

  const activateWorkspaceAt = async (index: number) => {
    if (!state) return;
    const workspace = state.workspaces[index];
    if (workspace) await refresh(await api.activateWorkspace(workspace.id));
  };

  const activateWorkspaceRelative = async (delta: number) => {
    if (!state || !activeWorkspace) return;
    const current = state.workspaces.findIndex((workspace) => workspace.id === activeWorkspace.id);
    if (current === -1) return;
    const next = modulo(current + delta, state.workspaces.length);
    await activateWorkspaceAt(next);
  };

  const activateTabAt = async (index: number) => {
    if (!activeWorkspace) return;
    const tab = activeWorkspace.tabs[index];
    if (tab) await refresh(await api.activateTab(activeWorkspace.id, tab.id));
  };

  const activateTabRelative = async (delta: number) => {
    if (!activeWorkspace || !activeTab) return;
    const current = activeWorkspace.tabs.findIndex((tab) => tab.id === activeTab.id);
    if (current === -1) return;
    const next = modulo(current + delta, activeWorkspace.tabs.length);
    await activateTabAt(next);
  };

  const focusPaneRelative = async (delta: number) => {
    if (!activeTab) return;
    const paneIds = flattenPaneIds(activeTab.layout);
    const current = paneIds.indexOf(activeTab.activePaneId);
    if (current === -1 || paneIds.length < 2) return;
    const nextPaneId = paneIds[modulo(current + delta, paneIds.length)];
    await refresh(await api.activatePane(activeTab.id, nextPaneId));
  };

  const jumpLatestUnread = async () => {
    const latest = notifications.find((notification) => !notification.read);
    if (!latest) return;
    await refresh(await api.activateWorkspace(latest.workspaceId));
    await refresh(await api.activateTab(latest.workspaceId, latest.tabId));
    await refresh(await api.activatePane(latest.tabId, latest.paneId));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const primary = event.metaKey || event.ctrlKey;
      const primaryOnly = primary && !event.altKey && !(event.metaKey && event.ctrlKey);
      const primaryWithAlt = primary && event.altKey && !(event.metaKey && event.ctrlKey);

      const run = (action: () => void | Promise<void>) => {
        event.preventDefault();
        event.stopPropagation();
        void action();
      };

      if (!settingsOpen && !commandPaletteOpen && primaryOnly && key === "k") {
        run(openCommandPalette);
        return;
      }

      if (settingsOpen || commandPaletteOpen) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const digit = /^[1-9]$/.test(key) ? Number(key) : null;

      if (primaryOnly && key === "b") {
        run(() => setSidebarCollapsed((value) => !value));
        return;
      }

      if (primaryOnly && !event.shiftKey && key === "n") {
        run(() => createWorkspace(newMachineId));
        return;
      }

      if (primaryOnly && !event.shiftKey && key === "t") {
        run(() => createTab(newMachineId));
        return;
      }

      if (primaryOnly && key === "w") {
        run(() => (event.shiftKey ? closeActiveWorkspace() : closeActiveTab()));
        return;
      }

      if (primaryOnly && key === "d") {
        const pane = activeTab?.panes.find((candidate) => candidate.id === activeTab.activePaneId);
        if (!pane) return;
        run(() => splitPane(pane.id, event.shiftKey ? "horizontal" : "vertical", newMachineId));
        return;
      }

      if (primaryWithAlt && key.startsWith("arrow")) {
        run(() => focusPaneRelative(key === "arrowleft" || key === "arrowup" ? -1 : 1));
        return;
      }

      if (((event.metaKey && event.ctrlKey) || (event.altKey && event.ctrlKey && !event.metaKey)) && (event.key === "]" || event.key === "[")) {
        run(() => activateWorkspaceRelative(event.key === "]" ? 1 : -1));
        return;
      }

      if (primaryOnly && event.shiftKey && (event.key === "]" || event.key === "[")) {
        run(() => activateTabRelative(event.key === "]" ? 1 : -1));
        return;
      }

      if (event.ctrlKey && !event.metaKey && !event.altKey && key === "tab") {
        run(() => activateTabRelative(event.shiftKey ? -1 : 1));
        return;
      }

      if (primaryOnly && digit !== null) {
        if (!state) return;
        run(() => activateWorkspaceAt(digit === 9 ? state.workspaces.length - 1 : digit - 1));
        return;
      }

      if (event.altKey && !event.metaKey && digit !== null) {
        if (!activeWorkspace) return;
        run(() => activateTabAt(digit === 9 ? activeWorkspace.tabs.length - 1 : digit - 1));
        return;
      }

      if (primaryOnly && event.shiftKey && key === "u") {
        run(jumpLatestUnread);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [activeTab, activeWorkspace, state, newMachineId, notifications, settingsOpen, commandPaletteOpen]);

  const enableBrowserNotifications = async () => {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    await Notification.requestPermission();
  };

  const markWorkspaceRead = async () => {
    if (!activeWorkspace) return;
    await refresh(await api.markWorkspaceNotificationsRead(activeWorkspace.id));
  };

  const openCommandPalette = () => {
    setCommandPaletteQuery("");
    setCommandPaletteOpen(true);
  };

  const commands = useMemo<PaletteCommand[]>(() => {
    const activePane = activeTab?.panes.find((pane) => pane.id === activeTab.activePaneId);
    const activePaneCount = activeTab?.panes.length ?? 0;
    const workspaceUnreadCount = activeWorkspace ? unreadByWorkspaceId.get(activeWorkspace.id) ?? 0 : 0;
    const base: PaletteCommand[] = [
      {
        id: "open-settings",
        title: "Open settings",
        subtitle: "Ghostty settings, host aliases, durable session audit",
        section: "System",
        shortcut: "Cmd+,",
        run: () => setSettingsOpen(true),
      },
      {
        id: "audit-sessions",
        title: "Open session audit",
        subtitle: "Review local tmux/screen durable sessions",
        section: "System",
        run: () => setSettingsOpen(true),
        keywords: ["tmux", "screen", "durable", "orphan", "duplicate"],
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
        id: "switch-chrome-mode",
        title: openTuiMode ? "Use legacy browser chrome" : "Use OpenTUI chrome",
        subtitle: openTuiMode ? "Reload with the original React controls" : "Reload with the canvas TUI chrome",
        section: "View",
        run: () => switchChromeMode(!openTuiMode),
        keywords: ["opentui", "canvas", "chrome", "ui", "legacy"],
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
        id: "copy-wmux-buffer",
        title: "Copy wmux clipboard buffer",
        subtitle: clipboardItem ? `${formatBytes(clipboardItem.text.length)} from wmux-copy` : undefined,
        section: "Actions",
        disabled: !clipboardItem,
        run: copyWmuxClipboard,
        keywords: ["clipboard", "copy", "pipe"],
      },
      {
        id: "toggle-sidebar",
        title: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
        subtitle: "Toggle workspace and host navigation",
        section: "View",
        shortcut: "Cmd+B",
        run: () => setSidebarCollapsed((value) => !value),
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
        title: `New workspace on ${selectedMachine?.name ?? newMachineId}`,
        subtitle: "Create a new workspace on the target host",
        section: "Create",
        shortcut: "Cmd+N",
        disabled: !selectedMachine?.reachable,
        run: () => createWorkspace(newMachineId),
        keywords: ["session"],
      },
      {
        id: "new-tab-selected",
        title: `New tab on ${selectedMachine?.name ?? newMachineId}`,
        subtitle: activeWorkspace?.name,
        section: "Create",
        shortcut: "Cmd+T",
        disabled: !selectedMachine?.reachable || !activeWorkspace,
        run: () => createTab(newMachineId),
        keywords: ["session"],
      },
      {
        id: "split-right",
        title: `Split right on ${selectedMachine?.name ?? newMachineId}`,
        subtitle: activeTab?.title,
        section: "Pane",
        shortcut: "Cmd+D",
        disabled: !activePane || !selectedMachine?.reachable,
        run: () => activePane && splitPane(activePane.id, "vertical", newMachineId),
        keywords: ["vertical", "pane"],
      },
      {
        id: "split-down",
        title: `Split down on ${selectedMachine?.name ?? newMachineId}`,
        subtitle: activeTab?.title,
        section: "Pane",
        shortcut: "Shift+Cmd+D",
        disabled: !activePane || !selectedMachine?.reachable,
        run: () => activePane && splitPane(activePane.id, "horizontal", newMachineId),
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
        id: "close-tab",
        title: "Close current tab",
        subtitle: activeTab?.title,
        section: "Close",
        shortcut: "Cmd+W",
        disabled: !activeWorkspace || !activeTab || activeWorkspace.tabs.length <= 1,
        run: closeActiveTab,
      },
      {
        id: "close-workspace",
        title: "Close current workspace",
        subtitle: activeWorkspace?.name,
        section: "Close",
        shortcut: "Shift+Cmd+W",
        disabled: !state || !activeWorkspace,
        run: closeActiveWorkspace,
      },
      {
        id: "latest-unread",
        title: "Jump to latest unread",
        subtitle: `${unreadNotifications.length} unread notifications`,
        section: "Navigate",
        shortcut: "Shift+Cmd+U",
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
        const host = displayWorkspaceHost(
          machineFor(displayMachines, workspace.machineId),
          machineFor(machines, workspace.machineId),
          workspace.machineId,
        );
        const activeWorkspaceTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? workspace.tabs[0];
        const workspaceCommand: PaletteCommand[] = activeWorkspaceTab
          ? [
              {
                id: `workspace:${workspace.id}`,
                title: `Open workspace: ${workspace.name}`,
                subtitle: host,
                section: "Workspaces",
                run: async () => {
                  const nextPath = chromePath(workspaceTabPath(workspace.id, activeWorkspaceTab.id));
                  window.history.pushState(null, "", nextPath);
                  lastSyncedPath.current = nextPath;
                  await refresh(await activateRouteTarget(await api.bootstrap()));
                },
                keywords: [host, workspace.descriptor ?? ""],
              },
            ]
          : [];
        const tabCommands = workspace.tabs.map((tab): PaletteCommand => ({
          id: `tab:${workspace.id}:${tab.id}`,
          title: `Open tab: ${tab.title}`,
          subtitle: workspace.name,
          section: "Tabs",
          run: async () => {
            const nextPath = chromePath(workspaceTabPath(workspace.id, tab.id));
            window.history.pushState(null, "", nextPath);
            lastSyncedPath.current = nextPath;
            await refresh(await activateRouteTarget(await api.bootstrap()));
          },
          keywords: [host],
        }));
        return [...workspaceCommand, ...tabCommands];
      }) ?? [];

    return [...base, ...hostCommands, ...workspaceCommands];
  }, [
    activeTab,
    activeWorkspace,
    clipboardItem,
    displayMachines,
    machines,
    newMachineId,
    openTuiMode,
    selectedMachine,
    sidebarCollapsed,
    state,
    unreadByWorkspaceId,
    unreadNotifications.length,
  ]);

  if (error) return <div className="load-state">wmux failed to load: {error}</div>;
  if (!state) return <div className="load-state">Loading wmux...</div>;

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${openTuiMode ? "open-tui-mode" : ""}`}>
      {openTuiMode ? (
        <OpenTuiSidebar
          targetMachineId={newMachineId}
          targetMachineName={selectedMachine?.name ?? newMachineId}
          targetMachineReachable={Boolean(selectedMachine?.reachable)}
          workspaces={openTuiWorkspaces}
          machines={openTuiMachines}
          onTargetMachineChange={setNewMachineId}
          onCreateWorkspace={() => createWorkspace(newMachineId)}
          onActivateWorkspace={activateWorkspaceFromChrome}
        />
      ) : (
      <aside className="sidebar">
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
            <select title="Target host for new workspaces, tabs, and splits" value={newMachineId} onChange={(event) => setNewMachineId(event.target.value)}>
            {displayMachines.map((machine) => (
              <option key={machine.id} value={machine.id} disabled={!machine.reachable}>
                {machine.name}
              </option>
              ))}
            </select>
            <button
              title={`New workspace on ${selectedMachine?.name ?? newMachineId}`}
              disabled={!selectedMachine?.reachable}
              onClick={() => createWorkspace(newMachineId)}
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
                {machine.name}
              </option>
            ))}
          </select>
        </div>
        <nav className="workspace-list">
            {visibleWorkspaces.length === 0 ? <div className="workspace-empty">No workspaces</div> : null}
            {visibleWorkspaces.map((workspace) => {
              const machine = machineFor(displayMachines, workspace.machineId);
              const sourceMachine = machineFor(machines, workspace.machineId);
              const unreadCount = unreadByWorkspaceId.get(workspace.id) ?? 0;
              const latestUnread = latestUnreadByWorkspaceId.get(workspace.id);
              const latestAgent = latestAgentByWorkspaceId.get(workspace.id);
              const descriptor =
                latestUnread?.body ||
                latestUnread?.subtitle ||
                latestAgent?.summary ||
                displayWorkspaceDescriptor(workspace.descriptor, machine, sourceMachine, workspace.machineId);
              const host = displayWorkspaceHost(machine, sourceMachine, workspace.machineId);
              const visibleDescriptor = compactWorkspaceDescription(descriptor, 72);
              const tooltipDescriptor = compactWorkspaceDescription(descriptor, 200);
              const showDescriptor = visibleDescriptor && visibleDescriptor !== host;
              const tooltip = [workspace.name, showDescriptor ? tooltipDescriptor : "", host].filter(Boolean).join(" / ");
              const tab = workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId) ?? workspace.tabs[0];
              if (!tab) return null;
              return (
              <a
                key={workspace.id}
                href={workspaceTabPath(workspace.id, tab.id)}
                title={tooltip}
                className={`workspace-item ${workspace.id === activeWorkspace?.id ? "active" : ""} ${
                  machine?.reachable ? "" : "disabled"
                }`}
                onClick={(event) => activateWorkspaceLink(event, workspace.id, tab.id)}
                >
                  <span className={`reach-dot ${machine?.reachable ? "on" : ""}`} />
                  <span className="workspace-title">{workspace.name}</span>
                  {unreadCount > 0 ? <span className="badge workspace-badge">{unreadCount}</span> : null}
                  <span className="workspace-meta">
                    {latestAgent ? <span className={`agent-pill ${agentStatusClass(latestAgent.status)}`}>{latestAgent.agent} {latestAgent.status}</span> : null}
                    {showDescriptor ? <span className="workspace-descriptor">{visibleDescriptor}</span> : null}
                    <span className="workspace-host">{host}</span>
                  </span>
                </a>
              );
            })}
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
              <span className="machine-name">{machine.name}</span>
              <span className={`reach-dot ${machine.reachable ? "on" : ""}`} />
              <span className="machine-detail">{machineStatusDetail(machine)}</span>
            </div>
          ))}
        </div>
      </aside>
      )}
      <section className="workspace">
        {openTuiMode ? (
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
            targetLabel={selectedMachine?.name ?? newMachineId}
            canCreate={Boolean(selectedMachine?.reachable)}
            canCopyLink={Boolean(activeWorkspace && activeTab)}
            canCopyClipboard={Boolean(clipboardItem)}
            clipboardAttention={clipboardStatus === "blocked"}
            unreadNotifications={unreadNotifications.length}
            canMarkRead={Boolean(activeWorkspace && (unreadByWorkspaceId.get(activeWorkspace.id) ?? 0) > 0)}
            canEnableNotifications={"Notification" in window && Notification.permission === "default"}
            activityOpen={activityOpen}
            onActivateTab={activateTabFromChrome}
            onCreate={() => (activeWorkspace ? createTab(newMachineId) : createWorkspace(newMachineId))}
            onOpenCommandPalette={openCommandPalette}
            onOpenSettings={() => setSettingsOpen(true)}
            onToggleActivity={() => setActivityOpen((value) => !value)}
            onCopyLink={copyActiveLink}
            onCopyClipboard={copyWmuxClipboard}
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
              title={`${activeWorkspace ? "New tab" : "New workspace"} on ${selectedMachine?.name ?? newMachineId}`}
              disabled={!selectedMachine?.reachable}
              onClick={() => (activeWorkspace ? createTab(newMachineId) : createWorkspace(newMachineId))}
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
              onClick={() => setSettingsOpen(true)}
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
              title="Copy active session link"
              disabled={!activeWorkspace || !activeTab}
              onClick={copyActiveLink}
            >
              <Link2 size={16} />
            </button>
            <button
              className={clipboardStatus === "blocked" ? "attention-tool" : clipboardItem ? "active-tool" : ""}
              title={clipboardTitle}
              disabled={!clipboardItem}
              onClick={copyWmuxClipboard}
            >
              <Clipboard size={16} />
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
        )}
        {activeTab ? (
          <LayoutView
            tab={activeTab}
            machines={displayMachines}
            splitMachineId={newMachineId}
            terminalFontSize={settings.terminalFontSize}
            unreadByPaneId={unreadByPaneId}
            mediaByPaneId={mediaByPaneId}
            onActivatePane={async (paneId) => refresh(await api.activatePane(activeTab.id, paneId))}
            onSplit={splitPane}
            onResizeSplit={resizeSplit}
            onClosePane={closePane}
            onDismissMedia={(mediaId) => setMediaItems((items) => items.filter((item) => item.id !== mediaId))}
            runsByPaneId={latestRunByPaneId}
          />
        ) : (
          <EmptyWorkspaceView />
        )}
      </section>
      {activityOpen ? (
        openTuiMode ? (
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
      {settingsOpen ? (
        <SettingsModal
          machines={machines}
          settings={persistedSettings}
          onPreview={setPreviewSettings}
          onSave={updateSettings}
          onCancel={cancelSettings}
        />
      ) : null}
      {commandPaletteOpen ? (
        openTuiMode ? (
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
          />
        )
      ) : null}
    </main>
  );
}

const machineFor = (machines: MachineStatus[], machineId: string): MachineStatus | undefined =>
  machines.find((machine) => machine.id === machineId);

const withMachineAlias = (machine: MachineStatus, settings: WmuxSettings): MachineStatus => {
  const alias = cleanAlias(settings.machineAliases[machine.id] ?? "");
  return alias ? { ...machine, name: alias } : machine;
};

const displayWorkspaceDescriptor = (
  descriptor: string | undefined,
  displayMachine: MachineStatus | undefined,
  sourceMachine: MachineStatus | undefined,
  machineId: string,
): string => {
  const raw = descriptor?.trim();
  if (!raw) return displayMachine?.name ?? machineId;
  if (raw === machineId || raw === sourceMachine?.name || raw === displayMachine?.id) {
    return displayMachine?.name ?? raw;
  }
  return raw;
};

const displayWorkspaceHost = (
  displayMachine: MachineStatus | undefined,
  sourceMachine: MachineStatus | undefined,
  machineId: string,
): string => displayMachine?.name ?? sourceMachine?.name ?? machineId;

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

const latestRunByPane = (runs: TerminalRun[]): Map<string, TerminalRun> => {
  const latest = new Map<string, TerminalRun>();
  for (const run of runs) {
    if (!latest.has(run.paneId)) latest.set(run.paneId, run);
  }
  return latest;
};

const agentStatusClass = (status: string): string => {
  const normalized = status.toLowerCase();
  if (["failed", "error", "cancelled", "stopped"].includes(normalized)) return "failed";
  if (["completed", "done", "success"].includes(normalized)) return "completed";
  if (["running", "started", "working"].includes(normalized)) return "running";
  return "updated";
};

const openTuiActivityStatus = (status: string): OpenTuiActivityRow["status"] => {
  const normalized = status.toLowerCase();
  if (["failed", "error", "cancelled", "stopped"].includes(normalized)) return "failed";
  if (["completed", "done", "success"].includes(normalized)) return "completed";
  if (["running", "started", "working"].includes(normalized)) return "running";
  return "updated";
};

const machineStatusDetail = (machine: MachineStatus): string => {
  const endpoint = machine.endpoint ?? machine.host ?? machine.kind;
  const checked = machine.checkedAt ? `checked ${formatRelativeTime(machine.checkedAt)}` : "";
  return [machine.reachable ? endpoint : machine.reason ?? endpoint, machine.backendDetail, checked]
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

const writeBrowserClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard write blocked");
};

function CommandPalette({
  commands,
  query,
  onQueryChange,
  onClose,
}: {
  commands: PaletteCommand[];
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filteredCommands = useMemo(() => filterCommands(commands, query).slice(0, 40), [commands, query]);
  const selectableCommands = filteredCommands.filter((command) => !command.disabled);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const firstEnabled = filteredCommands.findIndex((command) => !command.disabled);
    setSelectedIndex(firstEnabled === -1 ? 0 : firstEnabled);
  }, [filteredCommands]);

  const runCommand = async (command: PaletteCommand | undefined) => {
    if (!command || command.disabled) return;
    onClose();
    await command.run();
  };

  const moveSelection = (delta: number) => {
    if (!filteredCommands.length) return;
    let next = selectedIndex;
    for (let step = 0; step < filteredCommands.length; step += 1) {
      next = modulo(next + delta, filteredCommands.length);
      if (!filteredCommands[next].disabled) {
        setSelectedIndex(next);
        return;
      }
    }
  };

  return (
    <div className="command-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <div
        className="command-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveSelection(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(-1);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void runCommand(filteredCommands[selectedIndex] ?? selectableCommands[0]);
          }
        }}
      >
        <div className="command-input-row">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search commands, workspaces, tabs, hosts"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <div className="command-list">
          {filteredCommands.length ? (
            filteredCommands.map((command, index) => (
              <button
                key={command.id}
                type="button"
                className={`command-item ${index === selectedIndex ? "selected" : ""}`}
                disabled={command.disabled}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => void runCommand(command)}
              >
                <span className="command-section">{command.section}</span>
                <span className="command-text">
                  <span className="command-title">{command.title}</span>
                  {command.subtitle ? <span className="command-subtitle">{command.subtitle}</span> : null}
                </span>
                {command.shortcut ? <span className="command-shortcut">{command.shortcut}</span> : null}
              </button>
            ))
          ) : (
            <div className="command-empty">No commands</div>
          )}
        </div>
      </div>
    </div>
  );
}

const filterCommands = (commands: PaletteCommand[], query: string): PaletteCommand[] => {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return commands;
  return commands.filter((command) => {
    const haystack = [command.title, command.subtitle, command.section, command.shortcut, ...(command.keywords ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
};

type ActivityItem =
  | { kind: "agent"; id: string; createdAt: string; event: AgentActivity }
  | { kind: "run"; id: string; createdAt: string; run: TerminalRun };

function ActivityPanel({
  state,
  machines,
  onClose,
}: {
  state: BootstrapPayload;
  machines: MachineStatus[];
  onClose: () => void;
}) {
  const items = useMemo(() => buildActivityItems(state.agentEvents, state.runs).slice(0, 100), [state.agentEvents, state.runs]);
  return (
    <aside className="activity-panel" aria-label="Activity">
      <div className="activity-header">
        <h2>Activity</h2>
        <button title="Close activity" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="activity-list">
        {items.length ? (
          items.map((item) =>
            item.kind === "agent" ? (
              <AgentActivityRow key={item.id} event={item.event} state={state} machines={machines} />
            ) : (
              <RunActivityRow key={item.id} run={item.run} state={state} machines={machines} />
            ),
          )
        ) : (
          <div className="activity-empty">No activity yet</div>
        )}
      </div>
    </aside>
  );
}

function AgentActivityRow({
  event,
  state,
  machines,
}: {
  event: AgentActivity;
  state: BootstrapPayload;
  machines: MachineStatus[];
}) {
  const workspace = state.workspaces.find((candidate) => candidate.id === event.workspaceId);
  const machine = workspace ? machineFor(machines, workspace.machineId) : undefined;
  const title = event.title || workspace?.name || event.agent;
  const summary = compactWorkspaceDescription(event.summary, 160);
  return (
    <div className={`activity-row agent ${agentStatusClass(event.status)}`} title={event.summary || title}>
      <div className="activity-row-main">
        <span className="activity-kind">{event.agent}</span>
        <span className="activity-title">{title}</span>
        {summary ? <span className="activity-summary">{summary}</span> : null}
      </div>
      <div className="activity-row-meta">
        <span>{event.status}</span>
        <span>{workspace?.name ?? "workspace removed"}</span>
        <span>{machine?.name ?? workspace?.machineId ?? "host unknown"}</span>
        <span>{formatRelativeTime(event.createdAt)}</span>
      </div>
    </div>
  );
}

function RunActivityRow({
  run,
  state,
  machines,
}: {
  run: TerminalRun;
  state: BootstrapPayload;
  machines: MachineStatus[];
}) {
  const workspace = state.workspaces.find((candidate) => candidate.id === run.workspaceId);
  const tab = workspace?.tabs.find((candidate) => candidate.id === run.tabId);
  const machine = workspace ? machineFor(machines, workspace.machineId) : undefined;
  return (
    <div className={`activity-row run ${run.status}`} title={run.command}>
      <div className="activity-row-main">
        <span className="activity-kind">run</span>
        <span className="activity-title">{run.command}</span>
        <span className="activity-summary">
          {run.status === "started" ? "running" : `exit ${run.exitCode ?? "?"}`}
          {run.completedAt ? ` / ${formatDuration(run.startedAt, run.completedAt)}` : ""}
        </span>
      </div>
      <div className="activity-row-meta">
        <span>{workspace?.name ?? "workspace removed"}</span>
        <span>{tab?.title ?? "tab removed"}</span>
        <span>{machine?.name ?? workspace?.machineId ?? "host unknown"}</span>
        <span>{formatRelativeTime(run.completedAt ?? run.startedAt)}</span>
        <button
          title="Copy command"
          disabled={!navigator.clipboard}
          onClick={() => void navigator.clipboard?.writeText(run.command)}
        >
          <Clipboard size={13} />
        </button>
      </div>
    </div>
  );
}

const buildActivityItems = (agentEvents: AgentActivity[], runs: TerminalRun[]): ActivityItem[] =>
  [
    ...agentEvents.map((event) => ({ kind: "agent" as const, id: `agent:${event.id}`, createdAt: event.createdAt, event })),
    ...runs.map((run) => ({ kind: "run" as const, id: `run:${run.id}`, createdAt: run.completedAt ?? run.startedAt, run })),
  ].sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));

function SettingsModal({
  machines,
  settings,
  onPreview,
  onSave,
  onCancel,
}: {
  machines: MachineStatus[];
  settings: WmuxSettings;
  onPreview: (settings: WmuxSettings | null) => void;
  onSave: (settings: WmuxSettings) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<WmuxSettings>(() => normalizeSettings(settings));
  const [saving, setSaving] = useState(false);
  const [sessionAudit, setSessionAudit] = useState<DurableSessionAudit | null>(null);
  const [sessionAuditError, setSessionAuditError] = useState("");
  const [sessionAuditLoading, setSessionAuditLoading] = useState(false);

  useEffect(() => {
    setDraft(normalizeSettings(settings));
  }, [settings]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const applyDraft = (nextSettings: WmuxSettings) => {
    const normalized = normalizeSettings(nextSettings);
    setDraft(normalized);
    onPreview(normalized);
  };

  const setAlias = (machineId: string, value: string) => {
    const machineAliases = { ...draft.machineAliases };
    const alias = cleanAlias(value);
    if (alias) {
      machineAliases[machineId] = alias;
    } else {
      delete machineAliases[machineId];
    }
    applyDraft({ ...draft, machineAliases });
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(normalizeSettings(draft));
    } finally {
      setSaving(false);
    }
  };

  const runSessionAudit = async () => {
    setSessionAuditLoading(true);
    setSessionAuditError("");
    try {
      setSessionAudit(await api.auditSessions());
    } catch (error) {
      setSessionAudit(null);
      setSessionAuditError(error instanceof Error ? error.message : "Session audit failed");
    } finally {
      setSessionAuditLoading(false);
    }
  };

  const cleanupSession = async (backend: "tmux" | "screen", name: string) => {
    if (!window.confirm(`Quit ${backend} session ${name}?`)) return;
    setSessionAuditLoading(true);
    setSessionAuditError("");
    try {
      setSessionAudit(await api.cleanupSession(backend, name));
    } catch (error) {
      setSessionAuditError(error instanceof Error ? error.message : "Session cleanup failed");
    } finally {
      setSessionAuditLoading(false);
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onCancel()}>
      <form
        className="settings-panel"
        aria-labelledby="settings-title"
        role="dialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" title="Cancel settings" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="settings-body">
          <section className="settings-section">
            <h3>Ghostty</h3>
            <label className="settings-row">
              <span>Font size</span>
              <input
                type="range"
                min="10"
                max="24"
                value={draft.terminalFontSize}
                onChange={(event) =>
                  applyDraft({
                    ...draft,
                    terminalFontSize: clampFontSize(Number(event.target.value)),
                  })
                }
              />
              <input
                className="settings-number"
                type="number"
                min="10"
                max="24"
                value={draft.terminalFontSize}
                onChange={(event) =>
                  applyDraft({
                    ...draft,
                    terminalFontSize: clampFontSize(Number(event.target.value)),
                  })
                }
              />
            </label>
          </section>
          <section className="settings-section">
            <h3>Host aliases</h3>
            {machines.map((machine) => (
              <label key={machine.id} className="settings-row">
                <span>{machine.name}</span>
                <input
                  type="text"
                  maxLength={40}
                  placeholder={machine.id}
                  value={draft.machineAliases[machine.id] ?? ""}
                  onChange={(event) => setAlias(machine.id, event.target.value)}
                />
              </label>
            ))}
          </section>
          <section className="settings-section">
            <h3>Durable sessions</h3>
            <div className="settings-command-row">
              <button type="button" onClick={runSessionAudit} disabled={sessionAuditLoading}>
                {sessionAuditLoading ? "Auditing" : "Audit sessions"}
              </button>
              {sessionAudit ? (
                <span>
                  {sessionAudit.summary.orphanCount} orphan / {sessionAudit.summary.duplicateCount} duplicate / {sessionAudit.summary.missingCount} missing
                </span>
              ) : (
                <span>Read-only local tmux/screen check</span>
              )}
            </div>
            {sessionAuditError ? <div className="settings-error">{sessionAuditError}</div> : null}
            {sessionAudit ? (
              <div className="session-audit">
                <div className="session-audit-summary">
                  {sessionAudit.summary.activePaneCount} panes, {sessionAudit.summary.sessionCount} sessions
                </div>
                {sessionAudit.sessions.map((row) => (
                  <div key={`${row.backend}:${row.name}`} className={`session-audit-row ${row.status}`}>
                    <span>{row.status}</span>
                    <span>{row.backend}</span>
                    <span title={row.name}>{row.name}</span>
                    <span>{row.detail}</span>
                    <span>
                      {row.cleanupAllowed ? (
                        <button
                          type="button"
                          title={`Quit ${row.backend} session`}
                          disabled={sessionAuditLoading}
                          onClick={() => void cleanupSession(row.backend, row.name)}
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
                {sessionAudit.missing.map((row) => (
                  <div key={`missing:${row.name}`} className="session-audit-row missing">
                    <span>missing</span>
                    <span>none</span>
                    <span title={row.name}>{row.name}</span>
                    <span>{row.paneId}</span>
                    <span />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            onClick={() => applyDraft({ ...defaultSettings })}
          >
            Reset
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={saving}>
            {saving ? "Saving" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

const normalizeSettings = (settings: WmuxSettings): WmuxSettings => ({
  terminalFontSize: clampFontSize(settings.terminalFontSize),
  machineAliases: Object.fromEntries(
    Object.entries(settings.machineAliases ?? {})
      .map(([machineId, alias]) => [machineId, cleanAlias(alias)] as const)
      .filter(([, alias]) => alias.length > 0),
  ),
});

const clampFontSize = (value: number): number => {
  const fallback = defaultSettings.terminalFontSize;
  const numeric = Number.isFinite(value) ? value : fallback;
  return Math.min(24, Math.max(10, Math.round(numeric)));
};

const cleanAlias = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 40);

const workspaceTabPath = (workspaceId: string, tabId: string): string =>
  `/workspaces/${encodeURIComponent(workspaceId)}/tabs/${encodeURIComponent(tabId)}`;

const parseRouteTarget = (): { workspaceId: string; tabId?: string } | null => {
  const match = window.location.pathname.match(/^\/workspaces\/([^/]+)(?:\/tabs\/([^/]+))?\/?$/);
  if (!match) return null;
  return {
    workspaceId: decodeURIComponent(match[1]),
    tabId: match[2] ? decodeURIComponent(match[2]) : undefined,
  };
};

const activateRouteTarget = async (payload: BootstrapPayload): Promise<BootstrapPayload> => {
  const target = parseRouteTarget();
  if (!target) return payload;
  const workspace = payload.workspaces.find((candidate) => candidate.id === target.workspaceId);
  if (!workspace) return payload;
  const tab = target.tabId
    ? workspace.tabs.find((candidate) => candidate.id === target.tabId)
    : workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId) ?? workspace.tabs[0];
  if (!tab) return payload;

  let next = payload;
  if (next.activeWorkspaceId !== workspace.id) {
    next = await api.activateWorkspace(workspace.id);
  }
  const nextWorkspace = next.workspaces.find((candidate) => candidate.id === workspace.id);
  if (nextWorkspace && nextWorkspace.activeTabId !== tab.id) {
    next = await api.activateTab(workspace.id, tab.id);
  }
  return next;
};

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

const groupMediaByPane = (items: TerminalMedia[]): Map<string, TerminalMedia[]> => {
  const grouped = new Map<string, TerminalMedia[]>();
  for (const item of items) {
    grouped.set(item.paneId, [...(grouped.get(item.paneId) ?? []), item]);
  }
  return grouped;
};

const showBrowserNotification = (notification: TerminalNotification): void => {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = notification.subtitle ? `${notification.title}: ${notification.subtitle}` : notification.title;
  new Notification(title, {
    body: notification.body,
    tag: notification.id,
  });
};

const modulo = (value: number, length: number): number => ((value % length) + length) % length;

const flattenPaneIds = (node: LayoutNode): string[] => {
  if (node.type === "pane") return [node.paneId];
  return [...flattenPaneIds(node.first), ...flattenPaneIds(node.second)];
};
