import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { WmuxSettings } from "./types.js";

const defaultPath = (): string => path.join(os.homedir(), ".wmux", "settings.json");

export const defaultSettings: WmuxSettings = {
  terminalFontSize: 14,
  terminalScrollbackRows: 10_000,
  machineAliases: {},
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
      machineAliases: input.machineAliases ?? this.settings.machineAliases,
    });
    this.save(true);
    return this.snapshot();
  }

  save(emitChange = true): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2));
    if (emitChange) this.emit("change");
  }

  private load(): WmuxSettings {
    if (!fs.existsSync(this.filePath)) return defaultSettings;
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<WmuxSettings>;
    return normalizeSettings(raw);
  }
}

const normalizeSettings = (input: Partial<WmuxSettings>): WmuxSettings => ({
  terminalFontSize: clampFontSize(input.terminalFontSize),
  terminalScrollbackRows: clampScrollbackRows(input.terminalScrollbackRows),
  machineAliases: cleanAliases(input.machineAliases),
});

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
