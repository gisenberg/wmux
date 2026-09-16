export type CodexTaskStatus = "active" | "idle" | "notLoaded" | "unavailable" | "unknown";

export interface CodexTaskEndpoint {
  id: string;
  label: string;
  machineId: string;
  identity: string;
  transport: "local" | "ssh";
  status: "available" | "unavailable" | "unknown";
  reason: string | null;
  sampledAt: string | null;
  freshLaunch: boolean;
  launchReason: string | null;
}

export interface CodexTask {
  endpointId: string;
  endpointIdentity: string;
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  modelProvider: string | null;
  source: string;
  parentThreadId: string | null;
  status: CodexTaskStatus;
  updatedAt: number | null;
  sampledAt: string;
  stale: boolean;
  latestTurn: { id: string; status: string } | null;
}

export interface CodexTaskTurn {
  id: string;
  status: string;
  text: string;
  truncated: boolean;
}

export interface CodexTaskPage {
  endpoint: CodexTaskEndpoint;
  tasks: CodexTask[];
  nextCursor: string | null;
}

export interface CodexTaskDetail {
  task: CodexTask;
  turns: CodexTaskTurn[];
  historyReason: string | null;
  resume: { enabled: false; reason: string };
}

export interface CodexTaskTarget {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface CodexTaskAssociation {
  id: string;
  endpointId: string;
  endpointIdentity: string;
  threadId: string;
  target: CodexTaskTarget;
  createdAt: string;
  resolved: boolean;
  reason: string | null;
}

export interface CodexTaskLaunch {
  requestId: string;
  endpointId: string;
  endpointIdentity?: string;
  status: "opening" | "opened" | "unknown" | "failed";
  target: CodexTaskTarget | null;
  reason: string | null;
  createdAt: string;
  acknowledgedAt?: string;
}
