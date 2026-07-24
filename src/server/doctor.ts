import type { DurableSessionAudit } from "./session-audit.js";
import {
  sessionBackendCapabilitiesForMachine,
  sessionBackendKindForMachine,
} from "./backends/index.js";
import type { DoctorReport, MachineConfig, MachineStatus, PersistedState } from "./types.js";

export const buildDoctorReport = (
  state: PersistedState,
  machines: MachineConfig[],
  statuses: MachineStatus[],
  audit: DurableSessionAudit,
): DoctorReport => {
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const missingPaneIds = new Set(audit.missing.map((row) => row.paneId));
  const duplicatePaneIds = new Set(
    audit.sessions.filter((row) => row.status === "duplicate").map((row) => row.paneId),
  );
  const panes = state.workspaces.flatMap((workspace) =>
    workspace.tabs.flatMap((tab) =>
      tab.panes.map((pane) => {
        const machine = machineById.get(pane.machineId);
        const machineStatus = statusById.get(pane.machineId);
        if (!machine) {
          return {
            paneId: pane.id,
            title: pane.title,
            machineId: pane.machineId,
            machineName: pane.machineId,
            status: pane.status,
            exitCode: pane.exitCode,
            driver: "pty" as const,
            transport: "pty" as const,
            restartDurable: false,
            replay: false,
            cwd: "osc7" as const,
            machineReachable: false,
            issue: "machine configuration missing",
          };
        }
        const backendKind = sessionBackendKindForMachine(machine);
        const capabilities = sessionBackendCapabilitiesForMachine(machine);
        const issue = pane.status === "exited"
          ? `process exited${pane.exitCode === undefined ? "" : ` with code ${pane.exitCode}`}`
          : missingPaneIds.has(pane.id)
            ? "durable session missing"
            : duplicatePaneIds.has(pane.id)
              ? "duplicate durable session"
              : machineStatus && !machineStatus.reachable
                ? machineStatus.reason ?? "machine unreachable"
                : undefined;
        return {
          paneId: pane.id,
          title: pane.title,
          machineId: pane.machineId,
          machineName: machineStatus?.name ?? machine.name,
          status: pane.status,
          exitCode: pane.exitCode,
          driver: (backendKind === "windows-agent" ? "windows-agent" : "pty") as "windows-agent" | "pty",
          transport: capabilities.transport,
          restartDurable: capabilities.restartDurable,
          replay: capabilities.replay,
          cwd: capabilities.cwd,
          machineReachable: machineStatus?.reachable ?? false,
          issue,
        };
      }),
    ),
  );
  const unreachableMachineCount = statuses.filter((status) => !status.reachable).length;
  return {
    checkedAt: new Date().toISOString(),
    summary: {
      paneCount: panes.length,
      restartDurablePaneCount: panes.filter((pane) => pane.restartDurable).length,
      exitedPaneCount: panes.filter((pane) => pane.status === "exited").length,
      unreachableMachineCount,
      sessionIssueCount: audit.summary.orphanCount + audit.summary.duplicateCount + audit.summary.missingCount,
    },
    panes,
  };
};
