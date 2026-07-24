import { PtySession } from "../pty-session.js";
import {
  PasteImageStageError,
  type PasteImageStager,
  type StagedPasteImage,
} from "../paste-image-staging.js";
import type {
  BackendCapabilities,
  BackendSession,
  BackendSpawnSpec,
  SessionBackend,
  StageFileMetadata,
} from "./backend.js";
import type { MachineConfig } from "../types.js";

export const rawPtyCapabilities = (machine: MachineConfig): BackendCapabilities => ({
  transport: "pty",
  restartDurable: false,
  supportsFileStaging:
    !machine.command?.length
    && (machine.kind === "local" || machine.kind === "ssh" || machine.kind === "powershell-ssh"),
  supportsCwdReport: true,
  replay: true,
  resize: true,
  cwd: "osc7",
  agentOwned: false,
  refreshClient: false,
});

export class RawPtyBackend implements SessionBackend {
  readonly id: SessionBackend["id"] = "raw-pty";
  readonly capabilities: BackendCapabilities;

  constructor(
    readonly machine: MachineConfig,
    protected readonly pasteImages: PasteImageStager,
  ) {
    this.capabilities = rawPtyCapabilities(machine);
  }

  spawn(spec: BackendSpawnSpec): BackendSession {
    return new PtySession(spec.pane, this.machine, spec.cols, spec.rows, spec.env);
  }

  attach(session: BackendSession): Promise<void> | void {
    return session.attachReady;
  }

  write(session: BackendSession, data: string, terminalResponse = false): void {
    if (terminalResponse && session.writeTerminalResponse) session.writeTerminalResponse(data);
    else session.write(data);
  }

  resize(session: BackendSession, cols: number, rows: number): void {
    session.resize(cols, rows);
  }

  readReplay(session: BackendSession, outputOnly = false): ReturnType<SessionBackend["readReplay"]> {
    if (!outputOnly && session.attachReplay) return session.attachReplay;
    return { data: session.replayOutput, kind: "raw" };
  }

  checkpoint(session: BackendSession): ReturnType<SessionBackend["checkpoint"]> {
    return session.attachReplay;
  }

  async stageFile(paneId: string, data: Buffer, _metadata: StageFileMetadata): Promise<StagedPasteImage> {
    if (!this.capabilities.supportsFileStaging) {
      throw new PasteImageStageError(409, "paste_image_backend_unsupported");
    }
    return this.pasteImages.stage(paneId, structuredClone(this.machine), data);
  }

  detach(session: BackendSession): void {
    if (session.detach) session.detach();
    else session.kill();
  }

  async dispose(_paneId: string, session?: BackendSession, options: { kill?: boolean } = {}): Promise<void> {
    if (options.kill !== false) session?.kill();
  }

  async readCwd(_paneId: string): Promise<string | undefined> {
    return undefined;
  }

  async refreshClient(_paneId: string): Promise<boolean> {
    return false;
  }
}
