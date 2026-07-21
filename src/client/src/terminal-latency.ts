export type TerminalLatencyInputKind = "printable" | "backspace" | "control" | "multi";
export type TerminalLatencyScreen = "normal" | "alternate";

interface PendingTerminalLatencySample {
  key: string;
  paneId: string;
  sequence: number;
  kind: TerminalLatencyInputKind;
  screen: TerminalLatencyScreen;
  inputAt: number;
  handledAt: number;
  predictionMutationAt?: number;
  predictionPaintAt?: number;
  outputAt?: number;
  writeAt?: number;
  outputChars: number;
}

export interface TerminalLatencySample {
  paneId: string;
  sequence: number;
  kind: TerminalLatencyInputKind;
  screen: TerminalLatencyScreen;
  inputDispatchMs: number;
  predictionMutationMs?: number;
  predictionPaintMs?: number;
  outputMs: number;
  authoritativeRenderMs: number;
  outputToRenderMs: number;
  writeToRenderMs: number;
  outputChars: number;
}

export interface TerminalLatencyDistribution {
  samples: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface TerminalLatencySnapshot {
  sampleCount: number;
  pendingCount: number;
  droppedCount: number;
  updatedAt: number;
  metrics: {
    inputDispatch: TerminalLatencyDistribution;
    predictedPaint: TerminalLatencyDistribution;
    predictedBackspacePaint: TerminalLatencyDistribution;
    normalPredictedPaint: TerminalLatencyDistribution;
    normalPredictedBackspacePaint: TerminalLatencyDistribution;
    normalOutput: TerminalLatencyDistribution;
    normalRender: TerminalLatencyDistribution;
    normalBackspaceRender: TerminalLatencyDistribution;
    normalOutputToRender: TerminalLatencyDistribution;
    alternatePredictedPaint: TerminalLatencyDistribution;
    alternatePredictedBackspacePaint: TerminalLatencyDistribution;
    alternateOutput: TerminalLatencyDistribution;
    alternateRender: TerminalLatencyDistribution;
    alternateBackspaceRender: TerminalLatencyDistribution;
    alternateOutputToRender: TerminalLatencyDistribution;
    normalOutputChars: TerminalLatencyDistribution;
    alternateOutputChars: TerminalLatencyDistribution;
  };
}

const MAX_SAMPLES = 512;
const MAX_PENDING_AGE_MS = 10_000;

const emptyDistribution = (): TerminalLatencyDistribution => ({ samples: 0, p50: null, p95: null, p99: null });

const percentile = (sorted: readonly number[], value: number): number | null => {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? null;
};

const distribution = (values: readonly number[]): TerminalLatencyDistribution => {
  if (values.length === 0) return emptyDistribution();
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
};

const finiteDelta = (end: number, start: number): number => Math.max(0, end - start);

export const classifyTerminalLatencyInput = (data: string): TerminalLatencyInputKind => {
  if (data === "\b" || data === "\x7f") return "backspace";
  if (data.length === 1 && data >= " " && data <= "~") return "printable";
  if (data.length === 1) return "control";
  return "multi";
};

export const normalizeDomEventTimestamp = (timestamp: number, now: number, timeOrigin: number): number => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return now;
  const relative = timestamp > timeOrigin ? timestamp - timeOrigin : timestamp;
  return Math.abs(relative - now) <= 60_000 ? relative : now;
};

export class TerminalLatencyRecorder {
  private readonly pending = new Map<string, PendingTerminalLatencySample>();
  private readonly samples: TerminalLatencySample[] = [];
  private readonly completedByKey = new Map<string, TerminalLatencySample>();
  private readonly completedInputAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private droppedCount = 0;
  private snapshot: TerminalLatencySnapshot = this.buildSnapshot(0);
  private publishScheduled = false;
  private pendingUpdatedAt = 0;

  constructor(
    private readonly maxSamples = MAX_SAMPLES,
    private readonly schedulePublish: (callback: () => void) => void = (callback) => callback(),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TerminalLatencySnapshot => this.snapshot;

  recordInput(
    paneId: string,
    sequence: number,
    kind: TerminalLatencyInputKind,
    screen: TerminalLatencyScreen,
    inputAt: number,
    handledAt: number,
  ): void {
    this.expirePending(handledAt);
    const key = this.key(paneId, sequence);
    this.pending.set(key, {
      key,
      paneId,
      sequence,
      kind,
      screen,
      inputAt,
      handledAt,
      outputChars: 0,
    });
    this.publish(handledAt);
  }

  recordPredictionMutation(paneId: string, sequence: number, at: number): void {
    const pending = this.pending.get(this.key(paneId, sequence));
    if (pending && pending.predictionMutationAt === undefined) pending.predictionMutationAt = at;
  }

  recordPredictionPaint(paneId: string, sequence: number, at: number): void {
    const key = this.key(paneId, sequence);
    const pending = this.pending.get(key);
    if (pending) pending.predictionPaintAt ??= at;
    const completed = this.completedByKey.get(key);
    if (completed && completed.predictionPaintMs === undefined) {
      const inputAt = this.completedInputAt.get(key);
      if (inputAt !== undefined) {
        completed.predictionPaintMs = finiteDelta(at, inputAt);
        this.completedInputAt.delete(key);
        this.publish(at);
      }
    }
  }

  recordOutput(paneId: string, sequence: number | undefined, outputChars: number, at: number): void {
    if (sequence === undefined) return;
    this.expirePending(at);
    for (const pending of this.pending.values()) {
      if (pending.paneId !== paneId || pending.sequence > sequence) continue;
      pending.outputAt ??= at;
      pending.outputChars += Math.max(0, outputChars);
    }
  }

  recordWrite(paneId: string, at: number): void {
    for (const pending of this.pending.values()) {
      if (pending.paneId === paneId && pending.outputAt !== undefined) pending.writeAt ??= at;
    }
  }

  recordRender(paneId: string, at: number): void {
    const completed: PendingTerminalLatencySample[] = [];
    for (const pending of this.pending.values()) {
      if (pending.paneId === paneId && pending.outputAt !== undefined && pending.writeAt !== undefined) completed.push(pending);
    }
    if (completed.length === 0) return;
    for (const pending of completed) {
      const outputAt = pending.outputAt;
      const writeAt = pending.writeAt;
      if (outputAt === undefined || writeAt === undefined) continue;
      this.pending.delete(pending.key);
      const sample: TerminalLatencySample = {
        paneId: pending.paneId,
        sequence: pending.sequence,
        kind: pending.kind,
        screen: pending.screen,
        inputDispatchMs: finiteDelta(pending.handledAt, pending.inputAt),
        ...(pending.predictionMutationAt === undefined
          ? {}
          : { predictionMutationMs: finiteDelta(pending.predictionMutationAt, pending.inputAt) }),
        ...(pending.predictionPaintAt === undefined
          ? {}
          : { predictionPaintMs: finiteDelta(pending.predictionPaintAt, pending.inputAt) }),
        outputMs: finiteDelta(outputAt, pending.inputAt),
        authoritativeRenderMs: finiteDelta(at, pending.inputAt),
        outputToRenderMs: finiteDelta(at, outputAt),
        writeToRenderMs: finiteDelta(at, writeAt),
        outputChars: pending.outputChars,
      };
      this.samples.push(sample);
      this.completedByKey.set(pending.key, sample);
      if (pending.predictionPaintAt === undefined && pending.predictionMutationAt !== undefined) {
        this.completedInputAt.set(pending.key, pending.inputAt);
      }
    }
    while (this.samples.length > this.maxSamples) {
      const removed = this.samples.shift();
      if (removed) {
        const key = this.key(removed.paneId, removed.sequence);
        this.completedByKey.delete(key);
        this.completedInputAt.delete(key);
      }
    }
    this.publish(at);
  }

  abandonPane(paneId: string, at: number): void {
    for (const [key, pending] of this.pending) {
      if (pending.paneId !== paneId) continue;
      this.pending.delete(key);
      this.droppedCount += 1;
    }
    this.publish(at);
  }

  clear(at: number): void {
    this.pending.clear();
    this.samples.length = 0;
    this.completedByKey.clear();
    this.completedInputAt.clear();
    this.droppedCount = 0;
    this.publish(at);
  }

  private key(paneId: string, sequence: number): string {
    return `${paneId}:${sequence}`;
  }

  private expirePending(now: number): void {
    for (const [key, pending] of this.pending) {
      if (now - pending.handledAt <= MAX_PENDING_AGE_MS) continue;
      this.pending.delete(key);
      this.droppedCount += 1;
    }
  }

  private publish(at: number): void {
    this.pendingUpdatedAt = Math.max(this.pendingUpdatedAt, at);
    if (this.publishScheduled) return;
    this.publishScheduled = true;
    this.schedulePublish(() => {
      this.publishScheduled = false;
      const updatedAt = this.pendingUpdatedAt;
      this.pendingUpdatedAt = 0;
      this.snapshot = this.buildSnapshot(updatedAt);
      for (const listener of this.listeners) listener();
    });
  }

  private buildSnapshot(updatedAt: number): TerminalLatencySnapshot {
    const normal = this.samples.filter((sample) => sample.screen === "normal");
    const alternate = this.samples.filter((sample) => sample.screen === "alternate");
    const normalBackspace = normal.filter((sample) => sample.kind === "backspace");
    const alternateBackspace = alternate.filter((sample) => sample.kind === "backspace");
    const predicted = (samples: readonly TerminalLatencySample[]): number[] => samples.flatMap((sample) =>
      sample.predictionPaintMs === undefined ? [] : [sample.predictionPaintMs]);
    const predictedBackspace = (samples: readonly TerminalLatencySample[]): number[] => samples.flatMap((sample) =>
      sample.kind === "backspace" && sample.predictionPaintMs !== undefined ? [sample.predictionPaintMs] : []);
    return {
      sampleCount: this.samples.length,
      pendingCount: this.pending.size,
      droppedCount: this.droppedCount,
      updatedAt,
      metrics: {
        inputDispatch: distribution(this.samples.map((sample) => sample.inputDispatchMs)),
        predictedPaint: distribution(predicted(this.samples)),
        predictedBackspacePaint: distribution(predictedBackspace(this.samples)),
        normalPredictedPaint: distribution(predicted(normal)),
        normalPredictedBackspacePaint: distribution(predictedBackspace(normal)),
        normalOutput: distribution(normal.map((sample) => sample.outputMs)),
        normalRender: distribution(normal.map((sample) => sample.authoritativeRenderMs)),
        normalBackspaceRender: distribution(normalBackspace.map((sample) => sample.authoritativeRenderMs)),
        normalOutputToRender: distribution(normal.map((sample) => sample.outputToRenderMs)),
        alternatePredictedPaint: distribution(predicted(alternate)),
        alternatePredictedBackspacePaint: distribution(predictedBackspace(alternate)),
        alternateOutput: distribution(alternate.map((sample) => sample.outputMs)),
        alternateRender: distribution(alternate.map((sample) => sample.authoritativeRenderMs)),
        alternateBackspaceRender: distribution(alternateBackspace.map((sample) => sample.authoritativeRenderMs)),
        alternateOutputToRender: distribution(alternate.map((sample) => sample.outputToRenderMs)),
        normalOutputChars: distribution(normal.map((sample) => sample.outputChars)),
        alternateOutputChars: distribution(alternate.map((sample) => sample.outputChars)),
      },
    };
  }
}

export const terminalLatency = new TerminalLatencyRecorder(MAX_SAMPLES, (callback) => {
  globalThis.setTimeout(callback, 0);
});

export const clearTerminalLatency = (): void => terminalLatency.clear(performance.now());
