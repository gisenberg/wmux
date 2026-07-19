import assert from "node:assert/strict";
import test from "node:test";
import { cwdFromDurableSessionOutput } from "../src/server/durable-session.js";
import { sessionCapabilitiesForMachine, sessionDriverForMachine } from "../src/server/session-driver.js";
import type { MachineConfig } from "../src/server/types.js";

const machine = (patch: Partial<MachineConfig>): MachineConfig => ({
  id: "test",
  name: "Test",
  kind: "local",
  ...patch,
});

test("session drivers describe restart durability by backend", () => {
  assert.equal(sessionCapabilitiesForMachine(machine({ sessionBackend: "tmux" })).restartDurable, true);
  assert.equal(sessionCapabilitiesForMachine(machine({ sessionBackend: "pty" })).restartDurable, false);
  assert.equal(
    sessionCapabilitiesForMachine(machine({ kind: "ssh", host: "example", sessionBackend: "screen" })).transport,
    "ssh-multiplexer",
  );
  assert.equal(
    sessionCapabilitiesForMachine(machine({ command: ["echo", "hello"], sessionBackend: "tmux" })).restartDurable,
    false,
  );
});

test("powershell SSH agent sessions use the agent-owned driver", () => {
  const windows = machine({ kind: "powershell-ssh", host: "windows", sessionBackend: "agent" });
  assert.equal(sessionDriverForMachine(windows).id, "windows-agent");
  assert.deepEqual(sessionCapabilitiesForMachine(windows), {
    transport: "windows-agent",
    restartDurable: true,
    replay: true,
    resize: true,
    cwd: "agent",
    agentOwned: true,
    refreshClient: false,
  });
});

test("durable cwd parsing ignores login-profile output before the tmux result", () => {
  assert.equal(
    cwdFromDurableSessionOutput("login notice\n/misleading/profile/path\nwmux-cwd:/home/operator/project\n"),
    "/home/operator/project",
  );
  assert.equal(cwdFromDurableSessionOutput("login notice\n/misleading/profile/path\n"), undefined);
});
