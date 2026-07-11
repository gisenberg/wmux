import assert from "node:assert/strict";
import test from "node:test";
import { resolveMachineStatuses } from "../src/server/machines.js";

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
  assert.equal(status.stream?.gatewayUrl, "https://gateway.example");
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /agent-secret|gateway-secret|private-command|private-shell|secret\/worktree/);
  assert.equal("agentToken" in status, false);
  assert.equal("command" in status, false);
});
