import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { isCodexAttachmentPane, recoverCodexAttachmentTarget, verifyCodexAttachment } from "../src/server/codex-cli-attachment.js";

const start = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").trim().split(" ")[21]!;
const proof = (generation = "generation", peerExe = "") => ({ public: { enabled: true, reason: null, generation }, private: { fingerprint: "fingerprint", endpointId: "endpoint", threadId: "thread", generation, cwd: "/work", route: { launcherPath: "/launcher", deploymentPath: "/deploy", managedArgv: ["/launcher", "resume", "thread"] }, receipt: { peerExe } } });

test("marks only private bound descriptors as attachment panes and fails closed for a malformed store", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attachment-registry-"));
  const store = path.join(directory, "codex-attachments"); fs.mkdirSync(store, { mode: 0o700 });
  const descriptor = path.join(store, "123e4567-e89b-12d3-a456-426614174000.json");
  fs.writeFileSync(descriptor, JSON.stringify({ version: 1, target: { paneId: "pane" } }), { mode: 0o600 });
  try {
    assert.equal(isCodexAttachmentPane(directory, "pane"), true);
    assert.equal(isCodexAttachmentPane(directory, "other"), false);
    const pending = path.join(store, "223e4567-e89b-12d3-a456-426614174000.json");
    fs.writeFileSync(pending, JSON.stringify({ version: 1, target: { paneId: "" } }), { mode: 0o600 });
    for (let index = 0; index < 250; index++) fs.writeFileSync(path.join(store, `receipt-${index}.json`), "{}", { mode: 0o600 });
    assert.equal(isCodexAttachmentPane(directory, "other"), false, "pending descriptors and receipts do not suppress ordinary panes");
    fs.writeFileSync(path.join(store, "bad.json"), "{", { mode: 0o600 });
    assert.equal(isCodexAttachmentPane(directory, "other"), false, "non-descriptor receipts are ignored");
    fs.writeFileSync(descriptor, "{", { mode: 0o600 });
    assert.equal(isCodexAttachmentPane(directory, "other"), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("recovers only the exact private bound descriptor tuple after lost controller output", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attachment-recover-"));
  const store = path.join(directory, "codex-attachments"); fs.mkdirSync(store, { mode: 0o700 });
  const request = { requestId: "123e4567-e89b-12d3-a456-426614174000", endpointId: "endpoint", threadId: "thread", generation: "generation" };
  const descriptor = { version: 1, attestation: { endpointId: request.endpointId, threadId: request.threadId, generation: request.generation }, target: { workspaceId: "workspace", tabId: "tab", paneId: "pane", ...request } };
  fs.writeFileSync(path.join(store, `${request.requestId}.json`), JSON.stringify(descriptor), { mode: 0o600 });
  try {
    assert.deepEqual(recoverCodexAttachmentTarget(directory, request), { workspaceId: "workspace", tabId: "tab", paneId: "pane", requestId: request.requestId, threadId: request.threadId, generation: request.generation });
    assert.equal(recoverCodexAttachmentTarget(directory, { ...request, threadId: "other" }), null);
    fs.chmodSync(path.join(store, `${request.requestId}.json`), 0o644);
    assert.equal(recoverCodexAttachmentTarget(directory, request), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("verifies a target-keyed owner-only receipt across coalesced request aliases", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-attachment-proof-"));
  fs.chmodSync(directory, 0o700);
  const receipts = path.join(directory, "codex-attachments"); fs.mkdirSync(receipts, { mode: 0o700 });
  const target = { workspaceId: "workspace", tabId: "tab", paneId: "pane", requestId: "first-request", threadId: "thread", generation: "generation" };
  const key = (await import("node:crypto")).createHash("sha256").update("pane\0thread\0generation").digest("hex");
  const file = path.join(receipts, `${key}.json`);
  const cliSocket = path.join(directory, "cli.sock");
  const native = spawn(process.execPath, ["-e", "require('net').createServer().listen(process.env.CLI_SOCKET);setTimeout(() => {}, 10000)", "--", "--remote", `unix://${cliSocket}`, "resume", "thread"], { env: { ...process.env, CLI_SOCKET: cliSocket } });
  for (let index = 0; index < 100 && !fs.existsSync(cliSocket); index++) await new Promise(resolve => setTimeout(resolve, 10)); fs.chmodSync(cliSocket, 0o600);
  const nativeStart = fs.readFileSync(`/proc/${native.pid}/stat`, "utf8").trim().split(" ")[21]!;
  const nativeExe = fs.realpathSync(`/proc/${native.pid}/exe`); const socket = fs.lstatSync(cliSocket);
  const listener = Number(fs.readFileSync("/proc/net/unix", "utf8").split("\n").find(line => line.endsWith(cliSocket))!.trim().split(/\s+/).at(-2));
  fs.writeFileSync(file, JSON.stringify({ ...target, fingerprint: "fingerprint", endpointId: "endpoint", wrapperPid: process.pid, wrapperStart: start, managedPid: native.pid, managedStart: nativeStart, nativePid: native.pid, nativeStart, nativeExe, cliSocket, cliSocketDev: socket.dev, cliSocketIno: socket.ino, cliListenerIno: listener, cliPeerPid: native.pid, cliPeerStart: nativeStart, status: "startup-gated" }), { mode: 0o600 });
  try {
    assert.equal(await verifyCodexAttachment({ request: { endpointId: "endpoint", threadId: "thread" }, target: { ...target, requestId: "coalesced-request" }, storageDirectory: directory, attestation: proof("generation", nativeExe) }), true);
    fs.chmodSync(file, 0o644);
    assert.equal(await verifyCodexAttachment({ request: { endpointId: "endpoint", threadId: "thread" }, target, storageDirectory: directory, attestation: proof("generation", nativeExe) }), false);
  } finally { native.kill(); fs.rmSync(directory, { recursive: true, force: true }); }
});
