import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { TerminalCheckpoint } from "../src/server/terminal-checkpoint.js";
import type { WindowsAgentOutputResponse } from "../src/shared/windows-agent-protocol.js";

// Drives real ConPTY through the Windows agent, then replays the recorded
// trace through wmux's terminal model: every console screen ConPTY reported
// must agree with the model without a repair.

const python = process.env.PYTHON ?? "python";
const conptyAvailable = process.platform === "win32"
  && spawnSync(python, ["-c", "import winpty"], { stdio: "ignore" }).status === 0;

const scenario = String.raw`
import json
import os
import runpy
import sys
import tempfile
import time

module = runpy.run_path("scripts/wmux-windows-agent")
palette = ",".join(["#000000", "#cc3333", "#33cc33", "#cccc33", "#3333cc", "#cc33cc", "#33cccc", "#cccccc"] * 2)
session = module["Session"]("pane_conformance", {}, {
    "cols": 137,
    "rows": 38,
    "cwd": tempfile.gettempdir(),
    "env": {
        "WMUX_TERMINAL_ANSI_PALETTE": palette,
        "WMUX_TERMINAL_BACKGROUND": "#101010",
        "WMUX_TERMINAL_FOREGROUND": "#e0e0e0",
    },
})

def settle(seconds=1.0):
    time.sleep(seconds)

def wait_for_screen(reason, after):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if any(event["seq"] > after and event["reason"] == reason for event in session.screen_events):
            return
        time.sleep(0.05)
    raise SystemExit(f"no {reason} screen after event {after}")

try:
    settle(8)
    session.write(b'1..30 | % { "history line $_ " + ("x" * ($_ * 3)) }\r')
    settle(3)
    session.write(b'Write-Output "wide \xe7\xbe\x8a\xe7\xbe\x8a emoji \xf0\x9f\x91\x8d accent \xc3\xa9"\r')
    settle(2)
    seq = session.event_seq
    session.request_screen("verify")
    wait_for_screen("verify", seq)
    initial = next(event for event in session.screen_events if event["seq"] > seq and event["reason"] == "verify")
    session.write(b"echo T:\\git\\example\\a-long-path-that-wraps-at-phone-width \xe7\xbe\x8a")
    settle(1.5)
    for cols, rows in ((48, 33), (173, 38), (137, 38), (137, 21), (137, 38), (75, 27), (137, 38)):
        seq = session.event_seq
        session.resize(cols, rows)
        wait_for_screen("resize", seq)
    session.write(b" tail")
    settle(1.5)
    seq = session.event_seq
    session.request_screen("verify")
    wait_for_screen("verify", seq)
    sys.stdout.write(json.dumps({
        "initial": {"cols": initial["cols"], "rows": initial["rows"]},
        "trace": session.read_from(0, 0, 0),
    }))
finally:
    session.terminate()
`;

test("Windows ConPTY screens agree with wmux's terminal model through resizes", {
  skip: conptyAvailable ? false : "requires Windows with pywinpty",
  timeout: 120_000,
}, () => {
  const result = spawnSync(python, ["-c", scenario], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 110_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { initial, trace } = JSON.parse(result.stdout) as {
    initial: { cols: number; rows: number };
    trace: WindowsAgentOutputResponse;
  };
  // Replay a failure offline with `npm run trace:agent -- replay <file>`.
  const traceOut = process.env.WMUX_CONPTY_TRACE_OUT;
  if (traceOut) {
    fs.writeFileSync(traceOut, JSON.stringify({ version: 1, pane: "pane_conformance", backend: "conpty", capturedAt: new Date().toISOString(), output: trace }));
  }
  // The themed console keeps the pane's exact geometry: before any resize, a
  // console one row short never produces an exact screen at the pane's size.
  assert.deepEqual(initial, { cols: 137, rows: 38 });
  const screens = trace.screens ?? [];

  const data = Buffer.from(trace.dataBase64 ?? "", "base64");
  const events = [
    ...(trace.resizes ?? []).map((resize) => ({ kind: "resize" as const, seq: resize.seq ?? 0, ...resize })),
    ...screens.map((screen) => ({ kind: "screen" as const, ...screen })),
  ].sort((left, right) => left.cursor - right.cursor || left.seq - right.seq);
  const checkpoint = new TerminalCheckpoint(trace.cols ?? 137, trace.rows ?? 38);
  const decoder = new TextDecoder();
  const disagreements: string[] = [];
  let offset = 0;
  try {
    for (const event of events) {
      checkpoint.write(decoder.decode(data.subarray(offset, event.cursor), { stream: true }));
      offset = event.cursor;
      if (event.kind === "resize") {
        checkpoint.resize(event.cols, event.rows, "conpty");
        continue;
      }
      const cursor = checkpoint.cursor();
      if (checkpoint.reconcileConsoleScreen(event)) {
        disagreements.push(
          `#${event.seq} ${event.reason} ${event.cols}x${event.rows}: model cursor ${cursor?.x},${cursor?.y}, `
          + `console ${event.cursorX},${event.cursorY}`,
        );
      }
    }
  } finally {
    checkpoint.dispose();
  }
  assert.ok(screens.length >= 8, `expected a screen per resize, got ${screens.length}`);
  assert.deepEqual(disagreements, []);
});
