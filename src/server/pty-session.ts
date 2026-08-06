import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import type { MachineConfig, PaneStartupPhase, PaneState } from "./types.js";
import { buildSpawnSpec } from "./machines.js";
import { appendBoundedReplay } from "./replay-buffer.js";
import { captureOsc7 } from "./osc7.js";
import { selectAttachReplay, TerminalCheckpoint, type AttachReplay } from "./terminal-checkpoint.js";

interface PtyEvents {
  output: [string];
  title: [string];
  cwd: [string];
  agentPort: [number, string];
  phase: [PaneStartupPhase, string];
  exit: [number | null];
}

const MAX_REPLAY_BYTES = 2 * 1024 * 1024;

export class PtySession extends EventEmitter<PtyEvents> {
  private pty: IPty;
  private replay: string[] = [];
  private replayBytes = 0;
  private replayTruncated = false;
  private readonly checkpoint: TerminalCheckpoint;
  private replayRequiresCheckpoint = false;
  private exited = false;
  private title: string;
  private cwd = "";
  private cwdCaptureBuffer = "";
  private liveResetEmitted = false;
  private restoredReplayConsumed = false;

  constructor(
    readonly pane: PaneState,
    machine: MachineConfig,
    cols: number,
    rows: number,
    extraEnv: Record<string, string> = {},
    private readonly restoredCheckpoint?: AttachReplay,
  ) {
    super();
    const spec = buildSpawnSpec(machine, cols, rows, extraEnv);
    this.title = spec.title;
    this.checkpoint = new TerminalCheckpoint(cols, rows, extraEnv);
    const trackProcessTitle = spec.trackProcessTitle ?? true;
    this.pty = spawn(spec.file, spec.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: spec.cwd,
      env: spec.env,
    });

    this.pty.onData((data) => {
      this.checkpoint.write(data);
      this.appendReplay(data);
      this.captureCwd(data);
      this.emit(
        "output",
        this.restoredCheckpoint && !this.liveResetEmitted
          ? `\x1bc${data}`
          : data,
      );
      this.liveResetEmitted = true;
      if (!trackProcessTitle) return;
      const processTitle = this.pty.process?.trim();
      if (processTitle && processTitle !== this.title) {
        this.title = processTitle;
        this.emit("title", processTitle);
      }
    });

    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.emit("exit", exitCode);
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  get isExited(): boolean {
    return this.exited;
  }

  get replayOutput(): string {
    return this.replay.join("");
  }

  get attachReplay(): AttachReplay {
    const current = selectAttachReplay(
      this.replayOutput,
      this.replayTruncated,
      this.checkpoint,
      this.replayRequiresCheckpoint,
    );
    if (!this.restoredCheckpoint || this.restoredReplayConsumed) return current;
    if (!this.liveResetEmitted) return this.restoredCheckpoint;
    this.restoredReplayConsumed = true;
    return {
      data: this.restoredCheckpoint.data
        + (current.data ? `\x1bc${current.data}` : ""),
      kind: "checkpoint",
    };
  }

  get restoredAttachReplay(): AttachReplay | undefined {
    return this.restoredReplayConsumed
      ? undefined
      : this.restoredCheckpoint;
  }

  get screenCheckpoint(): AttachReplay | undefined {
    const data = this.checkpoint.snapshot();
    return data ? { data, kind: "checkpoint" } : undefined;
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || cols < 2 || rows < 1) return;
    try {
      const previousSize = this.checkpoint.dimensions;
      this.pty.resize(cols, rows);
      this.checkpoint.resize(cols, rows);
      if (previousSize && (previousSize.cols !== cols || previousSize.rows !== rows)) {
        // Raw VT history contains cursor movement and wrapping decisions made
        // at its original dimensions. Replaying it at the new size can paint
        // plausible cells while restoring the cursor to the wrong position.
        this.replayRequiresCheckpoint = true;
      }
    } catch {
      /* PTY already exited */
    }
  }

  kill(): void {
    if (this.exited) {
      this.checkpoint.dispose();
      return;
    }
    try {
      this.pty.kill();
    } catch {
      /* PTY already exited */
    } finally {
      this.checkpoint.dispose();
    }
  }

  pause(): void {
    if (this.exited) return;
    try {
      this.pty.pause();
    } catch {
      /* PTY already exited */
    }
  }

  resume(): void {
    if (this.exited) return;
    try {
      this.pty.resume();
    } catch {
      /* PTY already exited */
    }
  }

  private appendReplay(data: string): void {
    if (this.replayBytes + Buffer.byteLength(data) > MAX_REPLAY_BYTES) this.replayTruncated = true;
    this.replayBytes = appendBoundedReplay(this.replay, this.replayBytes, data, MAX_REPLAY_BYTES);
  }

  private captureCwd(data: string): void {
    const { cwds, pending } = captureOsc7(this.cwdCaptureBuffer, data);
    this.cwdCaptureBuffer = pending;
    for (const cwd of cwds) {
      if (cwd === this.cwd) continue;
      this.cwd = cwd;
      this.emit("cwd", cwd);
    }
  }
}

export const describeLocalCwd = (): string => path.basename(process.cwd()) || os.hostname();
