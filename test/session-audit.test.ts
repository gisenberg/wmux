import assert from "node:assert/strict";
import fs from "node:fs";
import { privateTempDirectory } from "./private-fixture.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DurableEndpointStore } from "../src/server/durable-endpoint-store.js";
import { parseDurableSessionObservations } from "../src/server/durable-session.js";
import {
  auditDurableSessions,
  cleanupDurableSession,
  expectedLocalDurablePaneIds,
} from "../src/server/session-audit.js";
import type { MachineConfig } from "../src/server/types.js";

test("only live local durable panes require local tmux or screen sessions", () => {
  const paneIds = expectedLocalDurablePaneIds({
    machines: [
      { id: "local", kind: "local", sessionBackend: "auto" },
      { id: "raw", kind: "local", sessionBackend: "pty" },
      { id: "command", kind: "local", command: ["watch", "date"] },
      { id: "remote", kind: "ssh", sessionBackend: "auto" },
      { id: "windows", kind: "powershell-ssh", sessionBackend: "agent" },
    ],
    workspaces: [
      {
        tabs: [
          {
            panes: [
              { id: "local-live", machineId: "local", status: "running" },
              { id: "local-idle", machineId: "local", status: "idle" },
              { id: "local-exited", machineId: "local", status: "exited" },
              { id: "raw-live", machineId: "raw", status: "running" },
              { id: "command-live", machineId: "command", status: "running" },
              { id: "remote-live", machineId: "remote", status: "running" },
              { id: "windows-live", machineId: "windows", status: "running" },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual([...paneIds].sort(), ["local-idle", "local-live"]);
});

test("legacy local panes without a machine record still default to auto", () => {
  const paneIds = expectedLocalDurablePaneIds({
    workspaces: [{ tabs: [{ panes: [{ id: "legacy", machineId: "local", status: "idle" }] }] }],
  });

  assert.deepEqual([...paneIds], ["legacy"]);
});

test("remote durable session output only admits wmux-owned tmux and screen sessions", () => {
  const observations = parseDurableSessionObservations([
    "login banner",
    "__WMUX_TMUX__",
    "wmux_pane-one\t1\t2",
    "personal\t0\t1",
    "__WMUX_SCREEN__",
    "1234.wmux_pane-two (07/24/26 12:00:00) (Detached)",
    "4321.personal (07/24/26 12:00:00) (Detached)",
  ].join("\n"));

  assert.deepEqual(observations, [
    {
      backend: "tmux",
      name: "wmux_pane-one",
      paneId: "pane-one",
      attached: true,
      detail: "1 attached, 2 windows",
    },
    {
      backend: "screen",
      name: "wmux_pane-two",
      paneId: "pane-two",
      attached: false,
      detail: "Detached",
    },
  ]);
});

test("audit and cleanup retain the old endpoint after dynamic ID reassignment", async () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-remote-audit-"));
  const statePath = path.join(directory, "state.json");
  const endpointPath = path.join(directory, "session-endpoints.json");
  const oldMachine = registeredMachine("100.64.0.10");
  const replacementMachine = registeredMachine("100.64.0.11");
  const disposedHosts: string[] = [];
  try {
    fs.writeFileSync(statePath, JSON.stringify({ workspaces: [] }));
    const store = new DurableEndpointStore(endpointPath);
    const oldRecord = store.bind("pane-one", oldMachine, "durable-multiplexer");
    assert.ok(oldRecord);
    store.reconcile(new Set(["pane-one"]), [replacementMachine]);
    const replacementRecord = store.bind(
      "pane-one",
      replacementMachine,
      "durable-multiplexer",
    );
    assert.ok(replacementRecord);

    const options = {
      endpointPath,
      commandOutput: async () => "",
      remoteLister: async (machine: MachineConfig) => ({
        reachable: true,
        sessions: [{
          backend: "tmux" as const,
          name: "wmux_pane-one",
          paneId: "pane-one",
          attached: false,
          detail: `0 attached at ${machine.host}`,
        }],
      }),
      remoteDisposer: async (machine: MachineConfig) => {
        disposedHosts.push(machine.host ?? "");
        return true;
      },
    };
    const audit = await auditDurableSessions(statePath, options);
    const oldRow = audit.sessions.find((row) => row.cleanupKey === oldRecord.id);
    const activeRow = audit.sessions.find((row) => row.endpoint?.includes("100.64.0.11"));
    assert.equal(oldRow?.status, "orphan");
    assert.equal(oldRow?.cleanupAllowed, true);
    assert.equal(activeRow?.status, "active");
    assert.equal(JSON.stringify(audit).includes("server-only-agent-secret"), false);

    await assert.rejects(
      cleanupDurableSession(
        "tmux",
        "wmux_pane-one",
        statePath,
        replacementRecord.id,
        options,
      ),
      /unknown durable endpoint cleanup target/,
    );
    await assert.rejects(
      cleanupDurableSession(
        "tmux",
        "wmux_unrelated-pane",
        statePath,
        oldRecord.id,
        options,
      ),
      /unknown durable endpoint cleanup target/,
    );
    assert.deepEqual(disposedHosts, []);

    await cleanupDurableSession(
      "tmux",
      "wmux_pane-one",
      statePath,
      oldRecord.id,
      options,
    );
    assert.deepEqual(disposedHosts, ["100.64.0.10"]);
    const remaining = new DurableEndpointStore(endpointPath).snapshot();
    assert.deepEqual(remaining.map((record) => record.id), [replacementRecord.id]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unreachable registered endpoints are reported but never cleanup-enabled", async () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-remote-unreachable-"));
  const statePath = path.join(directory, "state.json");
  const endpointPath = path.join(directory, "session-endpoints.json");
  try {
    fs.writeFileSync(statePath, JSON.stringify({ workspaces: [] }));
    new DurableEndpointStore(endpointPath)
      .bind("pane-one", registeredMachine("100.64.0.10"), "durable-multiplexer");
    const audit = await auditDurableSessions(statePath, {
      endpointPath,
      commandOutput: async () => "",
      remoteLister: async () => ({
        reachable: false,
        detail: "ssh timed out",
        sessions: [],
      }),
    });

    assert.equal(audit.summary.unreachableCount, 1);
    assert.equal(audit.sessions[0].status, "unreachable");
    assert.equal(audit.sessions[0].cleanupAllowed, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native-agent strands use the persisted endpoint for audit and cleanup", async () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-agent-audit-"));
  const statePath = path.join(directory, "state.json");
  const endpointPath = path.join(directory, "session-endpoints.json");
  const oldMachine = {
    ...registeredAgentMachine("100.64.0.20"),
    agentUrl: "http://agent-user:agent-password@100.64.0.20:3481/private?token=secret",
  };
  const replacementMachine = {
    ...registeredAgentMachine("100.64.0.21"),
    agentUrl: "http://agent-user:replacement-password@100.64.0.21:3481/private?token=other",
  };
  const disposedHosts: string[] = [];
  try {
    fs.writeFileSync(statePath, JSON.stringify({ workspaces: [] }));
    const store = new DurableEndpointStore(endpointPath);
    const oldRecord = store.bind("pane-agent", oldMachine, "windows-agent");
    assert.ok(oldRecord);
    store.reconcile(new Set(["pane-agent"]), [replacementMachine]);
    const replacementRecord = store.bind(
      "pane-agent",
      replacementMachine,
      "windows-agent",
    );
    assert.ok(replacementRecord);

    const options = {
      endpointPath,
      commandOutput: async () => "",
      agentLister: async (machine: MachineConfig) => ({
        reachable: true,
        sessions: [{
          paneId: "pane-agent",
          detail: `running at ${machine.host}`,
        }],
      }),
      agentDisposer: async (machine: MachineConfig) => {
        disposedHosts.push(machine.host ?? "");
        return true;
      },
    };
    const audit = await auditDurableSessions(statePath, options);
    assert.equal(
      audit.sessions.find((row) => row.cleanupKey === oldRecord.id)?.status,
      "orphan",
    );
    assert.equal(
      audit.sessions.find((row) => row.cleanupKey === replacementRecord.id)?.status,
      "active",
    );
    assert.equal(JSON.stringify(audit).includes("agent-password"), false);
    assert.equal(JSON.stringify(audit).includes("token=secret"), false);

    await cleanupDurableSession(
      "agent",
      "wmux_pane-agent",
      statePath,
      oldRecord.id,
      options,
    );
    assert.deepEqual(disposedHosts, ["100.64.0.20"]);
    assert.deepEqual(
      new DurableEndpointStore(endpointPath).snapshot().map((record) => record.id),
      [replacementRecord.id],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const registeredMachine = (host: string): MachineConfig => ({
  id: "dynamic-node",
  name: "Dynamic node",
  kind: "ssh",
  host,
  user: "wmux",
  sessionBackend: "auto",
  source: "registered",
  agentToken: "server-only-agent-secret",
});

const registeredAgentMachine = (host: string): MachineConfig => ({
  ...registeredMachine(host),
  sessionBackend: "agent",
  agentPort: 3481,
});
