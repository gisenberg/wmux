import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIDEBAR_AGENT_RUNNING_FRAMES,
  sidebarAgentStatusPresentation,
} from "../src/client/src/sidebar-agent-status";

test("sidebar agent indicators distinguish active work from user attention", () => {
  const active = sidebarAgentStatusPresentation("running", true, 3);
  assert.equal(active.label, "working");
  assert.equal(active.marker, SIDEBAR_AGENT_RUNNING_FRAMES[3]);

  assert.deepEqual(
    sidebarAgentStatusPresentation("waiting", true, 3),
    { label: "waiting", marker: "?" },
  );
  assert.deepEqual(
    sidebarAgentStatusPresentation("completed", true, 3),
    { label: "done", marker: "✓" },
  );
});
