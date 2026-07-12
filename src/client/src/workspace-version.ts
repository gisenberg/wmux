import type { MachineStatus, MachineVersionStatus, Workspace } from "./types";

export interface WorkspaceVersionSummary {
  status: MachineVersionStatus;
  label: string;
  detail: string;
}

const statusRank: Record<MachineVersionStatus, number> = {
  current: 0,
  unknown: 1,
  outdated: 2,
};

const compactVersion = (version: string | undefined): string => {
  if (!version) return "?";
  return /^[0-9a-f]{12,}$/i.test(version) ? version.slice(0, 8) : version;
};

const displayVersion = (version: string | undefined): string => {
  const compact = compactVersion(version);
  return compact === "?" || /^v/i.test(compact) ? compact : `v${compact}`;
};

const machineVersionDetail = (machine: MachineStatus): string => {
  const actual = compactVersion(machine.runtimeVersion);
  const expected = compactVersion(machine.expectedRuntimeVersion);
  const runtime = machine.expectedRuntimeVersion && machine.runtimeVersion !== machine.expectedRuntimeVersion
    ? `runtime ${actual}, expected ${expected}`
    : `runtime ${actual}`;
  const helpers = machine.expectedHelperBundleVersion
    ? machine.helperBundleVersion
      ? machine.helperBundleVersion === machine.expectedHelperBundleVersion
        ? `helpers ${compactVersion(machine.helperBundleVersion)}`
        : `helpers ${compactVersion(machine.helperBundleVersion)}, expected ${compactVersion(machine.expectedHelperBundleVersion)}`
      : "helpers not reported"
    : "";
  return `${machine.name}: ${[runtime, helpers].filter(Boolean).join("; ")}`;
};

export const summarizeWorkspaceVersion = (
  workspace: Workspace,
  machines: MachineStatus[],
): WorkspaceVersionSummary | undefined => {
  const machineIds = new Set<string>([workspace.machineId]);
  for (const tab of workspace.tabs) {
    for (const pane of tab.panes) machineIds.add(pane.machineId);
  }
  const versionedMachines = [...machineIds]
    .map((machineId) => machines.find((machine) => machine.id === machineId))
    .filter((machine): machine is MachineStatus => Boolean(machine?.versionStatus));
  if (!versionedMachines.length) return undefined;

  const status = versionedMachines.reduce<MachineVersionStatus>(
    (result, machine) => statusRank[machine.versionStatus ?? "unknown"] > statusRank[result]
      ? machine.versionStatus ?? "unknown"
      : result,
    "current",
  );
  const marker = status === "current" ? "✓" : status === "outdated" ? "↑" : "?";
  const label = versionedMachines.length === 1
    ? `${marker} ${displayVersion(versionedMachines[0].runtimeVersion)}`
    : `${marker} ${versionedMachines.length}H`;
  const statusLabel = status === "current" ? "Up to date" : status === "outdated" ? "Update available" : "Version unknown";
  return {
    status,
    label,
    detail: `${statusLabel}. ${versionedMachines.map(machineVersionDetail).join(" / ")}`,
  };
};
