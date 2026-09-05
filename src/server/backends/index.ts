import type { PasteImageStager } from "../paste-image-staging.js";
import type { MachineConfig } from "../types.js";
import { shouldUseSessionAgent } from "../windows-agent.js";
import type { SessionBackend } from "./backend.js";
import type { BackendCapabilities } from "./backend.js";
import {
  DurableMultiplexerBackend,
  durableMultiplexerCapabilities,
} from "./durable-multiplexer.js";
import { RawPtyBackend, rawPtyCapabilities } from "./raw-pty.js";
import { SessionAgentBackend, SESSION_AGENT_CAPABILITIES } from "./session-agent-backend.js";

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
  options: { windowsAgentBasePort?: number } = {},
): SessionBackend => {
  const snapshot = structuredClone(machine);
  if (shouldUseSessionAgent(snapshot)) {
    return new SessionAgentBackend(snapshot, pasteImages, options.windowsAgentBasePort);
  }
  if (isDurableMultiplexerMachine(snapshot)) return new DurableMultiplexerBackend(snapshot, pasteImages);
  return new RawPtyBackend(snapshot, pasteImages);
};

export const sessionBackendKindForMachine = (machine: MachineConfig): SessionBackend["id"] =>
  shouldUseSessionAgent(machine)
    ? "windows-agent"
    : isDurableMultiplexerMachine(machine)
      ? "durable-multiplexer"
      : "raw-pty";

export const sessionBackendCapabilitiesForMachine = (machine: MachineConfig): BackendCapabilities =>
  shouldUseSessionAgent(machine)
    ? SESSION_AGENT_CAPABILITIES
    : isDurableMultiplexerMachine(machine)
      ? durableMultiplexerCapabilities(machine)
      : rawPtyCapabilities(machine);

export type {
  BackendCapabilities,
  BackendRuntimeFile,
  BackendSession,
  BackendSpawnSpec,
  SessionBackend,
} from "./backend.js";
