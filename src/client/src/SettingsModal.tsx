import { useCallback, useEffect, useState } from "react";
import {
  api,
  type BrowserSessionMetadata,
  type ScopedCredentialMetadata,
} from "./api";
import { OpenTuiSettingsModal } from "./OpenTuiSettingsModal";
import { terminalColorSchemes } from "./color-schemes";
import { MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE } from "./types";
import type { DurableSessionAudit, KeybindingMap, MachineStatus, WmuxSettings } from "./types";

export const defaultSettings: WmuxSettings = {
  terminalFontSize: 14,
  terminalScrollbackRows: 10_000,
  colorScheme: "flock",
  inactiveTabStreaming: "suspend",
  tuiFrameRate: 15,
  terminalScrollMode: "batched",
  groupSidebarSessionsByHost: true,
  machineAliases: {},
  collapsedWorkspaceIds: [],
  favoriteWorkspaceIds: [],
};

export function SettingsModal({
  machines,
  settings,
  keybindings,
  appleKeybindings,
  defaults = defaultSettings,
  onPreview,
  onSave,
  onCancel,
  onManageMachines,
}: {
  machines: MachineStatus[];
  settings: WmuxSettings;
  keybindings: KeybindingMap;
  appleKeybindings: boolean;
  defaults?: WmuxSettings;
  onPreview: (settings: WmuxSettings | null) => void;
  onSave: (settings: WmuxSettings) => void | Promise<void>;
  onCancel: () => void;
  onManageMachines: () => void;
}) {
  const [draft, setDraft] = useState<WmuxSettings>(() =>
    normalizeSettings(settings, defaults.terminalFontSize));
  const [saving, setSaving] = useState(false);
  const [sessionAudit, setSessionAudit] = useState<DurableSessionAudit | null>(null);
  const [sessionAuditError, setSessionAuditError] = useState("");
  const [sessionAuditLoading, setSessionAuditLoading] = useState(false);
  const [browserSessions, setBrowserSessions] = useState<BrowserSessionMetadata[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [scopedCredentials, setScopedCredentials] = useState<ScopedCredentialMetadata[]>([]);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [securityError, setSecurityError] = useState("");
  const [securityAvailable, setSecurityAvailable] = useState(false);

  useEffect(() => {
    setDraft(normalizeSettings(settings, defaults.terminalFontSize));
  }, [defaults, settings]);

  const loadSecurity = useCallback(async () => {
    setSecurityLoading(true);
    setSecurityError("");
    try {
      const authInfo = await api.authInfo();
      if (authInfo.browserAuthMode !== "login-only") {
        setSecurityAvailable(false);
        return;
      }
      const [sessionResponse, credentialResponse] = await Promise.all([
        api.browserSessions(),
        api.scopedCredentials(),
      ]);
      setBrowserSessions(sessionResponse.sessions);
      setCurrentSessionId(sessionResponse.currentSessionId);
      setScopedCredentials(credentialResponse.credentials);
      setSecurityAvailable(true);
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : "Security inventory failed");
    } finally {
      setSecurityLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSecurity();
  }, [loadSecurity]);

  const applyDraft = (nextSettings: WmuxSettings) => {
    const normalized = normalizeSettings(nextSettings, defaults.terminalFontSize);
    setDraft(normalized);
    onPreview(normalized);
  };

  const save = useCallback(async (nextDraft = draft) => {
    setSaving(true);
    try {
      await onSave(normalizeSettings(nextDraft, defaults.terminalFontSize));
    } finally {
      setSaving(false);
    }
  }, [defaults.terminalFontSize, draft, onSave]);

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

  const cleanupSession = async (
    backend: "tmux" | "screen" | "agent",
    name: string,
    cleanupKey?: string,
  ) => {
    if (!window.confirm(`Quit ${backend} session ${name}?`)) return;
    setSessionAuditLoading(true);
    setSessionAuditError("");
    try {
      setSessionAudit(await api.cleanupSession(backend, name, cleanupKey));
    } catch (error) {
      setSessionAuditError(error instanceof Error ? error.message : "Session cleanup failed");
    } finally {
      setSessionAuditLoading(false);
    }
  };

  const revokeBrowserSession = async (session: BrowserSessionMetadata) => {
    const suffix = session.id === currentSessionId
      ? " This will sign out this browser."
      : "";
    if (!window.confirm(`Revoke ${session.device} at ${session.address}?${suffix}`)) return;
    setSecurityLoading(true);
    setSecurityError("");
    try {
      await api.revokeBrowserSession(session.id);
      if (session.id === currentSessionId) {
        window.location.reload();
        return;
      }
      await loadSecurity();
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : "Session revocation failed");
      setSecurityLoading(false);
    }
  };

  const rotateScopedCredential = async (credential: ScopedCredentialMetadata) => {
    if (!window.confirm(`Rotate the ${credential.kind} credential now? Existing copies will stop working immediately.`)) return;
    setSecurityLoading(true);
    setSecurityError("");
    try {
      await api.rotateScopedCredential(credential.kind);
      await loadSecurity();
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : "Credential rotation failed");
      setSecurityLoading(false);
    }
  };

  return (
    <OpenTuiSettingsModal
      machines={machines}
      draft={draft}
      defaultSettings={defaults}
      sessionAudit={sessionAudit}
      sessionAuditError={sessionAuditError}
      sessionAuditLoading={sessionAuditLoading}
      browserSessions={browserSessions}
      currentSessionId={currentSessionId}
      scopedCredentials={scopedCredentials}
      securityAvailable={securityAvailable}
      securityLoading={securityLoading}
      securityError={securityError}
      saving={saving}
      keybindings={keybindings}
      appleKeybindings={appleKeybindings}
      onApplyDraft={applyDraft}
      onSave={save}
      onCancel={onCancel}
      onManageMachines={onManageMachines}
      onRunSessionAudit={runSessionAudit}
      onCleanupSession={cleanupSession}
      onRevokeBrowserSession={revokeBrowserSession}
      onRotateScopedCredential={rotateScopedCredential}
    />
  );
}

const normalizeSettings = (
  settings: WmuxSettings,
  terminalFontSizeFallback = defaultSettings.terminalFontSize,
): WmuxSettings => ({
  terminalFontSize: clampFontSize(settings.terminalFontSize, terminalFontSizeFallback),
  terminalScrollbackRows: clampScrollbackRows(settings.terminalScrollbackRows),
  colorScheme: terminalColorSchemes.some((scheme) => scheme.id === settings.colorScheme)
    ? settings.colorScheme
    : defaultSettings.colorScheme,
  inactiveTabStreaming: settings.inactiveTabStreaming === "live" || settings.inactiveTabStreaming === "suspend"
    ? settings.inactiveTabStreaming
    : defaultSettings.inactiveTabStreaming,
  tuiFrameRate: settings.tuiFrameRate === 15 || settings.tuiFrameRate === 30 || settings.tuiFrameRate === 60
    ? settings.tuiFrameRate
    : defaultSettings.tuiFrameRate,
  terminalScrollMode: settings.terminalScrollMode === "batched" || settings.terminalScrollMode === "immediate"
    ? settings.terminalScrollMode
    : defaultSettings.terminalScrollMode,
  groupSidebarSessionsByHost: typeof settings.groupSidebarSessionsByHost === "boolean"
    ? settings.groupSidebarSessionsByHost
    : defaultSettings.groupSidebarSessionsByHost,
  machineAliases: Object.fromEntries(
    Object.entries(settings.machineAliases ?? {})
      .map(([machineId, alias]) => [machineId, cleanAlias(alias)] as const)
      .filter(([, alias]) => alias.length > 0),
  ),
  collapsedWorkspaceIds: settings.collapsedWorkspaceIds ?? [],
  favoriteWorkspaceIds: settings.favoriteWorkspaceIds ?? [],
});

const clampFontSize = (
  value: number,
  fallback = defaultSettings.terminalFontSize,
): number => {
  const numeric = Number.isFinite(value) ? value : fallback;
  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(numeric)),
  );
};

const clampScrollbackRows = (value: number): number => {
  const numeric = Number.isFinite(value)
    ? value
    : defaultSettings.terminalScrollbackRows;
  return Math.min(200_000, Math.max(1_000, Math.round(numeric)));
};

export const cleanAlias = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, 40);
