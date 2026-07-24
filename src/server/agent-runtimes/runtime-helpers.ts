import type { DelegationRequest } from "../../shared/agent-contract.js";
import type { AgentRuntime } from "../../shared/agent-contract.js";
import type {
  AdapterEvent,
  AdapterScanState,
  SpawnSpec,
} from "./adapter.js";
import { scanLines } from "./adapter.js";

export const tuiLaunch = (
  request: DelegationRequest,
  runtime: AgentRuntime,
  args: string[] = [],
): SpawnSpec => ({
  file: runtime,
  args,
  cwd: request.directory,
  env: { WMUX_INTERACTIVE_TUI: "1" },
  stdin: "none",
});

export const parseJsonLines = (
  chunk: string,
  state: AdapterScanState,
  classify: (value: Record<string, unknown>) => AdapterEvent[],
): AdapterEvent[] =>
  scanLines(chunk, state, (line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? classify(value as Record<string, unknown>)
        : [];
    } catch {
      return [];
    }
  });

export const nestedText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "message", "error", "data", "part"]) {
    const text = nestedText(record[key]);
    if (text) return text;
  }
  return "";
};
