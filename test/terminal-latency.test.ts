import assert from "node:assert/strict";
import test from "node:test";
import {
  TerminalLatencyRecorder,
  classifyTerminalLatencyInput,
  normalizeDomEventTimestamp,
} from "../src/client/src/terminal-latency.js";

test("terminal latency classifies input without retaining its contents", () => {
  assert.equal(classifyTerminalLatencyInput("a"), "printable");
  assert.equal(classifyTerminalLatencyInput("\x7f"), "backspace");
  assert.equal(classifyTerminalLatencyInput("\r"), "control");
  assert.equal(classifyTerminalLatencyInput("\x1b[D"), "multi");
});

test("terminal latency normalizes DOM event timestamps onto the performance timeline", () => {
  assert.equal(normalizeDomEventTimestamp(125, 130, 1_000), 125);
  assert.equal(normalizeDomEventTimestamp(1_125, 130, 1_000), 125);
  assert.equal(normalizeDomEventTimestamp(1_700_000_000_000, 130, 1_000), 130);
  assert.equal(normalizeDomEventTimestamp(Number.NaN, 130, 1_000), 130);
});

test("terminal latency measures prediction, output, and authoritative render stages", () => {
  const recorder = new TerminalLatencyRecorder();
  recorder.recordInput("pane-1", 1, "printable", "normal", 100, 102);
  recorder.recordPredictionMutation("pane-1", 1, 103);
  recorder.recordPredictionPaint("pane-1", 1, 116);
  recorder.recordOutput("pane-1", 1, 2, 130);
  recorder.recordWrite("pane-1", 132);
  recorder.recordRender("pane-1", 148);

  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.sampleCount, 1);
  assert.equal(snapshot.pendingCount, 0);
  assert.deepEqual(snapshot.metrics.inputDispatch, { samples: 1, p50: 2, p95: 2, p99: 2 });
  assert.deepEqual(snapshot.metrics.predictedPaint, { samples: 1, p50: 16, p95: 16, p99: 16 });
  assert.deepEqual(snapshot.metrics.normalPredictedPaint, { samples: 1, p50: 16, p95: 16, p99: 16 });
  assert.equal(snapshot.metrics.alternatePredictedPaint.samples, 0);
  assert.deepEqual(snapshot.metrics.normalOutput, { samples: 1, p50: 30, p95: 30, p99: 30 });
  assert.deepEqual(snapshot.metrics.normalRender, { samples: 1, p50: 48, p95: 48, p99: 48 });
  assert.deepEqual(snapshot.metrics.normalOutputToRender, { samples: 1, p50: 18, p95: 18, p99: 18 });
  assert.deepEqual(snapshot.metrics.normalOutputChars, { samples: 1, p50: 2, p95: 2, p99: 2 });
  assert.equal(snapshot.metrics.alternateRender.samples, 0);
});

test("terminal latency separates alternate-screen samples and acknowledges input batches", () => {
  const recorder = new TerminalLatencyRecorder();
  recorder.recordInput("pane-1", 1, "printable", "alternate", 10, 10);
  recorder.recordInput("pane-1", 2, "backspace", "alternate", 12, 12);
  recorder.recordPredictionMutation("pane-1", 2, 13);
  recorder.recordPredictionPaint("pane-1", 2, 17);
  recorder.recordOutput("pane-1", 2, 40, 30);
  recorder.recordWrite("pane-1", 31);
  recorder.recordRender("pane-1", 40);

  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.sampleCount, 2);
  assert.deepEqual(snapshot.metrics.alternateOutput, { samples: 2, p50: 18, p95: 20, p99: 20 });
  assert.deepEqual(snapshot.metrics.alternateRender, { samples: 2, p50: 28, p95: 30, p99: 30 });
  assert.deepEqual(snapshot.metrics.alternateBackspaceRender, { samples: 1, p50: 28, p95: 28, p99: 28 });
  assert.deepEqual(snapshot.metrics.alternatePredictedPaint, { samples: 1, p50: 5, p95: 5, p99: 5 });
  assert.deepEqual(snapshot.metrics.alternatePredictedBackspacePaint, { samples: 1, p50: 5, p95: 5, p99: 5 });
  assert.deepEqual(snapshot.metrics.alternateOutputChars, { samples: 2, p50: 40, p95: 40, p99: 40 });
  assert.equal(snapshot.metrics.normalOutput.samples, 0);
});

test("terminal latency bounds completed and stale pending samples", () => {
  const recorder = new TerminalLatencyRecorder(1);
  recorder.recordInput("pane-1", 1, "control", "normal", 0, 0);
  recorder.recordInput("pane-1", 2, "control", "normal", 11_000, 11_000);
  assert.equal(recorder.getSnapshot().droppedCount, 1);

  recorder.recordOutput("pane-1", 2, 1, 11_010);
  recorder.recordWrite("pane-1", 11_011);
  recorder.recordRender("pane-1", 11_012);
  recorder.recordInput("pane-1", 3, "control", "normal", 12_000, 12_000);
  recorder.recordOutput("pane-1", 3, 1, 12_010);
  recorder.recordWrite("pane-1", 12_011);
  recorder.recordRender("pane-1", 12_012);

  assert.equal(recorder.getSnapshot().sampleCount, 1);
});
