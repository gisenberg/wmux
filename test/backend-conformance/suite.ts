import assert from "node:assert/strict";
import fs from "node:fs";
import type { SessionBackend, BackendSession } from "../../src/server/backends/backend.js";
import type { AttachReplay } from "../../src/server/terminal-checkpoint.js";
import type { PaneState } from "../../src/server/types.js";

const OUTPUT_DEADLINE_MS = 5_000;
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

class OutputProbe {
  private output = "";
  private waiters = new Set<() => void>();

  constructor(session: BackendSession) {
    session.on("output", (data) => {
      this.output += data;
      for (const notify of this.waiters) notify();
    });
  }

  snapshot(): string {
    return this.output;
  }

  async waitFor(pattern: string | RegExp, after = 0): Promise<string> {
    const matches = (): boolean => {
      const candidate = this.output.slice(after);
      return typeof pattern === "string"
        ? candidate.includes(pattern)
        : pattern.test(stripTerminalControls(candidate));
    };
    if (matches()) return this.output;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for backend output ${String(pattern)}; received ${JSON.stringify(this.output)}`));
      }, OUTPUT_DEADLINE_MS);
      const check = () => {
        if (!matches()) return;
        clearTimeout(deadline);
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
    return this.output;
  }
}

const pane = (id: string, machineId: string): PaneState => ({
  id,
  machineId,
  title: "Backend conformance",
  status: "idle",
  createdAt: new Date().toISOString(),
});

const spawn = async (
  backend: SessionBackend,
  paneId: string,
  restoredCheckpoint?: AttachReplay,
): Promise<{ session: BackendSession; output: OutputProbe }> => {
  const session = backend.spawn({
    pane: pane(paneId, backend.machine.id),
    cols: 80,
    rows: 24,
    env: { TERM: "xterm-256color" },
    ...(restoredCheckpoint ? { restoredCheckpoint } : {}),
  });
  const output = new OutputProbe(session);
  await backend.attach(session);
  const baseline = output.snapshot().length;
  backend.write(
    session,
    backend.machine.kind === "powershell" || backend.machine.kind === "powershell-ssh"
      ? "Write-Output ('WMUX_BACKEND_' + 'READY')\r"
      : "stty -echo; printf '%s%s\\n' 'WMUX_BACKEND_' 'READY'\r",
  );
  await output.waitFor("WMUX_BACKEND_READY", baseline);
  return { session, output };
};

const stripTerminalControls = (value: string): string => value
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

export const exerciseBackendConformance = async (
  backend: SessionBackend,
  paneId: string,
): Promise<void> => {
  let session: BackendSession | undefined;
  const windows =
    backend.machine.kind === "powershell"
    || backend.machine.kind === "powershell-ssh";
  try {
    const started = await spawn(backend, paneId);
    session = started.session;
    let output = started.output;
    if (backend.machine.sessionBackend === "tmux" || backend.machine.sessionBackend === "agent") {
      assert.equal(backend.capabilities.restartDurable, true, "the actual backend must confirm durability");
    }

    let baseline = output.snapshot().length;
    backend.write(
      session,
      windows ? "Write-Output 'WMUX_ECHO_ROUND_TRIP'\r" : "printf 'WMUX_ECHO_ROUND_TRIP\\n'\r",
    );
    await output.waitFor("WMUX_ECHO_ROUND_TRIP", baseline);
    assert.match(backend.readReplay(session, true).data, /WMUX_ECHO_ROUND_TRIP/);

    backend.resize(session, 101, 31);
    baseline = output.snapshot().length;
    backend.write(
      session,
      windows ? "Write-Output 'WMUX_RESIZED_101_31'\r"
        : "wmux_resize_attempt=0; while [ \"$(stty size)\" != '31 101' ] && [ \"$wmux_resize_attempt\" -lt 100 ]; do wmux_resize_attempt=$((wmux_resize_attempt + 1)); sleep 0.02; done; stty size\r",
    );
    await output.waitFor(windows ? "WMUX_RESIZED_101_31" : /\b31 101\b/, baseline);

    baseline = output.snapshot().length;
    for (const fragment of ["A", "B", "C", "D"]) {
      backend.write(
        session,
        windows ? `[Console]::Out.Write('${fragment}')\r` : `printf '${fragment}'\r`,
      );
    }
    backend.write(
      session,
      windows
        ? "Write-Output ''; Write-Output 'WMUX_SERIAL_DONE'\r"
        : "printf '\\nWMUX_SERIAL_DONE\\n'\r",
    );
    const serialized = await output.waitFor("WMUX_SERIAL_DONE", baseline);
    const ordered = serialized.slice(baseline).replace(/\r/g, "");
    assert.match(ordered, /A.*B.*C.*D.*WMUX_SERIAL_DONE/s);

    baseline = output.snapshot().length;
    backend.write(
      session,
      windows
        ? "[Console]::Out.Write(\"`e[?1049hWMUX_ALT_SCREEN\")\r"
        : "printf '\\033[?1049hWMUX_ALT_SCREEN'\r",
    );
    await output.waitFor("WMUX_ALT_SCREEN", baseline);
    assert.equal(backend.checkpoint(session)?.kind, "checkpoint");
    if (backend.capabilities.persistentCheckpoint) {
      const persistedCheckpoint = backend.checkpoint(session);
      assert.ok(persistedCheckpoint);
      backend.detach(session);
      const restarted = await spawn(
        backend,
        paneId,
        persistedCheckpoint,
      );
      session = restarted.session;
      output = restarted.output;
      const restoredReplay = backend.readReplay(session);
      assert.equal(restoredReplay.kind, "checkpoint");
      assert.match(restoredReplay.data, /WMUX_ALT_SCREEN/);
    }
    backend.write(
      session,
      windows ? "[Console]::Out.Write(\"`e[?1049l\")\r" : "printf '\\033[?1049l'\r",
    );

    if (backend.capabilities.supportsFileStaging) {
      const staged = await backend.stageFile(paneId, PNG, { inputEpoch: 0 });
      assert.deepEqual(fs.readFileSync(staged.targetPath), PNG);
    }

    if (backend.capabilities.restartDurable) {
      backend.write(session, windows
        ? "$global:wmuxConformanceRetained = 'retained-process'; Write-Output ('WMUX_SAVED_' + 'STATE')\r"
        : "wmux_conformance_retained=retained-process; printf '%s%s\\n' 'WMUX_SAVED_' 'STATE'\r");
      await output.waitFor("WMUX_SAVED_STATE");
      backend.detach(session);
      const reattached = await spawn(backend, paneId);
      session = reattached.session;
      baseline = reattached.output.snapshot().length;
      backend.write(
        session,
        windows ? "Write-Output 'WMUX_REATTACHED'\r" : "printf 'WMUX_REATTACHED\\n'\r",
      );
      await reattached.output.waitFor("WMUX_REATTACHED", baseline);
      assert.match(backend.readReplay(session, true).data, /WMUX_REATTACHED/);
      baseline = reattached.output.snapshot().length;
      backend.write(session, windows
        ? "Write-Output ('WMUX_PERSISTED:' + $global:wmuxConformanceRetained)\r"
        : "printf 'WMUX_PERSISTED:%s\\n' \"$wmux_conformance_retained\"\r");
      await reattached.output.waitFor("WMUX_PERSISTED:retained-process", baseline);
    }

    const exited = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("backend process survived disposal")),
        OUTPUT_DEADLINE_MS,
      );
      session?.on("exit", () => {
        clearTimeout(deadline);
        resolve();
      });
    });
    await backend.dispose(paneId, session, { kill: true });
    await exited;
    session = undefined;
  } finally {
    if (session) await backend.dispose(paneId, session, { kill: true }).catch(() => undefined);
  }
};
