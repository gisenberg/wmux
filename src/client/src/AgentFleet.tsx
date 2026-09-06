import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type {
  BootstrapPayload,
  DelegationAttentionReason,
  MachineStatus,
} from "./types";
import { workspaceTabPath } from "./route-state";
import { buildSessionRows, type SessionRow } from "./session-inventory";
import { useConsoleDialog } from "./useConsoleDialog";

export type AgentFleetRow = SessionRow;
export const buildAgentFleetRows = buildSessionRows;

export function AgentFleet({
  state,
  machines,
  onClose,
  onOpenSession,
  docked = false,
  onToggleDock,
}: {
  state: BootstrapPayload;
  machines: MachineStatus[];
  onClose: () => void;
  onOpenSession: (row: AgentFleetRow) => void;
  docked?: boolean;
  onToggleDock?: () => void;
}) {
  const rows = useMemo(
    () => buildAgentFleetRows(state, machines),
    [machines, state],
  );
  const attentionCount = rows.filter((row) => row.attentionReason || row.state === "waiting").length;
  const activeCount = rows.filter(
    (row) => row.state === "running" || row.state === "waiting",
  ).length;
  const dialogRef = useConsoleDialog<HTMLElement>(onClose, !docked);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div
      className={docked ? "agent-fleet-dock" : "agent-fleet-backdrop"}
      onMouseDown={(event) => {
        if (!docked && event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="agent-fleet"
        role={docked ? "region" : "dialog"}
        aria-modal={docked ? undefined : "true"}
        aria-label="Agent fleet"
        data-event-revision={state.eventRevision}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onClose();
        }}
      >
        <header className="agent-fleet-header">
          <div>
            <span>// AGENT FLEET</span>
            <strong>{rows.length} SESSIONS</strong>
          </div>
          <div className="agent-fleet-summary">
            {onToggleDock ? <button type="button" onClick={onToggleDock}>{docked ? "[FLOAT]" : "[DOCK]"}</button> : null}
            <span>[RUN {activeCount}]</span>
            <span className={attentionCount > 0 ? "attention" : ""}>
              [WAIT {attentionCount}]
            </span>
            <button
              type="button"
              aria-label="Close agent fleet"
              title="Close agent fleet"
              onClick={onClose}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="agent-fleet-columns" aria-hidden="true">
          <span>STATE</span>
          <span>RUNTIME / SESSION</span>
          <span>HOST</span>
          <span>IN STATE</span>
        </div>
        <div className="agent-fleet-list" role="list">
          {rows.length > 0 ? rows.map((row) => (
            <a
              key={row.id}
              className={`agent-fleet-row ${row.attentionReason ? "attention" : ""}`}
              href={row.available ? workspaceTabPath(row.workspaceId, row.tabId) : undefined}
              aria-disabled={!row.available}
              role="listitem"
              data-agent-run-id={row.id}
              data-agent-state={row.state}
              data-agent-machine={row.machineId}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                if (row.available) onOpenSession(row);
              }}
            >
              <span className="agent-fleet-state">
                {fleetStateToken(row)}
              </span>
              <span className="agent-fleet-identity">
                <strong>{row.runtime}</strong>
                <span>{row.title}</span>
                <small>{row.workspaceName} / {row.source.toUpperCase()}</small>
              </span>
              <span className="agent-fleet-machine">
                {row.machineName} {!row.reachable ? "[OFFLINE]" : ""}
              </span>
              <span className="agent-fleet-elapsed">
                {formatFleetElapsed(row.stateChangedAt, nowMs)}
              </span>
              <span className="agent-fleet-entry">
                {compactFleetText(
                  row.lastEntry?.text
                    || (row.attentionReason
                      ? attentionLabel(row.attentionReason)
                      : row.state),
                )}
              </span>
            </a>
          )) : (
            <div className="agent-fleet-empty">
              [IDLE] No sessions. Create a workspace to begin.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const fleetStateToken = (row: AgentFleetRow): string => {
  if (row.attentionReason) {
    return `[${row.attentionReason.toUpperCase()}]`;
  }
  return `[${row.state.toUpperCase()}]`;
};

const attentionLabel = (reason: DelegationAttentionReason): string => ({
  approval: "Waiting for approval",
  login: "Waiting for login",
  blocked: "Blocked outcome",
  input: "Waiting for input",
})[reason];

export const formatFleetElapsed = (
  updatedAt: string,
  nowMs = Date.now(),
): string => {
  const elapsedMs = Math.max(0, nowMs - Date.parse(updatedAt));
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const compactFleetText = (value: string, limit = 240): string => {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 1).trimEnd()}…`;
};
