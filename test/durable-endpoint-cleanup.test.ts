import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupStrandedDurableEndpoints } from "../src/server/durable-endpoint-cleanup.js";
import { DurableEndpointStore } from "../src/server/durable-endpoint-store.js";
import type { MachineConfig } from "../src/server/types.js";

const staticAgent: MachineConfig = {
  id: "static-agent",
  name: "Static agent",
  kind: "powershell-ssh",
  host: "100.64.0.30",
  sessionBackend: "agent",
  agentPort: 3481,
  agentToken: "secret",
  source: "config",
};

const staticRemote: MachineConfig = {
  id: "static-remote",
  name: "Static remote",
  kind: "ssh",
  host: "100.64.0.31",
  user: "wmux",
  sessionBackend: "auto",
  source: "config",
};

test("stranded endpoint cleanup deletes owned sessions and stale records", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-cleanup-"));
  const store = new DurableEndpointStore(path.join(directory, "session-endpoints.json"));
  try {
    const liveAgent = store.bind("pane-agent-live", staticAgent, "windows-agent");
    const missingAgent = store.bind("pane-agent-missing", staticAgent, "windows-agent");
    const durable = store.bind("pane-remote", staticRemote, "durable-multiplexer");
    assert.ok(liveAgent && missingAgent && durable);
    store.reconcile(new Set(), [staticAgent, staticRemote]);
    const disposedAgents: string[] = [];
    const disposedDurable: Array<{ paneId: string; backend: string | undefined }> = [];

    const result = await cleanupStrandedDurableEndpoints(store, {
      agentLister: async () => ({
        reachable: true,
        sessions: [{ paneId: "pane-agent-live", detail: "running" }],
      }),
      agentDisposer: async (_machine, paneId) => {
        disposedAgents.push(paneId);
        return true;
      },
      remoteLister: async () => ({
        reachable: true,
        sessions: [
          {
            backend: "tmux",
            name: "wmux_pane-remote",
            paneId: "pane-remote",
            attached: false,
            detail: "0 attached",
          },
        ],
      }),
      remoteDisposer: async (machine, paneId) => {
        disposedDurable.push({ paneId, backend: machine.sessionBackend });
        return true;
      },
    });

    assert.deepEqual(disposedAgents, ["pane-agent-live"]);
    assert.deepEqual(disposedDurable, [{ paneId: "pane-remote", backend: "tmux" }]);
    assert.deepEqual(result, {
      removedRecords: 3,
      disposedSessions: 2,
      unreachableRecords: 0,
      failedRecords: 0,
    });
    assert.deepEqual(store.snapshot(), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("stranded endpoint cleanup retains unreachable and failed targets for audit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-cleanup-failure-"));
  const store = new DurableEndpointStore(path.join(directory, "session-endpoints.json"));
  try {
    assert.ok(store.bind("pane-agent", staticAgent, "windows-agent"));
    assert.ok(store.bind("pane-remote", staticRemote, "durable-multiplexer"));
    store.reconcile(new Set(), [staticAgent, staticRemote]);

    const result = await cleanupStrandedDurableEndpoints(store, {
      agentLister: async () => ({ reachable: false, sessions: [] }),
      remoteLister: async () => ({
        reachable: true,
        sessions: [{
          backend: "screen",
          name: "wmux_pane-remote",
          paneId: "pane-remote",
          attached: false,
          detail: "detached",
        }],
      }),
      remoteDisposer: async () => false,
    });

    assert.deepEqual(result, {
      removedRecords: 0,
      disposedSessions: 0,
      unreachableRecords: 1,
      failedRecords: 1,
    });
    assert.equal(store.snapshot().length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
