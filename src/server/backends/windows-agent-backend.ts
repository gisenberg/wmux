import {
  deleteWindowsAgentSession,
  WindowsAgentSession,
} from "../windows-agent.js";
import type {
  BackendCapabilities,
  BackendSession,
  BackendSpawnSpec,
  SessionBackend,
  StageFileMetadata,
} from "./backend.js";
import type { MachineConfig } from "../types.js";
import type { PasteImageStager, StagedPasteImage } from "../paste-image-staging.js";

export const WINDOWS_AGENT_CAPABILITIES: BackendCapabilities = {
  transport: "windows-agent",
  restartDurable: true,
  supportsFileStaging: true,
  supportsCwdReport: true,
  replay: true,
  resize: true,
  cwd: "agent",
  agentOwned: true,
  refreshClient: false,
  persistentCheckpoint: true,
};

export class WindowsAgentBackend implements SessionBackend {
  readonly id = "windows-agent" as const;
  readonly capabilities = WINDOWS_AGENT_CAPABILITIES;

  constructor(
    readonly machine: MachineConfig,
    private readonly pasteImages: PasteImageStager,
    private readonly baseAgentPort?: number,
  ) {}

  spawn(spec: BackendSpawnSpec): BackendSession {
    return new WindowsAgentSession(
      spec.pane,
      this.machine,
      spec.cols,
      spec.rows,
      spec.env,
      undefined,
      undefined,
      spec.restoredCheckpoint,
      this.baseAgentPort,
    );
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
    if (outputOnly) return { data: session.replayOutput, kind: "raw" };
    return session.attachReplay ?? { data: session.replayOutput, kind: "raw" };
  }

  checkpoint(session: BackendSession): ReturnType<SessionBackend["checkpoint"]> {
    return session.screenCheckpoint ?? session.attachReplay;
  }

  stageFile(paneId: string, data: Buffer, _metadata: StageFileMetadata): Promise<StagedPasteImage> {
    return this.pasteImages.stage(paneId, structuredClone(this.machine), data);
  }

  detach(session: BackendSession): void {
    session.detach?.();
  }

  async dispose(
    paneId: string,
    session?: BackendSession,
    options: { kill?: boolean } = {},
  ): Promise<boolean> {
    if (session && options.kill !== false) {
      if (session instanceof WindowsAgentSession) return session.disposeRemote();
      session.kill();
      return deleteWindowsAgentSession(this.machine, paneId);
    }
    if (!session && options.kill !== false) {
      return deleteWindowsAgentSession(this.machine, paneId);
    }
    return true;
  }

  async readCwd(): Promise<string | undefined> {
    return undefined;
  }

  async refreshClient(): Promise<boolean> {
    return false;
  }
}
