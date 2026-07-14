import assert from "node:assert/strict";
import test from "node:test";
import {
  machineReleaseVersion,
  resolveMachinePlatform,
  resolveMachineStatuses,
  resolveMachineVersionStatus,
} from "../src/server/machines.js";

test("browser-facing machine status excludes server-only configuration", async () => {
  const [status] = await resolveMachineStatuses([
    {
      id: "local",
      name: "Local",
      kind: "local",
      cwd: "/secret/worktree",
      shell: "/bin/private-shell",
      command: ["private-command"],
      agentToken: "agent-secret",
      stream: {
        provider: "moonlight-gateway",
        gatewayUrl: "https://gateway.example",
        gatewayOpenUrl: "https://gateway.example/open",
        gatewayToken: "gateway-secret",
      },
    },
  ]);

  assert.equal(status.id, "local");
  assert.equal(status.platform, resolveMachinePlatform({ id: "local", name: "Local", kind: "local" }));
  assert.match(status.releaseVersion, /^v\d+\.\d+\.\d+-(linux|mac|win)$/);
  assert.match(status.runtimeVersion ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(status.expectedRuntimeVersion, status.runtimeVersion);
  assert.equal(status.versionStatus, "current");
  assert.equal(status.stream?.gatewayUrl, "https://gateway.example");
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /agent-secret|gateway-secret|private-command|private-shell|secret\/worktree/);
  assert.equal("agentToken" in status, false);
  assert.equal("command" in status, false);
});

test("machine release versions use one platform-suffixed scheme", () => {
  const ssh = { id: "mac", name: "Mac", kind: "ssh" as const, platform: "mac" as const };
  const windows = { id: "win", name: "Windows", kind: "powershell-ssh" as const };
  const local = { id: "local", name: "Linux", kind: "local" as const };

  assert.match(machineReleaseVersion(ssh), /^v\d+\.\d+\.\d+-mac$/);
  assert.match(machineReleaseVersion(windows), /^v\d+\.\d+\.\d+-win$/);
  assert.match(machineReleaseVersion(local, "linux"), /^v\d+\.\d+\.\d+-linux$/);
});

test("machine version status distinguishes runtime and helper drift", () => {
  assert.equal(resolveMachineVersionStatus({
    reachable: true,
    runtimeVersion: "0.7",
    expectedRuntimeVersion: "0.7",
    helperBundleVersion: "bundle-a",
    expectedHelperBundleVersion: "bundle-a",
  }), "current");
  assert.equal(resolveMachineVersionStatus({
    reachable: true,
    runtimeVersion: "0.4",
    expectedRuntimeVersion: "0.7",
  }), "outdated");
  assert.equal(resolveMachineVersionStatus({
    reachable: true,
    runtimeVersion: "0.7",
    expectedRuntimeVersion: "0.7",
    helperBundleVersion: "bundle-a",
    expectedHelperBundleVersion: "bundle-b",
  }), "outdated");
  assert.equal(resolveMachineVersionStatus({
    reachable: false,
    runtimeVersion: "0.7",
    expectedRuntimeVersion: "0.7",
  }), "unknown");
});

test("offline registered status preserves heartbeat metadata without exposing credentials", async () => {
  const [status] = await resolveMachineStatuses([
    {
      id: "gdi",
      name: "GDI",
      kind: "powershell-ssh",
      host: "100.70.0.8",
      sessionBackend: "agent",
      agentPort: 3481,
      agentToken: "private-agent-token",
      source: "registered",
      registeredAt: "2026-07-08T00:00:00.000Z",
      lastSeenAt: "2026-07-08T00:01:00.000Z",
      expiresAt: "2026-07-08T00:02:30.000Z",
      online: false,
    },
  ]);

  assert.equal(status.reachable, false);
  assert.equal(status.source, "registered");
  assert.equal(status.lastSeenAt, "2026-07-08T00:01:00.000Z");
  assert.equal(status.online, false);
  assert.match(status.reason ?? "", /^Offline; last seen /);
  assert.doesNotMatch(JSON.stringify(status), /private-agent-token/);
  assert.equal("agentToken" in status, false);
});
