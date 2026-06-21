export type MachineKind = "local" | "ssh" | "powershell" | "powershell-ssh" | "service";
export type SessionBackend = "auto" | "pty" | "tmux" | "screen";

export interface MachineStatus {
  id: string;
  name: string;
  kind: MachineKind;
  host?: string;
  user?: string;
  port?: number;
  sessionBackend?: SessionBackend;
  reachable: boolean;
  reason?: string;
  checkedAt: string;
  endpoint?: string;
  backendDetail?: string;
  health?: Record<string, unknown>;
}

export interface PaneState {
  id: string;
  machineId: string;
  title: string;
  cwd?: string;
  status: "idle" | "running" | "exited";
  exitCode?: number | null;
  createdAt: string;
}

export type TitleSource = "default" | "auto" | "user";

export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "pane"; paneId: string }
  | { type: "split"; direction: SplitDirection; first: LayoutNode; second: LayoutNode; ratio: number };

export interface SurfaceTab {
  id: string;
  title: string;
  titleSource?: TitleSource;
  activePaneId: string;
  layout: LayoutNode;
  panes: PaneState[];
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  nameSource?: TitleSource;
  descriptor?: string;
  descriptorSource?: TitleSource;
  machineId: string;
  activeTabId: string;
  tabs: SurfaceTab[];
  createdAt: string;
  updatedAt: string;
}

export interface TerminalNotification {
  id: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  title: string;
  subtitle: string;
  body: string;
  createdAt: string;
  read: boolean;
}

export interface TerminalMedia {
  id: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  name: string;
  mimeType: string;
  data: string;
  createdAt: string;
}

export interface TerminalClipboard {
  id: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  text: string;
  createdAt: string;
}

export interface AgentActivity {
  id: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  agent: string;
  status: string;
  title: string;
  summary: string;
  createdAt: string;
}

export interface TerminalRun {
  id: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  command: string;
  status: "started" | "completed" | "failed";
  exitCode?: number | null;
  startedAt: string;
  completedAt?: string;
}

export interface StreamStatus {
  machineId: string;
  path: string;
  live: boolean;
  requested: boolean;
  requestCount: number;
  requestedUntil?: string;
  viewerCount: number;
  startedAt?: string;
  webRtcUrl: string;
  publishRtspUrl: string;
  publishWhipUrl: string;
  reason?: string;
}

export interface WmuxSettings {
  terminalFontSize: number;
  machineAliases: Record<string, string>;
}

export interface BootstrapPayload {
  machines: MachineStatus[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  notifications: TerminalNotification[];
  agentEvents: AgentActivity[];
  runs: TerminalRun[];
  settings: WmuxSettings;
  streams: StreamStatus[];
}

export interface DurableSessionAuditRow {
  backend: "tmux" | "screen";
  name: string;
  paneId: string;
  attached: boolean;
  detail: string;
  activePane: boolean;
  status: "active" | "duplicate" | "orphan";
  cleanupAllowed: boolean;
}

export interface DurableSessionAudit {
  summary: {
    statePath: string;
    activePaneCount: number;
    sessionCount: number;
    orphanCount: number;
    duplicateCount: number;
    missingCount: number;
  };
  sessions: DurableSessionAuditRow[];
  missing: Array<{ paneId: string; name: string }>;
}
