function remoteMain(options) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  let leased = false;
  let lock;
  let code = 1;
  const started = Date.now();
  const run = (command, args, capture = false) => {
    const result = spawnSync(command, args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit", env: { ...process.env, WMUX_RUNTIME_SCOPED: "1" } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
    return (result.stdout || "").trim();
  };
  try {
    process.chdir(options.checkout);
    lock = path.join(run("git", ["rev-parse", "--absolute-git-dir"], true), "wmux-verification.lock");
    fs.mkdirSync(lock, { mode: 0o700 });
    leased = true;
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ run: options.id, commit: options.commit, started }), { mode: 0o600 });
    const status = run("git", ["status", "--porcelain", "--untracked-files=all"], true);
    const unexpected = status.split("\n").filter((line) => line && !(process.platform === "win32" && line.startsWith("?? logs/")));
    if (unexpected.length) throw new Error("Runner checkout contains changes; preserve and inspect them before retrying");
    const old = run("git", ["rev-parse", "HEAD"], true);
    const remote = run("git", ["remote"], true).split("\n").find((name) => /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)gisenberg\/wmux(?:\.git)?$/.test(run("git", ["remote", "get-url", name], true)));
    if (!remote) throw new Error("No remote points to the owner repository gisenberg/wmux");
    run("git", ["fetch", remote, options.commit]);
    run("git", ["switch", "--detach", options.commit]);
    if (run("git", ["rev-parse", "HEAD"], true) !== options.commit) throw new Error("Runner HEAD mismatch");
    const dependenciesChanged = run("git", ["diff", "--name-only", old, options.commit, "--", "package.json", "package-lock.json"], true);
    // npm.cmd needs cmd.exe on Windows; all arguments here are fixed allowlisted values.
    const npm = (args) => process.platform === "win32" ? run("cmd.exe", ["/d", "/s", "/c", "npm", ...args]) : run("npm", args);
    if (dependenciesChanged || !fs.existsSync("node_modules")) npm(["ci"]);
    console.log(`Verifying ${options.commit}: npm run ${options.script}`);
    npm(["run", options.script]);
    if (run("git", ["rev-parse", "HEAD"], true) !== options.commit) throw new Error("Runner HEAD changed during verification");
    code = 0;
  } catch (error) {
    console.error(error.message);
  } finally {
    if (leased) {
      fs.unlinkSync(path.join(lock, "owner.json"));
      fs.rmdirSync(lock);
    }
    // Join fragments at runtime so shell echo cannot satisfy the controller.
    console.log(["WMUX", "VERIFY", options.id, options.commit, code, Date.now() - started].join(":"));
    process.exitCode = code;
  }
}
module.exports = { remoteMain };
