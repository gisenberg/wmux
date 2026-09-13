#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connectCodexObserver } from "../plugins/wmux/scripts/codex-rpc.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = value => createHash("sha256").update(value).digest("hex");
const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
}).trim();

export function pluginIdentity(directory) {
  const files = [];
  const visit = relative => {
    const absolute = path.join(directory, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error("Plugin artifacts must not contain symlinks.");
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(relative, entry));
    } else if (stat.isFile()) files.push({ path: relative.split(path.sep).join("/"), sha256: digest(fs.readFileSync(absolute)) });
    else throw new Error("Unexpected plugin artifact type.");
  };
  visit("");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, ".codex-plugin/plugin.json"), "utf8"));
  return { version: manifest.version, sha256: digest(JSON.stringify(files)), files };
}

export function schemaCapabilities(client, notifications) {
  const methods = schema => new Set((schema.oneOf ?? []).flatMap(item => item.properties?.method?.enum ?? []));
  const requests = methods(client), events = methods(notifications);
  return {
    threadRead: requests.has("thread/read"),
    metadataOnlyRead: Boolean(client.definitions?.ThreadReadParams?.properties?.includeTurns),
    boundedTurnListing: requests.has("thread/turns/list") && Boolean(client.definitions?.ThreadTurnsListParams?.properties?.itemsView),
    nativeName: Boolean(notifications.definitions?.Thread?.properties?.name),
    nativeNameNotification: events.has("thread/name/updated"),
    observationSubscriptionEstablished: false,
  };
}

export async function probeThread({ threadId, socketPath }, connect = connectCodexObserver) {
  let client;
  try {
    client = await connect({ threadId, ...(socketPath ? { socketPath } : {}) });
    const { thread } = await client.request("thread/read", { threadId, includeTurns: false });
    if (thread?.id !== threadId || thread.parentThreadId !== null) return { result: "identity_mismatch" };
    return { result: "readable", nativeNamePresent: typeof thread.name === "string" && thread.name.length > 0,
      runtimeStatus: ["active", "idle", "notLoaded", "systemError"].includes(thread.status?.type) ? thread.status.type : "unknown" };
  } catch { return { result: "unavailable" }; }
  finally { client?.close(); }
}

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: "string" }, "source-root": { type: "string" }, "installed-plugin": { type: "string" }, "deployed-root": { type: "string" },
    "thread-id": { type: "string" }, socket: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("npm run codex:baseline -- --out NEW_DIRECTORY [--source-root CHECKOUT] [--installed-plugin PATH] [--deployed-root PATH] [--thread-id EXACT_ID] [--socket ABSOLUTE_PATH]\nCaptures source/artifact hashes, installed CLI schema, default daemon version, and optional read-only metadata. Never starts/resumes/renames a task or changes native configuration. See docs/CODEX_M0_UAT.md.");
    return;
  }
  if (!values.out) throw new Error("An unused --out directory is required.");
  if (values.socket && !values["thread-id"]) throw new Error("--socket requires an explicit --thread-id.");
  if (values["thread-id"] && !/^[A-Za-z0-9_-]{1,128}$/.test(values["thread-id"])) throw new Error("Invalid thread ID.");
  const output = path.resolve(values.out);
  fs.mkdirSync(output, { mode: 0o700 }); // Never reuse or overwrite an earlier evidence bundle.
  const source = path.resolve(values["source-root"] || root);
  const git = (...args) => run("git", args, source);
  const commit = git("rev-parse", "HEAD");
  const status = git("status", "--porcelain");
  const patchSha256 = digest(git("diff", "HEAD", "--binary"));
  const sourcePlugin = pluginIdentity(path.join(source, "plugins/wmux"));
  const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), platform: process.platform,
    architecture: process.arch, nodeVersion: process.version,
    collector: { commit: run("git", ["rev-parse", "HEAD"]), clean: !run("git", ["status", "--porcelain"]),
      scriptSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))) },
    source: { commit, tree: git("rev-parse", "HEAD^{tree}"), clean: !status, patchSha256, plugin: sourcePlugin,
      nativeNameObserverPresent: sourcePlugin.files.some(file => file.path === "scripts/wmux-name-observer.mjs") },
    nativeUat: "pending" };
  if (values["installed-plugin"]) {
    const installed = pluginIdentity(path.resolve(values["installed-plugin"]));
    const sourceFiles = new Map(sourcePlugin.files.map(file => [file.path, file.sha256]));
    report.installedPlugin = { ...installed, exactMatch: installed.sha256 === sourcePlugin.sha256,
      differences: [...new Set([...sourceFiles.keys(), ...installed.files.map(file => file.path)])]
        .filter(name => sourceFiles.get(name) !== installed.files.find(file => file.path === name)?.sha256) };
  }
  if (values["deployed-root"]) {
    const deployed = path.resolve(values["deployed-root"]);
    const paths = [...sourcePlugin.files.map(file => `plugins/wmux/${file.path}`),
      "src/server/codex-terminal-binding.ts", "src/server/routes/codex-binding-routes.ts"];
    report.deployedSource = { compiledRuntimeVerified: false, files: paths.map(name => {
      const target = path.join(deployed, name);
      const sha256 = fs.existsSync(target) ? digest(fs.readFileSync(target)) : null;
      return { path: name, sha256, matches: sha256 === digest(fs.readFileSync(path.join(source, name))) };
    }) };
  }
  report.cliVersion = run("codex", ["--version"]);
  const schemaDirectory = path.join(output, "schema");
  run("codex", ["app-server", "generate-json-schema", "--experimental", "--out", schemaDirectory]);
  const schemas = ["ClientRequest.json", "ServerNotification.json"].map(name => fs.readFileSync(path.join(schemaDirectory, name)));
  report.cliSchema = { sha256: schemas.map(digest), capabilities: schemaCapabilities(...schemas.map(buffer => JSON.parse(buffer.toString()))) };
  try {
    const daemon = JSON.parse(run("codex", ["app-server", "daemon", "version"]));
    report.defaultDaemon = { status: daemon.status, cliVersion: daemon.cliVersion, appServerVersion: daemon.appServerVersion };
  } catch { report.defaultDaemon = { status: "unavailable" }; }
  report.endpointSelection = values.socket ? "explicit-private-socket" : process.env.WMUX_CODEX_SOCKET_PATH ? "environment-private-socket" : "default-private-socket";
  report.defaultDaemonDescribesProbeEndpoint = report.endpointSelection === "default-private-socket";
  if (values["thread-id"]) report.nativeMetadata = await probeThread({ threadId: values["thread-id"], socketPath: values.socket });
  if (git("rev-parse", "HEAD") !== commit || git("status", "--porcelain") !== status
    || digest(git("diff", "HEAD", "--binary")) !== patchSha256
    || pluginIdentity(path.join(source, "plugins/wmux")).sha256 !== sourcePlugin.sha256) {
    throw new Error("Source changed during capture; discard this bundle and retry.");
  }
  fs.writeFileSync(path.join(output, "baseline.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ commit, clean: report.source.clean, pluginSha256: sourcePlugin.sha256,
    cliVersion: report.cliVersion, defaultDaemon: report.defaultDaemon, nativeMetadata: report.nativeMetadata ?? "not requested", nativeUat: "pending" }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Baseline capture failed; check arguments, artifact paths, and local Codex availability. No native state was changed. Use a new output directory for retry."); process.exitCode = 1; });
}
