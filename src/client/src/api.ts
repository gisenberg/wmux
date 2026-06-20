import type { BootstrapPayload, DurableSessionAudit, SplitDirection, WmuxSettings } from "./types";

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
};

export const api = {
  bootstrap: () => json<BootstrapPayload>("/api/bootstrap"),
  auditSessions: () => json<DurableSessionAudit>("/api/session-audit"),
  cleanupSession: (backend: "tmux" | "screen", name: string) =>
    json<DurableSessionAudit>(`/api/session-audit/${backend}/${encodeURIComponent(name)}`, { method: "DELETE" }),
  updateSettings: (settings: WmuxSettings) =>
    json<{ settings: WmuxSettings; state: BootstrapPayload }>("/api/settings", {
      method: "POST",
      body: JSON.stringify(settings),
    }),
  createWorkspace: (machineId: string) =>
    json<{ workspace: BootstrapPayload["workspaces"][number] }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ machineId }),
    }),
  activateWorkspace: (workspaceId: string) =>
    json<BootstrapPayload>(`/api/workspaces/${workspaceId}/active`, { method: "POST" }),
  closeWorkspace: (workspaceId: string) =>
    json<{ state: BootstrapPayload }>(`/api/workspaces/${workspaceId}`, { method: "DELETE" }),
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
  createTab: (workspaceId: string, machineId: string) =>
    json<{ state: BootstrapPayload }>(`/api/workspaces/${workspaceId}/tabs`, {
      method: "POST",
      body: JSON.stringify({ machineId }),
    }),
  activateTab: (workspaceId: string, tabId: string) =>
    json<BootstrapPayload>(`/api/workspaces/${workspaceId}/tabs/${tabId}/active`, {
      method: "POST",
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
  splitPane: (tabId: string, paneId: string, direction: SplitDirection, machineId: string) =>
    json<{ state: BootstrapPayload }>(`/api/tabs/${tabId}/split`, {
      method: "POST",
      body: JSON.stringify({ paneId, direction, machineId }),
    }),
  updateSplitRatio: (tabId: string, path: string, ratio: number) =>
    json<{ state: BootstrapPayload }>(`/api/tabs/${tabId}/split-ratio`, {
      method: "POST",
      body: JSON.stringify({ path, ratio }),
    }),
  activatePane: (tabId: string, paneId: string) =>
    json<BootstrapPayload>(`/api/tabs/${tabId}/panes/${paneId}/active`, { method: "POST" }),
  closePane: (tabId: string, paneId: string) =>
    json<{ state: BootstrapPayload }>(`/api/tabs/${tabId}/panes/${paneId}`, { method: "DELETE" }),
  createNotification: (paneId: string, title: string, subtitle: string, body: string) =>
    json<{ state: BootstrapPayload }>("/api/notifications", {
      method: "POST",
      body: JSON.stringify({ paneId, title, subtitle, body }),
    }),
  markNotificationRead: (notificationId: string) =>
    json<BootstrapPayload>(`/api/notifications/${notificationId}/read`, { method: "POST" }),
  markWorkspaceNotificationsRead: (workspaceId: string) =>
    json<BootstrapPayload>(`/api/workspaces/${workspaceId}/notifications/read`, { method: "POST" }),
};
