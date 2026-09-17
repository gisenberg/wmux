import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CodexTaskTarget, CodexTaskDetail } from "../shared/codex-tasks.js";
import type { StateStore } from "./state.js";
import type { MachineConfig } from "./types.js";
import { CodexTaskCatalog, CodexCatalogError, type CodexCatalogEndpointConfig } from "./codex-task-catalog.js";
import { CodexTaskAssociations } from "./codex-task-associations.js";
import { CodexTaskLaunches, CodexCliViewUncertainError, type CodexAttachmentRequest } from "./codex-task-launches.js";
import type { AttachmentAttestation } from "./codex-attachment-route.js";

export const attachmentReason = (reason: string): string => ({
  attachment_unconfigured: "This endpoint has no qualified managed CLI route. Configure and qualify its managed launcher before attaching.",
  attachment_ssh_unsupported: "This task is on another host. This release opens CLI views only for tasks running on the wmux server; Desktop-local tasks on other hosts cannot be attached here.",
  attachment_platform_unsupported: "Existing-task attachment is qualified only on Linux.",
  attachment_route_unavailable: "The managed route or guard readiness check is unavailable. Inspect the installed launcher and guard; no fallback was used.",
  attachment_route_untrusted: "The installed guard or account does not match this endpoint. Restore a qualified route before attaching.",
  attachment_native_unavailable: "Native ownership or queue inspection failed. Reconnect the owning server and refresh.",
  attachment_not_loaded: "This task is saved but not loaded on this server. Open it in its owning native client; this action will not load stored work.",
  attachment_input_unavailable: "The native server does not permit direct input to this task.",
  attachment_queue_not_empty: "Queued input is present or its state is unknown. Review it in the native client before opening another CLI.",
  attachment_owner_unknown: "Another configured owner could not be checked. Restore its connection and refresh; no executor was selected.",
  attachment_owner_ambiguous: "This UUID is loaded on multiple native servers. Resolve the owning server before attaching.",
  attachment_generation_changed: "The server or managed route changed since inspection. Refresh the task and review its current route.",
  attachment_controller_unavailable: "The local CLI controller is unavailable. Configure a local HTTP listener before attaching.",
}[reason] ?? "The task's managed route could not be verified. Refresh or inspect its native client.");

export class CodexTasksService {
  readonly catalog: CodexTaskCatalog;
  readonly associations: CodexTaskAssociations;
  readonly launches: CodexTaskLaunches;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private cursor = 0;
  private readonly attachmentDisabledReason?: string;
  constructor(state: StateStore, machines: () => MachineConfig[], options: {
    endpoints?: CodexCatalogEndpointConfig[];
    catalog?: CodexTaskCatalog;
    open?: (endpointId: string, cwd: string, requestId: string) => Promise<CodexTaskTarget>;
    openAttached?: (request: CodexAttachmentRequest, attestation: AttachmentAttestation) => Promise<CodexTaskTarget>;
    verifyAttached?: (request: CodexAttachmentRequest, target: CodexTaskTarget, attestation: AttachmentAttestation) => Promise<boolean>;
    recoverAttached?: (request: CodexAttachmentRequest) => CodexTaskTarget | null;
    pollIntervalMs?: number;
    freshLaunchDisabledReason?: string;
  } = {}) {
    this.catalog = options.catalog ?? new CodexTaskCatalog(machines, options.endpoints);
    this.attachmentDisabledReason = options.freshLaunchDisabledReason;
    if (options.freshLaunchDisabledReason) this.catalog.disableFreshLaunch(options.freshLaunchDisabledReason);
    const persistent = this.catalog.listEndpoints().length > 0;
    this.associations = new CodexTaskAssociations({
      filePath: persistent ? path.join(state.storageDirectory(), "codex-task-associations.json") : undefined,
      endpointIdentity: id => this.catalog.identity(id),
      resolveTarget: target => {
        const found = state.findPaneContext(target.paneId);
        return found?.workspace.id === target.workspaceId && found.tab.id === target.tabId;
      },
      notify: notification => {
        state.ensureNotification(notification);
        // Commit the deterministic notification before acknowledging its outbox.
        state.flush();
      },
    });
    this.launches = new CodexTaskLaunches({
      filePath: persistent ? path.join(state.storageDirectory(), "codex-task-launches.json") : undefined,
      open: async (endpointId, cwd, requestId) => {
        this.catalog.launchConfig(endpointId);
        // A fresh view never resumes a discovered thread or submits a prompt.
        await this.catalog.list(endpointId);
        if (this.catalog.listEndpoints().find(e => e.id === endpointId)?.status !== "available" || !options.open) {
          throw new Error("Fresh CLI view is unavailable");
        }
        return options.open(endpointId, cwd, requestId);
      },
      openAttached: async request => {
        const attestation = await this.requireAttachment(request);
        if (!options.openAttached) throw new Error("Attachment controller unavailable");
        return options.openAttached(request, attestation);
      },
      recoverAttached: options.recoverAttached,
      verifyAttached: async (request, target) => {
        try {
          const found = state.findPaneContext(target.paneId);
          const config = this.catalog.attachmentConfig(request.endpointId);
          if (!found || found.workspace.id !== target.workspaceId || found.tab.id !== target.tabId || found.pane.machineId !== config.machineId) return false;
          const attestation = await this.requireAttachment(request);
          if (await options.verifyAttached?.(request, target, attestation) !== true) return false;
          const current = state.findPaneContext(target.paneId);
          if (!current || current.workspace.id !== target.workspaceId || current.tab.id !== target.tabId || current.pane.machineId !== config.machineId) return false;
          // Seed only a newly verified view; reuse must not claim the original
          // receipt's naming binding or replace a later user choice.
          const name = attestation.private?.name;
          if (this.launches.get(request.requestId)?.status === "opening" && name?.trim()) {
            state.setAutoTitle({ workspaceId: target.workspaceId, tabId: target.tabId,
              sourcePaneId: target.paneId, title: name, exact: true });
          }
          return true;
        } catch { return false; }
      },
    });
    const poll = async (): Promise<void> => {
      try {
        const unique = new Map(this.associations.list().filter(a => a.resolved).map(a => [`${a.endpointId}/${a.threadId}`, a]));
        const rows = [...unique.values()];
        const deadline = Date.now() + 8_000;
        for (let n = 0; n < Math.min(rows.length, 20) && !this.stopped && Date.now() < deadline; n++) {
          const row = rows[this.cursor++ % rows.length];
          try {
            const task = (await this.catalog.read(row.endpointId, row.threadId)).task;
            if (!task.stale) this.associations.observe(task);
          }
          catch { /* Preserve metadata and authority; a later bounded poll retries. */ }
        }
      } finally {
        if (!this.stopped && persistent) { this.timer = setTimeout(poll, options.pollIntervalMs ?? 10_000); this.timer.unref(); }
      }
    };
    if (persistent) { this.timer = setTimeout(poll, options.pollIntervalMs ?? 10_000); this.timer.unref(); }
  }
  close(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  async requireAttachment(request: CodexAttachmentRequest): Promise<AttachmentAttestation> {
    if (this.attachmentDisabledReason) throw new CodexCatalogError("attachment_controller_unavailable", 409);
    if (this.catalog.identity(request.endpointId) !== request.endpointIdentity) throw new CodexCatalogError("endpoint_identity_changed", 409);
    const attestation = await this.catalog.attestAttachment(request.endpointId, request.threadId);
    if (!attestation.public.enabled || !attestation.private) throw new CodexCatalogError(attestation.public.reason ?? "attachment_route_unavailable", 409);
    if (attestation.public.generation !== request.generation) throw new CodexCatalogError("attachment_generation_changed", 409);
    return attestation;
  }

  async detail(endpointId: string, threadId: string, history = false): Promise<CodexTaskDetail> {
    const detail = await this.catalog.read(endpointId, threadId, history);
    if (detail.task.stale) return { ...detail, resume: { enabled: false, reason: attachmentReason("attachment_native_unavailable") } };
    try {
      if (this.attachmentDisabledReason) throw new CodexCatalogError("attachment_controller_unavailable");
      const attestation = await this.catalog.attestAttachment(endpointId, threadId);
      if (!attestation.public.enabled || !attestation.public.generation) {
        return { ...detail, resume: { enabled: false, reason: attachmentReason(attestation.public.reason ?? "attachment_route_unavailable") } };
      }
      const generation = attestation.public.generation;
      return { ...detail, resume: { enabled: true, generation,
        reason: "This opens another view of the same loaded task. Active work continues; native input affects this shared task. Ownership and queue checks are not an atomic lock.",
        target: await this.launches.verifiedTarget(detail.task.endpointIdentity, generation, threadId) } };
    } catch (error) {
      return { ...detail, resume: { enabled: false, reason: attachmentReason(error instanceof CodexCatalogError ? error.code : "attachment_route_unavailable") } };
    }
  }
}

export async function openCodexCliView(input: {
  baseUrl: string; token: string; machineId: string; socketPath: string; cwd: string;
}): Promise<CodexTaskTarget> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const script = path.join(root, "skills/wmux/scripts/wmuxctl.py");
  const args = [script, "tui", "codex", input.machineId, "--directory", input.cwd,
    "--no-prompt", "--codex-remote", `unix://${input.socketPath}`];
  const response = await new Promise<{ output: string; failed: boolean }>((resolve) => {
    execFile("python3", args, { timeout: 100_000, maxBuffer: 256 * 1024,
      env: { ...process.env, WMUX_URL: input.baseUrl, WMUX_AUTOMATION_TOKEN: input.token || "wmux-auth-disabled-placeholder-000000000000" } },
    (error, stdout) => resolve({ output: stdout, failed: Boolean(error) }));
  });
  let result: Record<string, unknown>;
  try { result = JSON.parse(response.output) as Record<string, unknown>; } catch { throw new Error("CLI view result unavailable"); }
  for (const key of ["workspaceId", "tabId", "paneId"] as const) {
    if (typeof result[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result[key])) throw new Error("CLI view identity unavailable");
  }
  const target = { workspaceId: result.workspaceId as string, tabId: result.tabId as string, paneId: result.paneId as string };
  if (response.failed) throw new CodexCliViewUncertainError(target);
  return target;
}
