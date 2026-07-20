import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { readAgentProfileBundle, resolveAgentProfilePath } from "../src/server/agent-profile.js";

const helper = path.resolve("scripts/wmux-agent-profile");
const profilePlatform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const temporary: string[] = [];
const originalProfilePath = process.env.WMUX_AGENT_PROFILE_PATH;

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-profile-"));
  temporary.push(dir);
  return dir;
};

afterEach(() => {
  if (originalProfilePath === undefined) delete process.env.WMUX_AGENT_PROFILE_PATH;
  else process.env.WMUX_AGENT_PROFILE_PATH = originalProfilePath;
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const writeProfile = (root: string): void => {
  fs.mkdirSync(path.join(root, "instructions"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "portable"), { recursive: true });
  fs.writeFileSync(path.join(root, "instructions", "shared.md"), "Prefer the robust solution.\n");
  fs.writeFileSync(path.join(root, "skills", "portable", "SKILL.md"), "portable skill\n");
  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({
    version: 1,
    name: "test",
    managedText: [{ id: "shared", source: "instructions/shared.md", target: "~/.codex/AGENTS.md", comment: "html" }],
    trees: [{ source: "skills", target: "~/.agents/skills" }],
  }));
};

test("server bundles the configured profile with hashes", () => {
  const root = tempDir();
  writeProfile(root);
  process.env.WMUX_AGENT_PROFILE_PATH = root;
  fs.writeFileSync(path.join(root, "unreferenced-secret.txt"), "must not be served");
  assert.equal(resolveAgentProfilePath(), root);
  const bundle = readAgentProfileBundle();
  assert.equal(bundle.exists, true);
  assert.equal(bundle.manifest?.name, "test");
  for (const file of bundle.files ?? []) {
    const bytes = Buffer.from(file.dataBase64, "base64");
    assert.equal(file.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(bundle.files?.some((file) => file.path === "unreferenced-secret.txt"), false);
});

test("plan is read-only and apply preserves unmanaged text", () => {
  const profile = tempDir();
  const home = tempDir();
  writeProfile(profile);
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "AGENTS.md"), "local instruction\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home, WMUX_AGENT_PROFILE_STATE_PATH: path.join(home, "state.json") };

  const plan = spawnSync("python3", [helper, "plan", "--profile", profile, "--json"], { encoding: "utf8", env });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8"), "local instruction\n");
  assert.equal(fs.existsSync(path.join(home, "state.json")), false);
  assert.equal(fs.existsSync(path.join(home, ".wmux", "logs", "agent-profile.log")), false);

  const apply = spawnSync("python3", [helper, "apply", "--profile", profile, "--json"], { encoding: "utf8", env });
  assert.equal(apply.status, 0, apply.stderr);
  const instructions = fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8");
  assert.match(instructions, /^local instruction/m);
  assert.match(instructions, /Prefer the robust solution/);
  assert.equal(fs.readFileSync(path.join(home, ".agents", "skills", "portable", "SKILL.md"), "utf8"), "portable skill\n");
  assert.equal(fs.existsSync(path.join(home, "state.json")), true);
  const backupRoot = path.join(home, ".wmux", "agent-profile-backups");
  assert.ok(fs.readdirSync(backupRoot).some((run) => fs.readdirSync(path.join(backupRoot, run)).length > 0));
});

test("apply refuses a locally changed profile-owned file", () => {
  const profile = tempDir();
  const home = tempDir();
  writeProfile(profile);
  const env = { ...process.env, HOME: home, USERPROFILE: home, WMUX_AGENT_PROFILE_STATE_PATH: path.join(home, "state.json") };
  assert.equal(spawnSync("python3", [helper, "apply", "--profile", profile], { env }).status, 0);
  const skill = path.join(home, ".agents", "skills", "portable", "SKILL.md");
  fs.writeFileSync(skill, "local edit\n");
  fs.writeFileSync(path.join(profile, "skills", "portable", "SKILL.md"), "profile update\n");
  const result = spawnSync("python3", [helper, "apply", "--profile", profile, "--json"], { encoding: "utf8", env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /conflict/);
  assert.equal(fs.readFileSync(skill, "utf8"), "local edit\n");
});

test("items with missing tool prerequisites are visible and not applied", () => {
  const profile = tempDir();
  const home = tempDir();
  writeProfile(profile);
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, "profile.json"), "utf8"));
  manifest.tools = [{
    id: "definitely-missing",
    command: "wmux-test-tool-that-does-not-exist",
    platforms: [profilePlatform],
  }];
  manifest.managedText[0].requires = ["definitely-missing"];
  fs.writeFileSync(path.join(profile, "profile.json"), JSON.stringify(manifest));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WMUX_AGENT_PROFILE_STATE_PATH: path.join(home, "state.json") };

  const result = spawnSync("python3", [helper, "apply", "--profile", profile, "--json"], { encoding: "utf8", env });
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.results.some((item: { action: string; detail: string }) =>
    item.action === "blocked" && item.detail.includes("definitely-missing missing")));
  assert.equal(fs.existsSync(path.join(home, ".codex", "AGENTS.md")), false);
});

test("bootstrap verifies a pinned artifact before enabling dependent items", { skip: process.platform === "win32" }, () => {
  const profile = tempDir();
  const home = tempDir();
  writeProfile(profile);
  const artifact = path.join(profile, "fake-tool");
  const toolBytes = Buffer.from("#!/bin/sh\necho 'fake 1.0.0'\n");
  fs.writeFileSync(artifact, toolBytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, "profile.json"), "utf8"));
  const platformName = profilePlatform;
  const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
  manifest.tools = [{
    id: "fake",
    command: "fake",
    versionPattern: "^fake 1\\.0\\.0$",
    installTarget: "~/.local/bin/fake",
    platforms: [platformName],
    artifacts: {
      [`${platformName}-${architecture}`]: {
        url: pathToFileURL(artifact).href,
        sha256: crypto.createHash("sha256").update(toolBytes).digest("hex"),
        format: "raw",
      },
    },
  }];
  manifest.managedText[0].requires = ["fake"];
  fs.writeFileSync(path.join(profile, "profile.json"), JSON.stringify(manifest));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    WMUX_AGENT_PROFILE_ALLOW_FILE_URL: "1",
    WMUX_AGENT_PROFILE_STATE_PATH: path.join(home, "state.json"),
  };

  const bootstrap = spawnSync("python3", [helper, "bootstrap", "--tool", "fake", "--profile", profile, "--json"], {
    encoding: "utf8",
    env,
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(fs.statSync(path.join(home, ".local", "bin", "fake")).mode & 0o777, 0o755);
  const apply = spawnSync("python3", [helper, "apply", "--profile", profile, "--json"], { encoding: "utf8", env });
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8"), /Prefer the robust solution/);
  const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
  assert.equal(state.tools.fake.version, "fake 1.0.0");
});

test("bootstrap refuses an artifact whose checksum changed", () => {
  const profile = tempDir();
  const home = tempDir();
  writeProfile(profile);
  const artifact = path.join(profile, "fake-tool");
  fs.writeFileSync(artifact, "unexpected bytes");
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, "profile.json"), "utf8"));
  const platformName = profilePlatform;
  const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
  manifest.tools = [{
    id: "fake",
    command: "fake",
    installTarget: "~/.local/bin/fake",
    platforms: [platformName],
    artifacts: {
      [`${platformName}-${architecture}`]: { url: pathToFileURL(artifact).href, sha256: "0".repeat(64), format: "raw" },
    },
  }];
  fs.writeFileSync(path.join(profile, "profile.json"), JSON.stringify(manifest));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    WMUX_AGENT_PROFILE_ALLOW_FILE_URL: "1",
    WMUX_AGENT_PROFILE_STATE_PATH: path.join(home, "state.json"),
  };
  const result = spawnSync("python3", [helper, "bootstrap", "--tool", "fake", "--profile", profile], { encoding: "utf8", env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /artifact hash mismatch/);
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "fake")), false);
});

test("add-skill validates content, records provenance, and requires explicit replacement", () => {
  const profile = tempDir();
  const source = tempDir();
  writeProfile(profile);
  fs.writeFileSync(path.join(source, "SKILL.md"), [
    "---",
    "name: sample-skill",
    "description: A sample portable skill.",
    "---",
    "",
    "# Sample",
    "",
  ].join("\n"));

  const added = spawnSync("python3", [helper, "add-skill", source, "--profile", profile, "--license", "MIT", "--source-url", "https://example.com/skills.git", "--source-ref", "abc123", "--json"], { encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).action, "create");
  assert.equal(fs.existsSync(path.join(profile, "skills", "sample-skill", "SKILL.md")), true);
  const lock = JSON.parse(fs.readFileSync(path.join(profile, "skills.lock.json"), "utf8"));
  assert.equal(lock.skills["sample-skill"].license, "MIT");
  assert.equal(lock.skills["sample-skill"].source, "https://example.com/skills.git");

  fs.appendFileSync(path.join(source, "SKILL.md"), "Updated.\n");
  const conflict = spawnSync("python3", [helper, "add-skill", source, "--profile", profile, "--license", "MIT"], { encoding: "utf8" });
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /use --replace after review/);
  assert.doesNotMatch(fs.readFileSync(path.join(profile, "skills", "sample-skill", "SKILL.md"), "utf8"), /Updated/);

  const replaced = spawnSync("python3", [helper, "add-skill", source, "--profile", profile, "--license", "MIT", "--replace", "--json"], { encoding: "utf8" });
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(JSON.parse(replaced.stdout).action, "update");
  assert.match(fs.readFileSync(path.join(profile, "skills", "sample-skill", "SKILL.md"), "utf8"), /Updated/);
});

test("add-skill rejects common secret material", () => {
  const profile = tempDir();
  const source = tempDir();
  writeProfile(profile);
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: unsafe-skill\ndescription: Unsafe fixture.\n---\n");
  fs.writeFileSync(path.join(source, ".env"), "TOKEN=secret\n");
  const result = spawnSync("python3", [helper, "add-skill", source, "--profile", profile], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sensitive file name/);
  assert.equal(fs.existsSync(path.join(profile, "skills", "unsafe-skill")), false);
});

test("status remains useful when the server profile cannot be fetched", () => {
  const home = tempDir();
  const statePath = path.join(home, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, owned: {}, lastProfile: "offline-profile", platform: "linux" }));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    WMUX_AGENT_PROFILE_STATE_PATH: statePath,
    WMUX_URL: "http://127.0.0.1:1",
  };
  const result = spawnSync("python3", [helper, "status", "--json"], { encoding: "utf8", env });
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state.lastProfile, "offline-profile");
  assert.match(payload.sourceError, /profile fetch failed/);
});

test("remote profile fetch prefers refreshed token state and falls back to the inherited token", () => {
  const home = tempDir();
  fs.mkdirSync(path.join(home, ".wmux"));
  fs.writeFileSync(path.join(home, ".wmux", "token"), "refreshed-token\n", { mode: 0o600 });
  const source = String.raw`
import io
import json
import runpy
import sys
import urllib.error

module = runpy.run_path(sys.argv[1])
authorizations = []

class Response(io.BytesIO):
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False

def fake_urlopen(request, timeout):
    authorization = request.get_header("Authorization") or ""
    authorizations.append(authorization)
    if authorization == "Bearer refreshed-token":
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)
    return Response(b'{"exists": false}')

module["load_remote"].__globals__["urllib"].request.urlopen = fake_urlopen
module["load_remote"]()
print(json.dumps(authorizations))
`;
  const result = spawnSync("python3", ["-c", source, helper], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, WMUX_TOKEN: "inherited-token" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["Bearer refreshed-token", "Bearer inherited-token"]);
});

test("optional automatic profile auth quietly skips HTTP 401", () => {
  const home = tempDir();
  const source = String.raw`
import contextlib
import io
import json
import runpy
import sys
import urllib.error

module = runpy.run_path(sys.argv[1])

def fake_urlopen(request, timeout):
    raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)

module["load_remote"].__globals__["urllib"].request.urlopen = fake_urlopen
results = []
for arguments in (["apply", "--quiet", "--optional-auth"], ["apply", "--quiet"]):
    sys.argv = [sys.argv[1], *arguments]
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        status = module["main"]()
    results.append({"status": status, "stderr": stderr.getvalue()})
print(json.dumps(results))
`;
  const result = spawnSync("python3", ["-c", source, helper], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      WMUX_TOKEN: "",
      WMUX_TOKEN_PATH: path.join(home, "missing-token"),
      WMUX_URL: "http://wmux.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { status: 0, stderr: "" },
    { status: 2, stderr: "wmux-agent-profile: profile fetch failed: HTTP 401\n" },
  ]);
});
