import assert from "node:assert/strict";
import fs from "node:fs";
import { privateTempDirectory, assertPrivateFile } from "./private-fixture.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TerminalCheckpointStore,
  UnsupportedTerminalCheckpointVersionError,
} from "../src/server/terminal-checkpoint-store.js";

const checkpoint = (label: string) => ({
  data: `\x1bc\x1b[2J\x1b[H${label}`,
  kind: "checkpoint" as const,
});

test("terminal checkpoints are owner-only, atomic, and recover from backup", () => {
  const directory = privateTempDirectory(
    path.join(os.tmpdir(), "wmux-checkpoint-store-"),
  );
  try {
    const store = new TerminalCheckpointStore(directory);
    store.schedule(
      "pane-one",
      "raw-pty",
      () => checkpoint("first"),
    );
    store.flush();
    const checkpointPath = path.join(
      directory,
      fs.readdirSync(directory).find((entry) => entry.endsWith(".json"))!,
    );
    assertPrivateFile(directory);
    assertPrivateFile(checkpointPath);
    assert.deepEqual(
      store.load("pane-one", "raw-pty"),
      checkpoint("first"),
    );
    assert.equal(
      store.load("pane-one", "windows-agent"),
      undefined,
    );

    store.schedule(
      "pane-one",
      "raw-pty",
      () => checkpoint("second"),
    );
    store.flush();
    fs.writeFileSync(checkpointPath, "{corrupt");
    const recovered = new TerminalCheckpointStore(directory).load(
      "pane-one",
      "raw-pty",
    );
    assert.deepEqual(recovered, checkpoint("first"));
    assert.equal(
      fs.readdirSync(directory).some((entry) =>
        entry.includes(".corrupt-")),
      true,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal checkpoint downgrade refusal preserves a future file", () => {
  const directory = privateTempDirectory(
    path.join(os.tmpdir(), "wmux-checkpoint-version-"),
  );
  try {
    const store = new TerminalCheckpointStore(directory);
    store.schedule(
      "pane-future",
      "raw-pty",
      () => checkpoint("current"),
    );
    store.flush();
    const checkpointPath = path.join(
      directory,
      fs.readdirSync(directory).find((entry) => entry.endsWith(".json"))!,
    );
    const future = JSON.stringify({
      schemaVersion: 2,
      paneId: "pane-future",
      backendId: "raw-pty",
      capturedAt: new Date().toISOString(),
      replay: checkpoint("future"),
    });
    fs.writeFileSync(checkpointPath, future);

    assert.throws(
      () => store.load("pane-future", "raw-pty"),
      UnsupportedTerminalCheckpointVersionError,
    );
    assert.equal(fs.readFileSync(checkpointPath, "utf8"), future);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("checkpoint pruning removes panes no longer present in state", () => {
  const directory = privateTempDirectory(
    path.join(os.tmpdir(), "wmux-checkpoint-prune-"),
  );
  try {
    const store = new TerminalCheckpointStore(directory);
    for (const paneId of ["retained", "removed"]) {
      store.schedule(
        paneId,
        "raw-pty",
        () => checkpoint(paneId),
      );
    }
    store.flush();
    store.prune(new Set(["retained"]));
    assert.deepEqual(
      store.load("retained", "raw-pty"),
      checkpoint("retained"),
    );
    assert.equal(store.load("removed", "raw-pty"), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
