import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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

test("raw PTY conforms to the shared session backend contract", async () => {
  await runCase({
    id: "conformance-raw",
    name: "Conformance raw PTY",
    kind: "local",
    sessionBackend: "pty",
    shell: "/bin/sh",
  });
});

test("durable tmux conforms to the shared session backend contract", {
  skip: available("tmux", ["-V"]) ? false : "tmux is unavailable",
}, async () => {
  await runCase({
    id: "conformance-tmux",
    name: "Conformance tmux",
    kind: "local",
    sessionBackend: "tmux",
    shell: "/bin/sh",
  });
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
