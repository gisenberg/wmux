import type { WorkspaceAgentStatus } from "./workspace-tree";

export const SIDEBAR_AGENT_RUNNING_FRAMES = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
] as const;

export const SIDEBAR_AGENT_HEARTBEAT_FRAMES = ["·", "♡", "♥", "♡"] as const;

export interface SidebarAgentStatusPresentation {
  label: string;
  marker: string;
}

const labels: Record<WorkspaceAgentStatus, string> = {
  running: "working",
  heartbeat: "heartbeat",
  waiting: "waiting",
  completed: "done",
  failed: "failed",
  updated: "updated",
};

export const sidebarAgentStatusPresentation = (
  status: WorkspaceAgentStatus | undefined,
  reachable: boolean,
  animationTick: number,
): SidebarAgentStatusPresentation => {
  if (status === "running") {
    return {
      label: labels.running,
      marker: SIDEBAR_AGENT_RUNNING_FRAMES[
        animationTick % SIDEBAR_AGENT_RUNNING_FRAMES.length
      ],
    };
  }
  if (status === "heartbeat") {
    return {
      label: labels.heartbeat,
      marker: SIDEBAR_AGENT_HEARTBEAT_FRAMES[
        animationTick % SIDEBAR_AGENT_HEARTBEAT_FRAMES.length
      ],
    };
  }
  if (status === "waiting") return { label: labels.waiting, marker: "?" };
  if (status === "completed") return { label: labels.completed, marker: "✓" };
  if (status === "failed") return { label: labels.failed, marker: "×" };
  return {
    label: status ? labels[status] : reachable ? "online" : "offline",
    marker: reachable ? "●" : "○",
  };
};

export const sidebarWorkspaceAgentContext = (
  activePaneCount: number,
  heartbeatPaneCount: number,
  agentPaneCount: number,
  paneCount: number,
): string => {
  const total = Math.max(paneCount, activePaneCount, heartbeatPaneCount, agentPaneCount);
  const paneWord = total === 1 ? "pane" : "panes";
  if (activePaneCount > 0) return `${activePaneCount}/${total} ${paneWord} active`;
  if (heartbeatPaneCount > 0) return `${heartbeatPaneCount}/${total} ${paneWord} scheduled`;
  if (agentPaneCount > 1) return `${agentPaneCount} pane results`;
  return "";
};
