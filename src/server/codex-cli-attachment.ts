import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliViewUncertainError as LaunchUncertainError } from "./codex-task-launches.js";

export type CodexAttachmentTarget = { workspaceId: string; tabId: string; paneId: string; requestId: string; threadId: string; generation: string };
export type CodexAttachmentAttestation = { public: { enabled: boolean; reason: string | null; generation: string | null }; private: { fingerprint: string; endpointId: string; threadId: string; generation: string; cwd: string | null; route: { launcherPath: string; deploymentPath: string; managedArgv: string[] }; receipt: Record<string, unknown> } | null };
export type CodexAttachmentRequest = { endpointId: string; threadId: string };

/** The workspace was created but its live native view could not be proved. */
export class CodexCliViewUncertainError extends LaunchUncertainError {
  constructor(message: string, readonly attachmentTarget: CodexAttachmentTarget) {
    super({ workspaceId: attachmentTarget.workspaceId, tabId: attachmentTarget.tabId, paneId: attachmentTarget.paneId });
    this.message = message;
  }
}

type Receipt = CodexAttachmentTarget & { fingerprint: string; endpointId: string; wrapperPid: number; wrapperStart: string; managedPid: number; managedStart: string; nativePid: number; nativeStart: string; nativeExe: string; cliSocket: string; cliSocketDev: number; cliSocketIno: number; cliListenerIno: number; cliPeerPid: number; cliPeerStart: string; status: "startup-gated"; invalidated?: boolean };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const id = (value: unknown) => /^[A-Za-z0-9._-]{1,256}$/.test(text(value)) ? text(value) : "";
const privateFile = (file: string) => {
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077);
};
const procStart = (pid: number) => {
  try { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/); return fields[19] || ""; } catch { return ""; }
};
const procParent = (pid: number) => { try { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1]) || 0; } catch { return 0; } };
const descends = (pid: number, ancestor: number) => { while (pid > 1) { if (pid === ancestor) return true; pid = procParent(pid); } return false; };
const ownsSocket = (root: number, inode: number) => {
  const queue = [root], seen = new Set<number>();
  while (queue.length) { const pid = queue.pop()!; if (seen.has(pid)) continue; seen.add(pid);
    try { for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) { try { if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return true; } catch {} } } catch {}
    try { for (const entry of fs.readdirSync("/proc")) if (/^\d+$/.test(entry) && procParent(Number(entry)) === pid) queue.push(Number(entry)); } catch {}
  } return false;
};
const receiptKey = (target: Pick<CodexAttachmentTarget, "paneId" | "threadId" | "generation">) => createHash("sha256").update(`${target.paneId}\0${target.threadId}\0${target.generation}`).digest("hex");
const receiptPath = (directory: string, target: Pick<CodexAttachmentTarget, "paneId" | "threadId" | "generation">) => path.join(directory, `${receiptKey(target)}.json`);

/**
 * Identifies a pane reserved for an attaching shared view before its native
 * process exists. This is deliberately only a naming-suppression hint: any
 * malformed private registry fails closed (suppresses names) and never grants
 * launch or verification authority.
 */
export function isCodexAttachmentPane(storageDirectory: string, paneId: string): boolean {
  if (!id(paneId)) return true;
  const directory = path.join(path.resolve(storageDirectory), "codex-attachments");
  try {
    if (!fs.existsSync(directory)) return false;
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) return true;
    const entries = fs.readdirSync(directory);
    const descriptors = entries.filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(name));
    if (descriptors.length > 200) return true;
    for (const name of descriptors) {
      const file = path.join(directory, name);
      if (!privateFile(file) || fs.statSync(file).size > 32 * 1024) return true;
      const descriptor = object(JSON.parse(fs.readFileSync(file, "utf8")));
      const target = object(descriptor.target);
      if (descriptor.version !== 1) return true;
      // The server writes a pending descriptor before wmuxctl creates/binds
      // the pane. It cannot affect naming until it has a concrete target.
      if (target.paneId === "" || target.paneId === undefined) continue;
      if (!id(target.paneId)) return true;
      if (target.paneId === paneId) return true;
    }
    return false;
  } catch { return true; }
}

function readReceipt(directory: string, target: CodexAttachmentTarget): Receipt | null {
  try {
    const file = receiptPath(directory, target);
    if (!privateFile(file)) return null;
    const parsed = object(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed as Receipt;
  } catch { return null; }
}

function targetMatches(receipt: Receipt, target: CodexAttachmentTarget, attestation: CodexAttachmentAttestation) {
  const proof = attestation.private;
  let nativeArgv: string[] = [];
  try { nativeArgv = fs.readFileSync(`/proc/${receipt.nativePid}/cmdline`).toString("utf8").split("\0").filter(Boolean); } catch { return false; }
  let socket: fs.Stats;
  try { socket = fs.lstatSync(receipt.cliSocket); } catch { return false; }
  return !!proof && receipt.status === "startup-gated" && receipt.invalidated !== true
    && receipt.workspaceId === target.workspaceId && receipt.tabId === target.tabId && receipt.paneId === target.paneId && receipt.threadId === target.threadId && receipt.generation === target.generation
    && receipt.fingerprint === proof.fingerprint && receipt.endpointId === proof.endpointId
    && receipt.wrapperPid > 1 && receipt.managedPid > 1 && receipt.nativePid > 1
    && socket.isSocket() && socket.uid === process.getuid?.() && !(socket.mode & 0o077) && socket.dev === receipt.cliSocketDev && socket.ino === receipt.cliSocketIno
    && procStart(receipt.wrapperPid) === receipt.wrapperStart && procStart(receipt.managedPid) === receipt.managedStart && procStart(receipt.nativePid) === receipt.nativeStart
    && fs.realpathSync(`/proc/${receipt.nativePid}/exe`) === String(proof.receipt.peerExe) && receipt.nativeExe === String(proof.receipt.peerExe)
    && procStart(receipt.cliPeerPid) === receipt.cliPeerStart && descends(receipt.nativePid, receipt.managedPid) && descends(receipt.cliPeerPid, receipt.managedPid) && ownsSocket(receipt.cliPeerPid, receipt.cliListenerIno)
    && nativeArgv.at(-4) === "--remote" && nativeArgv.at(-3) === `unix://${receipt.cliSocket}` && nativeArgv.at(-2) === "resume" && nativeArgv.at(-1) === target.threadId;
}

/**
 * Requests a server-created descriptor and turns an enabled catalog attestation
 * into a narrow target. The browser never supplies a launcher, policy, model,
 * cwd, or trust answer; those stay in the private descriptor.
 */
export async function openCodexAttachment(input: { baseUrl: string; token: string; machineId: string; attestation: CodexAttachmentAttestation; requestId?: string; storageDirectory: string }): Promise<CodexAttachmentTarget> {
  const requestId = input.requestId || randomUUID();
  const proof = input.attestation;
  if (!proof.public.enabled || !proof.private) throw new Error(`codex_attachment_unavailable:${proof.public.reason || "unknown"}`);
  if (!proof.private.cwd) throw new Error("codex_attachment_cwd_unavailable");
  const directory = path.join(path.resolve(input.storageDirectory), "codex-attachments");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const descriptor = path.join(directory, `${requestId}.json`);
  const receipt = path.join(directory, `${requestId}.receipt.json`);
  const target: CodexAttachmentTarget = { workspaceId: "", tabId: "", paneId: "", requestId, threadId: proof.private.threadId, generation: proof.private.generation };
  const payload = { version: 1, endpointId: proof.private.endpointId, attestation: proof.private, receiptFile: receipt, target };
  try { fs.writeFileSync(descriptor, JSON.stringify(payload), { mode: 0o600, flag: "wx" }); fs.chmodSync(descriptor, 0o600); }
  catch { throw new Error("codex_attachment_descriptor_unavailable"); }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const script = path.join(root, "skills/wmux/scripts/wmuxctl.py");
  const args = [script, "tui", "codex", input.machineId, "--directory", proof.private.cwd, "--no-prompt", "--user-created", "--codex-attach-file", descriptor];
  const response = await new Promise<{ output: string; failed: boolean }>(resolve => execFile("python3", args, { timeout: 100_000, maxBuffer: 256 * 1024, env: { ...process.env, WMUX_URL: input.baseUrl, WMUX_AUTOMATION_TOKEN: input.token || "wmux-auth-disabled-placeholder-000000000000" } }, (error, stdout) => resolve({ output: stdout, failed: Boolean(error) })));
  const body = object((() => { try { return JSON.parse(response.output); } catch { return {}; } })());
  const opened = { ...target, workspaceId: id(body.workspaceId), tabId: id(body.tabId), paneId: id(body.paneId) };
  if (!opened.workspaceId || !opened.tabId || !opened.paneId) throw new Error("codex_attachment_view_unavailable");
  if (response.failed) throw new CodexCliViewUncertainError("codex_attachment_view_uncertain", opened);
  return opened;
}

/**
 * Recovers only a server-created descriptor target after controller stdout is
 * lost. It does not inspect a process or receipt and therefore grants no
 * authority; callers must follow it with verifyCodexAttachment.
 */
export function recoverCodexAttachmentTarget(storageDirectory: string, request: { requestId: string; endpointId: string; threadId: string; generation: string }): CodexAttachmentTarget | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.requestId) || !id(request.endpointId) || !id(request.threadId) || !id(request.generation)) return null;
  const directory = path.join(path.resolve(storageDirectory), "codex-attachments");
  const descriptor = path.join(directory, `${request.requestId}.json`);
  try {
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) || !privateFile(descriptor) || fs.statSync(descriptor).size > 32 * 1024) return null;
    const data = object(JSON.parse(fs.readFileSync(descriptor, "utf8")));
    const attestation = object(data.attestation), target = object(data.target);
    if (data.version !== 1 || attestation.endpointId !== request.endpointId || attestation.threadId !== request.threadId || attestation.generation !== request.generation) return null;
    const recovered: CodexAttachmentTarget = { workspaceId: id(target.workspaceId), tabId: id(target.tabId), paneId: id(target.paneId), requestId: id(target.requestId), threadId: id(target.threadId), generation: id(target.generation) };
    return recovered.workspaceId && recovered.tabId && recovered.paneId && recovered.requestId === request.requestId && recovered.threadId === request.threadId && recovered.generation === request.generation ? recovered : null;
  } catch { return null; }
}

/** Reattests the route and validates a private, live receipt. Request aliases share a target-keyed receipt. */
export async function verifyCodexAttachment(input: { request: CodexAttachmentRequest; target: CodexAttachmentTarget; attestation: CodexAttachmentAttestation; storageDirectory: string }): Promise<boolean> {
  const proof = input.attestation;
  if (!proof.private || !proof.public.enabled || proof.private.generation !== input.target.generation || proof.private.endpointId !== input.request.endpointId || proof.private.threadId !== input.request.threadId) return false;
  const receipt = readReceipt(path.join(input.storageDirectory, "codex-attachments"), input.target);
  try { return !!receipt && targetMatches(receipt, input.target, proof); } catch { return false; }
}
