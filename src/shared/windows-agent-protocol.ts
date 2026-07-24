export const WINDOWS_AGENT_PROTOCOL_VERSION = 5;

export const WINDOWS_AGENT_CAPABILITIES = [
  "paste-images-v1",
  "registration-heartbeat-v1",
] as const;

export const WINDOWS_AGENT_PATHS = {
  health: "/health",
  sessions: "/sessions",
  drain: "/drain",
  session: (sessionId: string): string => `/sessions/${encodeURIComponent(sessionId)}`,
  input: (sessionId: string): string => `/sessions/${encodeURIComponent(sessionId)}/input`,
  resize: (sessionId: string): string => `/sessions/${encodeURIComponent(sessionId)}/resize`,
  output: (sessionId: string, cursor: number, timeoutMs: number): string =>
    `/sessions/${encodeURIComponent(sessionId)}/output?cursor=${cursor}&timeoutMs=${timeoutMs}`,
  pasteImage: (sessionId: string, stageId: string, extension?: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/paste-images/${encodeURIComponent(stageId)}`
    + (extension === undefined ? "" : `?extension=${encodeURIComponent(extension)}`),
} as const;

export const WINDOWS_AGENT_LONG_POLL = {
  defaultTimeoutMs: 15_000,
  maximumTimeoutMs: 30_000,
  requestTimeoutMs: 20_000,
} as const;

export interface WindowsAgentHeartbeatHealth {
  owner?: boolean;
  enabled?: boolean;
  configured?: boolean;
  intervalSeconds?: number;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures?: number;
  lastError?: string | null;
}

export interface WindowsAgentHealth {
  ok?: boolean;
  releaseVersion?: string;
  protocolVersion?: number;
  version?: string;
  machine?: string;
  pid?: number;
  sessions?: number;
  activeSessions?: number;
  draining?: boolean;
  updatePending?: boolean;
  restartWhenIdle?: boolean;
  backend?: string;
  processTree?: string;
  helperBundleVersion?: string;
  conptyAvailable?: boolean;
  pywinptyAvailable?: boolean;
  capabilities?: string[];
  heartbeat?: WindowsAgentHeartbeatHealth;
}

export interface WindowsAgentSessionResponse {
  id: string;
  pid?: number;
  status?: string;
  exitCode?: number | null;
  cwd?: string;
  base?: number;
  cursor?: number;
  cols?: number;
  rows?: number;
}

export interface WindowsAgentSessionListResponse {
  sessions?: WindowsAgentSessionResponse[];
}

export interface WindowsAgentResizeEvent {
  cursor: number;
  cols: number;
  rows: number;
}

export interface WindowsAgentOutputResponse {
  base?: number;
  startCursor?: number;
  cursor?: number;
  cols?: number;
  rows?: number;
  resizes?: WindowsAgentResizeEvent[];
  dataBase64?: string;
  exited?: boolean;
  exitCode?: number | null;
  cwd?: string;
}

export interface WindowsAgentCreateRequest {
  cols: number;
  rows: number;
  cwd: string;
  shell: string;
  loadPowerShellProfile: boolean;
  agentProfileOptionalAuth: boolean;
  helperBundle: {
    bundleVersion: string;
    files: Array<{ name: string; dataBase64: string; sha256: string }>;
  };
  env: Record<string, string>;
}

export interface WindowsAgentInputRequest {
  dataBase64: string;
  terminalResponse: boolean;
}

export interface WindowsAgentResizeRequest {
  cols: number;
  rows: number;
}

export interface WindowsAgentPasteImageResponse {
  stageId: string;
  targetPath: string;
  bytes: number;
}
