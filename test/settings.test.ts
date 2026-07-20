import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CURRENT_SETTINGS_SCHEMA_VERSION, SettingsStore } from "../src/server/settings.js";

const withTempSettings = (run: (filePath: string, dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-settings-"));
  try {
    run(path.join(dir, "settings.json"), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("settings persist atomically with a schema version and owner-only mode", () => {
  withTempSettings((filePath, dir) => {
    new SettingsStore(filePath);
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(persisted.schemaVersion, CURRENT_SETTINGS_SCHEMA_VERSION);
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
    if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  });
});

test("legacy settings migrate while preserving normalized values", () => {
  withTempSettings((filePath) => {
    fs.writeFileSync(filePath, JSON.stringify({ terminalFontSize: 19, terminalScrollbackRows: 5000, machineAliases: { local: "Home" } }));
    const store = new SettingsStore(filePath);
    assert.deepEqual(store.snapshot(), {
      terminalFontSize: 19,
      terminalScrollbackRows: 5000,
      colorScheme: "wmux",
      inactiveTabStreaming: "suspend",
      tuiFrameRate: 15,
      terminalScrollMode: "batched",
      machineAliases: { local: "Home" },
      collapsedWorkspaceIds: [],
    });
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, CURRENT_SETTINGS_SCHEMA_VERSION);
  });
});

test("version 1 and version 2 settings migrate to inactive tab suspension", () => {
  withTempSettings((filePath) => {
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      terminalFontSize: 16,
      terminalScrollbackRows: 8000,
      machineAliases: {},
    }));
    const store = new SettingsStore(filePath);
    assert.equal(store.snapshot().colorScheme, "wmux");
    assert.equal(store.snapshot().inactiveTabStreaming, "suspend");
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, CURRENT_SETTINGS_SCHEMA_VERSION);
  });
  withTempSettings((filePath) => {
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 2,
      terminalFontSize: 16,
      terminalScrollbackRows: 8000,
      colorScheme: "nord",
      machineAliases: { local: "Home" },
    }));
    const store = new SettingsStore(filePath);
    assert.deepEqual(store.snapshot(), {
      terminalFontSize: 16,
      terminalScrollbackRows: 8000,
      colorScheme: "nord",
      inactiveTabStreaming: "suspend",
      tuiFrameRate: 15,
      terminalScrollMode: "batched",
      machineAliases: { local: "Home" },
      collapsedWorkspaceIds: [],
    });
  });
});

test("settings persist supported schemes and normalize unknown values", () => {
  withTempSettings((filePath) => {
    const store = new SettingsStore(filePath);
    store.update({ colorScheme: "catppuccin-mocha" });
    assert.equal(store.snapshot().colorScheme, "catppuccin-mocha");
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      colorScheme: "not-a-scheme",
    }));
    assert.equal(new SettingsStore(filePath).snapshot().colorScheme, "wmux");
    assert.equal(new SettingsStore(filePath).snapshot().inactiveTabStreaming, "suspend");
  });
});

test("settings persist live inactive-tab streaming and normalize invalid values", () => {
  withTempSettings((filePath) => {
    const store = new SettingsStore(filePath);
    store.update({ inactiveTabStreaming: "live" });
    assert.equal(store.snapshot().inactiveTabStreaming, "live");
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION, inactiveTabStreaming: "invalid" }));
    assert.equal(new SettingsStore(filePath).snapshot().inactiveTabStreaming, "suspend");
  });
});

test("version 3 settings migrate to the efficient frame rate and normalize rates", () => {
  withTempSettings((filePath) => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 3, tuiFrameRate: 60, inactiveTabStreaming: "live" }));
    assert.equal(new SettingsStore(filePath).snapshot().tuiFrameRate, 60);
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION, tuiFrameRate: 24 }));
    assert.equal(new SettingsStore(filePath).snapshot().tuiFrameRate, 15);
  });
});

test("settings recover from a validated rolling backup", () => {
  withTempSettings((filePath, dir) => {
    const store = new SettingsStore(filePath);
    store.update({ terminalFontSize: 18 });
    assert.ok(fs.existsSync(`${filePath}.bak`));
    fs.writeFileSync(filePath, "not-json");

    const recovered = new SettingsStore(filePath);
    assert.equal(recovered.snapshot().terminalFontSize, 14);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("settings.json.corrupt-")));
  });
});

test("newer settings schemas refuse downgrade without overwriting the file", () => {
  withTempSettings((filePath, dir) => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION + 1 }));
    assert.throws(() => new SettingsStore(filePath), /newer than this wmux build supports/);
    assert.ok(fs.existsSync(filePath));
    assert.equal(fs.readdirSync(dir).some((name) => name.includes(".corrupt-")), false);
  });
});

test("version 4 settings migrate to batched terminal scrolling", () => {
  withTempSettings((filePath) => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 4, tuiFrameRate: 30, inactiveTabStreaming: "live" }));
    const store = new SettingsStore(filePath);
    assert.equal(store.snapshot().terminalScrollMode, "batched");
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, CURRENT_SETTINGS_SCHEMA_VERSION);
  });
});

test("settings persist terminal scroll mode and normalize invalid values", () => {
  withTempSettings((filePath) => {
    const store = new SettingsStore(filePath);
    store.update({ terminalScrollMode: "immediate" });
    assert.equal(store.snapshot().terminalScrollMode, "immediate");
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).terminalScrollMode, "immediate");
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION, terminalScrollMode: "invalid" }));
    assert.equal(new SettingsStore(filePath).snapshot().terminalScrollMode, "batched");
  });
});
