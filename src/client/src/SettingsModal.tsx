import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { api } from "./api";
import { OpenTuiSettingsModal } from "./OpenTuiSettingsModal";
import { terminalColorSchemes } from "./color-schemes";
import type { DurableSessionAudit, MachineStatus, WmuxSettings } from "./types";

export type SettingsSurface = "opentui" | "dom";

export const defaultSettings: WmuxSettings = {
  terminalFontSize: 14,
  terminalScrollbackRows: 10_000,
  colorScheme: "wmux",
  machineAliases: {},
};

export function SettingsModal({
  machines,
  settings,
  surface = "dom",
  onPreview,
  onSave,
  onCancel,
  onUseDomFallback,
  onUseOpenTui,
}: {
  machines: MachineStatus[];
  settings: WmuxSettings;
  surface?: SettingsSurface;
  onPreview: (settings: WmuxSettings | null) => void;
  onSave: (settings: WmuxSettings) => void | Promise<void>;
  onCancel: () => void;
  onUseDomFallback?: () => void;
  onUseOpenTui?: () => void;
}) {
  const [draft, setDraft] = useState<WmuxSettings>(() => normalizeSettings(settings));
  const [saving, setSaving] = useState(false);
  const [sessionAudit, setSessionAudit] = useState<DurableSessionAudit | null>(null);
  const [sessionAuditError, setSessionAuditError] = useState("");
  const [sessionAuditLoading, setSessionAuditLoading] = useState(false);

  useEffect(() => {
    setDraft(normalizeSettings(settings));
  }, [settings]);

  useEffect(() => {
    if (surface !== "dom") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, surface]);

  const applyDraft = (nextSettings: WmuxSettings) => {
    const normalized = normalizeSettings(nextSettings);
    setDraft(normalized);
    onPreview(normalized);
  };

  const setAlias = (machineId: string, value: string) => {
    const machineAliases = { ...draft.machineAliases };
    const alias = cleanAlias(value);
    if (alias) {
      machineAliases[machineId] = alias;
    } else {
      delete machineAliases[machineId];
    }
    applyDraft({ ...draft, machineAliases });
  };

  const save = async (nextDraft = draft) => {
    setSaving(true);
    try {
      await onSave(normalizeSettings(nextDraft));
    } finally {
      setSaving(false);
    }
  };

  const runSessionAudit = async () => {
    setSessionAuditLoading(true);
    setSessionAuditError("");
    try {
      setSessionAudit(await api.auditSessions());
    } catch (error) {
      setSessionAudit(null);
      setSessionAuditError(error instanceof Error ? error.message : "Session audit failed");
    } finally {
      setSessionAuditLoading(false);
    }
  };

  const cleanupSession = async (backend: "tmux" | "screen", name: string) => {
    if (!window.confirm(`Quit ${backend} session ${name}?`)) return;
    setSessionAuditLoading(true);
    setSessionAuditError("");
    try {
      setSessionAudit(await api.cleanupSession(backend, name));
    } catch (error) {
      setSessionAuditError(error instanceof Error ? error.message : "Session cleanup failed");
    } finally {
      setSessionAuditLoading(false);
    }
  };

  const openTuiSurface = surface === "opentui";

  if (openTuiSurface) {
    return (
      <OpenTuiSettingsModal
        machines={machines}
        draft={draft}
        defaultSettings={defaultSettings}
        sessionAudit={sessionAudit}
        sessionAuditError={sessionAuditError}
        sessionAuditLoading={sessionAuditLoading}
        saving={saving}
        onApplyDraft={applyDraft}
        onSave={save}
        onCancel={onCancel}
        onUseDomFallback={onUseDomFallback}
        onRunSessionAudit={runSessionAudit}
        onCleanupSession={cleanupSession}
      />
    );
  }

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(event) => event.currentTarget === event.target && onCancel()}
    >
      <form
        className="settings-panel"
        aria-labelledby="settings-title"
        role="dialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <div className="settings-header-actions">
            {openTuiSurface && onUseDomFallback ? (
              <button type="button" title="Use DOM settings fallback" onClick={onUseDomFallback}>
                DOM
              </button>
            ) : !openTuiSurface && onUseOpenTui ? (
              <button type="button" title="Use canvas settings surface" onClick={onUseOpenTui}>
                TUI
              </button>
            ) : null}
            <button type="button" title="Cancel settings" onClick={onCancel}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="settings-body">
          <section className="settings-section">
            <h3>Appearance</h3>
            <label className="settings-row">
              <span>Color scheme</span>
              <select
                value={draft.colorScheme}
                onChange={(event) => applyDraft({
                  ...draft,
                  colorScheme: event.target.value as WmuxSettings["colorScheme"],
                })}
              >
                {terminalColorSchemes.map((scheme) => (
                  <option key={scheme.id} value={scheme.id}>{scheme.name}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <span>Font size</span>
              <input
                type="range"
                min="10"
                max="24"
                value={draft.terminalFontSize}
                onChange={(event) =>
                  applyDraft({
                    ...draft,
                    terminalFontSize: clampFontSize(Number(event.target.value)),
                  })
                }
              />
              <input
                className="settings-number"
                type="number"
                min="10"
                max="24"
                value={draft.terminalFontSize}
                onChange={(event) =>
                  applyDraft({
                    ...draft,
                    terminalFontSize: clampFontSize(Number(event.target.value)),
                  })
                }
              />
            </label>
            <label className="settings-row">
              <span>Scrollback rows</span>
              <input
                type="range"
                min="1000"
                max="200000"
                step="1000"
                value={draft.terminalScrollbackRows}
                onChange={(event) =>
                  applyDraft({
                    ...draft,
                    terminalScrollbackRows: clampScrollbackRows(Number(event.target.value)),
                  })
                }
              />
              <input
                className="settings-number"
                type="number"
                min="1000"
                max="200000"
                step="1000"
                value={draft.terminalScrollbackRows}
                onChange={(event) =>
                  applyDraft({
                    ...draft,
                    terminalScrollbackRows: clampScrollbackRows(Number(event.target.value)),
                  })
                }
              />
            </label>
          </section>
          <section className="settings-section">
            <h3>Host aliases</h3>
            {machines.map((machine) => (
              <label key={machine.id} className="settings-row">
                <span>{machine.name}</span>
                <input
                  type="text"
                  maxLength={40}
                  placeholder={machine.id}
                  value={draft.machineAliases[machine.id] ?? ""}
                  onChange={(event) => setAlias(machine.id, event.target.value)}
                />
              </label>
            ))}
          </section>
          <section className="settings-section">
            <h3>Durable sessions</h3>
            <div className="settings-command-row">
              <button type="button" onClick={runSessionAudit} disabled={sessionAuditLoading}>
                {sessionAuditLoading ? "Auditing" : "Audit sessions"}
              </button>
              {sessionAudit ? (
                <span>
                  {sessionAudit.summary.orphanCount} orphan / {sessionAudit.summary.duplicateCount} duplicate / {sessionAudit.summary.missingCount} missing
                </span>
              ) : (
                <span>Read-only local tmux/screen check</span>
              )}
            </div>
            {sessionAuditError ? <div className="settings-error">{sessionAuditError}</div> : null}
            {sessionAudit ? (
              <div className="session-audit">
                <div className="session-audit-summary">
                  {sessionAudit.summary.activePaneCount} panes, {sessionAudit.summary.sessionCount} sessions
                </div>
                {sessionAudit.sessions.map((row) => (
                  <div key={`${row.backend}:${row.name}`} className={`session-audit-row ${row.status}`}>
                    <span>{row.status}</span>
                    <span>{row.backend}</span>
                    <span title={row.name}>{row.name}</span>
                    <span>{row.detail}</span>
                    <span>
                      {row.cleanupAllowed ? (
                        <button
                          type="button"
                          title={`Quit ${row.backend} session`}
                          disabled={sessionAuditLoading}
                          onClick={() => void cleanupSession(row.backend, row.name)}
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
                {sessionAudit.missing.map((row) => (
                  <div key={`missing:${row.name}`} className="session-audit-row missing">
                    <span>missing</span>
                    <span>none</span>
                    <span title={row.name}>{row.name}</span>
                    <span>{row.paneId}</span>
                    <span />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            onClick={() => applyDraft({ ...defaultSettings })}
          >
            Reset
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={saving}>
            {saving ? "Saving" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

const normalizeSettings = (settings: WmuxSettings): WmuxSettings => ({
  terminalFontSize: clampFontSize(settings.terminalFontSize),
  terminalScrollbackRows: clampScrollbackRows(settings.terminalScrollbackRows),
  colorScheme: terminalColorSchemes.some((scheme) => scheme.id === settings.colorScheme)
    ? settings.colorScheme
    : defaultSettings.colorScheme,
  machineAliases: Object.fromEntries(
    Object.entries(settings.machineAliases ?? {})
      .map(([machineId, alias]) => [machineId, cleanAlias(alias)] as const)
      .filter(([, alias]) => alias.length > 0),
  ),
});

const clampFontSize = (value: number): number => {
  const fallback = defaultSettings.terminalFontSize;
  const numeric = Number.isFinite(value) ? value : fallback;
  return Math.min(24, Math.max(10, Math.round(numeric)));
};

const clampScrollbackRows = (value: number): number => {
  const fallback = defaultSettings.terminalScrollbackRows;
  const numeric = Number.isFinite(value) ? value : fallback;
  return Math.min(200_000, Math.max(1_000, Math.round(numeric)));
};

export const cleanAlias = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 40);
