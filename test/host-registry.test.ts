import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BOOTSTRAP_TOKEN_GRACE_MS,
  CURRENT_HOST_REGISTRY_SCHEMA_VERSION,
  HostRegistry,
  HostRegistryError,
  InvalidHostRegistryError,
  MAX_HOSTS_PER_ADDRESS,
  MAX_METADATA_BYTES,
  MIN_REGISTRATION_INTERVAL_MS,
  MIN_HOST_TTL_MS,
  UnsupportedHostRegistryVersionError,
} from "../src/server/host-registry.js";
import type { MachineConfig } from "../src/server/types.js";

const staticMachines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];

const tempRegistry = (): { dir: string; filePath: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-registry-"));
  return { dir, filePath: path.join(dir, "registry.json") };
};

test("merges registered hosts and derives the destination from the observed address", () => {
  const { dir, filePath } = tempRegistry();
  const registry = new HostRegistry(staticMachines, filePath);
  try {
    const now = Date.parse("2026-07-08T00:00:00.000Z");
    registry.register(
      {
        machine: {
          id: "worker-1",
          name: "Worker 1",
          kind: "ssh",
          host: "ignored.example",
          user: "wmux",
          sessionBackend: "tmux",
        },
        ttlMs: 60_000,
        metadata: { role: "test" },
      },
      "::ffff:100.70.0.10",
      now,
    );

    const machines = registry.machines(now);
    assert.deepEqual(machines.map((machine) => machine.id), ["local", "worker-1"]);
    assert.equal(machines[0].source, "config");
    assert.equal(machines[1].source, "registered");
    assert.equal(machines[1].host, "100.70.0.10");
    assert.equal(machines[1].lastSeenAt, "2026-07-08T00:00:00.000Z");
    assert.equal(machines[1].online, true);
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a later heartbeat moves the dial-back address and lapsed hosts stay offline", () => {
  const { dir, filePath } = tempRegistry();
  const registry = new HostRegistry(staticMachines, filePath);
  try {
    const now = Date.parse("2026-07-08T00:00:00.000Z");
    const ttlMs = 60_000;
    const input = { machine: { id: "roamer", name: "Roamer", kind: "ssh" }, ttlMs };
    registry.register(input, "100.70.0.10", now);
    const firstBootstrapToken = registry.bootstrapToken("roamer");
    assert.ok(firstBootstrapToken);
    registry.register(input, "100.70.0.11", now + MIN_REGISTRATION_INTERVAL_MS);
    const nextBootstrapToken = registry.bootstrapToken("roamer");
    assert.ok(nextBootstrapToken);
    assert.notEqual(nextBootstrapToken, firstBootstrapToken);
    assert.equal(
      registry.acceptsBootstrapToken("roamer", firstBootstrapToken, now + MIN_REGISTRATION_INTERVAL_MS),
      true,
    );
    assert.equal(
      registry.acceptsBootstrapToken(
        "roamer",
        firstBootstrapToken,
        now + MIN_REGISTRATION_INTERVAL_MS + BOOTSTRAP_TOKEN_GRACE_MS + 1,
      ),
      false,
    );
    assert.equal(registry.machines(now + MIN_REGISTRATION_INTERVAL_MS)[1].host, "100.70.0.11");
    const afterExpiry = now + MIN_REGISTRATION_INTERVAL_MS + ttlMs + 2_000;
    assert.equal(registry.machines(afterExpiry)[1].online, false);
    assert.equal(registry.snapshot(afterExpiry)[0].active, false);
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registration accepts only remote-safe machine fields", () => {
  const forbiddenMachines = [
    { id: "bad-command", name: "Bad", kind: "ssh", command: ["id"] },
    { id: "bad-url", name: "Bad", kind: "powershell-ssh", agentUrl: "http://127.0.0.1:9" },
    { id: "bad-stream", name: "Bad", kind: "ssh", stream: { gatewayUrl: "http://127.0.0.1:9" } },
    { id: "bad-local", name: "Bad", kind: "local" },
    { id: "bad-service", name: "Bad", kind: "service" },
  ];

  for (const machine of forbiddenMachines) {
    const { dir, filePath } = tempRegistry();
    const registry = new HostRegistry(staticMachines, filePath);
    try {
      assert.throws(
        () => registry.register({ machine }, "100.70.0.20"),
        (error) => error instanceof HostRegistryError && error.code === "invalid_registration",
      );
    } finally {
      registry.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("observed-host Windows agent tokens work but never appear in public snapshots", () => {
  const { dir, filePath } = tempRegistry();
  const registry = new HostRegistry(staticMachines, filePath);
  try {
    const result = registry.register(
      {
        machine: {
          id: "dynamic-win",
          name: "Dynamic Windows",
          kind: "powershell-ssh",
          host: "spoofed.example",
          user: "operator",
          sessionBackend: "agent",
          agentPort: 3481,
          agentToken: "private-agent-token",
        },
      },
      "100.70.0.8",
    );

    const machine = registry.machines()[1];
    assert.equal(machine.host, "100.70.0.8");
    assert.equal(machine.agentToken, "private-agent-token");
    assert.equal("host" in result.machine, false);
    assert.equal("agentToken" in result.machine, false);
    assert.equal("bootstrapToken" in result, false);
    assert.ok(registry.bootstrapToken("dynamic-win"));
    assert.doesNotMatch(JSON.stringify(registry.snapshot()), /private-agent-token|spoofed\.example/);

    assert.throws(
      () => registry.register(
        { machine: { ...result.machine, agentPort: undefined, agentToken: "bad" } },
        "100.70.0.8",
      ),
      (error) => error instanceof HostRegistryError && error.code === "invalid_registration",
    );
    assert.throws(
      () => registry.register(
        {
          machine: { id: "huge-metadata", name: "Huge metadata", kind: "ssh" },
          metadata: { payload: "x".repeat(MAX_METADATA_BYTES) },
        },
        "100.70.0.2",
      ),
      (error) => error instanceof HostRegistryError && error.code === "invalid_registration",
    );
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects missing addresses, static collisions, and invalid TTLs", () => {
  const { dir, filePath } = tempRegistry();
  const registry = new HostRegistry(staticMachines, filePath);
  try {
    assert.throws(
      () => registry.register({ machine: { id: "worker", name: "Worker", kind: "ssh" } }, undefined),
      (error) => error instanceof HostRegistryError && error.code === "invalid_observed_address",
    );
    assert.throws(
      () => registry.register({ machine: { id: "local", name: "Override", kind: "ssh" } }, "100.70.0.2"),
      (error) => error instanceof HostRegistryError && error.status === 409,
    );
    assert.throws(
      () => registry.register({ machine: { id: "worker", name: "Worker", kind: "ssh" }, ttlMs: 5_000 }, "100.70.0.2"),
      (error) => error instanceof HostRegistryError && error.code === "invalid_registration",
    );
    assert.throws(
      () => registry.register({ machine: { id: "public", name: "Public", kind: "ssh" } }, "198.51.100.2"),
      (error) => error instanceof HostRegistryError && error.code === "invalid_observed_address",
    );
    assert.throws(
      () => registry.register({
        machine: {
          id: "open-agent",
          name: "Open agent",
          kind: "powershell-ssh",
          sessionBackend: "agent",
          agentPort: 3481,
        },
      }, "100.70.0.2"),
      (error) => error instanceof HostRegistryError && error.code === "invalid_registration",
    );
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rate and per-address limits bound registration write amplification", () => {
  const { dir, filePath } = tempRegistry();
  const registry = new HostRegistry(staticMachines, filePath);
  try {
    const now = Date.parse("2026-07-08T00:00:00.000Z");
    const input = { machine: { id: "rate-limited", name: "Rate limited", kind: "ssh" as const } };
    registry.register(input, "100.70.0.40", now);
    const outsideInput = { machine: { id: "outside", name: "Outside", kind: "ssh" as const } };
    registry.register(outsideInput, "100.70.0.41", now);
    assert.throws(
      () => registry.register(input, "100.70.0.40", now + MIN_REGISTRATION_INTERVAL_MS - 1),
      (error) => error instanceof HostRegistryError && error.code === "heartbeat_too_frequent",
    );

    for (let index = 1; index < MAX_HOSTS_PER_ADDRESS; index += 1) {
      registry.register(
        { machine: { id: `host-${index}`, name: `Host ${index}`, kind: "ssh" } },
        "100.70.0.40",
        now,
      );
    }
    assert.throws(
      () => registry.register(
        { machine: { id: "one-too-many", name: "One too many", kind: "ssh" } },
        "100.70.0.40",
        now,
      ),
      (error) => error instanceof HostRegistryError && error.code === "address_capacity",
    );
    assert.throws(
      () => registry.register(outsideInput, "100.70.0.40", now + MIN_REGISTRATION_INTERVAL_MS),
      (error) => error instanceof HostRegistryError && error.code === "address_capacity",
    );
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("referenced hosts can roam but pin descriptors, and unreferenced agent credentials can rotate", () => {
  const { dir, filePath } = tempRegistry();
  let retained = true;
  let liveAgent = true;
  const registry = new HostRegistry(
    staticMachines,
    filePath,
    60_000,
    (id) => retained && (id === "busy" || id === "busy-agent"),
    undefined,
    (id) => liveAgent && id === "busy-agent",
  );
  try {
    const now = Date.parse("2026-07-08T00:00:00.000Z");
    const input = { machine: { id: "busy", name: "Busy", kind: "ssh" as const, user: "wmux" } };
    registry.register(input, "100.70.0.50", now);
    registry.register(input, "100.70.0.51", now + MIN_REGISTRATION_INTERVAL_MS);
    assert.equal(registry.machines(now + MIN_REGISTRATION_INTERVAL_MS)[1].host, "100.70.0.51");
    assert.throws(
      () => registry.register(
        { machine: { ...input.machine, user: "takeover" } },
        "100.70.0.51",
        now + MIN_REGISTRATION_INTERVAL_MS * 2,
      ),
      (error) => error instanceof HostRegistryError && error.code === "machine_in_use",
    );
    assert.throws(
      () => registry.register(
        { machine: { ...input.machine, sessionBackend: "tmux" } },
        "100.70.0.51",
        now + MIN_REGISTRATION_INTERVAL_MS * 2,
      ),
      (error) => error instanceof HostRegistryError && error.code === "machine_in_use",
    );
    assert.throws(
      () => registry.unregister("busy"),
      (error) => error instanceof HostRegistryError && error.code === "machine_in_use",
    );
    assert.equal(registry.sweep(now + 60_001), false);
    assert.equal(registry.snapshot().length, 1);

    const agentInput = {
      machine: {
        id: "busy-agent",
        name: "Busy agent",
        kind: "powershell-ssh" as const,
        sessionBackend: "agent" as const,
        agentPort: 3481,
        agentToken: "first-agent-token",
      },
    };
    registry.register(agentInput, "100.70.0.52", now);
    assert.throws(
      () => registry.register(
        { machine: { ...agentInput.machine, agentToken: "rotated-agent-token" } },
        "100.70.0.52",
        now + MIN_REGISTRATION_INTERVAL_MS,
      ),
      (error) => error instanceof HostRegistryError && error.code === "machine_in_use",
    );
    liveAgent = false;
    assert.throws(
      () => registry.register(
        { machine: { ...agentInput.machine, agentToken: "rotated-agent-token" } },
        "100.70.0.52",
        now + MIN_REGISTRATION_INTERVAL_MS * 2,
      ),
      (error) => error instanceof HostRegistryError && error.code === "machine_in_use",
    );
    retained = false;
    registry.register(
      { machine: { ...agentInput.machine, agentToken: "rotated-agent-token" } },
      "100.70.0.52",
      now + MIN_REGISTRATION_INTERVAL_MS * 2,
    );

    assert.equal(registry.unregister("busy"), true);
    assert.equal(registry.unregister("busy-agent"), true);
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy persisted records load with host overrides and unsafe extras removed", () => {
  const { dir, filePath } = tempRegistry();
  const now = Date.now();
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      hosts: [
        {
          id: "legacy-win",
          machine: {
            id: "legacy-win",
            name: "Legacy Windows",
            kind: "powershell-ssh",
            host: "legacy-spoof.example",
            user: "operator",
            sessionBackend: "agent",
            agentPort: 3481,
            agentToken: "legacy-agent-token",
            command: ["unsafe"],
            agentUrl: "http://127.0.0.1:9",
            stream: { gatewayToken: "stream-secret" },
          },
          registeredAt: new Date(now - 1_000).toISOString(),
          lastSeenAt: new Date(now - 1_000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
          ttlMs: 60_000,
          observedAddress: "100.70.0.9",
        },
      ],
    }),
  );

  const registry = new HostRegistry(staticMachines, filePath);
  try {
    const machine = registry.machines()[1];
    assert.equal(machine.host, "100.70.0.9");
    assert.equal(machine.agentToken, "legacy-agent-token");
    assert.equal(machine.command, undefined);
    assert.equal(machine.agentUrl, undefined);
    assert.equal(machine.stream, undefined);
    const serialized = JSON.stringify(registry.snapshot());
    assert.doesNotMatch(serialized, /legacy-agent-token|legacy-spoof|unsafe|stream-secret/);
    assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /legacy-spoof|unsafe|stream-secret/);
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, CURRENT_HOST_REGISTRY_SCHEMA_VERSION);
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("future registry versions fail closed without touching the file", () => {
  const { dir, filePath } = tempRegistry();
  const contents = `${JSON.stringify({
    schemaVersion: CURRENT_HOST_REGISTRY_SCHEMA_VERSION + 1,
    hosts: [],
    futureField: { preserve: true },
  }, null, 2)}\n`;
  fs.writeFileSync(filePath, contents);
  try {
    assert.throws(
      () => new HostRegistry(staticMachines, filePath),
      (error) => error instanceof UnsupportedHostRegistryVersionError,
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), contents);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid current-schema records fail closed without loading or rewriting a partial catalog", () => {
  const { dir, filePath } = tempRegistry();
  const seed = new HostRegistry(staticMachines, filePath);
  seed.register({ machine: { id: "valid-one", name: "Valid one", kind: "ssh" } }, "100.70.0.61");
  seed.register({ machine: { id: "valid-two", name: "Valid two", kind: "ssh" } }, "100.70.0.62");
  seed.dispose();

  const document = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    schemaVersion: number;
    hosts: Array<Record<string, unknown> & { machine: Record<string, unknown> }>;
  };
  const invalid = structuredClone(document.hosts[0]);
  invalid.id = "invalid-middle";
  invalid.machine.id = "invalid-middle";
  invalid.futureField = "must-not-be-stripped";
  document.hosts.splice(1, 0, invalid);
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  fs.writeFileSync(filePath, contents);

  try {
    assert.throws(
      () => new HostRegistry(staticMachines, filePath),
      (error) => error instanceof InvalidHostRegistryError,
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), contents);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the semantic local machine id stays reserved without a static local machine", () => {
  const { dir, filePath } = tempRegistry();
  const registry = new HostRegistry([], filePath);
  try {
    assert.throws(
      () => registry.register({ machine: { id: "local", name: "Claimed local", kind: "ssh" } }, "100.70.0.2"),
      (error) => error instanceof HostRegistryError && error.code === "static_machine_id",
    );
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registrations survive restart and can be removed", () => {
  const { dir, filePath } = tempRegistry();
  const first = new HostRegistry(staticMachines, filePath);
  first.register({ machine: { id: "durable", name: "Durable", kind: "ssh" } }, "100.70.0.7");
  first.dispose();

  const second = new HostRegistry(staticMachines, filePath);
  try {
    assert.equal(second.machines()[1].host, "100.70.0.7");
    assert.equal(second.unregister("durable"), true);
    assert.equal(second.unregister("durable"), false);
    assert.deepEqual(second.machines().map((machine) => machine.id), ["local"]);
  } finally {
    second.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retention is scheduled even after the heartbeat TTL has already lapsed", async () => {
  const { dir, filePath } = tempRegistry();
  const now = Date.now();
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      hosts: [
        {
          id: "stale",
          machine: { id: "stale", name: "Stale", kind: "ssh" },
          registeredAt: new Date(now - 1_000).toISOString(),
          lastSeenAt: new Date(now + 200).toISOString(),
          expiresAt: new Date(now - 1).toISOString(),
          ttlMs: MIN_HOST_TTL_MS,
          observedAddress: "100.70.0.30",
        },
      ],
    }),
  );

  const registry = new HostRegistry(staticMachines, filePath, 100);
  try {
    assert.equal(registry.snapshot()[0].active, false);
    await Promise.race([
      once(registry, "change"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("retention timer did not fire")), 1_000)),
    ]);
    assert.deepEqual(registry.snapshot(), []);
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
