/**
 * Capture a session agent's output trace and replay it through wmux's
 * terminal model.
 *
 *   npm run trace:agent -- capture --url http://100.64.0.30:3481 --pane pane_x --out trace.json
 *   npm run trace:agent -- replay trace.json [--mode conpty|native] [--screen]
 *
 * A trace holds the agent's retained output bytes with every resize and
 * console screen event, which is enough to reproduce a rendering defect
 * offline: replay reports each ConPTY screen the model disagreed with.
 * Traces contain terminal output; keep them private. Set WMUX_AGENT_TOKEN for
 * an agent that requires a bearer token.
 */
import fs from "node:fs";
import { TerminalCheckpoint } from "../src/server/terminal-checkpoint.js";
import type { TerminalResizeMode } from "../src/shared/conpty-resize.js";
import type {
  WindowsAgentOutputResponse,
  WindowsAgentScreenEvent,
  WindowsAgentSessionListResponse,
} from "../src/shared/windows-agent-protocol.js";
import { WINDOWS_AGENT_PATHS } from "../src/shared/windows-agent-protocol.js";

interface AgentTrace {
  version: 1;
  pane: string;
  backend?: string;
  capturedAt: string;
  output: WindowsAgentOutputResponse;
}

const usage = (): never => {
  console.error("usage: agent-trace capture --url <agent-url> --pane <pane-id> --out <file>");
  console.error("       agent-trace replay <file> [--mode conpty|native] [--screen]");
  process.exit(2);
};

const option = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const token = process.env.WMUX_AGENT_TOKEN;
  const response = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
};

const capture = async (args: string[]): Promise<void> => {
  const url = option(args, "--url")?.replace(/\/+$/, "");
  const pane = option(args, "--pane");
  const out = option(args, "--out");
  if (!url || !pane || !out) usage();
  const sessions = await fetchJson<WindowsAgentSessionListResponse>(`${url}${WINDOWS_AGENT_PATHS.sessions}`);
  const session = sessions.sessions?.find((candidate) => candidate.id === pane);
  if (!session) throw new Error(`the agent at ${url} has no session ${pane}`);
  const output = await fetchJson<WindowsAgentOutputResponse>(`${url}${WINDOWS_AGENT_PATHS.output(pane!, 0, 0, 0)}`);
  const trace: AgentTrace = {
    version: 1,
    pane: pane!,
    ...(session.backend ? { backend: session.backend } : {}),
    capturedAt: new Date().toISOString(),
    output,
  };
  fs.writeFileSync(out!, `${JSON.stringify(trace)}\n`, { mode: 0o600 });
  const bytes = Buffer.from(output.dataBase64 ?? "", "base64").length;
  console.log(
    `captured ${bytes} bytes from ${output.base ?? 0}, ${output.resizes?.length ?? 0} resizes, `
    + `${output.screens?.length ?? 0} console screens into ${out}`,
  );
};

const replay = (args: string[]): void => {
  const file = args[0];
  if (!file) usage();
  const trace = JSON.parse(fs.readFileSync(file!, "utf8")) as AgentTrace;
  const output = trace.output;
  const mode = (option(args, "--mode") ?? (trace.backend === "conpty" ? "conpty" : "native")) as TerminalResizeMode;
  const data = Buffer.from(output.dataBase64 ?? "", "base64");
  const start = output.startCursor ?? output.base ?? 0;
  const events = [
    ...(output.resizes ?? []).map((resize, index) => ({ kind: "resize" as const, seq: resize.seq ?? index, ...resize })),
    ...(output.screens ?? []).map((screen) => ({ kind: "screen" as const, ...screen })),
  ].sort((left, right) => left.cursor - right.cursor || left.seq - right.seq);
  const checkpoint = new TerminalCheckpoint(output.cols ?? 80, output.rows ?? 24);
  const decoder = new TextDecoder();
  let offset = 0;
  let disagreements = 0;
  try {
    for (const event of events) {
      const next = Math.max(offset, event.cursor - start);
      checkpoint.write(decoder.decode(data.subarray(offset, next), { stream: true }));
      offset = next;
      if (event.kind === "resize") {
        checkpoint.resize(event.cols, event.rows, mode);
        console.log(`#${event.seq} @${event.cursor} resize ${event.cols}x${event.rows}`);
        continue;
      }
      const screen = event as WindowsAgentScreenEvent & { kind: "screen" };
      const cursor = checkpoint.cursor();
      const repaint = checkpoint.reconcileConsoleScreen(screen);
      if (repaint) disagreements += 1;
      console.log(
        `#${screen.seq} @${screen.cursor} ${screen.reason} screen ${screen.cols}x${screen.rows}: `
        + (repaint
          ? `DISAGREED (model cursor ${cursor?.x},${cursor?.y}; console ${screen.cursorX},${screen.cursorY}; ${repaint.length}-byte repair)`
          : "agrees"),
      );
    }
    checkpoint.write(decoder.decode(data.subarray(offset)));
    console.log(`${disagreements} of ${output.screens?.length ?? 0} console screens disagreed with the ${mode} model`);
    if (args.includes("--screen")) {
      console.log(`final ${JSON.stringify(checkpoint.dimensions)} cursor ${JSON.stringify(checkpoint.cursor())}`);
      checkpoint.screenLines().forEach((line, row) => console.log(`${String(row + 1).padStart(3)}|${line.trimEnd()}`));
    }
  } finally {
    checkpoint.dispose();
  }
};

const [command, ...rest] = process.argv.slice(2);
if (command === "capture") await capture(rest);
else if (command === "replay") replay(rest);
else usage();
