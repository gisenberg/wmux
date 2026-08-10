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
      ["--no-session", ...(request.model ? ["--model", request.model] : [])],
    ),
  classifyOutput: classifyTuiMarkers,
};

export const primeAgentHeadlessAdapter: AgentRuntimeAdapter = {
  runtime: "prime-agent",
  mode: "headless",
  buildLaunch: (request) => {
    if (!request.writeAccess) {
      throw new Error(
        "Prime Agent delegation cannot enforce read-only mode; explicitly enable writeAccess",
      );
    }
    if (!request.unattended) {
      throw new Error(
        "Prime Agent delegation has no approval prompts; explicitly enable unattended",
      );
    }
    return {
      file: "prime-agent",
      args: [
        "--print",
        "--mode",
        "json",
        "--no-session",
        "--cwd",
        request.directory,
        ...(request.model ? ["--model", request.model] : []),
      ],
      stdin: "prompt",
    };
  },
  classifyOutput: (chunk, state) =>
    parseJsonLines(chunk, state, (value): AdapterEvent[] => {
      const message = value.message;
      if (
        value.type === "message_end"
        && message
        && typeof message === "object"
        && !Array.isArray(message)
        && (message as Record<string, unknown>).role === "assistant"
        && ["error", "aborted"].includes(
          String((message as Record<string, unknown>).stopReason),
        )
      ) {
        return [{
          type: "error",
          message: nestedText(message) || "Prime Agent failed",
        }];
      }
      if (value.type === "message_end") {
        const text = assistantText(message);
        return text ? [{ type: "text", text }] : [];
      }
      if (value.type === "error") {
        return [{ type: "error", message: nestedText(value) }];
      }
      return [];
    }),
};
