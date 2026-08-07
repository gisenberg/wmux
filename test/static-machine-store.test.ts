import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StaticMachineStore,
  StaticMachineStoreError,
} from "../src/server/static-machine-store.js";

test("static machine CRUD is validated, atomic, owner-only, and secret-preserving", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-static-machines-"));
  const configPath = path.join(directory, ".wmux", "config.json");
  const store = new StaticMachineStore([{
    id: "local",
    name: "Local",
    kind: "local",
    agentToken: "existing-agent-secret",
    stream: {
      provider: "moonlight-gateway",
      gatewayUrl: "http://127.0.0.1:47990",
      gatewayToken: "existing-gateway-secret",
    },
  }], configPath);
  try {
    store.create({
      id: "remote",
      name: "Remote",
      kind: "ssh",
      host: "100.64.0.8",
      user: "operator",
      sessionBackend: "auto",
    });
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(configPath)).mode & 0o777, 0o700);
    assert.deepEqual(store.snapshot().map((machine) => machine.id), ["local", "remote"]);

    const publicLocal = store.publicSnapshot().find((machine) => machine.id === "local");
    assert.equal(publicLocal?.hasAgentToken, true);
    assert.equal(publicLocal?.hasGatewayToken, true);
    assert.doesNotMatch(JSON.stringify(publicLocal), /existing-agent-secret|existing-gateway-secret/);

    store.update("local", {
      id: "local",
      name: "Renamed Local",
      kind: "local",
      stream: {
        provider: "moonlight-gateway",
        gatewayUrl: "http://127.0.0.1:47991",
      },
    });
    const updated = store.snapshot().find((machine) => machine.id === "local");
    assert.equal(updated?.agentToken, "existing-agent-secret");
    assert.equal(updated?.stream?.gatewayToken, "existing-gateway-secret");
    assert.ok(fs.existsSync(`${configPath}.bak`));

    assert.throws(
      () => store.update("local", { id: "changed", name: "Changed", kind: "local" }),
      (error) => error instanceof StaticMachineStoreError && error.code === "machine_id_immutable",
    );
    assert.throws(
      () => store.create({
        id: "leaky",
        name: "Leaky",
        kind: "ssh",
        agentToken: "must-not-enter-through-browser",
      }),
      (error) => error instanceof StaticMachineStoreError && error.code === "unsupported_machine_field",
    );

    assert.equal(store.delete("remote"), true);
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      managedMachineCatalog: boolean;
      localMachine: boolean;
      machines: Array<{ id: string }>;
    };
    assert.equal(persisted.managedMachineCatalog, true);
    assert.equal(persisted.localMachine, false);
    assert.deepEqual(persisted.machines.map((machine) => machine.id), ["local"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser updates cannot retarget a hidden session-agent token", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-static-agent-origin-"));
  const configPath = path.join(directory, ".wmux", "config.json");
  const store = new StaticMachineStore([{
    id: "agent",
    name: "Agent",
    kind: "ssh",
    host: "agent.internal",
    sessionBackend: "agent",
    agentUrl: "http://100.64.0.8:3481",
    agentPort: 3481,
    agentToken: "hidden-agent-token",
  }], configPath);
  try {
    assert.throws(
      () => store.update("agent", {
        id: "agent",
        name: "Retargeted agent",
        kind: "ssh",
        host: "agent.internal",
        sessionBackend: "agent",
        agentUrl: "http://100.64.0.9:3481",
        agentPort: 3481,
      }),
      (error) => error instanceof StaticMachineStoreError
        && error.code === "agent_endpoint_immutable_with_token",
    );
    const updated = store.update("agent", {
      id: "agent",
      name: "Renamed agent",
      kind: "ssh",
      host: "agent.internal",
      sessionBackend: "agent",
      agentUrl: "http://100.64.0.8:3481",
      agentPort: 3481,
    });
    assert.equal(updated.agentToken, "hidden-agent-token");
    assert.equal(updated.agentUrl, "http://100.64.0.8:3481");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
