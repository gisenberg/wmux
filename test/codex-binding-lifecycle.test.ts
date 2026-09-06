import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexBindingError } from "../src/server/codex-terminal-binding.js";
import { SessionManager } from "../src/server/session-manager.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for session transition");
    await delay(10);
  }
};

test("a replaced raw session cannot bind from delayed old output after the pane is live again", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-binding-lifecycle-"));
  const machine: MachineConfig = {
    id: "local",
    name: "Local",
    kind: "local",
    sessionBackend: "pty",
    command: ["sh", "-c", "cat"],
  };
  const state = new StateStore([machine], path.join(directory, "state.json"));
  const pane = state.snapshot().workspaces[0]?.tabs[0]?.panes[0];
  assert.ok(pane);
  const manager = new SessionManager(state, [machine]);
  const internals = manager as unknown as { sessions: Map<string, { isExited: boolean; kill(): void; emit(event: string, data: string): void }> };
  try {
    assert.equal(manager.writePane(pane.id, ""), true);
    const oldSession = internals.sessions.get(pane.id);
    assert.ok(oldSession);
    const oldBinding = manager.codexTerminalBindings.issue("thread_old");
    oldSession.emit("output", oldBinding.marker);
    assert.equal(manager.codexTerminalBindings.resolve("thread_old", oldBinding.receipt).paneId, pane.id);

    oldSession.kill();
    await waitFor(() => !internals.sessions.has(pane.id));
    assert.equal(manager.writePane(pane.id, ""), true);
    const replacement = internals.sessions.get(pane.id);
    assert.ok(replacement);
    assert.notEqual(replacement, oldSession);

    assert.throws(() => manager.codexTerminalBindings.resolve("thread_old", oldBinding.receipt), (error: unknown) =>
      error instanceof CodexBindingError && error.code === "binding_not_found");
    const replacementBinding = manager.codexTerminalBindings.issue("thread_new");
    // The old EventEmitter listener remains callable after kill. This is the
    // regression path: delayed bytes must not bind a challenge to replacement.
    oldSession.emit("output", replacementBinding.marker);
    assert.throws(() => manager.codexTerminalBindings.resolve("thread_new", replacementBinding.receipt), (error: unknown) =>
      error instanceof CodexBindingError && error.code === "binding_pending");

    replacement.emit("output", replacementBinding.marker);
    assert.equal(manager.codexTerminalBindings.resolve("thread_new", replacementBinding.receipt).paneId, pane.id);
  } finally {
    manager.disposeAll();
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
