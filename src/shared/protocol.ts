import type { KeybindingMap } from "./keybindings.js";

export type { KeybindingAction, KeybindingMap } from "./keybindings.js";

export type MachineKind = "local" | "ssh" | "powershell" | "powershell-ssh" | "service";
export type MachinePlatform = "linux" | "mac" | "win";
export type SessionBackend = "auto" | "pty" | "tmux" | "screen" | "agent";
export type StreamProvider = "mediamtx" | "moonlight-gateway";
export type StreamReasonKind = "provider" | "gateway" | "upstream" | "target";
export type MachineVersionStatus = "current" | "outdated" | "unknown";
export const TERMINAL_COLOR_SCHEME_IDS = [
  "wmux",
  "catppuccin-mocha",
  "dracula",
  "nord",
  "solarized-dark",
  "gruvbox-dark",
  "tokyo-night",
] as const;
export type TerminalColorSchemeId = (typeof TERMINAL_COLOR_SCHEME_IDS)[number];
export type TerminalColorMode = "dark" | "light";
export const TERMINAL_COLOR_SCHEME_MODES: Record<TerminalColorSchemeId, TerminalColorMode> = {
  wmux: "dark",
  "catppuccin-mocha": "dark",
  dracula: "dark",
  nord: "dark",
  "solarized-dark": "dark",
  "gruvbox-dark": "dark",
  "tokyo-night": "dark",
};
export type InactiveTabStreaming = "suspend" | "live";
export type TuiFrameRate = 15 | 30 | 60;
export type TerminalScrollMode = "batched" | "immediate";

/** Browser-safe stream configuration. Server-only credentials never cross this boundary. */
export interface MachineStreamConfig {
  provider?: StreamProvider;
  gatewayUrl?: string;
  gatewayOpenUrl?: string;
}

export interface MachineStatus {
  id: string;
  name: string;
  kind: MachineKind;
  platform: MachinePlatform;
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
  releaseVersion: string;
  runtimeVersion?: string;
  expectedRuntimeVersion?: string;
  runtimeProtocolVersion?: number;
  expectedRuntimeProtocolVersion?: number;
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
  /** Windows agent generation port pinned for restart-safe side-by-side rollouts. */
  agentPort?: number;
  title: string;
  cwd?: string;
  status: "idle" | "running" | "exited";
  exitCode?: number | null;
  createdAt: string;
}

export type TitleSource = "default" | "auto" | "user";
export type WorkspaceCreator = "user" | "agent";
export type WorkspaceReorderPosition = "before" | "after";
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
  runId?: string;
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
  colorScheme: TerminalColorSchemeId;
  inactiveTabStreaming: InactiveTabStreaming;
  tuiFrameRate: TuiFrameRate;
  terminalScrollMode: TerminalScrollMode;
  machineAliases: Record<string, string>;
}

export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"Fira Code", "Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace';
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;

export interface BootstrapPayload {
  revision: number;
  healthEpoch: number;
  machines: MachineStatus[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  notifications: TerminalNotification[];
  agentEvents: AgentActivity[];
  runs: TerminalRun[];
  terminalFontFamily: string;
  settings: WmuxSettings;
  keybindings: KeybindingMap;
  settingsDefaults: WmuxSettings;
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

export interface DurableSessionMissingRow {
  paneId: string;
  name: string;
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
  missing: DurableSessionMissingRow[];
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

export type PaneClientMessage =
  | { type: "input"; data: string; terminalResponse?: boolean; sequence?: number }
  | { type: "resize"; cols: number; rows: number; foreground?: boolean }
  | { type: "activate"; cols: number; rows: number; foreground?: boolean };

export type PaneReplayKind = "raw" | "checkpoint";
export type PaneStartupPhase =
  | "connecting"
  | "checking-agent"
  | "staging-helpers"
  | "starting-generation"
  | "creating-session"
  | "replaying";

export type PaneServerMessage =
  | { type: "starting"; paneId: string; phase: PaneStartupPhase; label: string }
  | {
      type: "ready";
      paneId: string;
      pid: number;
      title: string;
      status: PaneState["status"];
      resizeOwner?: boolean;
      replay: string;
      replayKind: PaneReplayKind;
      outputOnly?: boolean;
      waitForRefresh?: true;
    }
  | { type: "output"; paneId: string; data: string; inputSequence?: number }
  | { type: "title"; paneId: string; title: string }
  | { type: "exit"; paneId: string; code: number | null }
  | { type: "removed"; paneId: string };

export type EventClientMessage =
  | { type: "stream-request"; machineId: string; requestId: string; ttlMs?: number }
  | { type: "stream-release"; machineId: string; requestId: string };

export type EventServerMessage =
  | { type: "ready" }
  | { type: "snapshot"; reason: string; revision: number; state: BootstrapPayload }
  | { type: "health"; revision: number; healthEpoch: number; machines?: MachineStatus[]; streams?: StreamStatus[] }
  | { type: "notification"; notification: TerminalNotification }
  | { type: "media"; media: TerminalMedia }
  | { type: "clipboard"; clipboard: TerminalClipboard }
  | { type: "state" };
