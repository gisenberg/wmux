#!/usr/bin/env node
import fs from "node:fs";
import runnerModule from "./verification-runner.cjs";
const { remoteMain } = runnerModule;
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  config: { type: "string", default: process.env.WMUX_VERIFICATION_CONFIG || path.join(os.homedir(), ".wmux/verification.json") },
  commit: { type: "string", default: "HEAD" },
  suite: { type: "string", default: "check" },
  runner: { type: "string", default: "posix" },
  timeout: { type: "string", default: "1800" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log("npm run verify:remote -- [--commit HEAD] [--suite check|server|webkit|auth|browser|e2e] [--runner posix|windows] [--config PATH] [--timeout SECONDS]\nSee docs/VERIFICATION.md. Full checks run on external hosts; dirty local changes must first be committed and pushed.");
  process.exit(0);
}
const suites = { check: "check", server: "test:e2e:server", webkit: "test:e2e:browser:webkit", auth: "test:e2e:auth", browser: "test:e2e:browser:chromium", e2e: "test:e2e" };
if (!Object.hasOwn(suites, values.suite)) throw new Error("Unknown verification suite");
const timeout = Number(values.timeout);
if (!Number.isFinite(timeout) || timeout < 30 || timeout > 14_400) throw new Error("Timeout must be 30..14400 seconds");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git("rev-parse", "--verify", `${values.commit}^{commit}`);
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a complete commit SHA");
if (git("status", "--porcelain")) throw new Error("Commit local changes before remote verification; a remote run cannot verify a dirty working tree.");
const config = JSON.parse(fs.readFileSync(values.config, "utf8"));
const runner = config.runners?.[values.runner];
if (!runner || !["posix", "windows"].includes(runner.shell)
  || typeof runner.machine !== "string" || typeof runner.checkout !== "string"
  || !/^(?:\/|[A-Za-z]:[\\/])/.test(runner.checkout)) throw new Error("Runner needs machine, absolute checkout, and posix/windows shell");
if (runner.shell === "windows" && values.suite !== "browser") throw new Error("Windows runs the browser-only Chromium lane; server-coupled checks require POSIX");
const python = config.python || (process.platform === "win32" ? "python" : "python3");
const ctl = path.join(root, "skills/wmux/scripts/wmuxctl.py");
const invoke = (args) => new Promise((resolve, reject) => {
  const child = spawn(python, [ctl, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(errors || `wmux controller exited ${code}`)));
});
const machines = JSON.parse(await invoke(["machines", "--json"]));
if (!machines.some((machine) => machine.id === runner.machine && machine.reachable)) {
  throw new Error(`Runner ${runner.machine} is unreachable. Use the documented fallback and report its reason.`);
}
// This program runs inside a visible terminal. The lease covers checkout
// preparation and execution, so concurrent controllers cannot change HEAD.
// It uses only Node built-ins and can therefore prepare an older checkout.


const id = randomBytes(8).toString("hex");
const quote = (value) => runner.shell === "windows"
  ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
const program = `(${remoteMain.toString()})(${JSON.stringify({ checkout: runner.checkout, commit, id, script: suites[values.suite] })})`;
// Do not forward any controller credentials or private environment to runners.
const line = `node -e ${quote(`eval(${JSON.stringify(program)})`)}`;
const reportDir = path.join(root, "test-results", "remote", id);
fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const report = { id, commit, runner: values.runner, machine: runner.machine, checkout: runner.checkout, command: `npm run ${suites[values.suite]}`, status: "starting", startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(reportDir, "result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
save();
try {
  Object.assign(report, JSON.parse(await invoke(["run", runner.machine, "--title", `wmux verify ${values.suite} ${commit.slice(0, 8)} ${id}`, "--new", "--line", line])));
  report.status = "running";
  save();
  console.log(`${report.command} on ${runner.machine} at ${commit}\n${report.url}\nEvidence: ${reportDir}`);
  const deadline = Date.now() + timeout * 1000;
  const marker = new RegExp(`WMUX:VERIFY:${id}:${commit}:(\\d+):(\\d+)`);
  for (;;) {
    const output = await invoke(["output", report.paneId, "--tail-chars", "24000"]);
    fs.writeFileSync(path.join(reportDir, "terminal.log"), output, { mode: 0o600 });
    const match = output.match(marker);
    if (match) {
      report.exitCode = Number(match[1]);
      report.durationMs = Number(match[2]);
      report.status = report.exitCode === 0 ? "passed" : "failed";
      save();
      console.log(output);
      if (report.exitCode === 0) {
        await invoke(["cleanup", "--workspace", report.workspaceId]);
        report.closed = true;
        save();
      }
      process.exitCode = report.exitCode === 0 ? 0 : 1;
      break;
    }
    if (Date.now() >= deadline) throw new Error("Observer timed out; the runner may still be executing. Inspect the retained workspace before retrying.");
    console.log(`Waiting for ${values.suite} on ${runner.machine} (${Math.round((Date.now() - Date.parse(report.startedAt)) / 1000)}s)`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
} catch (error) {
  report.status = "observer-failed";
  save();
  console.error(`${error.message}\nInspect ${report.url || reportDir}; no remote process was cancelled.`);
  process.exitCode = 1;
}
