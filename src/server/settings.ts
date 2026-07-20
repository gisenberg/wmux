import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { WmuxSettings } from "./types.js";
import { TERMINAL_COLOR_SCHEME_IDS, type InactiveTabStreaming, type TerminalColorSchemeId, type TerminalScrollMode, type TuiFrameRate } from "../shared/protocol.js";

const defaultPath = (): string => path.join(os.homedir(), ".wmux", "settings.json");
export const CURRENT_SETTINGS_SCHEMA_VERSION = 6;

const persistedSettingsSchema = z.object({
  schemaVersion: z.literal(CURRENT_SETTINGS_SCHEMA_VERSION),
  terminalFontSize: z.unknown().optional(),
  terminalScrollbackRows: z.unknown().optional(),
  colorScheme: z.unknown().optional(),
  inactiveTabStreaming: z.unknown().optional(),
  tuiFrameRate: z.unknown().optional(),
  terminalScrollMode: z.unknown().optional(),
  machineAliases: z.unknown().optional(),
  collapsedWorkspaceIds: z.unknown().optional(),
}).strict();

export const defaultSettings: WmuxSettings = {
  terminalFontSize: 14,
  terminalScrollbackRows: 10_000,
  colorScheme: "wmux",
  inactiveTabStreaming: "suspend",
  tuiFrameRate: 15,
  terminalScrollMode: "batched",
  machineAliases: {},
  collapsedWorkspaceIds: [],
};

export class SettingsStore extends EventEmitter {
  private settings: WmuxSettings;

  constructor(private readonly filePath: string = process.env.WMUX_SETTINGS_PATH ?? defaultPath()) {
    super();
    this.settings = this.load();
    this.save(false);
  }

  snapshot(): WmuxSettings {
    return structuredClone(this.settings);
  }

  update(input: Partial<WmuxSettings>): WmuxSettings {
    this.settings = normalizeSettings({
      terminalFontSize: input.terminalFontSize ?? this.settings.terminalFontSize,
      terminalScrollbackRows: input.terminalScrollbackRows ?? this.settings.terminalScrollbackRows,
      colorScheme: input.colorScheme ?? this.settings.colorScheme,
      inactiveTabStreaming: input.inactiveTabStreaming ?? this.settings.inactiveTabStreaming,
      tuiFrameRate: input.tuiFrameRate ?? this.settings.tuiFrameRate,
      terminalScrollMode: input.terminalScrollMode ?? this.settings.terminalScrollMode,
      machineAliases: input.machineAliases ?? this.settings.machineAliases,
      collapsedWorkspaceIds: input.collapsedWorkspaceIds ?? this.settings.collapsedWorkspaceIds,
    });
    this.save(true);
    return this.snapshot();
  }

  save(emitChange = true): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    try {
      const handle = fs.openSync(tempPath, "w", 0o600);
      try {
        fs.writeFileSync(handle, JSON.stringify({ schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION, ...this.settings }, null, 2));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.chmodSync(tempPath, 0o600);
      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, this.backupPath());
        fs.chmodSync(this.backupPath(), 0o600);
      }
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      throw error;
    }
    if (emitChange) this.emit("change");
  }

  private load(): WmuxSettings {
    if (fs.existsSync(this.filePath)) {
      const settings = this.tryLoad(this.filePath);
      if (settings) return settings;
      this.quarantine(this.filePath);
    }
    if (fs.existsSync(this.backupPath())) {
      const settings = this.tryLoad(this.backupPath());
      if (settings) {
        console.error(`wmux: recovered settings from ${this.backupPath()}`);
        return settings;
      }
      this.quarantine(this.backupPath());
    }
    return defaultSettings;
  }

  private tryLoad(filePath: string): WmuxSettings | null {
    try {
      const input = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!input || typeof input !== "object" || Array.isArray(input)) return null;
      const record = input as Record<string, unknown>;
      const version = record.schemaVersion;
      if (typeof version === "number" && Number.isInteger(version) && version > CURRENT_SETTINGS_SCHEMA_VERSION) {
        throw new Error(
          `settings schema ${version} is newer than this wmux build supports (${CURRENT_SETTINGS_SCHEMA_VERSION})`,
        );
      }
      const candidate = version === undefined || version === 1 || version === 2 || version === 3 || version === 4 || version === 5
        ? { ...record, schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION, colorScheme: record.colorScheme ?? defaultSettings.colorScheme }
        : record;
      const parsed = persistedSettingsSchema.parse(candidate);
      return normalizeSettings(parsed);
    } catch (error) {
      if (error instanceof Error && error.message.includes("newer than this wmux build supports")) throw error;
      return null;
    }
  }

  private backupPath(): string {
    return `${this.filePath}.bak`;
  }

  private quarantine(filePath: string): void {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const quarantinePath = `${filePath}.corrupt-${stamp}`;
      fs.renameSync(filePath, quarantinePath);
      console.error(`wmux: unreadable settings file quarantined to ${quarantinePath}`);
    } catch (error) {
      console.error(`wmux: failed to quarantine unreadable settings file: ${error instanceof Error ? error.message : error}`);
    }
  }
}

const normalizeSettings = (input: {
  terminalFontSize?: unknown;
  terminalScrollbackRows?: unknown;
  colorScheme?: unknown;
  inactiveTabStreaming?: unknown;
  tuiFrameRate?: unknown;
  terminalScrollMode?: unknown;
  machineAliases?: unknown;
  collapsedWorkspaceIds?: unknown;
}): WmuxSettings => ({
  terminalFontSize: clampFontSize(input.terminalFontSize),
  terminalScrollbackRows: clampScrollbackRows(input.terminalScrollbackRows),
  colorScheme: cleanColorScheme(input.colorScheme),
  inactiveTabStreaming: cleanInactiveTabStreaming(input.inactiveTabStreaming),
  tuiFrameRate: cleanTuiFrameRate(input.tuiFrameRate),
  terminalScrollMode: cleanTerminalScrollMode(input.terminalScrollMode),
  machineAliases: cleanAliases(input.machineAliases),
  collapsedWorkspaceIds: cleanCollapsedWorkspaceIds(input.collapsedWorkspaceIds),
});

const colorSchemeIds = new Set<string>(TERMINAL_COLOR_SCHEME_IDS);

const cleanColorScheme = (value: unknown): TerminalColorSchemeId =>
  typeof value === "string" && colorSchemeIds.has(value)
    ? value as TerminalColorSchemeId
    : defaultSettings.colorScheme;

const cleanInactiveTabStreaming = (value: unknown): InactiveTabStreaming =>
  value === "live" || value === "suspend" ? value : defaultSettings.inactiveTabStreaming;

const cleanTuiFrameRate = (value: unknown): TuiFrameRate =>
  value === 15 || value === 30 || value === 60 ? value : defaultSettings.tuiFrameRate;

const cleanTerminalScrollMode = (value: unknown): TerminalScrollMode =>
  value === "batched" || value === "immediate" ? value : defaultSettings.terminalScrollMode;

const clampFontSize = (value: unknown): number => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : defaultSettings.terminalFontSize;
  return Math.min(24, Math.max(10, Math.round(numeric)));
};

const clampScrollbackRows = (value: unknown): number => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : defaultSettings.terminalScrollbackRows;
  return Math.min(200_000, Math.max(1_000, Math.round(numeric)));
};

const cleanAliases = (aliases: unknown): Record<string, string> => {
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return {};
  const cleaned: Record<string, string> = {};
  for (const [machineId, alias] of Object.entries(aliases)) {
    if (typeof alias !== "string") continue;
    const key = machineId.replace(/\s+/g, "").slice(0, 80);
    const value = alias.replace(/\s+/g, " ").trim().slice(0, 40);
    if (key && value) cleaned[key] = value;
  }
  return cleaned;
};

const cleanCollapsedWorkspaceIds = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 120))]
  : [];
