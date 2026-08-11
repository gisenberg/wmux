import type { WorkspaceAgentStatus } from "./workspace-tree";

export const SIDEBAR_AGENT_RUNNING_FRAMES = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
] as const;

export interface SidebarAgentStatusPresentation {
  label: string;
  marker: string;
}

const labels: Record<WorkspaceAgentStatus, string> = {
  running: "working",
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
  if (status === "waiting") return { label: labels.waiting, marker: "?" };
  if (status === "completed") return { label: labels.completed, marker: "✓" };
  if (status === "failed") return { label: labels.failed, marker: "×" };
  return {
    label: status ? labels[status] : reachable ? "online" : "offline",
    marker: reachable ? "●" : "○",
  };
};
