import type {
  AdapterEvent,
  AgentRuntimeAdapter,
} from "./adapter.js";
import {
  nestedText,
  parseJsonLines,
  tuiLaunch,
} from "./runtime-helpers.js";
import { classifyTuiMarkers } from "./tui-markers.js";

const assistantText = (value: unknown): string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return "";
  return nestedText(message.content);
};

export const primeAgentTuiAdapter: AgentRuntimeAdapter = {
  runtime: "prime-agent",
  mode: "tui",
  buildLaunch: (request) =>
    tuiLaunch(
      request,
      "prime-agent",
      request.model ? ["--model", request.model] : [],
    ),
  classifyOutput: classifyTuiMarkers,
};

export const primeAgentHeadlessAdapter: AgentRuntimeAdapter = {
  runtime: "prime-agent",
  mode: "headless",
  buildLaunch: (request) => ({
    file: "prime-agent",
    args: [
      "--print",
      "--mode",
      "json",
      "--cwd",
      request.directory,
      ...(request.model ? ["--model", request.model] : []),
    ],
    stdin: "prompt",
  }),
  classifyOutput: (chunk, state) =>
    parseJsonLines(chunk, state, (value): AdapterEvent[] => {
      if (value.type === "message_end") {
        const message = value.message;
        if (
          message
          && typeof message === "object"
          && !Array.isArray(message)
          && (message as Record<string, unknown>).role === "assistant"
          && (message as Record<string, unknown>).stopReason === "error"
        ) {
          return [{
            type: "error",
            message: nestedText(
              (message as Record<string, unknown>).errorMessage
                ?? (message as Record<string, unknown>).content,
            ) || "Prime Agent reported an error",
          }];
        }
        const text = assistantText(message);
        return text ? [{ type: "text", text }] : [];
      }
      if (value.type === "error" || value.type === "extension_error") {
        return [{ type: "error", message: nestedText(value) }];
      }
      return [];
    }),
};
