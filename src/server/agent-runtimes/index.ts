import type { AgentRuntime } from "../../shared/agent-contract.js";
import {
  claudeHeadlessAdapter,
  claudeTuiAdapter,
} from "./claude.js";
import {
  codexHeadlessAdapter,
  codexTuiAdapter,
} from "./codex.js";
import {
  opencodeHeadlessAdapter,
  opencodeTuiAdapter,
} from "./opencode.js";
import type { AgentRuntimeAdapter } from "./adapter.js";

const adapters: Record<
  AgentRuntime,
  { tui: AgentRuntimeAdapter; headless: AgentRuntimeAdapter }
> = {
  claude: {
    tui: claudeTuiAdapter,
    headless: claudeHeadlessAdapter,
  },
  codex: {
    tui: codexTuiAdapter,
    headless: codexHeadlessAdapter,
  },
  opencode: {
    tui: opencodeTuiAdapter,
    headless: opencodeHeadlessAdapter,
  },
};

export const agentRuntimeAdapter = (
  runtime: AgentRuntime,
  options: {
    interactive: boolean;
    preferHeadless: boolean;
    headlessAvailable?: boolean;
  },
): AgentRuntimeAdapter => {
  if (options.interactive) return adapters[runtime].tui;
  if (options.preferHeadless && options.headlessAvailable !== false) {
    return adapters[runtime].headless;
  }
  return adapters[runtime].tui;
};
