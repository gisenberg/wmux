import assert from "node:assert/strict";
import test from "node:test";
import { buildDoctorReport } from "../src/server/doctor.js";
import { StateStore } from "../src/server/state.js";
import type { DurableSessionAudit } from "../src/server/session-audit.js";
import type { MachineConfig, MachineStatus } from "../src/server/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";

test("doctor reports driver durability and pane failures without machine secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-doctor-"));
  const machines: MachineConfig[] = [
    { id: "local", name: "Local", kind: "local", sessionBackend: "tmux", agentToken: "secret" },
  ];
  try {
    const state = new StateStore(machines, path.join(dir, "state.json"));
    const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
    state.updatePane(pane.id, { status: "exited", exitCode: 7 });
    const statuses: MachineStatus[] = [{
      id: "local",
      name: "Local",
      kind: "local",
      sessionBackend: "tmux",
      reachable: true,
      checkedAt: new Date().toISOString(),
    }];
    const audit: DurableSessionAudit = {
      summary: { statePath: "test", activePaneCount: 0, sessionCount: 0, orphanCount: 0, duplicateCount: 0, missingCount: 0 },
      sessions: [],
      missing: [],
    };
    const report = buildDoctorReport(state.snapshot(), machines, statuses, audit);
    assert.equal(report.panes[0].transport, "local-multiplexer");
    assert.equal(report.panes[0].restartDurable, false, "configuration alone does not establish durability");
    assert.equal(report.panes[0].capabilitySource, "unconfirmed");
    assert.match(report.panes[0].issue ?? "", /code 7/);
    assert.equal(JSON.stringify(report).includes("secret"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor CLI exposes persistence failure and exits unsuccessfully", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-doctor-cli-"));
  const tokenPath = path.join(directory, "helper-token");
  fs.writeFileSync(tokenPath, "a".repeat(48), { mode: 0o600 });
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      checkedAt: "fixture",
      summary: { paneCount: 0, restartDurablePaneCount: 0, exitedPaneCount: 0, sessionIssueCount: 0 },
      panes: [],
      persistence: { dirty: true, failureCount: 1, errorCode: "ENOSPC" },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await new Promise<{ code: number | string | undefined; stdout: string }>((resolve) => {
      execFile(process.execPath, ["scripts/wmux-doctor"], {
        env: { ...process.env, WMUX_URL: `http://127.0.0.1:${address.port}`, WMUX_HELPER_TOKEN: "a".repeat(48), WMUX_HELPER_TOKEN_PATH: tokenPath },
      }, (error, stdout) => resolve({ code: error?.code, stdout }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /\[WARN\] state persistence: pending \(ENOSPC; retrying\)/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
