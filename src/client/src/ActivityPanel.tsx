import { useEffect, useMemo, useRef } from "react";
import { Clipboard, X } from "lucide-react";
import type { AgentActivity, BootstrapPayload, MachineStatus, TerminalRun } from "./types";

type ActivityItem =
  | { kind: "agent"; id: string; createdAt: string; event: AgentActivity }
  | { kind: "run"; id: string; createdAt: string; run: TerminalRun };

export function ActivityPanel({
  state,
  machines,
  onClose,
}: {
  state: BootstrapPayload;
  machines: MachineStatus[];
  onClose: () => void;
}) {
  const items = useMemo(() => buildActivityItems(state.agentEvents, state.runs).slice(0, 100), [state.agentEvents, state.runs]);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);

  return (
    <aside className="activity-panel" aria-label="Activity" role="dialog" aria-modal="true">
      <div className="activity-header">
        <h2>Activity</h2>
        <button ref={closeRef} title="Close activity" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="activity-list">
        {items.length ? (
          items.map((item) =>
            item.kind === "agent" ? (
              <AgentActivityRow key={item.id} event={item.event} state={state} machines={machines} />
            ) : (
              <RunActivityRow key={item.id} run={item.run} state={state} machines={machines} />
            ),
          )
        ) : (
          <div className="activity-empty">No activity yet</div>
        )}
      </div>
    </aside>
  );
}

function AgentActivityRow({
  event,
  state,
  machines,
}: {
  event: AgentActivity;
  state: BootstrapPayload;
  machines: MachineStatus[];
}) {
  const workspace = state.workspaces.find((candidate) => candidate.id === event.workspaceId);
  const machine = workspace ? machineFor(machines, workspace.machineId) : undefined;
  const title = event.title || workspace?.name || event.agent;
  const summary = compactWorkspaceDescription(event.summary, 160);
  return (
    <div className={`activity-row agent ${agentStatusClass(event.status)}`} title={event.summary || title}>
      <div className="activity-row-main">
        <span className="activity-kind">{event.agent}</span>
        <span className="activity-title">{title}</span>
        {summary ? <span className="activity-summary">{summary}</span> : null}
      </div>
      <div className="activity-row-meta">
        <span>{event.status}</span>
        <span>{workspace?.name ?? "workspace removed"}</span>
        <span>{machine?.name ?? workspace?.machineId ?? "host unknown"}</span>
        <span>{formatRelativeTime(event.createdAt)}</span>
      </div>
    </div>
  );
}

function RunActivityRow({
  run,
  state,
  machines,
}: {
  run: TerminalRun;
  state: BootstrapPayload;
  machines: MachineStatus[];
}) {
  const workspace = state.workspaces.find((candidate) => candidate.id === run.workspaceId);
  const tab = workspace?.tabs.find((candidate) => candidate.id === run.tabId);
  const machine = workspace ? machineFor(machines, workspace.machineId) : undefined;
  return (
    <div className={`activity-row run ${run.status}`} title={run.command}>
      <div className="activity-row-main">
        <span className="activity-kind">run</span>
        <span className="activity-title">{run.command}</span>
        <span className="activity-summary">
          {run.status === "started" ? "running" : `exit ${run.exitCode ?? "?"}`}
          {run.completedAt ? ` / ${formatDuration(run.startedAt, run.completedAt)}` : ""}
        </span>
      </div>
      <div className="activity-row-meta">
        <span>{workspace?.name ?? "workspace removed"}</span>
        <span>{tab?.title ?? "tab removed"}</span>
        <span>{machine?.name ?? workspace?.machineId ?? "host unknown"}</span>
        <span>{formatRelativeTime(run.completedAt ?? run.startedAt)}</span>
        <button
          title="Copy command"
          disabled={!navigator.clipboard}
          onClick={() => void navigator.clipboard?.writeText(run.command)}
        >
          <Clipboard size={13} />
        </button>
      </div>
    </div>
  );
}

export const buildActivityItems = (agentEvents: AgentActivity[], runs: TerminalRun[]): ActivityItem[] =>
  [
    ...agentEvents.map((event) => ({ kind: "agent" as const, id: `agent:${event.id}`, createdAt: event.createdAt, event })),
    ...runs.map((run) => ({ kind: "run" as const, id: `run:${run.id}`, createdAt: run.completedAt ?? run.startedAt, run })),
  ].sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));


const machineFor = (machines: MachineStatus[], machineId: string): MachineStatus | undefined =>
  machines.find((machine) => machine.id === machineId);

const compactWorkspaceDescription = (value: string | undefined, limit: number): string => {
  const compact = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!compact || compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
};

const agentStatusClass = (status: string): "running" | "waiting" | "completed" | "failed" | "stopped" | "updated" => {
  const normalized = status.toLowerCase();
  if (["started", "running", "working", "in_progress", "active"].includes(normalized)) return "running";
  if (["waiting", "needs_input", "input_required", "approval_required"].includes(normalized)) return "waiting";
  if (["completed", "complete", "succeeded", "success", "done"].includes(normalized)) return "completed";
  if (["failed", "error"].includes(normalized)) return "failed";
  if (["stopped", "cancelled", "canceled"].includes(normalized)) return "stopped";
  return "updated";
};

const formatRelativeTime = (iso: string): string => {
  const delta = Math.max(0, Date.now() - Date.parse(iso));
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const formatDuration = (startedAt: string, completedAt: string): string => {
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${Math.round(durationMs / 60_000)}m`;
};

