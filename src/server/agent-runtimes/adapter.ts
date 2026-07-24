import type {
  AgentRuntime,
  DelegationRequest,
} from "../../shared/agent-contract.js";

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin: "prompt" | "none";
}

export interface AdapterScanState {
  pending: string;
}

export type AdapterEvent =
  | { type: "ready"; runId?: string }
  | { type: "launch"; runId: string }
  | { type: "exit"; runId: string; code: number }
  | { type: "done"; runId: string; code: number }
  | { type: "result"; value: unknown }
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "runtime-ready" }
  | { type: "title-refresh"; title: string };

export interface AgentRuntimeAdapter {
  runtime: AgentRuntime;
  mode: "headless" | "tui";
  buildLaunch(request: DelegationRequest): SpawnSpec;
  classifyOutput(
    chunk: string,
    state: AdapterScanState,
  ): AdapterEvent[];
}

export const createAdapterScanState = (): AdapterScanState => ({
  pending: "",
});

export const scanLines = (
  chunk: string,
  state: AdapterScanState,
  classify: (line: string) => AdapterEvent[],
): AdapterEvent[] => {
  const combined = state.pending + chunk;
  const lines = combined.split(/\r?\n/);
  state.pending = lines.pop() ?? "";
  return lines.flatMap(classify);
};

export const flushAdapterScanState = (
  state: AdapterScanState,
  classify: (line: string) => AdapterEvent[],
): AdapterEvent[] => {
  if (!state.pending) return [];
  const pending = state.pending;
  state.pending = "";
  return classify(pending);
};
