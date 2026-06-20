import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface DurableSessionAuditRow {
  backend: "tmux" | "screen";
  name: string;
  paneId: string;
  attached: boolean;
  detail: string;
  activePane: boolean;
  status: "active" | "duplicate" | "orphan";
  cleanupAllowed: boolean;
}

export interface DurableSessionMissingRow {
  paneId: string;
  name: string;
}

export interface DurableSessionAudit {
  summary: {
    statePath: string;
    activePaneCount: number;
    sessionCount: number;
    orphanCount: number;
    duplicateCount: number;
    missingCount: number;
  };
  sessions: DurableSessionAuditRow[];
  missing: DurableSessionMissingRow[];
}

const defaultStatePath = (): string => path.join(os.homedir(), ".wmux", "state.json");

const commandOutput = (command: string, args: string[]): string => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return "";
  return result.stdout;
};

const loadState = (statePath: string): { workspaces?: Array<{ tabs?: Array<{ panes?: Array<{ id?: string }> }> }> } => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as { workspaces?: Array<{ tabs?: Array<{ panes?: Array<{ id?: string }> }> }> };
  } catch {
    return { workspaces: [] };
  }
};

const durableSessionName = (paneId: string): string => `wmux_${String(paneId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}`;
const paneIdFromSession = (sessionName: string): string => (sessionName.startsWith("wmux_") ? sessionName.slice("wmux_".length) : "");

const activePaneIds = (state: ReturnType<typeof loadState>): Set<string> =>
  new Set(
    (state.workspaces ?? []).flatMap((workspace) =>
      (workspace.tabs ?? []).flatMap((tab) => (tab.panes ?? []).map((pane) => pane.id).filter(Boolean) as string[]),
    ),
  );

const listTmux = (): Array<Omit<DurableSessionAuditRow, "activePane" | "status" | "cleanupAllowed">> =>
  commandOutput("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_windows}"])
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

const listScreen = (): Array<Omit<DurableSessionAuditRow, "activePane" | "status" | "cleanupAllowed">> =>
  commandOutput("screen", ["-ls"])
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

export const auditDurableSessions = (statePath = process.env.WMUX_STATE_PATH ?? defaultStatePath()): DurableSessionAudit => {
  const state = loadState(statePath);
  const active = activePaneIds(state);
  const sessions = [...listTmux(), ...listScreen()];
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
): DurableSessionAudit => {
  if (!name.startsWith("wmux_")) {
    throw new Error("refusing to clean up a non-wmux session");
  }

  const audit = auditDurableSessions(statePath);
  const row = audit.sessions.find((candidate) => candidate.backend === backend && candidate.name === name);
  if (!row) return auditDurableSessions(statePath);
  if (!row.cleanupAllowed) {
    throw new Error("refusing to clean up an active wmux session");
  }

  const result =
    backend === "tmux"
      ? spawnSync("tmux", ["kill-session", "-t", name], { encoding: "utf8" })
      : spawnSync("screen", ["-S", name, "-X", "quit"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `${backend} exited with ${result.status}`;
    throw new Error(detail);
  }

  return auditDurableSessions(statePath);
};
