export const WINDOWS_AGENT_PROTOCOL_VERSION = 7;

export const WINDOWS_AGENT_CAPABILITIES = [
  "paste-images-v1",
  "registration-heartbeat-v1",
  "stream-supervision-v1",
  "posix-runtime-files-v1",
  "console-screen-v1",
] as const;

export const POSIX_AGENT_RUNTIME_FILE_CAPABILITY = "posix-runtime-files-v1" as const;
// Advertised only by an agent whose sessions run on ConPTY and can report the
// console's own screen buffer through ordered screen events.
export const CONSOLE_SCREEN_CAPABILITY = "console-screen-v1" as const;

export const WINDOWS_AGENT_PATHS = {
  health: "/health",
  sessions: "/sessions",
  drain: "/drain",
  session: (sessionId: string): string => `/sessions/${encodeURIComponent(sessionId)}`,
  input: (sessionId: string): string => `/sessions/${encodeURIComponent(sessionId)}/input`,
  resize: (sessionId: string): string => `/sessions/${encodeURIComponent(sessionId)}/resize`,
  output: (sessionId: string, cursor: number, timeoutMs: number, eventSeq?: number): string =>
    `/sessions/${encodeURIComponent(sessionId)}/output?cursor=${cursor}&timeoutMs=${timeoutMs}`
    + (eventSeq === undefined ? "" : `&eventSeq=${eventSeq}`),
  screen: (sessionId: string): string => `/sessions/${encodeURIComponent(sessionId)}/screen`,
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

export interface WindowsAgentStreamHealth {
  owner?: boolean;
  enabled?: boolean;
  configured?: boolean;
  running?: boolean;
  pid?: number | null;
  restartCount?: number;
  lastStartedAt?: string | null;
  lastExitAt?: string | null;
  lastExitCode?: number | null;
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
  stream?: WindowsAgentStreamHealth;
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
  backend?: string;
}

export interface WindowsAgentSessionListResponse {
  sessions?: WindowsAgentSessionResponse[];
}

export interface WindowsAgentResizeEvent {
  // Shared with screen events; present from agents that sequence events.
  seq?: number;
  cursor: number;
  cols: number;
  rows: number;
}

/**
 * One row of the console screen buffer as ConPTY itself holds it.
 * `text` has one UTF-16 unit per occupied cell run: a wide glyph appears once
 * and starts at a column listed in `wide`, spanning that column and the next.
 * ConPTY reports surrogate pairs and multi-codepoint graphemes as U+FFFD.
 * `attrs` run-length encodes the legacy console attribute of every column.
 */
export interface WindowsAgentScreenLine {
  text: string;
  wide?: number[];
  attrs?: Array<[attribute: number, columns: number]>;
}

export interface WindowsAgentConsoleScreen {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  lines: WindowsAgentScreenLine[];
}

/**
 * A console screen read that is exact at byte `cursor` of the session output:
 * no output was produced between the read and that position.
 */
export interface WindowsAgentScreenEvent extends WindowsAgentConsoleScreen {
  seq: number;
  cursor: number;
  reason: "resize" | "verify";
}

export interface WindowsAgentOutputResponse {
  base?: number;
  startCursor?: number;
  cursor?: number;
  cols?: number;
  rows?: number;
  resizes?: WindowsAgentResizeEvent[];
  // With `eventSeq` in the request, `resizes` and `screens` hold every event
  // newer than it, including events at the first returned byte, and
  // `eventSeq` is the newest sequence number the agent has issued. Several
  // resizes can share one byte position; each one changed ConPTY's buffer.
  screens?: WindowsAgentScreenEvent[];
  eventSeq?: number;
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
  helperBundle: {
    bundleVersion: string;
    files: Array<{ name: string; dataBase64: string; sha256: string }>;
  };
  runtimeFiles?: Array<{
    purpose: "agent-input-capability";
    dataBase64: string;
    sha256: string;
  }>;
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
