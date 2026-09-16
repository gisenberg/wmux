import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CodexTaskTarget } from "../shared/codex-tasks.js";
import type { StateStore } from "./state.js";
import type { MachineConfig } from "./types.js";
import { CodexTaskCatalog, type CodexCatalogEndpointConfig } from "./codex-task-catalog.js";
import { CodexTaskAssociations } from "./codex-task-associations.js";
import { CodexTaskLaunches } from "./codex-task-launches.js";

export class CodexTasksService {
  readonly catalog: CodexTaskCatalog;
  readonly associations: CodexTaskAssociations;
  readonly launches: CodexTaskLaunches;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private cursor = 0;
  constructor(state: StateStore, machines: () => MachineConfig[], options: {
    endpoints?: CodexCatalogEndpointConfig[];
    catalog?: CodexTaskCatalog;
    open?: (endpointId: string, cwd: string, requestId: string) => Promise<CodexTaskTarget>;
    pollIntervalMs?: number;
    freshLaunchDisabledReason?: string;
  } = {}) {
    this.catalog = options.catalog ?? new CodexTaskCatalog(machines, options.endpoints);
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
}

export async function openCodexCliView(input: {
  baseUrl: string; token: string; machineId: string; socketPath: string; cwd: string;
}): Promise<CodexTaskTarget> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const script = path.join(root, "skills/wmux/scripts/wmuxctl.py");
  const args = [script, "tui", "codex", input.machineId, "--directory", input.cwd,
    "--no-prompt", "--codex-remote", `unix://${input.socketPath}`];
  const output = await new Promise<string>((resolve, reject) => {
    execFile("python3", args, { timeout: 100_000, maxBuffer: 256 * 1024,
      env: { ...process.env, WMUX_URL: input.baseUrl, WMUX_AUTOMATION_TOKEN: input.token || "wmux-auth-disabled" } },
    (error, stdout) => error ? reject(new Error("CLI view submission uncertain; inspect the created workspace before retrying.")) : resolve(stdout));
  });
  let result: Record<string, unknown>;
  try { result = JSON.parse(output) as Record<string, unknown>; } catch { throw new Error("CLI view result unavailable"); }
  for (const key of ["workspaceId", "tabId", "paneId"] as const) {
    if (typeof result[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result[key])) throw new Error("CLI view identity unavailable");
  }
  return { workspaceId: result.workspaceId as string, tabId: result.tabId as string, paneId: result.paneId as string };
}
