import assert from "node:assert/strict";
import test from "node:test";
import { sshControlArgs, sshControlOnlyArgs } from "../src/server/ssh-control.js";
import { buildSpawnSpec, localMachine } from "../src/server/spawn-backends.js";
import { sessionBackendCapabilitiesForMachine, sessionBackendKindForMachine } from "../src/server/backends/index.js";

test("Windows local defaults launch PowerShell directly with honest durability", { skip: process.platform !== "win32" }, () => {
  const machine = localMachine();
  assert.equal(machine.sessionBackend, "pty");
  const spec = buildSpawnSpec(machine, 80, 24, { WMUX_START_CWD: "C:\\work" });
  assert.equal(spec.file, "powershell.exe");
  assert.equal(spec.cwd, "C:\\work");
  assert.equal(Object.keys(spec.env).filter((key) => key.toUpperCase() === "PATH").length, 1);
  assert.ok(spec.env.PATH.endsWith(process.env.PATH ?? ""));
  assert.match(spec.args.at(-1)!, /__wmuxInstallPrompt \$true/);
  const auto = { ...machine, sessionBackend: "auto" as const };
  assert.equal(sessionBackendKindForMachine(auto), "raw-pty");
  assert.equal(sessionBackendCapabilitiesForMachine(auto).restartDurable, false);
  assert.equal(sessionBackendCapabilitiesForMachine(auto).refreshClient, false);
  assert.deepEqual(sshControlArgs("fixture", true), ["-o", "ControlMaster=no", "-o", "ControlPath=none"]);
  assert.throws(() => sshControlOnlyArgs("fixture"), /unavailable on a Windows host/);
  assert.throws(() => buildSpawnSpec({ ...machine, sessionBackend: "tmux" }, 80, 24), /do not support/);
  assert.deepEqual(buildSpawnSpec({ ...machine, shell: "cmd.exe" }, 80, 24).args, []);
});
