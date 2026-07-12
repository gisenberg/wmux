export type MachineKind = "local" | "ssh" | "powershell" | "powershell-ssh" | "service";
export type SessionBackend = "auto" | "pty" | "tmux" | "screen" | "agent";
export type StreamProvider = "mediamtx" | "moonlight-gateway";
export type StreamReasonKind = "provider" | "gateway" | "upstream" | "target";
export type MachineVersionStatus = "current" | "outdated" | "unknown";

export interface MachineStreamConfig {
  provider?: StreamProvider;
  gatewayUrl?: string;
  gatewayOpenUrl?: string;
}

export interface MachineStatus {
  id: string;
  name: string;
  kind: MachineKind;
  host?: string;
  user?: string;
  port?: number;
  sessionBackend?: SessionBackend;
  agentUrl?: string;
  agentPort?: number;
  reachable: boolean;
  stream?: MachineStreamConfig;
  reason?: string;
  checkedAt: string;
  endpoint?: string;
  backendDetail?: string;
  runtimeVersion?: string;
  expectedRuntimeVersion?: string;
  helperBundleVersion?: string;
  expectedHelperBundleVersion?: string;
  versionStatus?: MachineVersionStatus;
  health?: Record<string, unknown>;
  source?: "config" | "registered";
  registeredAt?: string;
  lastSeenAt?: string;
  expiresAt?: string;
  online?: boolean;
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
export type WorkspaceCreator = "user" | "agent";

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
  createdBy?: WorkspaceCreator;
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
  message?: string;
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
  checkedAt: string;
  provider: StreamProvider;
  path: string;
  live: boolean;
  requested: boolean;
  requestCount: number;
  requestedUntil?: string;
  viewerCount: number;
  startedAt?: string;
  webRtcUrl: string;
  openUrl: string;
  gatewayUrl?: string;
  publishRtspUrl?: string;
  publishWhipUrl?: string;
  inputEnabled?: boolean;
  reason?: string;
  reasonKind?: StreamReasonKind;
}

export interface WmuxSettings {
  terminalFontSize: number;
  terminalScrollbackRows: number;
  machineAliases: Record<string, string>;
}

export interface BootstrapPayload {
  revision: number;
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

export interface DoctorPaneReport {
  paneId: string;
  title: string;
  machineId: string;
  machineName: string;
  status: PaneState["status"];
  exitCode?: number | null;
  driver: "pty" | "windows-agent";
  transport: "pty" | "local-multiplexer" | "ssh-multiplexer" | "windows-agent";
  restartDurable: boolean;
  replay: boolean;
  cwd: "osc7" | "multiplexer" | "agent";
  machineReachable: boolean;
  issue?: string;
}

export interface DoctorReport {
  checkedAt: string;
  summary: {
    paneCount: number;
    restartDurablePaneCount: number;
    exitedPaneCount: number;
    unreachableMachineCount: number;
    sessionIssueCount: number;
  };
  panes: DoctorPaneReport[];
}
