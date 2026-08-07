import type { MachineKind } from "./types";

export type MobileAgentLauncher = "codex" | "claude" | "prime-agent";

const agentArguments: Record<MobileAgentLauncher, string> = {
  codex: "--dangerously-bypass-approvals-and-sandbox",
  claude: "--dangerously-skip-permissions",
  "prime-agent": "",
};

export const mobileAgentLaunchCommand = (agent: MobileAgentLauncher, machineKind?: MachineKind): string => {
  const args = agentArguments[agent];
  if (machineKind !== "powershell" && machineKind !== "powershell-ssh") {
    return [agent, args].filter(Boolean).join(" ");
  }

  // npm exposes both tools through .cmd shims on Windows. Prefer those so a
  // restrictive PowerShell execution policy cannot select and reject the .ps1
  // shim, while retaining support for native installs.
  const command = [agent, args].filter(Boolean).join(" ");
  const cmdCommand = [`${agent}.cmd`, args].filter(Boolean).join(" ");
  return `if (Get-Command ${agent}.cmd -ErrorAction SilentlyContinue) { ${cmdCommand} } else { ${command} }`;
};
