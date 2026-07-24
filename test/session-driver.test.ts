import assert from "node:assert/strict";
import test from "node:test";
import { cwdFromDurableSessionOutput } from "../src/server/durable-session.js";
import {
  sessionBackendCapabilitiesForMachine,
  sessionBackendKindForMachine,
} from "../src/server/backends/index.js";
import type { MachineConfig } from "../src/server/types.js";

const machine = (patch: Partial<MachineConfig>): MachineConfig => ({
  id: "test",
  name: "Test",
  kind: "local",
  ...patch,
});

test("session drivers describe restart durability by backend", () => {
  assert.equal(sessionBackendCapabilitiesForMachine(machine({ sessionBackend: "tmux" })).restartDurable, true);
  assert.equal(sessionBackendCapabilitiesForMachine(machine({ sessionBackend: "pty" })).restartDurable, false);
  assert.equal(
    sessionBackendCapabilitiesForMachine(machine({ kind: "ssh", host: "example", sessionBackend: "screen" })).transport,
    "ssh-multiplexer",
  );
  assert.equal(
    sessionBackendCapabilitiesForMachine(machine({ command: ["echo", "hello"], sessionBackend: "tmux" })).restartDurable,
    false,
  );
});

test("powershell SSH agent sessions use the agent-owned driver", () => {
  const windows = machine({ kind: "powershell-ssh", host: "windows", sessionBackend: "agent" });
  assert.equal(sessionBackendKindForMachine(windows), "windows-agent");
  assert.deepEqual(sessionBackendCapabilitiesForMachine(windows), {
    transport: "windows-agent",
    restartDurable: true,
    supportsFileStaging: true,
    supportsCwdReport: true,
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
