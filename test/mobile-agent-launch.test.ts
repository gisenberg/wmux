import assert from "node:assert/strict";
import { test } from "node:test";
import { mobileAgentLaunchCommand } from "../src/client/src/mobile-agent-launch.ts";

test("mobile agent launchers disable permission prompts on POSIX machines", () => {
  assert.equal(
    mobileAgentLaunchCommand("codex", "ssh"),
    "codex --dangerously-bypass-approvals-and-sandbox",
  );
  assert.equal(
    mobileAgentLaunchCommand("claude", "local"),
    "claude --dangerously-skip-permissions",
  );
});

test("mobile agent launchers avoid PowerShell execution-policy-blocked ps1 shims", () => {
  assert.equal(
    mobileAgentLaunchCommand("codex", "powershell-ssh"),
    "if (Get-Command codex.cmd -ErrorAction SilentlyContinue) { codex.cmd --dangerously-bypass-approvals-and-sandbox } else { codex --dangerously-bypass-approvals-and-sandbox }",
  );
  assert.equal(
    mobileAgentLaunchCommand("claude", "powershell"),
    "if (Get-Command claude.cmd -ErrorAction SilentlyContinue) { claude.cmd --dangerously-skip-permissions } else { claude --dangerously-skip-permissions }",
  );
});
