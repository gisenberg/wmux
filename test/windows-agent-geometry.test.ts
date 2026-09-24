import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { WindowsAgentSession } from "../src/server/windows-agent.js";
import type { TerminalCheckpoint } from "../src/server/terminal-checkpoint.js";
import type { MachineConfig, PaneState } from "../src/server/types.js";
import type {
  WindowsAgentOutputResponse,
  WindowsAgentScreenEvent,
} from "../src/shared/windows-agent-protocol.js";

const waitUntil = async (predicate: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const pane = (id: string): PaneState => ({
  id,
  machineId: "windows",
  title: "PowerShell",
  status: "idle",
  createdAt: new Date(0).toISOString(),
});

const machine = (port: number): MachineConfig => ({
  id: "windows",
  name: "Windows",
  kind: "powershell-ssh",
  host: "127.0.0.1",
  sessionBackend: "agent",
  agentUrl: `http://127.0.0.1:${port}`,
});

interface FakeAgent {
  port: number;
  screenRequests: number;
  outputQueries: URLSearchParams[];
  close: () => Promise<void>;
}

/**
 * A session agent that serves scripted output responses in order and then
 * idles, like a long poll with nothing new.
 */
const startFakeAgent = async (
  id: string,
  backend: string,
  responses: WindowsAgentOutputResponse[],
): Promise<FakeAgent> => {
  const agent = { screenRequests: 0, outputQueries: [] as URLSearchParams[] };
  let cursor = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://agent.invalid");
    const reply = (body: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "POST" && url.pathname === `/sessions/${id}`) {
      reply({ id, pid: 123, base: 0, cursor: 0, cols: 20, rows: 4, backend });
      return;
    }
    if (request.method === "POST" && url.pathname === `/sessions/${id}/screen`) {
      agent.screenRequests += 1;
      reply({ scheduled: true }, 202);
      return;
    }
    if (request.method === "GET" && url.pathname === `/sessions/${id}/output`) {
      agent.outputQueries.push(url.searchParams);
      const next = responses.shift();
      if (next) {
        cursor = next.cursor ?? cursor;
        reply(next);
        return;
      }
      setTimeout(() => reply({ base: 0, startCursor: cursor, cursor, cols: 20, rows: 4, dataBase64: "", exited: false, eventSeq: 1 }), 20);
      return;
    }
    reply({ removed: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return Object.assign(agent, {
    port: address.port,
    close: async () => {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  });
};

const base64 = (text: string) => Buffer.from(text).toString("base64");

const consoleScreen = (
  seq: number,
  cursor: number,
  lines: string[],
  cursorX: number,
  cursorY: number,
): WindowsAgentScreenEvent => ({
  seq,
  cursor,
  reason: "resize",
  cols: lines[0]?.length ?? 0,
  rows: lines.length,
  cursorX,
  cursorY,
  cursorVisible: true,
  lines: lines.map((text) => ({ text })),
});

test("session-agent geometry changes at the exact byte where the agent resized", async () => {
  const id = "pane_sequenced";
  const agent = await startFakeAgent(id, "conpty", [{
    base: 0,
    startCursor: 0,
    cursor: 8,
    cols: 20,
    rows: 4,
    resizes: [{ cursor: 5, cols: 30, rows: 6 }],
    dataBase64: base64("PS> abcd"),
    exited: false,
  }]);
  const events: string[] = [];
  const session = new WindowsAgentSession(pane(id), machine(agent.port), 20, 4);
  session.on("output", (data) => events.push(`output:${data}`));
  session.on("geometry", (cols, rows) => events.push(`geometry:${cols}x${rows}`));
  try {
    await session.attachReady;
    assert.deepEqual(session.geometry, { cols: 20, rows: 4, mode: "conpty" });
    await waitUntil(() => events.length >= 3);
    assert.deepEqual(events.slice(0, 3), ["output:PS> a", "geometry:30x6", "output:bcd"]);
    assert.deepEqual(session.geometry, { cols: 30, rows: 6, mode: "conpty" });

    // A browser request does not move the model or the announced geometry
    // until the agent reports that it applied it.
    session.resize(40, 10);
    assert.deepEqual(session.geometry, { cols: 30, rows: 6, mode: "conpty" });
    const checkpoint = (session as unknown as { checkpoint: TerminalCheckpoint }).checkpoint;
    assert.deepEqual(checkpoint.dimensions, { cols: 30, rows: 6 });
    assert.ok(agent.outputQueries.every((query) => query.get("eventSeq") === "0"));
  } finally {
    session.detach();
    await agent.close();
  }
});

test("console screens reconcile the model at their stream position and repaint browsers", async () => {
  const id = "pane_reconciled";
  const truth = ["PS> T:\\git\\gisenberg", "                    ", "                    ", "                    "];
  const agent = await startFakeAgent(id, "conpty", [{
    base: 0,
    startCursor: 0,
    cursor: 11,
    cols: 20,
    rows: 4,
    resizes: [],
    screens: [consoleScreen(1, 11, truth, 20, 0)],
    eventSeq: 1,
    // A model that missed part of the prompt: ConPTY's own screen has it all.
    dataBase64: base64("PS> T:\\git\\"),
    exited: false,
  }]);
  const outputs: string[] = [];
  const screens: string[] = [];
  const session = new WindowsAgentSession(pane(id), machine(agent.port), 20, 4);
  session.on("output", (data) => outputs.push(data));
  session.on("screen", (data) => screens.push(data));
  try {
    await waitUntil(() => screens.length === 1);
    assert.equal(outputs.join(""), "PS> T:\\git\\");
    assert.match(screens[0] ?? "", /gisenberg/);
    assert.doesNotMatch(screens[0] ?? "", /\x1bc/);
    const checkpoint = (session as unknown as { checkpoint: TerminalCheckpoint }).checkpoint;
    assert.equal(checkpoint.screenLines()[0], "PS> T:\\git\\gisenberg");
    // Later polls ask only for newer screens.
    await waitUntil(() => agent.outputQueries.some((query) => query.get("eventSeq") === "1"));
    // Settled output asks the agent to verify the screen again.
    await waitUntil(() => agent.screenRequests === 1, 3000);
  } finally {
    session.detach();
    await agent.close();
  }
});

test("native session agents keep their reflow and never request console screens", async () => {
  const id = "pane_native";
  const agent = await startFakeAgent(id, "pty", [{
    base: 0,
    startCursor: 0,
    cursor: 2,
    cols: 20,
    rows: 4,
    resizes: [],
    dataBase64: base64("$ "),
    exited: false,
  }]);
  const session = new WindowsAgentSession(pane(id), machine(agent.port), 20, 4);
  try {
    await session.attachReady;
    assert.equal(session.geometry.mode, "native");
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(agent.screenRequests, 0);
  } finally {
    session.detach();
    await agent.close();
  }
});

test("application resets on ConPTY keep the model measuring graphemes", async () => {
  const id = "pane_reset";
  const agent = await startFakeAgent(id, "conpty", [{
    base: 0,
    startCursor: 0,
    cursor: 6,
    cols: 20,
    rows: 4,
    resizes: [],
    dataBase64: base64("a\x1bc👍🏽"),
    exited: false,
  }]);
  const outputs: string[] = [];
  const session = new WindowsAgentSession(pane(id), machine(agent.port), 20, 4);
  session.on("output", (data) => outputs.push(data));
  try {
    await waitUntil(() => outputs.join("").includes("👍🏽"));
    assert.equal(outputs.join(""), "a\x1bc\x1b[?2027h👍🏽");
    const checkpoint = (session as unknown as { checkpoint: TerminalCheckpoint }).checkpoint;
    assert.deepEqual(checkpoint.cursor(), { x: 2, y: 0, visible: true });
  } finally {
    session.detach();
    await agent.close();
  }
});

test("every ConPTY resize applies in order even without output between them", async () => {
  const id = "pane_resize_path";
  const history = Array.from({ length: 6 }, (_, index) => `h${index}\r\n`).join("") + "PS> ";
  const bytes = Buffer.byteLength(history);
  const agent = await startFakeAgent(id, "conpty", [
    {
      base: 0,
      startCursor: 0,
      cursor: bytes,
      cols: 20,
      rows: 4,
      resizes: [],
      dataBase64: base64(history),
      exited: false,
      eventSeq: 0,
    },
    {
      // A layout pass shrank and restored the pane with no output between.
      base: 0,
      startCursor: bytes,
      cursor: bytes,
      cols: 20,
      rows: 4,
      resizes: [
        { seq: 1, cursor: bytes, cols: 20, rows: 3 },
        { seq: 2, cursor: bytes, cols: 20, rows: 4 },
      ],
      dataBase64: "",
      exited: false,
      eventSeq: 2,
    },
  ]);
  const geometry: string[] = [];
  const session = new WindowsAgentSession(pane(id), machine(agent.port), 20, 4);
  session.on("geometry", (cols, rows) => geometry.push(`${cols}x${rows}`));
  try {
    await waitUntil(() => geometry.length === 2);
    assert.deepEqual(geometry, ["20x3", "20x4"]);
    const checkpoint = (session as unknown as { checkpoint: TerminalCheckpoint }).checkpoint;
    // ConPTY scrolled one row out when it shrank and added a blank row when
    // it grew back, so the prompt is now one row higher than before.
    assert.deepEqual(checkpoint.screenLines().map((line) => line.trimEnd()), ["h4", "h5", "PS>", ""]);
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 2, visible: true });
  } finally {
    session.detach();
    await agent.close();
  }
});
