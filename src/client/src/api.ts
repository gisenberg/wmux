import { authHeaders } from "./token";
import type { ClientSplitIds, ClientTabIds, ClientWorkspaceIds } from "./optimistic-creation";
import type { BootstrapPayload, DoctorReport, DurableSessionAudit, SplitDirection, WorkspaceReorderPosition, WmuxSettings } from "./types";

export type ModalSettingsUpdate = Omit<WmuxSettings, "collapsedWorkspaceIds">;

export const modalSettingsUpdate = (settings: WmuxSettings): ModalSettingsUpdate => ({
  terminalFontSize: settings.terminalFontSize,
  terminalScrollbackRows: settings.terminalScrollbackRows,
  colorScheme: settings.colorScheme,
  inactiveTabStreaming: settings.inactiveTabStreaming,
  tuiFrameRate: settings.tuiFrameRate,
  terminalScrollMode: settings.terminalScrollMode,
  machineAliases: settings.machineAliases,
});

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
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

export const api = {
  bootstrap: () => json<BootstrapPayload>("/api/bootstrap"),
  authInfo: async (): Promise<AuthInfo> => {
    const response = await fetch("/api/auth-info", { headers: { "cache-control": "no-store" } });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<AuthInfo>;
  },
  authSession: () => json<{ authenticated: true }>("/api/auth/session"),
  login: async (username: string, password: string): Promise<{ token: string; expiresInMs: number }> => {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (response.status === 401) throw new Error("Invalid username or password");
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<{ token: string; expiresInMs: number }>;
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
  cleanupSession: (backend: "tmux" | "screen", name: string) =>
    json<DurableSessionAudit>(`/api/session-audit/${backend}/${encodeURIComponent(name)}`, { method: "DELETE" }),
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
        machineAliases: settings.machineAliases,
      }),
    }),
  updateCollapsedWorkspaceIds: (collapsedWorkspaceIds: string[]) =>
    json<{ settings: WmuxSettings; state: BootstrapPayload }>("/api/settings", {
      method: "POST",
      body: JSON.stringify({ collapsedWorkspaceIds }),
    }),
  createWorkspace: (machineId: string, sourcePaneId?: string, clientIds?: ClientWorkspaceIds) =>
    json<{ workspace: BootstrapPayload["workspaces"][number]; state: BootstrapPayload }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ machineId, sourcePaneId, ...(clientIds ? { clientIds } : {}) }),
    }),
  closeWorkspace: (workspaceId: string) =>
    json<{ state: BootstrapPayload }>(`/api/workspaces/${workspaceId}`, { method: "DELETE" }),
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
  sendPaneInput: (paneId: string, data: string, cols = 96, rows = 32) =>
    json<BootstrapPayload>(`/api/panes/${encodeURIComponent(paneId)}/input`, {
      method: "POST",
      body: JSON.stringify({ data, cols, rows }),
    }),
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
