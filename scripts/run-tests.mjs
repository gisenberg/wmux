import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const files = ["test", "test/backend-conformance"].flatMap((directory) =>
  fs.readdirSync(directory).filter((file) => file.endsWith(".test.ts")).sort().map((file) => `${directory}/${file}`));

if (process.platform !== "win32") {
  const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
  child.on("error", (error) => { console.error(error); process.exitCode = 1; });
} else {
  const requested = process.argv.slice(2);
  const selected = requested.length ? files.filter((file) => requested.includes(file)) : files;
  if (!selected.length) throw new Error("No matching test files");
  const timeoutMs = Number(process.env.WMUX_TEST_FILE_TIMEOUT_MS ?? 120000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("Invalid WMUX_TEST_FILE_TIMEOUT_MS");
  let next = 0, failed = 0, timedOut = 0;
  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0 };
  const runFile = (file) => new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-test-"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WMUX_")));
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./test/test-environment.ts", "--test", file], {
      env: { ...env, HOME: home, USERPROFILE: home }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", expired = false;
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const timer = setTimeout(() => {
      expired = true;
      // Node's per-test timeout cannot close leaked handles after an assertion.
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill());
    }, timeoutMs);
    child.on("error", (error) => { output += String(error); });
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0 || expired) failed++;
      if (expired) timedOut++;
      console.log(`\n# ${file}: ${expired ? "TIMEOUT" : code === 0 ? "PASS" : "FAIL"}\n${output}`);
      for (const key of Object.keys(totals)) {
        const match = output.match(new RegExp(`(?:ℹ|#) ${key} (\\d+)`));
        if (match) totals[key] += Number(match[1]);
      }
      try { await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch { console.error(`Test home retained for inspection: ${home}`); failed++; }
      resolve();
    });
  });
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length) await runFile(selected[next++]);
  }));
  console.log(`\nWindows test files: ${selected.length}; failures: ${failed}; timeouts: ${timedOut}`);
  console.log(`Reported test totals: ${JSON.stringify(totals)}${timedOut ? " (incomplete in timed-out files)" : ""}`);
  process.exitCode = failed ? 1 : 0;
}
