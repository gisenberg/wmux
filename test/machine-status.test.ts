import assert from "node:assert/strict";
import test from "node:test";
import { resolveMachineStatuses, resolveMachineVersionStatus } from "../src/server/machines.js";

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
  assert.match(status.runtimeVersion ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(status.expectedRuntimeVersion, status.runtimeVersion);
  assert.equal(status.versionStatus, "current");
  assert.equal(status.stream?.gatewayUrl, "https://gateway.example");
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /agent-secret|gateway-secret|private-command|private-shell|secret\/worktree/);
  assert.equal("agentToken" in status, false);
  assert.equal("command" in status, false);
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
