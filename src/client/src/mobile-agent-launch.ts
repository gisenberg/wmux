import type { MachineKind } from "./types";

export type MobileAgentLauncher = "codex" | "claude";

const agentArguments: Record<MobileAgentLauncher, string> = {
  codex: "--dangerously-bypass-approvals-and-sandbox",
  claude: "--dangerously-skip-permissions",
};

export const mobileAgentLaunchCommand = (agent: MobileAgentLauncher, machineKind?: MachineKind): string => {
  const args = agentArguments[agent];
  if (machineKind !== "powershell" && machineKind !== "powershell-ssh") {
    return `${agent} ${args}`;
  }

  // npm exposes both tools through .cmd shims on Windows. Prefer those so a
  // restrictive PowerShell execution policy cannot select and reject the .ps1
  // shim, while retaining support for native installs.
  return `if (Get-Command ${agent}.cmd -ErrorAction SilentlyContinue) { ${agent}.cmd ${args} } else { ${agent} ${args} }`;
};
