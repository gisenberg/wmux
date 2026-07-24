import {
  canRefreshDurableSessionClient,
  disposeDurableSession,
  readDurableSessionCwd,
  refreshDurableSessionClient,
} from "../durable-session.js";
import type {
  BackendCapabilities,
  BackendSession,
  BackendSpawnSpec,
  StageFileMetadata,
} from "./backend.js";
import { RawPtyBackend } from "./raw-pty.js";
import type { PasteImageStager, StagedPasteImage } from "../paste-image-staging.js";
import type { MachineConfig } from "../types.js";

export class DurableMultiplexerBackend extends RawPtyBackend {
  readonly id = "durable-multiplexer" as const;
  readonly capabilities: BackendCapabilities;

  constructor(machine: MachineConfig, pasteImages: PasteImageStager) {
    super(machine, pasteImages);
    this.capabilities = durableMultiplexerCapabilities(machine);
  }

  override readReplay(
    session: BackendSession,
    outputOnly = false,
  ): ReturnType<RawPtyBackend["readReplay"]> {
    if (!outputOnly && this.capabilities.refreshClient) return { data: "", kind: "raw" };
    return super.readReplay(session);
  }

  override async stageFile(
    paneId: string,
    data: Buffer,
    _metadata: StageFileMetadata,
  ): Promise<StagedPasteImage> {
    return this.pasteImages.stage(paneId, structuredClone(this.machine), data);
  }

  override async dispose(
    paneId: string,
    session?: BackendSession,
    options: { kill?: boolean } = {},
  ): Promise<void> {
    if (options.kill !== false) session?.kill();
    await disposeDurableSession(this.machine, paneId);
  }

  override readCwd(paneId: string): Promise<string | undefined> {
    return readDurableSessionCwd(this.machine, paneId);
  }

  override refreshClient(paneId: string): Promise<boolean> {
    return refreshDurableSessionClient(this.machine, paneId);
  }

  override spawn(spec: BackendSpawnSpec): BackendSession {
    return super.spawn(spec);
  }
}

export const durableMultiplexerCapabilities = (machine: MachineConfig): BackendCapabilities => {
  const backend = machine.sessionBackend ?? "auto";
  return {
    transport: machine.kind === "ssh" ? "ssh-multiplexer" : "local-multiplexer",
    restartDurable: true,
    supportsFileStaging: true,
    supportsCwdReport: backend !== "screen",
    replay: true,
    resize: true,
    cwd: backend === "screen" ? "osc7" : "multiplexer",
    agentOwned: false,
    refreshClient: canRefreshDurableSessionClient(machine),
  };
};
