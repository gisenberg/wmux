import type { DelegationRequest } from "../../shared/agent-contract.js";
import type {
  AdapterEvent,
  AgentRuntimeAdapter,
} from "./adapter.js";
import {
  classifyTuiMarkerLine,
  classifyTuiMarkers,
} from "./tui-markers.js";
import {
  nestedText,
  parseJsonLines,
  tuiLaunch,
} from "./runtime-helpers.js";

const tuiArgs = (request: DelegationRequest): string[] => {
  const args: string[] = [];
  if (
    request.sandboxMode
    || request.writeAccess !== undefined
    || request.unattended !== undefined
  ) {
    args.push(
      "--config",
      "check_for_update_on_startup=false",
      "--sandbox",
      request.sandboxMode
        ?? (request.writeAccess ? "workspace-write" : "read-only"),
    );
    if (request.unattended) args.push("--ask-for-approval", "never");
  }
  if (request.model) args.push("--model", request.model);
  return args;
};

export const codexTuiAdapter: AgentRuntimeAdapter = {
  runtime: "codex",
  mode: "tui",
  buildLaunch: (request) => tuiLaunch(request, "codex", tuiArgs(request)),
  classifyOutput: (chunk, state) => {
    const events = classifyTuiMarkers(chunk, state);
    if (
      events.length === 0
      && /OpenAI Codex[\s\S]*?›(?:\s|$)/.test(chunk)
    ) {
      return [{ type: "runtime-ready" }];
    }
    return events;
  },
};

export const codexHeadlessAdapter: AgentRuntimeAdapter = {
  runtime: "codex",
  mode: "headless",
  buildLaunch: (request) => ({
    file: "codex",
    args: [
      "--sandbox",
      request.sandboxMode
        ?? (request.writeAccess ? "workspace-write" : "read-only"),
      ...(request.unattended
        ? ["--ask-for-approval", "never"]
        : []),
      ...(request.model ? ["--model", request.model] : []),
      "exec",
      "--json",
      "-C",
      request.directory,
      "-",
    ],
    stdin: "prompt",
  }),
  classifyOutput: (chunk, state) =>
    parseJsonLines(chunk, state, (value): AdapterEvent[] => {
      const kind = value.type;
      const item = value.item;
      if (
        kind === "item.completed"
        && item
        && typeof item === "object"
        && !Array.isArray(item)
        && (item as Record<string, unknown>).type === "agent_message"
      ) {
        return [{ type: "text", text: nestedText(item) }];
      }
      if (kind === "error" || kind === "turn.failed") {
        return [{ type: "error", message: nestedText(value) }];
      }
      return [];
    }),
};

export { classifyTuiMarkerLine };
