import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("OpenCode installer writes an idempotent global plugin without touching config", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-hooks-"));
  const configHome = path.join(home, "config home");
  const configPath = path.join(configHome, "opencode", "opencode.json");
  const config = '{"unrelated":true}\n';
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, config);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome };
  const hooks = path.join(repoRoot, "scripts", "wmux-hooks");
  try {
    await execFileAsync(hooks, ["install", "opencode"], { env });
    const pluginPath = path.join(configHome, "opencode", "plugins", "wmux.ts");
    const plugin = fs.readFileSync(pluginPath, "utf8");
    assert.match(plugin, /const eventScript = .*wmux-agent-event/);
    assert.match(plugin, /"chat\.message"/);
    assert.match(plugin, /if \(!session \|\| session\.data\?\.parentID\) return/);
    assert.match(plugin, /session\.idle/);
    assert.match(plugin, /session\.error/);
    assert.match(plugin, /UserPromptSubmit", title, prompt/);
    assert.match(plugin, /const session = await client\.session\.get/);
    assert.match(plugin, /const sessionTitle = \(title: string \| undefined\)/);
    assert.match(plugin, /\^New session - \\d\{4\}/);
    assert.match(plugin, /const title = sessionTitle\(session\.data\?\.title\)/);
    assert.match(plugin, /const title = sessionTitle\(session\?\.data\?\.title\) \|\| current\.title/);
    await execFileAsync(process.execPath, ["--experimental-strip-types", "--check", pluginPath]);
    const before = fs.statSync(pluginPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await execFileAsync(hooks, ["install", "opencode"], { env });
    assert.equal(fs.statSync(pluginPath).mtimeMs, before);
    assert.equal(fs.readFileSync(configPath, "utf8"), config);
    const { stdout } = await execFileAsync(hooks, ["status"], { env });
    const status = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(status.opencode, "installed");
    assert.equal(status.opencodePath, pluginPath);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
