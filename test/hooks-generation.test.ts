import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("integration generation is deterministic across checkout line endings and rejects stale sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-hooks-generation-"));
  try {
    for (const file of ["scripts/generate-hooks.mjs", "scripts/wmux-hooks", "src/integrations/hooks-installer.mjs", "src/integrations/opencode.ts", "src/integrations/prime-agent.ts"]) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fs.readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
    }
    const check = () => spawnSync(process.execPath, ["scripts/generate-hooks.mjs", "--check"], { cwd: root, encoding: "utf8" });
    const clean = check();
    assert.equal(clean.status, 0, clean.stderr);
    fs.appendFileSync(path.join(root, "src/integrations/prime-agent.ts"), "\r\n// fixture source change\r\n");
    assert.equal(check().status, 1);
    const generated = spawnSync(process.execPath, ["scripts/generate-hooks.mjs"], { cwd: root, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(check().status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
