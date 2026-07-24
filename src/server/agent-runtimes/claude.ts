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

export const claudeTuiAdapter: AgentRuntimeAdapter = {
  runtime: "claude",
  mode: "tui",
  buildLaunch: (request) =>
    tuiLaunch(
      request,
      "claude",
      request.model ? ["--model", request.model] : [],
    ),
  classifyOutput: classifyTuiMarkers,
};

export const claudeHeadlessAdapter: AgentRuntimeAdapter = {
  runtime: "claude",
  mode: "headless",
  buildLaunch: (request) => ({
    file: "claude",
    args: [
      "-p",
      "--verbose",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--permission-mode",
      request.unattended
        ? "bypassPermissions"
        : request.writeAccess
          ? "acceptEdits"
          : "plan",
      ...(request.model ? ["--model", request.model] : []),
    ],
    cwd: request.directory,
    stdin: "prompt",
  }),
  classifyOutput: (chunk, state) =>
    parseJsonLines(chunk, state, (value): AdapterEvent[] => {
      const kind = value.type;
      if (kind === "assistant" || kind === "result") {
        const text = kind === "result"
          ? nestedText(value.result)
          : nestedText(value);
        return text ? [{ type: "text", text }] : [];
      }
      if (kind === "error") {
        return [{ type: "error", message: nestedText(value) }];
      }
      return [];
    }),
};
