#!/usr/bin/env node
/**
 * Isolated M3/M4 catalog and display-association qualification.  It creates
 * only synthetic private Unix sockets and fresh report/state files below
 * --out; it never reads HOME, starts Codex, or touches a native endpoint.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";

const DAY = 86_400;
const MAX_EVENTS = 20_000;
const LIMITS = { rssBytes: 512 * 1024 * 1024, sockets: 8, requests: 4_000_000, tasks: 200, associations: 200 };
const usage = () => process.stderr.write("Usage: npm run build:server && node scripts/codex-integration-soak.mjs --out /private/fresh-dir [--duration-seconds N] [--fault-period-seconds N] [--fault-duration-seconds N]\n`--source-modules` is test-only, requires node --import tsx, and is limited to 60 seconds. Shorter runs are engineering_only; only a built-module full 86400-second run can be accepted.\n");
const number = (value, name, min, max) => { const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${name} must be ${min}..${max}`); return result; };
const args = () => {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index]; if (key === "--help") { usage(); process.exit(0); }
    if (key === "--source-modules") { values.set(key, "true"); continue; }
    if (!new Set(["--out", "--duration-seconds", "--fault-period-seconds", "--fault-duration-seconds"]).has(key)) throw new Error(`Unknown argument: ${key}`);
    const value = process.argv[++index]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`); values.set(key, value);
  }
  const out = values.get("--out"); if (!out || !path.isAbsolute(out)) throw new Error("--out must be an absolute fresh private directory");
  const seconds = number(values.get("--duration-seconds") ?? DAY, "--duration-seconds", 2, DAY);
  const faultPeriod = number(values.get("--fault-period-seconds") ?? 300, "--fault-period-seconds", 2, 3600);
  const faultDuration = number(values.get("--fault-duration-seconds") ?? 20, "--fault-duration-seconds", 1, Math.max(1, faultPeriod - 1));
  const sourceModules = values.has("--source-modules");
  if (sourceModules && seconds > 60) throw new Error("--source-modules is limited to 60 engineering seconds");
  return { out, seconds, durationMs: seconds * 1000, faultPeriodMs: faultPeriod * 1000, faultDurationMs: faultDuration * 1000, sourceModules };
};
const privateFresh = (output) => {
  if (fs.existsSync(output)) throw new Error("--out must be fresh");
  const parent = fs.lstatSync(path.dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && parent.uid !== process.getuid()) || (parent.mode & 0o077)) throw new Error("--out parent must be owned mode 0700");
  fs.mkdirSync(output, { mode: 0o700 });
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const close = async (endpoint) => {
  if (!endpoint) return;
  for (const client of endpoint.ws.clients) client.terminate();
  endpoint.ws.close();
  if (endpoint.server.listening) await new Promise(resolve => endpoint.server.close(resolve));
  try { fs.unlinkSync(endpoint.socket); } catch (error) { if (error.code !== "ENOENT") throw error; }
};

const main = async () => {
  const options = args(); privateFresh(options.out);
  const moduleRoot = options.sourceModules ? "../src/server" : "../dist/server";
  const extension = options.sourceModules ? ".ts" : ".js";
  const { CodexTaskCatalog } = await import(`${moduleRoot}/codex-task-catalog${extension}`);
  const { CodexTaskAssociations } = await import(`${moduleRoot}/codex-task-associations${extension}`);
  const { CodexTaskLaunches } = await import(`${moduleRoot}/codex-task-launches${extension}`);
  const startedAt = Date.now(), deadline = startedAt + options.durationMs;
  const eventPath = path.join(options.out, "events.jsonl"), reportPath = path.join(options.out, "report.json");
  const eventFd = fs.openSync(eventPath, "wx", 0o600);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-integration-soak-")); fs.chmodSync(fixture, 0o700);
  const shortMode = options.sourceModules || options.seconds <= 60;
  const cadenceMs = shortMode ? 1_000 : 10_000;
  const reloadEveryMs = shortMode ? 2_000 : 5 * 60_000;
  const metric = { requests: 0, sockets: 0, peakSockets: 0, maxRssBytes: 0, faults: 0, recoveries: 0, metadataRecoveries: 0, healthyDuringFault: 0, notificationCount: 0, notificationDigest: "", notificationRecentIds: [], notificationRecentDuplicates: 0, catalogIds: new Set(), catalogDuplicateTitleIds: new Set(), reloads: 0, errors: [], eventLines: 0, droppedEvents: 0, launchCalls: 0 };
  const event = (value) => { if (metric.eventLines >= MAX_EVENTS) { metric.droppedEvents++; return; } fs.writeSync(eventFd, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`); metric.eventLines++; };
  const tasks = Array.from({ length: 20 }, (_, index) => ({ id: `task_${String(index).padStart(2, "0")}`, endpoint: index < 10 ? "one" : "two", duplicate: index % 2 === 1, title: index % 2 ? "Duplicate title" : `Synthetic task ${index}`, turn: 0, status: "inProgress" }));
  let outage = false;
  const makeEndpoint = (id) => {
    const socket = path.join(fixture, `${id}.sock`), server = http.createServer(), ws = new WebSocketServer({ server });
    ws.on("connection", client => {
      metric.sockets++; metric.peakSockets = Math.max(metric.peakSockets, metric.sockets);
      client.on("close", () => { metric.sockets = Math.max(0, metric.sockets - 1); });
      client.on("message", raw => {
        metric.requests++;
        let request; try { request = JSON.parse(raw.toString()); } catch { client.close(); return; }
        if (!Object.hasOwn(request, "id")) return;
        const owned = tasks.filter(task => task.endpoint === id);
        const task = owned.find(candidate => candidate.id === request.params?.threadId);
        let result;
        if (request.method === "initialize") result = { protocolVersion: "0.153.4" };
        else if (request.method === "thread/list") result = { data: owned.map(candidate => ({ id: candidate.id, name: candidate.title, preview: "synthetic", cwd: "/synthetic", status: { type: candidate.status === "inProgress" ? "active" : "idle" }, updatedAt: Math.floor(Date.now() / 1_000) })), nextCursor: null };
        else if (request.method === "thread/read" && task) result = { thread: { id: task.id, name: task.title, preview: "synthetic", cwd: "/synthetic", status: { type: task.status === "inProgress" ? "active" : "idle" }, updatedAt: Math.floor(Date.now() / 1_000) } };
        else if (request.method === "thread/turns/list" && task) result = { data: [{ id: `${task.id}_turn_${task.turn}`, status: task.status, items: [] }], nextCursor: null, backwardsCursor: null };
        else { client.close(); return; }
        client.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      });
    });
    return { id, socket, server, ws };
  };
  let endpoints = [makeEndpoint("one"), makeEndpoint("two")];
  const listen = async endpoint => { await new Promise((resolve, reject) => endpoint.server.once("error", reject).listen(endpoint.socket, resolve)); fs.chmodSync(endpoint.socket, 0o600); };
  const machines = () => [{ id: "machine-one", name: "Fixture one", kind: "local", source: "config" }, { id: "machine-two", name: "Fixture two", kind: "local", source: "config" }];
  const configs = () => endpoints.map(endpoint => ({ id: endpoint.id, label: `Fixture ${endpoint.id}`, machineId: `machine-${endpoint.id}`, transport: "local", socketPath: endpoint.socket }));
  let catalog, associations;
  const targets = new Set(tasks.map(task => JSON.stringify({ workspaceId: `workspace_${task.id}`, tabId: `tab_${task.id}`, paneId: `pane_${task.id}` })));
  const createServices = () => {
    catalog = new CodexTaskCatalog(machines, configs());
    associations = new CodexTaskAssociations({ filePath: path.join(options.out, "associations.json"), endpointIdentity: id => catalog.identity(id), resolveTarget: target => targets.has(JSON.stringify(target)), notify: notification => {
      metric.notificationCount++;
      if (metric.notificationRecentIds.includes(notification.id)) metric.notificationRecentDuplicates++;
      metric.notificationRecentIds.push(notification.id);
      if (metric.notificationRecentIds.length > 32) metric.notificationRecentIds.shift();
      metric.notificationDigest = crypto.createHash("sha256").update(`${metric.notificationDigest}\u0000${notification.id}`).digest("hex");
    } });
  };
  const associate = () => {
    for (const task of tasks) associations.put({ endpointId: task.endpoint, endpointIdentity: catalog.identity(task.endpoint), threadId: task.id, target: { workspaceId: `workspace_${task.id}`, tabId: `tab_${task.id}`, paneId: `pane_${task.id}` } });
  };
  const sample = async () => {
    for (const endpoint of endpoints) {
      try {
        const page = await catalog.list(endpoint.id);
        if (page.tasks.length !== 10 || new Set(page.tasks.map(task => task.threadId)).size !== 10) throw new Error(`catalog identity mismatch for ${endpoint.id}`);
        for (const row of page.tasks) {
          metric.catalogIds.add(row.threadId);
          if (row.name?.startsWith("Duplicate title")) metric.catalogDuplicateTitleIds.add(row.threadId);
          associations.observe((await catalog.read(endpoint.id, row.threadId)).task);
        }
      } catch (error) { if (!outage || endpoint.id !== "two") metric.errors.push(String(error)); }
    }
    metric.maxRssBytes = Math.max(metric.maxRssBytes, process.memoryUsage().rss);
  };
  try {
    await Promise.all(endpoints.map(listen)); createServices(); associate();
    const launches = new CodexTaskLaunches({ filePath: path.join(options.out, "launches.json"), open: async () => { metric.launchCalls++; return { workspaceId: "launch_workspace", tabId: "launch_tab", paneId: "launch_pane" }; } });
    const launchId = crypto.randomUUID(); await Promise.all([launches.launch({ requestId: launchId, endpointId: "one", endpointIdentity: catalog.identity("one"), cwd: "/synthetic" }), launches.launch({ requestId: launchId, endpointId: "one", endpointIdentity: catalog.identity("one"), cwd: "/synthetic" })]);
    if (metric.launchCalls !== 1 || launches.list().length !== 1) throw new Error("synthetic launch idempotency failed");
    event({ type: "start", tasks: tasks.length, synthetic: true });
    await sample(); // Establish active-turn baselines before the synthetic activity cycle.
    let nextFault = Date.now() + options.faultPeriodMs, nextReload = Date.now() + reloadEveryMs, tick = 0;
    while (Date.now() < deadline) {
      for (const endpoint of ["one", "two"]) {
        const owned = tasks.filter(task => task.endpoint === endpoint);
        const task = owned[Math.floor(tick / 2) % owned.length];
        if (task.status === "inProgress") task.status = "completed";
        else { task.turn++; task.status = "inProgress"; }
        if (tick % 5 === 0) task.title = task.duplicate ? `Duplicate title ${task.turn}` : `Synthetic task ${task.id} ${task.turn}`;
      }
      await sample();
      if (Date.now() >= nextReload) { createServices(); metric.reloads++; await sample(); nextReload += reloadEveryMs; }
      if (Date.now() >= nextFault && Date.now() + options.faultDurationMs < deadline) {
        outage = true; metric.faults++; event({ type: "fault" });
        await close(endpoints[1]);
        const before = metric.requests; await sleep(options.faultDurationMs); await sample(); if (metric.requests <= before) metric.errors.push("healthy endpoint did not continue during fault"); else metric.healthyDuringFault++;
        endpoints[1] = makeEndpoint("two"); await listen(endpoints[1]); createServices();
        const recovered = await catalog.list("two");
        if (recovered.tasks.every(row => row.name === tasks.find(task => task.id === row.threadId)?.title)) metric.metadataRecoveries++;
        else metric.errors.push("current metadata did not recover");
        outage = false; metric.recoveries++; event({ type: "recovery" }); nextFault += options.faultPeriodMs;
      }
      await sleep(cadenceMs); if (++tick > 100_000) throw new Error("tick bound exceeded");
    }
    await sample();
    const assertions = [
      ["twenty exact synthetic task ids observed from catalog", metric.catalogIds.size === 20 && tasks.every(task => metric.catalogIds.has(task.id))],
      ["duplicate titles remain distinct catalog ids", metric.catalogDuplicateTitleIds.size === 10],
      ["manual synthetic associations bounded", associations.list().length === 20 && associations.list().length <= LIMITS.associations],
      ["notifications occurred and recent reload evidence has no duplicate", metric.notificationCount > 0 && metric.notificationRecentDuplicates === 0],
      ["fault recovery completed", metric.recoveries === metric.faults],
      ["fault endpoint recovered current metadata", metric.metadataRecoveries === metric.faults],
      ["completed at least one fault", metric.faults > 0 && metric.recoveries > 0],
      ["healthy endpoint continued during faults", metric.faults === 0 || metric.healthyDuringFault === metric.faults],
      ["no unexpected catalog errors", metric.errors.length === 0],
      ["bounded sockets", metric.peakSockets <= LIMITS.sockets], ["bounded request count", metric.requests <= LIMITS.requests], ["bounded RSS", metric.maxRssBytes <= LIMITS.rssBytes], ["no dropped events", metric.droppedEvents === 0],
    ];
    const passed = assertions.every(([, pass]) => pass), wallDurationMs = Date.now() - startedAt, actual = !options.sourceModules && options.seconds === DAY && wallDurationMs >= DAY * 1000;
    const reportMetrics = { ...metric, catalogIds: undefined, catalogDuplicateTitleIds: undefined, notificationEvidence: { count: metric.notificationCount, digest: metric.notificationDigest, recentIds: metric.notificationRecentIds, recentDuplicates: metric.notificationRecentDuplicates } };
    const report = { schemaVersion: 1, kind: "wmux_codex_catalog_association_isolated_soak", startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), requestedSeconds: options.seconds, wallDurationMs, sourceMode: options.sourceModules, cadenceMs, reloadEveryMs, qualification: actual ? (passed ? "accepted" : "failed") : "engineering_only_not_24h", accepted: actual && passed, assertions: assertions.map(([name, passed]) => ({ name, passed })), metrics: reportMetrics, limits: LIMITS, fixture: "synthetic manual display bindings + two private Unix-socket fixture endpoints; no native task, CLI, service, HOME, or production configuration was accessed" };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" }); event({ type: "finish", accepted: report.accepted });
    if (!passed) process.exitCode = 1;
  } finally { await Promise.all(endpoints.map(close)); fs.closeSync(eventFd); fs.rmSync(fixture, { recursive: true, force: true }); }
};
main().catch(error => { process.stderr.write(`codex integration soak failed: ${error.stack || error}\n`); process.exitCode = 1; });
