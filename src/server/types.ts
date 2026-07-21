import type {
  AgentActivity,
  MachineKind,
  MachinePlatform,
  MachineStreamConfig,
  SessionBackend,
  TerminalNotification,
  TerminalRun,
  Workspace,
} from "../shared/protocol.js";

export * from "../shared/protocol.js";

export interface MachineStreamServerConfig extends MachineStreamConfig {
  gatewayToken?: string;
}

export interface MachineConfig {
  id: string;
  name: string;
  kind: MachineKind;
  /** Target OS for display/version labeling. Inferred when omitted. */
  platform?: MachinePlatform;
  host?: string;
  user?: string;
  port?: number;
  shell?: string;
  cwd?: string;
  command?: string[];
  sessionBackend?: SessionBackend;
  /** Load the standard PowerShell profile chain for interactive powershell-ssh panes. */
  loadPowerShellProfile?: boolean;
  agentUrl?: string;
  agentPort?: number;
  agentToken?: string;
  stream?: MachineStreamServerConfig;
  /** Runtime provenance and heartbeat state; static config files omit these. */
  source?: "config" | "registered";
  registeredAt?: string;
  lastSeenAt?: string;
  expiresAt?: string;
  online?: boolean;
}

export type MachineSource = MachineConfig[] | (() => MachineConfig[]);

export type DelegationState =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "error"
  | "cancelled"
  | "stopped"
  | "timed_out"
  | "interrupted";

export interface DelegationRecord {
  runId: string;
  state: DelegationState;
  runtime: string;
  title: string;
  summary: string;
  result: string;
  error: string;
  observerError?: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedState {
  schemaVersion: number;
  revision: number;
  machines: MachineConfig[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  notifications: TerminalNotification[];
  agentEvents: AgentActivity[];
  delegations: DelegationRecord[];
  runs: TerminalRun[];
}

export interface PtySpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  title: string;
  trackProcessTitle?: boolean;
}
