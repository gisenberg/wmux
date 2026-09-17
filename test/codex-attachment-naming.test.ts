import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { privateTempDirectory } from "./private-fixture.js";
import { SessionManager } from "../src/server/session-manager.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

test("an attached CLI marker replay leaves the original Codex naming binding live", () => {
  const directory = privateTempDirectory(path.join(os.tmpdir(), "wmux-codex-attachment-naming-"));
  const machine: MachineConfig = {
    id: "local",
    name: "Local",
    kind: "local",
    sessionBackend: "pty",
    command: [process.execPath, "-e", "process.stdin.resume()"],
  };
  const state = new StateStore([machine], path.join(directory, "state.json"));
  const workspace = state.snapshot().workspaces[0]!;
  const originalPane = workspace.tabs[0]!.panes[0]!;
  const attachmentTab = state.createTab(workspace.id, machine.id);
  const attachmentPane = attachmentTab.panes[0]!;
  const manager = new SessionManager(state, [machine]);
  const sessions = manager as unknown as {
    sessions: Map<string, { emit(event: string, data: string): void }>;
  };
  try {
    manager.setCodexAttachmentPaneGuard((paneId) => paneId === attachmentPane.id);
    assert.equal(manager.writePane(originalPane.id, ""), true);
    assert.equal(manager.writePane(attachmentPane.id, ""), true);
    const originalSession = sessions.sessions.get(originalPane.id)!;
    const attachmentSession = sessions.sessions.get(attachmentPane.id)!;
    assert.ok(originalSession);
    assert.ok(attachmentSession);

    const binding = manager.codexTerminalBindings.issue("shared-thread");
    originalSession.emit("output", binding.marker);
    assert.equal(
      manager.codexTerminalBindings.resolve("shared-thread", binding.receipt).paneId,
      originalPane.id,
    );

    // `codex resume` redraws the original marker in the attached CLI. It is
    // still terminal output, but must not be allowed to replace or invalidate
    // the receipt-bound naming proof from the original pane.
    attachmentSession.emit("output", `${binding.marker}\r\nattached replay`);
    assert.equal(
      manager.codexTerminalBindings.resolve("shared-thread", binding.receipt).paneId,
      originalPane.id,
    );
  } finally {
    manager.disposeAll();
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
