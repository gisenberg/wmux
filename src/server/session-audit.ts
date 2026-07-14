import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DurableSessionAudit, DurableSessionAuditRow } from "../shared/protocol.js";
import { runCommand } from "./child-process.js";
import { durableSessionName } from "./durable-session.js";

export type { DurableSessionAudit, DurableSessionAuditRow } from "../shared/protocol.js";

const defaultStatePath = (): string => path.join(os.homedir(), ".wmux", "state.json");

const commandOutput = async (command: string, args: string[]): Promise<string> => {
  const result = await runCommand(command, args, { timeoutMs: 2000 });
  return result.status === 0 ? result.stdout : "";
};

interface AuditMachine {
  id?: string;
  kind?: string;
  sessionBackend?: string;
  command?: unknown[];
}

interface AuditPane {
  id?: string;
  machineId?: string;
  status?: string;
}

interface AuditState {
  machines?: AuditMachine[];
  workspaces?: Array<{ tabs?: Array<{ panes?: AuditPane[] }> }>;
}

const loadState = (statePath: string): AuditState => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as AuditState;
  } catch {
    return { workspaces: [] };
  }
};

const paneIdFromSession = (sessionName: string): string => (sessionName.startsWith("wmux_") ? sessionName.slice("wmux_".length) : "");

export const expectedLocalDurablePaneIds = (state: AuditState): Set<string> => {
  const machines = new Map((state.machines ?? []).map((machine) => [machine.id, machine]));
  const paneIds = (state.workspaces ?? []).flatMap((workspace) =>
    (workspace.tabs ?? []).flatMap((tab) =>
      (tab.panes ?? []).flatMap((pane) => {
        if (!pane.id || pane.status === "exited") return [];
        const machineId = pane.machineId ?? "local";
        const machine = machines.get(machineId);
        if (machineId !== "local" || (machine && machine.kind !== "local")) return [];
        if (machine?.command?.length) return [];
        const backend = machine?.sessionBackend ?? "auto";
        return backend === "auto" || backend === "tmux" || backend === "screen" ? [pane.id] : [];
      }),
    ),
  );
  return new Set(paneIds);
};

const listTmux = async (): Promise<Array<Omit<DurableSessionAuditRow, "activePane" | "status" | "cleanupAllowed">>> =>
  (await commandOutput("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_windows}"]))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, attached, windows] = line.split("\t");
      return {
        backend: "tmux" as const,
        name,
        paneId: paneIdFromSession(name),
        attached: Number(attached) > 0,
        detail: `${attached || 0} attached, ${windows || 0} windows`,
      };
    })
    .filter((session) => session.name.startsWith("wmux_"));

const listScreen = async (): Promise<Array<Omit<DurableSessionAuditRow, "activePane" | "status" | "cleanupAllowed">>> =>
  (await commandOutput("screen", ["-ls"]))
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/^(?:\d+\.)?(wmux_[^\s]+)\s+\([^)]+\)\s+\(([^)]+)\)/);
      if (!match) return [];
      return [
        {
          backend: "screen" as const,
          name: match[1],
          paneId: paneIdFromSession(match[1]),
          attached: /attached/i.test(match[2]),
          detail: match[2],
        },
      ];
    });

export const auditDurableSessions = async (
  statePath = process.env.WMUX_STATE_PATH ?? defaultStatePath(),
): Promise<DurableSessionAudit> => {
  const state = loadState(statePath);
  const active = expectedLocalDurablePaneIds(state);
  const [tmuxSessions, screenSessions] = await Promise.all([listTmux(), listScreen()]);
  const sessions = [...tmuxSessions, ...screenSessions];
  const byName = new Map<string, typeof sessions>();
  for (const session of sessions) {
    if (!byName.has(session.name)) byName.set(session.name, []);
    byName.get(session.name)?.push(session);
  }

  const rows: DurableSessionAuditRow[] = sessions.map((session) => {
    const siblings = byName.get(session.name) ?? [];
    const activePane = active.has(session.paneId);
    const duplicate = activePane && siblings.length > 1;
    const status = !activePane ? "orphan" : duplicate && session.backend !== "tmux" ? "duplicate" : "active";
    return {
      ...session,
      activePane,
      status,
      cleanupAllowed: status === "orphan" || status === "duplicate",
    };
  });

  const missing = [...active]
    .map((paneId) => ({ paneId, name: durableSessionName(paneId) }))
    .filter((pane) => !byName.has(pane.name));

  return {
    summary: {
      statePath,
      activePaneCount: active.size,
      sessionCount: rows.length,
      orphanCount: rows.filter((row) => row.status === "orphan").length,
      duplicateCount: rows.filter((row) => row.status === "duplicate").length,
      missingCount: missing.length,
    },
    sessions: rows,
    missing,
  };
};

export const formatDurableSessionAudit = (audit: DurableSessionAudit): string => {
  const lines = [
    `wmux session audit (${audit.summary.statePath})`,
    `active panes: ${audit.summary.activePaneCount}, sessions: ${audit.summary.sessionCount}, orphans: ${audit.summary.orphanCount}, duplicates: ${audit.summary.duplicateCount}, missing: ${audit.summary.missingCount}`,
  ];
  if (audit.sessions.length) {
    lines.push("");
    for (const row of audit.sessions) {
      lines.push(`${row.status.padEnd(9)} ${row.backend.padEnd(6)} ${row.name.padEnd(24)} ${row.detail}`);
    }
  }
  if (audit.missing.length) {
    lines.push("");
    for (const row of audit.missing) lines.push(`missing   ${row.name}`);
  }
  return lines.join("\n");
};

export const hasDurableSessionAuditIssues = (audit: DurableSessionAudit): boolean =>
  Boolean(audit.summary.orphanCount || audit.summary.duplicateCount || audit.summary.missingCount);

export const cleanupDurableSession = (
  backend: "tmux" | "screen",
  name: string,
  statePath = process.env.WMUX_STATE_PATH ?? defaultStatePath(),
): Promise<DurableSessionAudit> => {
  if (!name.startsWith("wmux_")) {
    throw new Error("refusing to clean up a non-wmux session");
  }

  return cleanupDurableSessionAsync(backend, name, statePath);
};

const cleanupDurableSessionAsync = async (
  backend: "tmux" | "screen",
  name: string,
  statePath: string,
): Promise<DurableSessionAudit> => {
  const audit = await auditDurableSessions(statePath);
  const row = audit.sessions.find((candidate) => candidate.backend === backend && candidate.name === name);
  if (!row) return auditDurableSessions(statePath);
  if (!row.cleanupAllowed) {
    throw new Error("refusing to clean up an active wmux session");
  }

  const result = await (
    backend === "tmux"
      ? runCommand("tmux", ["kill-session", "-t", name], { timeoutMs: 3000 })
      : runCommand("screen", ["-S", name, "-X", "quit"], { timeoutMs: 3000 })
  );
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `${backend} exited with ${result.status}`;
    throw new Error(detail);
  }

  return auditDurableSessions(statePath);
};
