import type { PasteImageStager } from "../paste-image-staging.js";
import type { MachineConfig } from "../types.js";
import { shouldUseWindowsAgent } from "../windows-agent.js";
import type { SessionBackend } from "./backend.js";
import type { BackendCapabilities } from "./backend.js";
import {
  DurableMultiplexerBackend,
  durableMultiplexerCapabilities,
} from "./durable-multiplexer.js";
import { RawPtyBackend, rawPtyCapabilities } from "./raw-pty.js";
import { WindowsAgentBackend, WINDOWS_AGENT_CAPABILITIES } from "./windows-agent-backend.js";

export const isDurableMultiplexerMachine = (machine: MachineConfig): boolean => {
  const backend = machine.sessionBackend ?? "auto";
  return (
    !machine.command?.length
    && (machine.kind === "local" || machine.kind === "ssh")
    && (backend === "auto" || backend === "tmux" || backend === "screen")
  );
};

export const createSessionBackend = (
  machine: MachineConfig,
  pasteImages: PasteImageStager,
): SessionBackend => {
  const snapshot = structuredClone(machine);
  if (shouldUseWindowsAgent(snapshot)) return new WindowsAgentBackend(snapshot, pasteImages);
  if (isDurableMultiplexerMachine(snapshot)) return new DurableMultiplexerBackend(snapshot, pasteImages);
  return new RawPtyBackend(snapshot, pasteImages);
};

export const sessionBackendKindForMachine = (machine: MachineConfig): SessionBackend["id"] =>
  shouldUseWindowsAgent(machine)
    ? "windows-agent"
    : isDurableMultiplexerMachine(machine)
      ? "durable-multiplexer"
      : "raw-pty";

export const sessionBackendCapabilitiesForMachine = (machine: MachineConfig): BackendCapabilities =>
  shouldUseWindowsAgent(machine)
    ? WINDOWS_AGENT_CAPABILITIES
    : isDurableMultiplexerMachine(machine)
      ? durableMultiplexerCapabilities(machine)
      : rawPtyCapabilities(machine);

export type {
  BackendCapabilities,
  BackendSession,
  BackendSpawnSpec,
  SessionBackend,
} from "./backend.js";
