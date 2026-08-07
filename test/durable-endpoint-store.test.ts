import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CURRENT_DURABLE_ENDPOINT_SCHEMA_VERSION,
  DurableEndpointStore,
  UnsupportedDurableEndpointVersionError,
} from "../src/server/durable-endpoint-store.js";
import type { MachineConfig } from "../src/server/types.js";

const registeredMachine = (
  host: string,
  overrides: Partial<MachineConfig> = {},
): MachineConfig => ({
  id: "dynamic-node",
  name: "Dynamic node",
  kind: "ssh",
  host,
  user: "wmux",
  sessionBackend: "auto",
  source: "registered",
  agentToken: "server-only-agent-secret",
  ...overrides,
});

test("durable endpoint records survive restart with owner-only permissions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-store-"));
  const filePath = path.join(directory, "session-endpoints.json");
  try {
    const store = new DurableEndpointStore(filePath);
    const record = store.bind("pane-one", registeredMachine("100.64.0.10"), "durable-multiplexer");
    assert.ok(record);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

    const restored = new DurableEndpointStore(filePath);
    assert.deepEqual(restored.snapshot(), store.snapshot());
    assert.equal(restored.activeForPane("pane-one")?.machine.agentToken, "server-only-agent-secret");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("static remote and session-agent endpoints are persisted while local multiplexers stay audit-owned", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-static-"));
  const filePath = path.join(directory, "session-endpoints.json");
  try {
    const store = new DurableEndpointStore(filePath);
    const remote = store.bind("pane-remote", {
      id: "static-remote",
      name: "Static remote",
      kind: "ssh",
      host: "100.64.0.20",
      user: "wmux",
      sessionBackend: "auto",
      source: "config",
    }, "durable-multiplexer");
    const agent = store.bind("pane-agent", {
      id: "static-agent",
      name: "Static agent",
      kind: "powershell-ssh",
      host: "100.64.0.21",
      user: "wmux",
      sessionBackend: "agent",
      agentPort: 3481,
      agentToken: "static-agent-secret",
      source: "config",
    }, "windows-agent");
    const local = store.bind("pane-local", {
      id: "local",
      name: "Local",
      kind: "local",
      sessionBackend: "tmux",
      source: "config",
    }, "durable-multiplexer");

    assert.equal(remote?.machine.source, "config");
    assert.equal(agent?.machine.source, "config");
    assert.equal(agent?.machine.agentToken, "static-agent-secret");
    assert.equal(local, undefined);
    assert.deepEqual(
      store.snapshot().map((record) => record.paneId).sort(),
      ["pane-agent", "pane-remote"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("version 1 endpoint ledgers migrate atomically to configured source support", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-migrate-"));
  const filePath = path.join(directory, "session-endpoints.json");
  const recordId = "84eb13dc-cf36-487d-b243-746f84359a0a";
  try {
    fs.writeFileSync(filePath, `${JSON.stringify({
      schemaVersion: 1,
      records: [{
        id: recordId,
        paneId: "pane-legacy",
        backend: "windows-agent",
        status: "active",
        machine: {
          id: "legacy-registered",
          name: "Legacy registered",
          kind: "powershell-ssh",
          host: "100.64.0.22",
          sessionBackend: "agent",
          agentPort: 3481,
          agentToken: "legacy-secret",
          source: "registered",
        },
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
      }],
    }, null, 2)}\n`, { mode: 0o600 });

    const store = new DurableEndpointStore(filePath);
    assert.equal(store.find(recordId)?.machine.source, "registered");
    assert.equal(
      JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion,
      CURRENT_DURABLE_ENDPOINT_SCHEMA_VERSION,
    );
    assert.equal(fs.statSync(`${filePath}.bak`).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reassignment strands the old endpoint and binds the replacement separately", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-reassign-"));
  const filePath = path.join(directory, "session-endpoints.json");
  try {
    const store = new DurableEndpointStore(filePath);
    const first = store.bind("pane-one", registeredMachine("100.64.0.10"), "durable-multiplexer");
    assert.ok(first);

    store.reconcile(
      new Set(["pane-one"]),
      [registeredMachine("100.64.0.11")],
    );
    const second = store.bind(
      "pane-one",
      registeredMachine("100.64.0.11"),
      "durable-multiplexer",
    );
    assert.ok(second);
    assert.notEqual(second.id, first.id);

    const records = store.recordsForPane("pane-one");
    assert.equal(records.length, 2);
    assert.equal(records.find((record) => record.id === first.id)?.status, "stranded");
    assert.equal(records.find((record) => record.id === second.id)?.status, "active");

    store.reconcile(new Set(["pane-one"]), [registeredMachine("100.64.0.10")]);
    const returned = store.bind(
      "pane-one",
      registeredMachine("100.64.0.10"),
      "durable-multiplexer",
    );
    assert.equal(returned?.id, first.id);
    assert.equal(store.recordsForPane("pane-one").length, 2);
    assert.equal(store.find(first.id).status, "active");
    assert.equal(store.find(second.id).status, "stranded");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reconciliation retains a pane-pinned agent generation across SSH hostname drift", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-generation-"));
  try {
    const store = new DurableEndpointStore(path.join(directory, "session-endpoints.json"));
    const generation: MachineConfig = {
      id: "windows",
      name: "Windows",
      kind: "powershell-ssh",
      host: "windows-new.internal",
      sessionBackend: "agent",
      agentUrl: "http://100.64.0.20:3482",
      agentPort: 3482,
      agentToken: "agent-secret",
      source: "config",
    };
    const record = store.bind("pane-generation", generation, "windows-agent");
    assert.ok(record);
    store.reconcile(
      new Set(["pane-generation"]),
      [{ ...generation, agentUrl: "http://100.64.0.30:3481", agentPort: 3481 }],
      new Map([["pane-generation", { ...generation, host: "windows-changed.internal" }]]),
    );
    assert.equal(store.find(record.id)?.status, "active");
    assert.equal(store.activeForPane("pane-generation")?.machine.agentUrl, "http://100.64.0.20:3482");
    assert.equal(
      store.bind(
        "pane-generation",
        { ...generation, host: "windows-changed.internal" },
        "windows-agent",
      )?.id,
      record.id,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid primary recovers from the last validated backup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-backup-"));
  const filePath = path.join(directory, "session-endpoints.json");
  try {
    const store = new DurableEndpointStore(filePath);
    const first = store.bind("pane-one", registeredMachine("100.64.0.10"), "durable-multiplexer");
    assert.ok(first);
    store.bind("pane-two", registeredMachine("100.64.0.10"), "durable-multiplexer");
    fs.writeFileSync(filePath, "{invalid");

    const recovered = new DurableEndpointStore(filePath);
    assert.deepEqual(recovered.snapshot().map((record) => record.id), [first.id]);
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).records.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("future endpoint ledger versions are refused without rewriting", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-future-"));
  const filePath = path.join(directory, "session-endpoints.json");
  const payload = `${JSON.stringify({
    schemaVersion: CURRENT_DURABLE_ENDPOINT_SCHEMA_VERSION + 1,
    records: [],
  })}\n`;
  try {
    fs.writeFileSync(filePath, payload, { mode: 0o600 });
    assert.throws(
      () => new DurableEndpointStore(filePath),
      UnsupportedDurableEndpointVersionError,
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), payload);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("endpoint ledger rejects unsafe parents and record files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-endpoint-security-"));
  const filePath = path.join(directory, "session-endpoints.json");
  try {
    fs.chmodSync(directory, 0o755);
    assert.throws(
      () => new DurableEndpointStore(filePath),
      /parent directory must be owner-only/,
    );

    fs.chmodSync(directory, 0o700);
    new DurableEndpointStore(filePath)
      .bind("pane-one", registeredMachine("100.64.0.10"), "durable-multiplexer");
    fs.chmodSync(filePath, 0o644);
    assert.throws(
      () => new DurableEndpointStore(filePath),
      /permissions must be 0600/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
