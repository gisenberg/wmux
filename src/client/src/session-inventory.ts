import type { AgentActivity, AgentTimelineEntry, BootstrapPayload, DelegationAttentionReason, MachineStatus } from "./types";
import { agentLifecycleStatus, latestAgentActivityByPane } from "./workspace-agent-activity";

export interface SessionRow {
  id: string;
  runtime: string;
  source: "delegation" | "hook" | "shell";
  title: string;
  workspaceId: string;
  workspaceName: string;
  tabId: string;
  paneId: string;
  machineId: string;
  machineName: string;
  state: string;
  attentionReason?: DelegationAttentionReason;
  stateChangedAt: string;
  updatedAt: string;
  available: boolean;
  reachable: boolean;
  unread: boolean;
  cwd?: string;
  heartbeatActive?: boolean;
  runId?: string;
  lastEntry?: AgentTimelineEntry;
}

/** Presentation only: observing a hook never grants managed-delegation authority. */
export function buildSessionRows(state: BootstrapPayload, machines: MachineStatus[]): SessionRow[] {
  const hosts = new Map(machines.map((machine) => [machine.id, machine]));
  const hooks = latestAgentActivityByPane(state.agentEvents ?? []);
  const delegations = new Map<string, BootstrapPayload["delegations"][number]>();
  for (const item of state.delegations) {
    const previous = delegations.get(item.paneId);
    if (!previous || item.updatedAt > previous.updatedAt) delegations.set(item.paneId, item);
  }
  const rows: SessionRow[] = [];
  for (const workspace of state.workspaces) for (const tab of workspace.tabs) for (const pane of tab.panes) {
    const candidate = hooks.get(pane.id);
    const hook = candidate?.workspaceId === workspace.id && candidate.tabId === tab.id ? candidate : undefined;
    const managed = delegations.get(pane.id);
    const delegation = managed?.workspaceId === workspace.id && managed.tabId === tab.id
      && (!hook || managed.updatedAt >= hook.createdAt || managed.runId === hook.runId) ? managed : undefined;
    delegations.delete(pane.id);
    const pending = state.agentInputRequests?.some((request) => request.paneId === pane.id && request.state === "pending");
    const source = delegation ? "delegation" : hook || pending ? "hook" : "shell";
    const status = pending ? "waiting" : delegation?.state ?? (hook ? agentLifecycleStatus(hook.status) : pane.status === "exited" ? "exited" : "idle");
    let stateChangedAt = delegation?.stateChangedAt ?? hook?.createdAt ?? pane.createdAt;
    if (!delegation && hook) {
      const history = (state.agentEvents ?? []).filter((event) => event.paneId === pane.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const event of history) {
        if (event.runId !== hook.runId || event.agent !== hook.agent || agentLifecycleStatus(event.status) !== agentLifecycleStatus(hook.status)) break;
        stateChangedAt = event.createdAt;
      }
    }
    const host = hosts.get(pane.machineId);
    rows.push({
      id: delegation?.runId ?? hook?.id ?? `shell:${pane.id}`, source,
      runId: delegation?.runId ?? hook?.runId, heartbeatActive: hook?.heartbeatActive,
      runtime: delegation?.runtime ?? hook?.agent ?? (pending ? "agent" : "shell"),
      title: delegation?.title || hook?.title || tab.title || pane.title || workspace.name,
      workspaceId: workspace.id, workspaceName: workspace.name, tabId: tab.id, paneId: pane.id,
      machineId: pane.machineId, machineName: host?.name ?? pane.machineId,
      state: status, attentionReason: pending ? "input" : delegation?.attentionReason,
      stateChangedAt, updatedAt: delegation?.updatedAt ?? hook?.createdAt ?? pane.createdAt,
      available: true, reachable: host?.reachable ?? false, cwd: pane.cwd,
      unread: (state.notifications ?? []).some((item) => item.paneId === pane.id && !item.read && item.createdAt >= stateChangedAt),
      lastEntry: delegation ? state.agentTimelines.find((timeline) => timeline.id === delegation.sessionId)?.entries.at(-1) : undefined,
    });
  }
  for (const delegation of state.delegations) {
    if (rows.some((row) => row.source === "delegation" && row.id === delegation.runId)) continue;
    if (delegation.state !== "running" && delegation.state !== "waiting" && !delegation.attentionReason) continue;
    const workspace = state.workspaces.find((workspace) => workspace.id === delegation.workspaceId);
    const pane = workspace?.tabs.find((tab) => tab.id === delegation.tabId)?.panes.find((pane) => pane.id === delegation.paneId);
    const machineId = pane?.machineId ?? delegation.machineId ?? "unknown";
    rows.push({
      ...delegation, id: delegation.runId, source: "delegation", workspaceName: workspace?.name ?? "workspace removed",
      machineId, machineName: hosts.get(machineId)?.name ?? machineId,
      available: Boolean(pane), reachable: hosts.get(machineId)?.reachable ?? false, unread: false,
      lastEntry: state.agentTimelines.find((timeline) => timeline.id === delegation.sessionId)?.entries.at(-1),
    });
  }
  return rows.sort((a, b) => sessionPriority(a) - sessionPriority(b) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function sessionActivities(rows: SessionRow[]): AgentActivity[] {
  const representatives = new Map<string, SessionRow>();
  for (const row of rows) {
    if (!row.available || row.source === "shell") continue;
    const current = representatives.get(row.paneId);
    if (!current || sessionPriority(row) < sessionPriority(current)
      || (sessionPriority(row) === sessionPriority(current) && row.updatedAt > current.updatedAt)) representatives.set(row.paneId, row);
  }
  return [...representatives.values()].map((row) => ({
    id: row.id, runId: row.runId, workspaceId: row.workspaceId, tabId: row.tabId, paneId: row.paneId,
    agent: row.runtime, status: row.attentionReason ? "waiting" : row.state,
    heartbeatActive: row.heartbeatActive, title: row.title, summary: row.lastEntry?.text ?? "",
    createdAt: row.updatedAt,
  }));
}

export function sessionPriority(row: SessionRow): number {
  if (row.attentionReason || row.state === "waiting") return 0;
  if (["failed", "error", "timed_out", "interrupted"].includes(row.state)) return 1;
  if (row.state === "completed" && row.unread) return 2;
  if (row.state === "running") return 3;
  return 4;
}
