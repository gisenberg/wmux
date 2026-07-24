export const AGENT_CONTRACT_VERSION = 1;

export const AGENT_MARKERS = {
  ready: "WMUX_AGENT_READY",
  result: "WMUX_AGENT_RESULT",
  done: "WMUX_AGENT_DONE",
  tuiReady: "WMUX_AGENT_TUI_READY",
  tuiLaunch: "WMUX_AGENT_TUI_LAUNCH",
  tuiAck: "WMUX_AGENT_TUI_ACK",
  tuiExit: "WMUX_AGENT_TUI_EXIT",
  tuiRelease: "WMUX_AGENT_TUI_RELEASE",
} as const;

export const AGENT_CONTRACT_LIMITS = {
  maxLine: 1_100_000,
  maxPrompt: 128 * 1024,
  maxText: 64_000,
  terminationGraceSeconds: 2,
  helpProbeTimeoutSeconds: 5,
  maxHelpOutput: 256 * 1024,
  maxBlankRequestLines: 8,
  maxRunId: 128,
  maxDirectory: 4_096,
  maxOptionText: 512,
} as const;

export const AGENT_RUNTIMES = [
  "opencode",
  "codex",
  "claude",
] as const;

export type AgentRuntime = typeof AGENT_RUNTIMES[number];

export const AGENT_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type AgentSandboxMode = typeof AGENT_SANDBOX_MODES[number];

export const AGENT_RESULT_FORMATS = ["outcome-v1"] as const;

export type AgentResultFormat = typeof AGENT_RESULT_FORMATS[number];

export const AGENT_OUTCOME_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["completed", "blocked", "failed"],
    },
    summary: {
      type: "string",
    },
  },
  required: ["outcome", "summary"],
  additionalProperties: false,
} as const;

export type AgentOutcome = typeof AGENT_OUTCOME_SCHEMA.properties.outcome.enum[number];

export interface DelegationRequest {
  runId: string;
  runtime?: AgentRuntime;
  prompt: string;
  directory: string;
  model?: string;
  agent?: string;
  title?: string;
  unattended?: boolean;
  writeAccess?: boolean;
  sandboxMode?: AgentSandboxMode;
  resultFormat?: AgentResultFormat;
}

export type InteractiveAgentRequest = Omit<
  DelegationRequest,
  "prompt" | "resultFormat" | "title"
>;

export interface AgentResult {
  runId: string;
  runtime?: AgentRuntime;
  ok: boolean;
  result?: string;
  error?: string;
  outcome?: AgentOutcome;
}

export interface AgentEventPostBody {
  runId?: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  agent?: string;
  status?: string;
  title?: string;
  summary?: string;
  message?: string;
  body?: string;
}

export type RunEventStatus = "started" | "completed" | "failed";

export interface RunEventPostBody {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  runId?: string;
  command?: string;
  status?: RunEventStatus;
  exitCode?: number | null;
  startedAt?: string;
  completedAt?: string;
}
