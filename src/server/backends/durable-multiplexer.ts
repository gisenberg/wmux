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
import { RawPtyBackend, rawPtyCapabilities } from "./raw-pty.js";
import { BackendObservation } from "../backend-observation.js";
import { PtySession } from "../pty-session.js";
import type { PasteImageStager, StagedPasteImage } from "../paste-image-staging.js";
import type { MachineConfig } from "../types.js";

export class DurableMultiplexerBackend extends RawPtyBackend {
  readonly id = "durable-multiplexer" as const;
  private observation?: BackendObservation;
  override get capabilities(): BackendCapabilities {
    const mode = this.observation?.mode;
    if (mode === "tmux" || mode === "screen") {
      return durableMultiplexerCapabilities({ ...this.machine, sessionBackend: mode });
    }
    // A configured preference is not proof that the target had a multiplexer.
    return rawPtyCapabilities(this.machine);
  }

  constructor(machine: MachineConfig, pasteImages: PasteImageStager) {
    super(machine, pasteImages);
  }

  override readReplay(
    session: BackendSession,
    outputOnly = false,
  ): ReturnType<RawPtyBackend["readReplay"]> {
    if (
      !outputOnly
      && this.capabilities.refreshClient
      && !session.restoredAttachReplay
    ) {
      return { data: "", kind: "raw" };
    }
    return super.readReplay(session, outputOnly);
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
  ): Promise<boolean> {
    if (options.kill === false) {
      if (session) this.detach(session);
      return true;
    }
    session?.kill();
    return disposeDurableSession(this.machine, paneId);
  }

  override readCwd(paneId: string): Promise<string | undefined> {
    return readDurableSessionCwd(this.machine, paneId);
  }

  override refreshClient(paneId: string): Promise<boolean> {
    return refreshDurableSessionClient(this.machine, paneId);
  }

  override spawn(spec: BackendSpawnSpec): BackendSession {
    this.observation = new BackendObservation();
    return new PtySession(spec.pane, this.machine, spec.cols, spec.rows,
      spec.env, spec.restoredCheckpoint, this.observation);
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
    persistentCheckpoint: true,
  };
};
