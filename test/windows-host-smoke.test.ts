import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { posixHostShell } from "../src/server/host-shell.js";

test("native Windows server authenticates and runs a Git Bash pane over WebSocket", {
  skip: process.platform !== "win32", timeout: 30000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-native-smoke-"));
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const token = crypto.randomBytes(32).toString("hex");
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ machines: [
    { id: "local", name: "Git Bash", kind: "local", shell: posixHostShell(), sessionBackend: "pty" },
  ] }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WMUX_")));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts", "--host", "127.0.0.1", "--port", String(port)], {
    env: { ...env, HOME: root, USERPROFILE: root, WMUX_TOKEN: token, WMUX_CONFIG_PATH: config },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  child.stderr.on("data", (data) => { log += data; });
  let socket: WebSocket | undefined;
  let workspaceId: string | undefined;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server startup failed: ${log}`);
      if (log.includes("wmux listening")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(log, /wmux listening/);
    assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
    assert.equal((await fetch(`${base}/`, { headers })).status, 200);
    const response = await fetch(`${base}/api/workspaces`, { method: "POST", headers, body: JSON.stringify({ machineId: "local" }) });
    assert.equal(response.status, 201, await response.clone().text());
    const { workspace } = await response.json() as { workspace: { id: string; tabs: { panes: { id: string }[] }[] } };
    workspaceId = workspace.id;
    const pane = workspace.tabs[0].panes[0].id;
    socket = new WebSocket(`${base.replace("http", "ws")}/ws/panes/${pane}?cols=80&rows=24`, { headers });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Git Bash output timed out: ${log}`)), 10000);
      socket!.on("error", reject);
      let output = "";
      socket!.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "ready") socket!.send(JSON.stringify({ type: "input", data: "printf '%s%s\\n' 'WMUX_NATIVE_' 'OK'\r" }));
        if (message.type === "output") output += message.data;
        if (output.includes("WMUX_NATIVE_OK")) { clearTimeout(deadline); resolve(); }
      });
    });
  } catch (error) {
    console.error("Native smoke failure:", error, log);
    throw error;
  } finally {
    socket?.terminate();
    if (workspaceId) await fetch(`${base}/api/workspaces/${workspaceId}`, { method: "DELETE", headers }).catch(() => undefined);
    const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (child.exitCode === null) { child.kill(); await stopped; }
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
