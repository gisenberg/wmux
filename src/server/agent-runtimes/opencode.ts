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

export const opencodeTuiAdapter: AgentRuntimeAdapter = {
  runtime: "opencode",
  mode: "tui",
  buildLaunch: (request) =>
    tuiLaunch(request, "opencode", [
      ...(request.agent ? ["--agent", request.agent] : []),
      ...(request.model ? ["--model", request.model] : []),
    ]),
  classifyOutput: (chunk, state) => {
    const markers = classifyTuiMarkers(chunk, state);
    const title = chunk.match(
      /(?:session|workspace)[_. -]?title["':=\s]+([^\r\n"]{1,80})/i,
    )?.[1]?.trim();
    return title
      ? [...markers, { type: "title-refresh", title }]
      : markers;
  },
};

export const opencodeHeadlessAdapter: AgentRuntimeAdapter = {
  runtime: "opencode",
  mode: "headless",
  buildLaunch: (request) => ({
    file: "opencode",
    args: [
      "run",
      "--format",
      "json",
      "--dir",
      request.directory,
      ...(request.title ? ["--title", request.title] : []),
      ...(request.agent ? ["--agent", request.agent] : []),
      ...(request.model ? ["--model", request.model] : []),
    ],
    stdin: "prompt",
  }),
  classifyOutput: (chunk, state) =>
    parseJsonLines(chunk, state, (value): AdapterEvent[] => {
      if (value.type === "text") {
        const text = nestedText(value.part) || nestedText(value.text);
        return text ? [{ type: "text", text }] : [];
      }
      if (value.type === "error") {
        return [{ type: "error", message: nestedText(value) }];
      }
      return [];
    }),
};
