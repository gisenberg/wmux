import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { SessionManager } from "../src/server/session-manager.js";
import { buildSpawnSpec } from "../src/server/spawn-backends.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("SSH staging keeps registration capability in owner-only runtime payload and stages broker helper", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-stage-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  const capability = `aic_${"a".repeat(36)}.${"C".repeat(43)}`;
  try {
    const spec = buildSpawnSpec(
      { id: "remote", name: "Remote", kind: "ssh", host: "100.64.0.2", sessionBackend: "auto" },
      80,
      24,
      {
        WMUX_PANE_ID: "pane-stage",
        WMUX_WORKSPACE_ID: "workspace-stage",
        WMUX_TAB_ID: "tab-stage",
        WMUX_URL: "http://100.64.0.1:3478",
        WMUX_AGENT_INPUT_REGISTRATION_CAPABILITY: capability,
      },
    );
    assert.doesNotMatch(JSON.stringify(spec.env), new RegExp(capability));
    assert.doesNotMatch(JSON.stringify(spec.args), new RegExp(capability));
    const wrapper = spec.args[0];
    const wrapperText = fs.readFileSync(wrapper, "utf8");
    const payloadMatch = /wmux_payload='([^']+)'/.exec(wrapperText);
    assert.ok(payloadMatch);
    const payload = fs.readFileSync(payloadMatch[1], "utf8");
    assert.equal(fs.statSync(payloadMatch[1]).mode & 0o777, 0o600);
    assert.match(payload, new RegExp(capability));
    assert.match(payload, /wmux_home_dir=.*\.wmux/);
    assert.match(payload, /wmux_agent_input_dir=.*agent-input/);
    assert.match(payload, /wmux-agent-input-broker/);
  } finally {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local runtime staging refuses a symlinked runtime directory before writing capability material", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-input-stage-link-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  try {
    const wmuxDirectory = path.join(directory, "wmux");
    const target = path.join(directory, "redirected");
    fs.mkdirSync(wmuxDirectory, { mode: 0o700 });
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, path.join(wmuxDirectory, "runtimes"));
    assert.throws(() => buildSpawnSpec(
      { id: "local", name: "Local", kind: "local", sessionBackend: "auto" },
      80,
      24,
      {
        WMUX_PANE_ID: "pane-stage-link",
        WMUX_WORKSPACE_ID: "workspace-stage-link",
        WMUX_TAB_ID: "tab-stage-link",
        WMUX_AGENT_INPUT_REGISTRATION_CAPABILITY: `aic_${"b".repeat(36)}.${"D".repeat(43)}`,
      },
    ), /runtime directory is unsafe/);
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("POSIX session agent stages capability bytes outside pane env and exposes only broker paths", () => {
  const source = String.raw`
import base64
import hashlib
import json
import os
import runpy
import tempfile

module = runpy.run_path("scripts/wmux-windows-agent")
capability = b"aic_agent_runtime_capability\n"
with tempfile.TemporaryDirectory() as home:
    os.chmod(home, 0o700)
    os.environ["HOME"] = home
    os.environ.pop("XDG_RUNTIME_DIR", None)
    payload = {
        "runtimeFiles": [{
            "purpose": "agent-input-capability",
            "dataBase64": base64.b64encode(capability).decode("ascii"),
            "sha256": hashlib.sha256(capability).hexdigest(),
        }],
        "env": {
            "WMUX_AGENT_INPUT_REGISTRATION_CAPABILITY": "must-not-cross",
            "WMUX_TOKEN": "broad-session-token",
        },
    }
    module["stage_runtime_files"](payload, "pane-agent")
    capability_path = payload["env"]["WMUX_AGENT_INPUT_CAPABILITY_PATH"]
    credential_path = payload["env"]["WMUX_AGENT_INPUT_CREDENTIAL_PATH"]
    capability_mode = oct(os.stat(capability_path).st_mode & 0o777)
    with open(capability_path, "rb") as handle:
        capability_value = handle.read().decode("ascii")
    outside = os.path.join(home, "outside")
    with open(outside, "wb") as handle:
        handle.write(b"outside")
    os.unlink(capability_path)
    os.symlink(outside, capability_path)
    refused = False
    try:
        module["stage_runtime_files"](payload, "pane-agent")
    except ValueError:
        refused = True
    with open(outside, "rb") as handle:
        outside_value = handle.read().decode("ascii")
    print(json.dumps({
        "capabilityPath": capability_path,
        "credentialPath": credential_path,
        "directoryMode": oct(os.stat(os.path.dirname(capability_path)).st_mode & 0o777),
        "capabilityMode": capability_mode,
        "capabilityValue": capability_value,
        "registrationInEnv": "WMUX_AGENT_INPUT_REGISTRATION_CAPABILITY" in payload["env"],
        "broadTokenPreservedForSession": payload["env"].get("WMUX_TOKEN"),
        "symlinkRefused": refused,
        "outside": outside_value,
    }))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const staged = JSON.parse(result.stdout);
  assert.match(staged.capabilityPath, /agent-input\.cap$/);
  assert.match(staged.credentialPath, /agent-input\.json$/);
  assert.equal(staged.directoryMode, "0o700");
  assert.equal(staged.capabilityMode, "0o600");
  assert.equal(staged.capabilityValue, "aic_agent_runtime_capability\n");
  assert.equal(staged.registrationInEnv, false);
  assert.equal(staged.broadTokenPreservedForSession, "broad-session-token");
  assert.equal(staged.symlinkRefused, true);
  assert.equal(staged.outside, "outside");
});

test("local and SSH agent backends carry pane capability only as an authenticated runtime file", async () => {
  for (const kind of ["local", "ssh"] as const) {
    const captured: any[] = [];
    const agent = http.createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/health") {
        response.end(JSON.stringify({ ok: true, protocolVersion: 6, capabilities: ["posix-runtime-files-v1"] }));
        return;
      }
      if (request.method === "POST" && request.url?.startsWith("/sessions/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.end(JSON.stringify({ id: request.url.split("/")[2], pid: 1, base: 0, cursor: 0 }));
        return;
      }
      if (request.method === "GET" && request.url?.includes("/output?")) {
        response.end(JSON.stringify({ base: 0, cursor: 0, dataBase64: "" }));
        return;
      }
      response.end(JSON.stringify({ removed: true }));
    });
    agent.listen(0, "127.0.0.1");
    await once(agent, "listening");
    const address = agent.address();
    if (!address || typeof address === "string") throw new Error("agent unavailable");
    const machine: MachineConfig = {
      id: `${kind}-agent`, name: `${kind} agent`, kind,
      ...(kind === "ssh" ? { host: "127.0.0.1" } : {}),
      sessionBackend: "agent", agentPort: address.port, agentToken: "agent-token",
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `wmux-${kind}-agent-stage-`));
    const state = new StateStore([machine], path.join(directory, "state.json"));
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    const capability = `aic_${kind}_${"x".repeat(40)}`;
    manager.setAgentInputCapabilityIssuer(() => ({ capability, capabilityId: `${kind}-capability`, expiresAt: Date.now() + 60_000 }));
    try {
      manager.attach(pane.id, new FakeSocket() as unknown as WebSocket, 80, 24);
      await waitFor(() => captured.length === 1);
      const payload = captured[0];
      assert.equal(payload.runtimeFiles.length, 1);
      assert.equal(payload.runtimeFiles[0].purpose, "agent-input-capability");
      assert.equal(Buffer.from(payload.runtimeFiles[0].dataBase64, "base64").toString("utf8"), `${capability}\n`);
      assert.doesNotMatch(JSON.stringify(payload.env), new RegExp(capability));
      assert.equal("WMUX_AGENT_INPUT_REGISTRATION_CAPABILITY" in payload.env, false);
      assert.equal("WMUX_AGENT_INPUT_CAPABILITY_PATH" in payload.env, false);
      assert.equal("WMUX_AGENT_INPUT_CREDENTIAL_PATH" in payload.env, false);
    } finally {
      manager.disposeAll();
      agent.close();
      agent.closeAllConnections();
      await once(agent, "close");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("feature-disabled, legacy POSIX, and Windows agent sessions start without agent-input runtime files", async () => {
  const cases = [
    { id: "disabled", kind: "local" as const, issueCapability: false },
    { id: "legacy-posix", kind: "ssh" as const, issueCapability: true },
    { id: "windows", kind: "powershell-ssh" as const, issueCapability: true },
  ];
  for (const scenario of cases) {
    const machineKind = scenario.kind;
    const captured: any[] = [];
    const agent = http.createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify(machineKind !== "powershell-ssh"
          ? { ok: true, protocolVersion: 6, capabilities: [] }
          : { ok: true, protocolVersion: 6, releaseVersion: "", capabilities: [] }));
        return;
      }
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.end(JSON.stringify({ pid: 1, base: 0, cursor: 0 }));
        return;
      }
      response.end(JSON.stringify({ removed: true }));
    });
    agent.listen(0, "127.0.0.1");
    await once(agent, "listening");
    const address = agent.address();
    if (!address || typeof address === "string") throw new Error("agent unavailable");
    const machine: MachineConfig = {
      id: `${scenario.id}-no-stage`, name: "No stage", kind: machineKind,
      ...(machineKind === "local" ? {} : { host: "127.0.0.1" }),
      sessionBackend: "agent", agentPort: address.port, agentToken: "agent-token",
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-no-stage-"));
    const state = new StateStore([machine], path.join(directory, "state.json"));
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    const manager = new SessionManager(state, [machine]);
    if (scenario.issueCapability) {
      manager.setAgentInputCapabilityIssuer(() => ({ capability: "must-not-cross", capabilityId: `${scenario.id}-capability`, expiresAt: Date.now() + 60_000 }));
    }
    try {
      manager.attach(pane.id, new FakeSocket() as unknown as WebSocket, 80, 24);
      await waitFor(() => captured.length === 1);
      assert.deepEqual(captured[0].runtimeFiles, []);
      assert.doesNotMatch(JSON.stringify(captured[0]), /must-not-cross/);
    } finally {
      manager.disposeAll();
      agent.close();
      agent.closeAllConnections();
      await once(agent, "close");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("normal SSH and raw spawn specs preserve existing staging boundaries", () => {
  const normalSsh = buildSpawnSpec(
    { id: "normal-ssh", name: "Normal SSH", kind: "ssh", host: "127.0.0.1", sessionBackend: "auto" },
    80,
    24,
    { WMUX_PANE_ID: "normal-pane" },
  );
  assert.doesNotMatch(JSON.stringify(normalSsh), /WMUX_AGENT_INPUT_(?:CAPABILITY|CREDENTIAL|REGISTRATION)/);
  const raw = buildSpawnSpec(
    { id: "raw", name: "Raw", kind: "local", sessionBackend: "pty" },
    80,
    24,
    {
      WMUX_PANE_ID: "raw-pane",
      WMUX_AGENT_INPUT_CAPABILITY_PATH: "/private/raw-pane.cap",
      WMUX_AGENT_INPUT_CREDENTIAL_PATH: "/private/raw-pane.json",
    },
  );
  assert.equal(raw.env.WMUX_AGENT_INPUT_CAPABILITY_PATH, "/private/raw-pane.cap");
  assert.equal(raw.env.WMUX_AGENT_INPUT_CREDENTIAL_PATH, "/private/raw-pane.json");
});

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  send(): void {}
  close(): void { this.readyState = 3; }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for staged agent payload");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
