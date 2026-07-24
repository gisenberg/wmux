import assert from "node:assert/strict";
import { test } from "node:test";
import { agentResponseMessage, buildMobileThreadItems, sendMobileComposerInput } from "../src/client/src/MobileAgentSurface";
import type { AgentActivity } from "../src/client/src/types";

const event = (input: Partial<AgentActivity> & Pick<AgentActivity, "id" | "status" | "createdAt">): AgentActivity => ({
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
  agent: "codex",
  title: "mobile chat",
  summary: `codex ${input.status}`,
  ...input,
});

test("mobile thread stays pane-local and collapses completed lifecycle starts", () => {
  const events = [
    event({
      id: "running-new",
      status: "running",
      createdAt: "2026-07-11T12:03:00.000Z",
      title: "next prompt",
      message: "response from the prior turn",
    }),
    event({
      id: "completed-old",
      status: "completed",
      createdAt: "2026-07-11T12:02:00.000Z",
      message: "actual response",
    }),
    event({
      id: "running-old",
      status: "running",
      createdAt: "2026-07-11T12:01:00.000Z",
      message: "older response",
    }),
    event({
      id: "other-pane",
      status: "completed",
      paneId: "pane-2",
      createdAt: "2026-07-11T12:04:00.000Z",
      message: "must not leak into pane 1",
    }),
  ];

  const items = buildMobileThreadItems("workspace-1", "pane-1", events, [], [], []);
  const agentIds = items.filter((item) => item.kind === "agent").map((item) => item.event.id);
  assert.deepEqual(agentIds, ["completed-old", "running-new"]);
});

test("only settled successful events expose assistant response text", () => {
  assert.equal(
    agentResponseMessage(event({ id: "running", status: "running", createdAt: new Date().toISOString(), message: "stale" })),
    "",
  );
  assert.equal(
    agentResponseMessage(event({ id: "notification", status: "updated", createdAt: new Date().toISOString(), message: "stale" })),
    "",
  );
  assert.equal(
    agentResponseMessage(event({ id: "completed", status: "completed", createdAt: new Date().toISOString(), message: "fresh" })),
    "fresh",
  );
});

test("mobile composer sends Enter as a distinct sequential terminal input", async () => {
  const writes: Array<{
    paneId: string;
    data: string;
    timelinePrompt?: string;
  }> = [];
  await sendMobileComposerInput(async (paneId, data, timelinePrompt) => {
    writes.push({ paneId, data, ...(timelinePrompt ? { timelinePrompt } : {}) });
  }, "pane-1", "hello agent", "hello agent");
  assert.deepEqual(writes, [
    { paneId: "pane-1", data: "hello agent" },
    { paneId: "pane-1", data: "\r", timelinePrompt: "hello agent" },
  ]);
});
