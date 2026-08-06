import { authHeaders } from "./token";
import type { ClientSplitIds, ClientTabIds, ClientWorkspaceIds } from "./optimistic-creation";
import type {
  AgentFollowUpRequest,
  AgentFollowUpResult,
  AgentInputAnswerResult,
  BootstrapPayload,
  DoctorReport,
  DurableSessionAudit,
  MachineKind,
  MachinePlatform,
  MachineStreamConfig,
  SessionBackend,
  SplitDirection,
  WorkspaceReorderPosition,
  WmuxSettings,
} from "./types";

export interface ManagedStaticMachine {
  id: string;
  name: string;
  kind: MachineKind;
  platform?: MachinePlatform;
  host?: string;
  user?: string;
  port?: number;
  shell?: string;
  cwd?: string;
  command?: string[];
  sessionBackend?: SessionBackend;
  loadPowerShellProfile?: boolean;
  agentUrl?: string;
  agentPort?: number;
  stream?: MachineStreamConfig;
  hasAgentToken: boolean;
  hasGatewayToken: boolean;
}

export interface ManagedRegisteredHost {
  id: string;
  machine: {
    id: string;
    name: string;
    kind: "ssh" | "powershell-ssh";
    user?: string;
    port?: number;
    sessionBackend?: SessionBackend;
    agentPort?: number;
  };
  active: boolean;
  disabled?: boolean;
  shadowed: boolean;
  observedAddress: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface MachineManagementCatalog {
  staticMachines: ManagedStaticMachine[];
  registeredHosts: ManagedRegisteredHost[];
}

export type ModalSettingsUpdate = Omit<WmuxSettings, "collapsedWorkspaceIds" | "favoriteWorkspaceIds">;

export const modalSettingsUpdate = (settings: WmuxSettings): ModalSettingsUpdate => ({
  terminalFontSize: settings.terminalFontSize,
  terminalScrollbackRows: settings.terminalScrollbackRows,
  colorScheme: settings.colorScheme,
  inactiveTabStreaming: settings.inactiveTabStreaming,
  tuiFrameRate: settings.tuiFrameRate,
  terminalScrollMode: settings.terminalScrollMode,
  groupSidebarSessionsByHost: settings.groupSidebarSessionsByHost,
  machineAliases: settings.machineAliases,
});

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
    if (typeof window !== "undefined") window.dispatchEvent(new Event("wmux-auth-required"));
  }
}

export class WorkspaceReorderConflictError extends Error {
  constructor(readonly state: BootstrapPayload) {
    super("workspace tree changed");
    this.name = "WorkspaceReorderConflictError";
  }
}

export interface PaneAttachment {
  id: string;
  paneId: string;
  name: string;
  mimeType: string;
  bytes: number;
  url: string;
  createdAt: string;
}

export interface StagedPanePasteImage {
  stageId: string;
  targetPath: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
  expiresAt: string;
}

export interface KittyGraphicsSourceRequest {
  medium: "f" | "t" | "s";
  source: string;
  size?: number;
  offset?: number;
}

const responseError = async (response: Response): Promise<Error> => {
  try {
    const body = await response.json() as { error?: string };
    return new Error(body.error || `HTTP ${response.status}`);
  } catch {
    return new Error(`HTTP ${response.status}`);
  }
};

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
};

export interface AuthInfo {
  authEnabled: boolean;
  loginEnabled: boolean;
  browserAuthMode: "shared-or-login" | "login-only";
}

export interface BrowserSessionMetadata {
  id: string;
  issuedAt: number;
  expiresAt: number;
  lastSeenAt: number;
  device: string;
  address: string;
}

export interface ScopedCredentialMetadata {
  kind: "automation" | "helper";
  issuedAt: number;
  expiresAt: number;
  rotatable: boolean;
}

export const api = {
  bootstrap: () => json<BootstrapPayload>("/api/bootstrap"),
  answerAgentInputRequest: async (
    id: string,
    expectedGeneration: number,
    idempotencyKey: string,
    answers: string[][],
  ): Promise<AgentInputAnswerResult> => {
    const response = await fetch(`/api/agent-input/requests/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ expectedGeneration, idempotencyKey, answers }),
    });
    if (response.status === 401) throw new UnauthorizedError();
    const body = await response.json() as AgentInputAnswerResult;
    if ([200, 409, 422, 502, 503].includes(response.status)) return body;
    throw new Error(`HTTP ${response.status}`);
  },
  authInfo: async (): Promise<AuthInfo> => {
    const response = await fetch("/api/auth-info", { headers: { "cache-control": "no-store" } });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<AuthInfo>;
  },
  authSession: () => json<{ authenticated: true }>("/api/auth/session"),
  browserSessions: () =>
    json<{
      currentSessionId?: string;
      sessions: BrowserSessionMetadata[];
    }>("/api/auth/sessions"),
  revokeBrowserSession: (sessionId: string) =>
    json<{ revoked: true }>(
      `/api/auth/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),
  scopedCredentials: () =>
    json<{ credentials: ScopedCredentialMetadata[] }>(
      "/api/auth/credentials",
    ),
  rotateScopedCredential: (kind: ScopedCredentialMetadata["kind"]) =>
    json<{ credential: ScopedCredentialMetadata }>(
      `/api/auth/credentials/${kind}/rotate`,
      { method: "POST" },
    ),
  login: async (
    username: string,
    password: string,
  ): Promise<{
    token?: string;
    authenticated?: true;
    expiresInMs: number;
  }> => {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (response.status === 401) throw new Error("Invalid username or password");
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<{
      token?: string;
      authenticated?: true;
      expiresInMs: number;
    }>;
  },
  streams: () => json<{ streams: BootstrapPayload["streams"] }>("/api/streams"),
  requestStream: (machineId: string, requestId: string, ttlMs: number) =>
    json<{ streams: BootstrapPayload["streams"] }>(`/api/streams/${encodeURIComponent(machineId)}/request`, {
      method: "POST",
      body: JSON.stringify({ requestId, ttlMs }),
    }),
  releaseStream: (machineId: string, requestId: string) =>
    json<{ streams: BootstrapPayload["streams"] }>(
      `/api/streams/${encodeURIComponent(machineId)}/request/${encodeURIComponent(requestId)}`,
      { method: "DELETE" },
    ),
  auditSessions: () => json<DurableSessionAudit>("/api/session-audit"),
  doctor: () => json<DoctorReport>("/api/doctor"),
  managedMachines: () => json<MachineManagementCatalog>("/api/machines/manage"),
  createManagedMachine: (machine: Omit<ManagedStaticMachine, "hasAgentToken" | "hasGatewayToken">) =>
    json<{ machine: ManagedStaticMachine; state: BootstrapPayload }>("/api/machines", {
      method: "POST",
      body: JSON.stringify(machine),
    }),
  updateManagedMachine: (
    machine: Omit<ManagedStaticMachine, "hasAgentToken" | "hasGatewayToken">,
  ) =>
    json<{ machine: ManagedStaticMachine; state: BootstrapPayload }>(
      `/api/machines/${encodeURIComponent(machine.id)}`,
      {
        method: "PUT",
        body: JSON.stringify(machine),
      },
    ),
  deleteManagedMachine: (machineId: string) =>
    json<{ removed: true; state: BootstrapPayload }>(
      `/api/machines/${encodeURIComponent(machineId)}`,
      { method: "DELETE" },
    ),
  updateRegisteredHost: (
    machineId: string,
    update: { name?: string; disabled?: boolean },
  ) =>
    json<{ host: ManagedRegisteredHost; state: BootstrapPayload }>(
      `/api/registry/hosts/${encodeURIComponent(machineId)}`,
      {
        method: "PUT",
        body: JSON.stringify(update),
      },
    ),
  deleteRegisteredHost: (machineId: string) =>
    json<{ removed: boolean }>(
      `/api/registry/hosts/${encodeURIComponent(machineId)}`,
      { method: "DELETE" },
    ),
  cleanupSession: (backend: "tmux" | "screen" | "agent", name: string, cleanupKey?: string) => {
    const query = cleanupKey ? `?endpoint=${encodeURIComponent(cleanupKey)}` : "";
    return json<DurableSessionAudit>(
      `/api/session-audit/${backend}/${encodeURIComponent(name)}${query}`,
      { method: "DELETE" },
    );
  },
  updateSettings: (settings: ModalSettingsUpdate) =>
    json<{ settings: WmuxSettings; state: BootstrapPayload }>("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        terminalFontSize: settings.terminalFontSize,
        terminalScrollbackRows: settings.terminalScrollbackRows,
        colorScheme: settings.colorScheme,
        inactiveTabStreaming: settings.inactiveTabStreaming,
        tuiFrameRate: settings.tuiFrameRate,
        terminalScrollMode: settings.terminalScrollMode,
        groupSidebarSessionsByHost: settings.groupSidebarSessionsByHost,
        machineAliases: settings.machineAliases,
      }),
    }),
  updateCollapsedWorkspaceIds: (collapsedWorkspaceIds: string[]) =>
    json<{ settings: WmuxSettings; state: BootstrapPayload }>("/api/settings", {
      method: "POST",
      body: JSON.stringify({ collapsedWorkspaceIds }),
    }),
  updateFavoriteWorkspaceIds: (favoriteWorkspaceIds: string[]) =>
    json<{ settings: WmuxSettings; state: BootstrapPayload }>("/api/settings", {
      method: "POST",
      body: JSON.stringify({ favoriteWorkspaceIds }),
    }),
  createWorkspace: (machineId: string, sourcePaneId?: string, clientIds?: ClientWorkspaceIds) =>
    json<{ workspace: BootstrapPayload["workspaces"][number]; state: BootstrapPayload }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ machineId, sourcePaneId, ...(clientIds ? { clientIds } : {}) }),
    }),
  closeWorkspace: (workspaceId: string) =>
    json<{ state: BootstrapPayload }>(`/api/workspaces/${workspaceId}`, { method: "DELETE" }),
  scheduleWorkspaceClose: (workspaceId: string) =>
    json<{ scheduled: true; closeAt: string }>(
      `/api/workspaces/${workspaceId}/pending-close`,
      { method: "POST" },
    ),
  cancelWorkspaceClose: (workspaceId: string) =>
    json<{ cancelled: boolean; state: BootstrapPayload }>(
      `/api/workspaces/${workspaceId}/pending-close`,
      { method: "DELETE" },
    ),
  reorderWorkspace: async (
    workspaceId: string,
    targetWorkspaceId: string | undefined,
    position: WorkspaceReorderPosition,
    workspaceTreeRevision: number,
  ): Promise<{ state: BootstrapPayload }> => {
    const response = await fetch("/api/workspaces/reorder", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ workspaceId, ...(targetWorkspaceId ? { targetWorkspaceId } : {}), position, workspaceTreeRevision }),
    });
    if (response.status === 401) throw new UnauthorizedError();
    if (response.status === 409) {
      const body = await response.json() as { state: BootstrapPayload };
      throw new WorkspaceReorderConflictError(body.state);
    }
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<{ state: BootstrapPayload }>;
  },
  setWorkspaceTitle: (workspaceId: string, title: string) =>
    json<{ state: BootstrapPayload }>(`/api/workspaces/${workspaceId}/title`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  setWorkspaceAutoTitle: (workspaceId: string, title: string, descriptor?: string, tabId?: string) =>
    json<{ state: BootstrapPayload }>(`/api/workspaces/${workspaceId}/auto-title`, {
      method: "POST",
      body: JSON.stringify({ title, descriptor, tabId, tabOnlyIfMultiple: true }),
    }),
  createTab: (workspaceId: string, machineId: string, sourcePaneId?: string, clientIds?: ClientTabIds) =>
    json<{ tab: BootstrapPayload["workspaces"][number]["tabs"][number]; state: BootstrapPayload }>(`/api/workspaces/${workspaceId}/tabs`, {
      method: "POST",
      body: JSON.stringify({ machineId, sourcePaneId, ...(clientIds ? { clientIds } : {}) }),
    }),
  closeTab: (workspaceId: string, tabId: string) =>
    json<{ state: BootstrapPayload }>(`/api/workspaces/${workspaceId}/tabs/${tabId}`, {
      method: "DELETE",
    }),
  setTabTitle: (workspaceId: string, tabId: string, title: string) =>
    json<{ state: BootstrapPayload }>(`/api/workspaces/${workspaceId}/tabs/${tabId}/title`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  splitPane: (
    tabId: string,
    paneId: string,
    direction: SplitDirection,
    machineId?: string,
    clientIds?: ClientSplitIds,
  ) =>
    json<{ tab: BootstrapPayload["workspaces"][number]["tabs"][number]; state: BootstrapPayload }>(`/api/tabs/${tabId}/split`, {
      method: "POST",
      body: JSON.stringify({ paneId, direction, ...(machineId ? { machineId } : {}), ...(clientIds ? { clientIds } : {}) }),
    }),
  updateSplitRatio: (tabId: string, path: string, ratio: number) =>
    json<{ state: BootstrapPayload }>(`/api/tabs/${tabId}/split-ratio`, {
      method: "POST",
      body: JSON.stringify({ path, ratio }),
    }),
  closePane: (tabId: string, paneId: string) =>
    json<{ state: BootstrapPayload }>(`/api/tabs/${tabId}/panes/${paneId}`, { method: "DELETE" }),
  sendPaneInput: (
    paneId: string,
    data: string,
    timelinePrompt?: string,
    cols = 96,
    rows = 32,
  ) =>
    json<BootstrapPayload>(`/api/panes/${encodeURIComponent(paneId)}/input`, {
      method: "POST",
      body: JSON.stringify({
        data,
        cols,
        rows,
        ...(timelinePrompt ? { timelinePrompt } : {}),
      }),
    }),
  createAgentFollowUp: (
    sessionId: string,
    request: AgentFollowUpRequest,
  ) =>
    json<AgentFollowUpResult & { state: BootstrapPayload }>(
      `/api/agent-sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
  uploadPaneAttachment: (paneId: string, attachment: { name: string; mimeType: string; data: string }) =>
    json<{ attachment: PaneAttachment }>(`/api/panes/${encodeURIComponent(paneId)}/attachments`, {
      method: "POST",
      body: JSON.stringify(attachment),
    }),
  stagePanePasteImage: async (paneId: string, image: Blob): Promise<StagedPanePasteImage> => {
    const response = await fetch(`/api/panes/${encodeURIComponent(paneId)}/paste-images`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...authHeaders(),
      },
      body: image,
    });
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<StagedPanePasteImage>;
  },
  readKittyGraphicsSource: async (
    paneId: string,
    request: KittyGraphicsSourceRequest,
  ): Promise<Uint8Array> => {
    const response = await fetch(
      `/api/panes/${encodeURIComponent(paneId)}/kitty-graphics/source`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(request),
      },
    );
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) throw await responseError(response);
    return new Uint8Array(await response.arrayBuffer());
  },
  discardPanePasteImage: async (paneId: string, stageId: string): Promise<void> => {
    const response = await fetch(
      `/api/panes/${encodeURIComponent(paneId)}/paste-images/${encodeURIComponent(stageId)}`,
      { method: "DELETE", headers: authHeaders() },
    );
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok && response.status !== 404) throw await responseError(response);
  },
  createNotification: (paneId: string, title: string, subtitle: string, body: string) =>
    json<{ state: BootstrapPayload }>("/api/notifications", {
      method: "POST",
      body: JSON.stringify({ paneId, title, subtitle, body }),
    }),
  markNotificationRead: (notificationId: string) =>
    json<BootstrapPayload>(`/api/notifications/${notificationId}/read`, { method: "POST" }),
  markWorkspaceNotificationsRead: (workspaceId: string) =>
    json<BootstrapPayload>(`/api/workspaces/${workspaceId}/notifications/read`, { method: "POST" }),
  markPaneNotificationsRead: (paneId: string) =>
    json<BootstrapPayload>(`/api/panes/${encodeURIComponent(paneId)}/notifications/read`, { method: "POST" }),
};
