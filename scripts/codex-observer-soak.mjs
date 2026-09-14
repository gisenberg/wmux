#!/usr/bin/env node
/**
 * Isolated M2-04 supervisor soak. It uses the production observer and its
 * read-only Unix-socket client, but only synthetic records, names, receipts,
 * and post authority owned by this process. It never reads or changes HOME,
 * CODEX_HOME, wmux state, or a native Codex endpoint.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { runCodexObservationSupervisor } from "../plugins/wmux/scripts/wmux-observation-supervisor.mjs";

const ACTUAL_DURATION_SECONDS = 24 * 60 * 60;
const FAULT_PERIOD_MS = 5 * 60 * 1000;
const FAULT_DURATION_MS = 20 * 1000;
const MONITOR_INTERVAL_MS = 10_000;
const RECOVERY_ASSERTION_TIMEOUT_MS = 30_000;
const MAX_EVENT_LINES = 20_000;
const RESOURCE_CEILINGS = { rssBytes: 512 * 1024 * 1024, openSockets: 8, inflightRpc: 8, cpuFraction: 0.25 };

const usage = () => {
  process.stderr.write("Usage: node scripts/codex-observer-soak.mjs --out /private/fresh-report-dir [--duration-seconds N] [--fault-period-seconds N]\n");
  process.stderr.write("Default runtime is 86400 seconds. A shorter --duration-seconds run is engineering-only, never 24-hour acceptance.\n");
};

const parseArgs = () => {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (key === "--help") { usage(); process.exit(0); }
    if (key !== "--out" && key !== "--duration-seconds" && key !== "--fault-period-seconds") throw new Error(`Unknown argument: ${key}`);
    const value = process.argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
  }
  const output = values.get("--out");
  if (!output || !path.isAbsolute(output)) throw new Error("--out must be an absolute owner-private report directory.");
  const seconds = values.has("--duration-seconds") ? Number(values.get("--duration-seconds")) : ACTUAL_DURATION_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > ACTUAL_DURATION_SECONDS) throw new Error("--duration-seconds must be between 2 and 86400.");
  const faultPeriodSeconds = values.has("--fault-period-seconds") ? Number(values.get("--fault-period-seconds")) : FAULT_PERIOD_MS / 1000;
  if (!Number.isFinite(faultPeriodSeconds) || faultPeriodSeconds < 4) throw new Error("--fault-period-seconds must be at least 4.");
  if (values.has("--fault-period-seconds") && seconds === ACTUAL_DURATION_SECONDS) throw new Error("--fault-period-seconds is engineering-only and cannot accompany a 24-hour acceptance run.");
  return { output, durationMs: Math.floor(seconds * 1000), requestedSeconds: seconds, faultPeriodMs: Math.floor(faultPeriodSeconds * 1000), faultDurationMs: values.has("--fault-period-seconds") ? Math.floor(faultPeriodSeconds * 500) : FAULT_DURATION_MS, requiresFaults: values.has("--fault-period-seconds") };
};

const createFreshPrivateDirectory = (directory) => {
  if (fs.existsSync(directory)) throw new Error("--out must be a fresh path; existing reports are never truncated or reused.");
  const parent = path.dirname(directory);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (process.getuid && parentStat.uid !== process.getuid()) || parentStat.mode & 0o077) {
    throw new Error("The existing --out parent must be an owned, non-symlink, mode-0700 directory.");
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077) throw new Error("Could not create an owner-private --out directory.");
};

const fixtureRecord = (index, socketPath, now) => ({
  schemaVersion: 3,
  sessionId: `soak_root_${index}`,
  bindingId: `${String(index).padStart(20, "a")}x`,
  receipt: `r${String(index).padStart(42, "x")}`,
  promptTurnId: `soak_turn_${index}`,
  createdAt: now,
  socketPath,
});

const closeServer = async (server) => {
  if (!server?.listening) return;
  await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
};

const main = async () => {
  const options = parseArgs();
  createFreshPrivateDirectory(options.output);
  const eventsPath = path.join(options.output, "events.jsonl");
  const reportPath = path.join(options.output, "report.json");
  const eventFd = fs.openSync(eventsPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-observer-soak-"));
  fs.chmodSync(fixtureDirectory, 0o700);
  const healthySocket = path.join(fixtureDirectory, "healthy.sock");
  const faultSocket = path.join(fixtureDirectory, "fault.sock");
  const startedAt = Date.now();
  const runDeadline = startedAt + options.durationMs;
  const startedUsage = process.cpuUsage();
  const started = process.hrtime.bigint();
  const abort = new AbortController();
  const metrics = {
    eventLines: 0, droppedEventLines: 0, cycles: 0, openSockets: 0, peakSockets: 0,
    inflightRpc: 0, peakInflightRpc: 0, rpcRequests: 0, titleDeliveries: 0, diagnosticPosts: 0,
    terminalLifecycleFixtureDeliveries: new Map(), titleVersions: new Map(), faultEvents: [], recoveryEvents: [], faultResults: [], assertions: [],
    fixtureRpcErrors: 0, staleTitleDeliveries: 0, unknownRpc: 0, faultErrors: [], healthyTitleDeliveriesDuringFault: 0,
    maxRssBytes: 0, maxCpuFraction: 0,
  };
  const writeEvent = (event) => {
    if (metrics.eventLines >= MAX_EVENT_LINES) { metrics.droppedEventLines += 1; return; }
    fs.writeSync(eventFd, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    metrics.eventLines += 1;
  };
  const records = [
    ...Array.from({ length: 10 }, (_, index) => fixtureRecord(index, healthySocket, startedAt)),
    ...Array.from({ length: 10 }, (_, index) => fixtureRecord(index + 10, faultSocket, startedAt)),
  ];
  const names = new Map(records.map((record) => [record.sessionId, `Synthetic idle name ${record.sessionId}`]));
  const lastReadNames = new Map();
  const sequences = new Map();
  const createEndpoint = (socketPath, label) => {
    const server = http.createServer();
    const websocket = new WebSocketServer({ server });
    websocket.on("connection", (socket) => {
      metrics.openSockets += 1; metrics.peakSockets = Math.max(metrics.peakSockets, metrics.openSockets);
      socket.on("close", () => { metrics.openSockets = Math.max(0, metrics.openSockets - 1); });
      socket.on("message", async (raw) => {
        let request;
        try { request = JSON.parse(raw.toString()); } catch { socket.close(); return; }
        if (!Object.hasOwn(request, "id")) return;
        metrics.rpcRequests += 1;
        metrics.inflightRpc += 1; metrics.peakInflightRpc = Math.max(metrics.peakInflightRpc, metrics.inflightRpc);
        try {
          const sessionId = request.params?.threadId;
          const index = Number(String(sessionId).replace("soak_root_", ""));
          if (request.method !== "initialize" && (!Number.isInteger(index) || index < 0 || index >= 20)) throw new Error("unexpected synthetic root");
          if (request.method === "thread/read") lastReadNames.set(sessionId, names.get(sessionId));
          const result = request.method === "initialize" ? { protocolVersion: "0.153.4" }
            : request.method === "thread/read" ? {
              thread: { id: sessionId, sessionId: `native_${sessionId}`, parentThreadId: null,
                name: names.get(sessionId), status: { type: "idle" } },
            }
            : request.method === "thread/turns/list" ? {
              data: [{ id: `soak_turn_${index}`, status: "completed", startedAt: startedAt, completedAt: startedAt + 1, durationMs: 1 }],
              nextCursor: null, backwardsCursor: null,
            }
            : (() => { throw new Error(`unexpected RPC ${request.method}`); })();
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        } catch (error) { metrics.fixtureRpcErrors += 1; metrics.unknownRpc += 1; socket.close(); writeEvent({ type: "fixture_rpc_error", endpoint: label, message: String(error) }); }
        finally { metrics.inflightRpc -= 1; }
      });
    });
    return { server, websocket, socketPath, label };
  };
  let healthy = createEndpoint(healthySocket, "healthy");
  let faulty = createEndpoint(faultSocket, "faulty");
  const listen = async (endpoint) => {
    await new Promise((resolve, reject) => {
      endpoint.server.once("error", reject);
      endpoint.server.listen(endpoint.socketPath, () => { endpoint.server.off("error", reject); resolve(); });
    });
    fs.chmodSync(endpoint.socketPath, 0o600);
  };
  const stopEndpoint = async (endpoint) => {
    for (const client of endpoint.websocket.clients) client.terminate();
    endpoint.websocket.close();
    await closeServer(endpoint.server);
    try { fs.unlinkSync(endpoint.socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  let faultActive = false;
  const post = async (endpoint, body) => {
    if (endpoint.endsWith("/resolve")) {
      const record = records.find((candidate) => candidate.sessionId === body.sessionId && candidate.receipt === body.receipt);
      if (!record) throw Object.assign(new Error("synthetic receipt unavailable"), { status: 404 });
      return { sessionId: record.sessionId, turnId: record.promptTurnId };
    }
    const record = records.find((candidate) => candidate.sessionId === body.sessionId && candidate.receipt === body.receipt);
    if (!record) throw Object.assign(new Error("synthetic receipt unavailable"), { status: 404 });
    if (endpoint.endsWith("/title")) {
      metrics.titleDeliveries += 1;
      // A name can change between its read and delivery. Reject replay that
      // disagrees with the latest observed sample; recovery separately requires
      // every root to converge to current metadata within the bounded window.
      if (body.title !== lastReadNames.get(record.sessionId)) {
        metrics.staleTitleDeliveries += 1;
        throw new Error("synthetic title delivery was not current");
      }
      metrics.titleVersions.set(record.sessionId, body.title);
      if (faultActive && record.socketPath === healthySocket) metrics.healthyTitleDeliveriesDuringFault += 1;
    } else if (endpoint.endsWith("/lifecycle")) {
      const total = (metrics.terminalLifecycleFixtureDeliveries.get(record.sessionId) ?? 0) + 1;
      metrics.terminalLifecycleFixtureDeliveries.set(record.sessionId, total);
      if (total > 1) throw new Error(`terminal delivery duplicated for ${record.sessionId}`);
    } else if (endpoint.endsWith("/observation")) {
      metrics.diagnosticPosts += 1;
    } else { metrics.unknownRpc += 1; throw new Error(`unexpected synthetic endpoint ${endpoint}`); }
    return {};
  };
  const monitorSample = () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const usage = process.cpuUsage(startedUsage);
    const cpuFraction = elapsedMs > 0 ? (usage.user + usage.system) / 1000 / elapsedMs : 0;
    const rssBytes = process.memoryUsage().rss;
    metrics.maxRssBytes = Math.max(metrics.maxRssBytes, rssBytes);
    if (elapsedMs >= 1_000) metrics.maxCpuFraction = Math.max(metrics.maxCpuFraction, cpuFraction);
    writeEvent({ type: "sample", elapsedMs: Math.round(elapsedMs), rssBytes, cpuFraction, openSockets: metrics.openSockets, inflightRpc: metrics.inflightRpc });
  };
  monitorSample();
  const monitor = setInterval(monitorSample, MONITOR_INTERVAL_MS);
  monitor.unref();
  const waitFor = async (read, label, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (!abort.signal.aborted && Date.now() < deadline) {
      if (read()) return true;
      await delay(100, undefined, { signal: abort.signal }).catch(() => undefined);
    }
    if (!abort.signal.aborted) metrics.faultErrors.push(`${label}: timed out`);
    return false;
  };
  let faultTimer;
  let activeFault;
  const faultCycle = async () => {
    if (abort.signal.aborted) return;
    const fault = { startedAt: Date.now(), recoveredAt: null, healthySamplesDuringFault: 0, restoredCurrentTitles: false };
    metrics.faultEvents.push(fault.startedAt); writeEvent({ type: "fault", endpoint: "faulty", action: "close" });
    faultActive = true;
    const healthyBefore = metrics.healthyTitleDeliveriesDuringFault;
    await stopEndpoint(faulty);
    await delay(options.faultDurationMs, undefined, { signal: abort.signal }).catch(() => undefined);
    if (abort.signal.aborted) return;
    // Measure healthy delivery while the failing endpoint is actually absent,
    // before recovery waits could make this check pass after the fact.
    fault.healthySamplesDuringFault = metrics.healthyTitleDeliveriesDuringFault - healthyBefore;
    faulty = createEndpoint(faultSocket, "faulty"); await listen(faulty);
    const recoveryName = `Synthetic recovered ${new Date().toISOString()}`;
    for (const record of records.filter((record) => record.socketPath === faultSocket)) names.set(record.sessionId, `${recoveryName} ${record.sessionId}`);
    fault.recoveredAt = Date.now(); metrics.recoveryEvents.push(fault.recoveredAt); writeEvent({ type: "recovery", endpoint: "faulty", action: "listen" });
    fault.restoredCurrentTitles = await waitFor(
      () => records.filter((record) => record.socketPath === faultSocket).every((record) => metrics.titleVersions.get(record.sessionId) === names.get(record.sessionId)),
      "fault endpoint current titles after recovery", RECOVERY_ASSERTION_TIMEOUT_MS,
    );
    metrics.faultResults.push(fault);
    faultActive = false;
  };
  const nameTimer = setInterval(() => {
    const stamp = new Date().toISOString();
    for (const record of records) names.set(record.sessionId, `Synthetic idle ${record.sessionId} ${stamp}`);
    writeEvent({ type: "name_change", roots: records.length });
  }, 60_000);
  nameTimer.unref();
  try {
    await listen(healthy); await listen(faulty);
    writeEvent({ type: "start", runId: randomUUID(), requestedSeconds: options.requestedSeconds, roots: records.length });
    faultTimer = setInterval(() => {
      if (activeFault) return;
      const recoveryMarginMs = RECOVERY_ASSERTION_TIMEOUT_MS;
      if (Date.now() + options.faultDurationMs + recoveryMarginMs >= runDeadline) return;
      activeFault = faultCycle().catch((error) => { metrics.faultErrors.push(String(error)); writeEvent({ type: "fault_error", message: String(error) }); abort.abort(); }).finally(() => { activeFault = undefined; });
    }, options.faultPeriodMs);
    faultTimer.unref();
    const supervisor = runCodexObservationSupervisor({
      list: () => records,
      load: (sessionId, bindingId) => records.find((record) => record.sessionId === sessionId && record.bindingId === bindingId) ?? (() => { throw Object.assign(new Error("missing synthetic record"), { status: 404 }); })(),
      lock: async (record, action) => action(record),
      nextSequence: (record) => { const next = (sequences.get(record.bindingId) ?? 0) + 1; sequences.set(record.bindingId, next); return next; },
      post,
      report: async (body) => { await post("/api/codex-bindings/observation", body); },
      sleep: async (milliseconds, _value, sleepOptions) => {
        metrics.cycles += 1;
        await delay(milliseconds, undefined, sleepOptions);
      },
      signal: abort.signal,
      stayAlive: true,
    });
    const terminate = () => abort.abort();
    process.once("SIGINT", terminate); process.once("SIGTERM", terminate);
    await Promise.race([delay(options.durationMs, undefined, { signal: abort.signal }).catch(() => undefined), supervisor.then(() => undefined)]);
    abort.abort();
    const supervisorResult = await supervisor;
    monitorSample();
    const wallDurationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const lifecycleCounts = Object.fromEntries(metrics.terminalLifecycleFixtureDeliveries);
    const assertions = [
      ["twenty synthetic records", records.length === 20],
      ["one terminal lifecycle fixture delivery per root", records.every((record) => metrics.terminalLifecycleFixtureDeliveries.get(record.sessionId) === 1)],
      ["no stale title delivery", metrics.staleTitleDeliveries === 0],
      ["no unknown fixture RPC", metrics.unknownRpc === 0 && metrics.fixtureRpcErrors === 0],
      ["no fault errors", metrics.faultErrors.length === 0],
      ["no dropped report events", metrics.droppedEventLines === 0],
      ["healthy endpoint sampled during every fault", metrics.faultResults.every((fault) => fault.healthySamplesDuringFault > 0)],
      ["fault endpoint restored every current title", metrics.faultResults.every((fault) => fault.restoredCurrentTitles)],
      ["bounded open sockets", metrics.peakSockets <= RESOURCE_CEILINGS.openSockets],
      ["bounded inflight RPC", metrics.peakInflightRpc <= RESOURCE_CEILINGS.inflightRpc],
      ["bounded RSS", metrics.maxRssBytes <= RESOURCE_CEILINGS.rssBytes],
      ["bounded CPU", metrics.maxCpuFraction <= RESOURCE_CEILINGS.cpuFraction],
    ];
    metrics.assertions = assertions.map(([name, passed]) => ({ name, passed }));
    const passed = assertions.every(([, assertion]) => assertion);
    const actual24h = options.requestedSeconds === ACTUAL_DURATION_SECONDS && wallDurationMs >= ACTUAL_DURATION_SECONDS * 1000;
    const requiredFaults = actual24h || options.requiresFaults
      ? metrics.faultEvents.length > 0 && metrics.recoveryEvents.length > 0 && metrics.faultResults.length === metrics.faultEvents.length
      : true;
    if (!requiredFaults) metrics.assertions.push({ name: "24-hour run completed every fault/recovery", passed: false });
    const completedAssertions = requiredFaults && passed;
    const report = {
      schemaVersion: 1, kind: "wmux_codex_observer_isolated_soak", startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(),
      requestedSeconds: options.requestedSeconds, wallDurationMs: Math.round(wallDurationMs), cadenceMs: 2_000,
      qualification: actual24h ? (completedAssertions ? "accepted" : "failed") : "engineering_only_not_24h",
      accepted: actual24h && completedAssertions, supervisor: supervisorResult, metrics: {
        ...metrics, terminalLifecycleFixtureDeliveries: lifecycleCounts,
      }, resourceCeilings: RESOURCE_CEILINGS, fixture: "synthetic records + private temporary Unix sockets; no production state, endpoint, credential, HOME, or CODEX_HOME access",
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeEvent({ type: "finish", qualification: report.qualification, accepted: report.accepted });
    if (!completedAssertions) process.exitCode = 1;
  } finally {
    abort.abort(); clearInterval(monitor); clearInterval(nameTimer); if (faultTimer) clearInterval(faultTimer);
    await activeFault?.catch(() => undefined);
    await stopEndpoint(healthy).catch(() => undefined); await stopEndpoint(faulty).catch(() => undefined);
    fs.closeSync(eventFd); fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
};

main().catch((error) => { process.stderr.write(`codex observer soak failed: ${error.stack || error}\n`); process.exitCode = 1; });
