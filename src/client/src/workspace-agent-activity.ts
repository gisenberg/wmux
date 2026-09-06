import type { AgentActivity } from "./types";

export type AgentLifecycleStatus = "running" | "waiting" | "stale" | "completed" | "failed" | "updated";

export interface WorkspaceAgentActivity {
  representative: AgentActivity;
  paneCount: number;
  activePaneCount: number;
  heartbeatPaneCount: number;
}

const eventTime = (event: AgentActivity): number => {
  const time = Date.parse(event.createdAt);
  return Number.isFinite(time) ? time : 0;
};

export const agentLifecycleStatus = (status: string): AgentLifecycleStatus => {
  const normalized = status.toLowerCase().replaceAll("-", "_");
  if (["waiting", "needs_input", "input_required", "approval_required", "login_required", "blocked"].includes(normalized)) {
    return "waiting";
  }
  if (["observer_stale", "stale"].includes(normalized)) return "stale";
  if (["failed", "error", "cancelled", "stopped", "timed_out", "interrupted"].includes(normalized)) return "failed";
  if (["completed", "done", "success"].includes(normalized)) return "completed";
  if (["running", "started", "working"].includes(normalized)) return "running";
  return "updated";
};

export const latestAgentActivityByPane = (events: readonly AgentActivity[]): Map<string, AgentActivity> => {
  const latest = new Map<string, AgentActivity>();
  for (const event of events) {
    const current = latest.get(event.paneId);
    if (!current || eventTime(event) > eventTime(current)) latest.set(event.paneId, event);
  }
  return latest;
};

const activePriority = (event: AgentActivity): number => {
  const lifecycle = agentLifecycleStatus(event.status);
  if (lifecycle === "waiting") return 4;
  if (lifecycle === "running") return 3;
  if (lifecycle === "stale") return 2;
  if (event.heartbeatActive && (lifecycle === "completed" || lifecycle === "updated")) return 1;
  return 0;
};

/**
 * Reduces activity in two stages: first to the latest lifecycle for each pane,
 * then to a workspace representative. Live/attention panes always outrank
 * settled results; when every pane is settled, the newest result wins.
 */
export const aggregateAgentActivityByWorkspace = (
  events: readonly AgentActivity[],
): Map<string, WorkspaceAgentActivity> => {
  const paneEventsByWorkspace = new Map<string, AgentActivity[]>();
  for (const event of latestAgentActivityByPane(events).values()) {
    const workspaceEvents = paneEventsByWorkspace.get(event.workspaceId) ?? [];
    workspaceEvents.push(event);
    paneEventsByWorkspace.set(event.workspaceId, workspaceEvents);
  }

  const aggregates = new Map<string, WorkspaceAgentActivity>();
  for (const [workspaceId, paneEvents] of paneEventsByWorkspace) {
    const activeEvents = paneEvents.filter((event) => activePriority(event) > 0);
    const candidates = activeEvents.length > 0 ? activeEvents : paneEvents;
    const representative = candidates.reduce((strongest, event) => {
      const priorityDelta = activeEvents.length > 0
        ? activePriority(event) - activePriority(strongest)
        : 0;
      if (priorityDelta > 0) return event;
      if (priorityDelta < 0) return strongest;
      return eventTime(event) > eventTime(strongest) ? event : strongest;
    });
    aggregates.set(workspaceId, {
      representative,
      paneCount: paneEvents.length,
      activePaneCount: paneEvents.filter((event) => {
        const lifecycle = agentLifecycleStatus(event.status);
        return lifecycle === "running" || lifecycle === "waiting";
      }).length,
      heartbeatPaneCount: paneEvents.filter((event) => {
        const lifecycle = agentLifecycleStatus(event.status);
        return Boolean(event.heartbeatActive) && (lifecycle === "completed" || lifecycle === "updated");
      }).length,
    });
  }
  return aggregates;
};
