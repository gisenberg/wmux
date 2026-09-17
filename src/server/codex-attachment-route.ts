import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexCatalogEndpointConfig } from "./codex-task-catalog.js";
import { queryCodexCatalog } from "./codex-catalog-rpc.js";

const THREAD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type AttachmentPublic = { enabled: boolean; reason: string | null; generation: string | null };
export type AttachmentAttestation = { public: AttachmentPublic; private: { fingerprint: string; endpointId: string; threadId: string; generation: string; cwd: string | null; route: { launcherPath: string; deploymentPath: string; managedArgv: string[] }; receipt: Record<string, unknown> } | null };
export type AttachmentProbe = (input: { socketPath: string; threadId: string }) => Promise<unknown>;
export type AttachmentInspector = (input: { socketPath: string; launcherPath: string; deploymentPath: string; cwd: string | null }) => Promise<Record<string, unknown>>;

const disabled = (reason: string): AttachmentAttestation => ({ public: { enabled: false, reason, generation: null }, private: null });

/** Runs the bounded helper; its JSON receipt remains server-side. */
export const inspectManagedRoute: AttachmentInspector = async input => new Promise((resolve, reject) => {
  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/wmux_codex_attach.py");
  const child = spawn("python3", [helper, "inspect"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  let output = "";
  const timer = setTimeout(() => { child.kill(); reject(new Error("attachment_inspection_timeout")); }, 5_000);
  child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; if (output.length > 32 * 1024) child.kill(); });
  child.once("error", reject);
  child.once("close", code => { clearTimeout(timer); try { const value = record(JSON.parse(output)); if (code !== 0 || value.ok !== true) throw new Error(); resolve(record(value.receipt)); } catch { reject(new Error("attachment_inspection_failed")); } });
  child.stdin.end(JSON.stringify(input));
});

/**
 * Attests one local, managed route without changing native or guard state.
 * It deliberately performs no resume: the caller must bind this receipt to
 * its immediately-following managed launcher invocation.
 */
export async function attestCodexAttachment(input: {
  endpoint: CodexCatalogEndpointConfig; endpoints: CodexCatalogEndpointConfig[]; threadId: string;
  inspect?: AttachmentInspector; probe?: AttachmentProbe;
  loadedProbe?: (endpoint: CodexCatalogEndpointConfig) => Promise<unknown>;
}): Promise<AttachmentAttestation> {
  const { endpoint, threadId } = input;
  if (!THREAD.test(threadId)) return disabled("invalid_thread_id");
  if (process.platform !== "linux") return disabled("attachment_platform_unsupported");
  if (endpoint.transport !== "local") return disabled("attachment_ssh_unsupported");
  if (!endpoint.managedLaunch) return disabled("attachment_unconfigured");
  const inspect = input.inspect ?? inspectManagedRoute;
  const probe = input.probe ?? (value => queryCodexCatalog({ ...value, operation: "attachment" }));
  let native: Record<string, unknown>;
  try { native = record(await probe({ socketPath: endpoint.socketPath, threadId })); } catch { return disabled("attachment_native_unavailable"); }
  const thread = record(native.thread);
  const status = record(thread.status).type;
  const queue = record(native.queue);
  const queued = Array.isArray(queue.data) && queue.nextCursor === null ? queue.data.length : -1;
  const loaded = record(native.loaded);
  // A partial loaded page cannot prove absence on another endpoint.  Native
  // currently returns UUID strings, but accept its documented object form too.
  const loadedRows = Array.isArray(loaded.data) && loaded.nextCursor === null ? loaded.data : [];
  const loadedExact = loadedRows.some(value => value === threadId || record(value).id === threadId || record(value).threadId === threadId);
  if (thread.id !== threadId || !loadedExact || (status !== "idle" && status !== "active")) return disabled("attachment_not_loaded");
  if (thread.canAcceptDirectInput !== true) return disabled("attachment_input_unavailable");
  if (queued !== 0) return disabled("attachment_queue_not_empty");
  const cwd = typeof thread.cwd === "string" && thread.cwd.startsWith("/") ? thread.cwd : null;
  if (!cwd) return disabled("attachment_cwd_unavailable");
  let receipt: Record<string, unknown>;
  try { receipt = await inspect({ socketPath: endpoint.socketPath, ...endpoint.managedLaunch, cwd }); }
  catch { return disabled("attachment_route_unavailable"); }
  const generation = typeof receipt.generation === "string" && receipt.generation.length <= 256 ? receipt.generation : null;
  if (!generation || receipt.ready !== true || receipt.policy !== "enforce" || receipt.account !== process.getuid?.()) return disabled("attachment_route_untrusted");
  // Only the selected launch route needs managed-launch attestation. Other
  // configured servers still require a complete read-only ownership scan,
  // including SSH peers which cannot themselves launch an attached view.
  const same = (peer: Record<string, unknown>) => peer.socket === receipt.socket && peer.generation === generation;
  for (const candidate of input.endpoints) {
    try {
      if (candidate.transport === "local" && candidate.managedLaunch) {
        const peer = await inspect({ socketPath: candidate.socketPath, ...candidate.managedLaunch, cwd });
        if (same(peer)) continue;
      }
      if (!input.loadedProbe && candidate.transport !== "local") return disabled("attachment_owner_unknown");
      const otherLoaded = record(input.loadedProbe
        ? await input.loadedProbe(candidate)
        : record(await probe({ socketPath: candidate.socketPath, threadId })).loaded);
      const rows = Array.isArray(otherLoaded.data) && otherLoaded.nextCursor === null ? otherLoaded.data : null;
      if (rows === null || rows.length > 200 || rows.some(value => {
        const id = typeof value === "string" ? value : record(value).id ?? record(value).threadId;
        return typeof id !== "string" || !THREAD.test(id);
      })) return disabled("attachment_owner_unknown");
      if (rows.some(value => value === threadId || record(value).id === threadId || record(value).threadId === threadId)) return disabled("attachment_owner_ambiguous");
    } catch { return disabled("attachment_owner_unknown"); }
  }
  // Hash the complete helper receipt.  That receipt contains the descriptor,
  // deployment/module tree, launcher, socket peer and effective policy facts.
  const routeGeneration = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify([endpoint.id, threadId, routeGeneration])).digest("hex");
  return { public: { enabled: true, reason: null, generation: routeGeneration }, private: { fingerprint, endpointId: endpoint.id, threadId, generation: routeGeneration, cwd,
    route: { launcherPath: endpoint.managedLaunch.launcherPath, deploymentPath: endpoint.managedLaunch.deploymentPath,
      // Exact installed dispatcher route.  `--remote` is never present.
      managedArgv: [endpoint.managedLaunch.launcherPath, "resume", threadId] }, receipt } };
}
