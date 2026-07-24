import type { AttachReplay } from "../terminal-checkpoint.js";
import type { MachineConfig, PaneStartupPhase, PaneState } from "../types.js";
import type { StagedPasteImage } from "../paste-image-staging.js";

export interface BackendSession {
  readonly pane: PaneState;
  readonly pid: number;
  readonly isExited: boolean;
  readonly replayOutput: string;
  readonly attachReady?: Promise<void>;
  readonly attachReplay?: AttachReplay;
  write(data: string): void;
  writeTerminalResponse?(data: string): void;
  resize(cols: number, rows: number): void;
  detach?(): void;
  kill(): void;
  pause(): void;
  resume(): void;
  on(event: "output" | "title" | "cwd", listener: (data: string) => void): this;
  on(event: "agentPort", listener: (port: number) => void): this;
  on(event: "phase", listener: (phase: PaneStartupPhase, label: string) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
}

export interface BackendCapabilities {
  readonly transport: "pty" | "local-multiplexer" | "ssh-multiplexer" | "windows-agent";
  readonly restartDurable: boolean;
  readonly supportsFileStaging: boolean;
  readonly supportsCwdReport: boolean;
  readonly replay: boolean;
  readonly resize: boolean;
  readonly cwd: "osc7" | "multiplexer" | "agent";
  readonly agentOwned: boolean;
  readonly refreshClient: boolean;
}

export interface BackendSpawnSpec {
  pane: PaneState;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface StageFileMetadata {
  inputEpoch: number;
}

/**
 * The behavior shared by every pane transport.
 *
 * A backend is bound to one immutable machine snapshot. SessionManager keeps
 * that backend beside the pane session so later configuration or dynamic-host
 * changes cannot redirect lifecycle operations.
 */
export interface SessionBackend {
  readonly id: "raw-pty" | "durable-multiplexer" | "windows-agent";
  readonly machine: MachineConfig;
  readonly capabilities: BackendCapabilities;
  spawn(spec: BackendSpawnSpec): BackendSession;
  attach(session: BackendSession): Promise<void> | void;
  write(session: BackendSession, data: string, terminalResponse?: boolean): void;
  resize(session: BackendSession, cols: number, rows: number): void;
  readReplay(session: BackendSession, outputOnly?: boolean): AttachReplay;
  checkpoint(session: BackendSession): AttachReplay | undefined;
  stageFile(paneId: string, data: Buffer, metadata: StageFileMetadata): Promise<StagedPasteImage>;
  detach(session: BackendSession): void;
  dispose(paneId: string, session?: BackendSession, options?: { kill?: boolean }): Promise<void>;
  readCwd(paneId: string): Promise<string | undefined>;
  refreshClient(paneId: string): Promise<boolean>;
}
