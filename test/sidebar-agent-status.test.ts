import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIDEBAR_AGENT_HEARTBEAT_FRAMES,
  SIDEBAR_AGENT_RUNNING_FRAMES,
  sidebarAgentStatusPresentation,
} from "../src/client/src/sidebar-agent-status";

test("sidebar agent indicators distinguish work, idle heartbeat, and attention", () => {
  const active = sidebarAgentStatusPresentation("running", true, 3);
  assert.equal(active.label, "working");
  assert.equal(active.marker, SIDEBAR_AGENT_RUNNING_FRAMES[3]);

  const heartbeat = sidebarAgentStatusPresentation("heartbeat", true, 2);
  assert.equal(heartbeat.label, "heartbeat");
  assert.equal(heartbeat.marker, SIDEBAR_AGENT_HEARTBEAT_FRAMES[2]);

  assert.deepEqual(
    sidebarAgentStatusPresentation("waiting", true, 3),
    { label: "waiting", marker: "?" },
  );
  assert.deepEqual(
    sidebarAgentStatusPresentation("completed", true, 3),
    { label: "done", marker: "✓" },
  );
});
