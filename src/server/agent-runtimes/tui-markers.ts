import {
  AGENT_MARKERS,
} from "../../shared/agent-contract.js";
import type {
  AdapterEvent,
  AdapterScanState,
} from "./adapter.js";
import { scanLines } from "./adapter.js";

const markerWithRun = (
  marker: string,
  line: string,
): string | undefined => {
  const prefix = `${marker} `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : undefined;
};

export const classifyTuiMarkerLine = (rawLine: string): AdapterEvent[] => {
  const line = rawLine
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
  if (line === AGENT_MARKERS.ready) return [{ type: "ready" }];
  const readyRunId = markerWithRun(AGENT_MARKERS.ready, line);
  if (readyRunId) return [{ type: "ready", runId: readyRunId }];

  const tuiReady = markerWithRun(AGENT_MARKERS.tuiReady, line);
  if (tuiReady) return [{ type: "ready", runId: tuiReady }];
  const launch = markerWithRun(AGENT_MARKERS.tuiLaunch, line);
  if (launch) return [{ type: "launch", runId: launch }];

  const result = markerWithRun(AGENT_MARKERS.result, line);
  if (result) {
    try {
      return [{
        type: "result",
        value: JSON.parse(Buffer.from(result, "base64").toString("utf8")),
      }];
    } catch {
      return [];
    }
  }

  for (const [marker, type] of [
    [AGENT_MARKERS.done, "done"],
    [AGENT_MARKERS.tuiExit, "exit"],
  ] as const) {
    const detail = markerWithRun(marker, line);
    if (!detail) continue;
    const match = detail.match(/^([A-Za-z0-9._-]+) (-?\d+)$/);
    if (!match) return [];
    return [{
      type,
      runId: match[1],
      code: Number(match[2]),
    }];
  }
  return [];
};

export const classifyTuiMarkers = (
  chunk: string,
  state: AdapterScanState,
): AdapterEvent[] =>
  scanLines(chunk, state, classifyTuiMarkerLine);
