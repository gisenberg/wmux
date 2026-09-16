import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionBackend } from "../../src/server/backends/index.js";
import { PasteImageStaging } from "../../src/server/paste-image-staging.js";
import type { MachineConfig } from "../../src/server/types.js";
import { exerciseBackendConformance } from "./suite.js";

const available = (command: string, args = ["--version"]): boolean =>
  spawnSync(command, args, { stdio: "ignore" }).status === 0;

const runCase = async (machine: MachineConfig): Promise<void> => {
  const pasteImages = new PasteImageStaging();
  const paneId = `backend_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await exerciseBackendConformance(createSessionBackend(machine, pasteImages), paneId);
  } finally {
    pasteImages.dispose();
  }
};

test("local Windows ConPTY conforms to the shared session backend contract", {
  skip: process.platform !== "win32",
}, async () => {
  await runCase({ id: "conformance-windows", name: "Windows", kind: "local", sessionBackend: "auto" });
});

const reservePort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve agent port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
};

const waitForAgent = async (url: string, child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`POSIX agent exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The listener may not have bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for POSIX agent");
};

const stopAgent = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

test("raw PTY conforms to the shared session backend contract", { skip: process.platform === "win32" }, async () => {
  await runCase({
    id: "conformance-raw",
    name: "Conformance raw PTY",
    kind: "local",
    sessionBackend: "pty",
    shell: "/bin/sh",
  });
});

test("durable tmux conforms to the shared session backend contract", {
  skip: process.platform === "win32" || !available("tmux", ["-V"]) ? "POSIX tmux is unavailable" : false,
}, async () => {
  await runCase({
    id: "conformance-tmux",
    name: "Conformance tmux",
    kind: "local",
    sessionBackend: "tmux",
    shell: "/bin/sh",
  });
});

test("POSIX session agent conforms to the shared session backend contract", {
  skip: process.platform === "win32" ? "POSIX PTY agent runs on Linux and macOS CI" : false,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-posix-agent-"));
  const configPath = path.join(root, "session-agent.json");
  const port = await reservePort();
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port,
    token,
    backend: "pty",
    heartbeatEnabled: false,
    releaseVersion: "v-test-linux",
    stateDir: root,
  }), { mode: 0o600 });
  const child = spawn(
    process.env.PYTHON ?? "python3",
    ["scripts/wmux-session-agent", "--config", configPath],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForAgent(url, child);
    await runCase({
      id: "conformance-posix-agent",
      name: "Conformance POSIX agent",
      kind: "local",
      platform: "linux",
      sessionBackend: "agent",
      agentUrl: url,
      agentToken: token,
      shell: "/bin/sh",
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  } finally {
    await stopAgent(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows stdio agent conforms to the shared session backend contract", {
  skip: process.platform !== "win32"
    ? "Windows ConPTY and stdio agent conformance runs on Windows CI or dogfood"
    : process.env.WMUX_WINDOWS_AGENT_CONFORMANCE_URL
      ? false
      : "set WMUX_WINDOWS_AGENT_CONFORMANCE_URL to a local Python stdio agent",
}, async () => {
  await runCase({
    id: "conformance-windows",
    name: "Conformance Windows agent",
    kind: "powershell-ssh",
    host: "127.0.0.1",
    sessionBackend: "agent",
    agentUrl: process.env.WMUX_WINDOWS_AGENT_CONFORMANCE_URL,
    shell: "pwsh",
  });
});
