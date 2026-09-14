import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { AgentSessionService } from "../src/server/agent-sessions.js";
import { AgentTimelineStore } from "../src/server/agent-timeline.js";
// Default tests use source. The opt-in browser qualification below loads the
// built server so it serves the candidate's dist/client without a Vite watcher.
import { createHttpServer } from "../src/server/http.js";
import { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";
import { issue, loadBinding, saveBinding } from "../plugins/wmux/scripts/wmux-binding.mjs";
import { runCodexObservationSupervisor } from "../plugins/wmux/scripts/wmux-observation-supervisor.mjs";

const scripts = path.resolve("plugins/wmux/scripts");
const token = "B".repeat(43), helperToken = "H".repeat(43);
const systemdAvailable = process.platform === "linux" && fs.existsSync(`/run/user/${process.getuid?.()}/systemd/private`);
const browserQualification = process.env.WMUX_BROWSER_QUALIFICATION === "1";

async function until<T>(read: () => T | Promise<T | undefined>, label: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const command = (file: string, args: string[], timeout = 10_000) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  const child = execFile(file, args, { timeout, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
  });
  child.unref();
});

async function closeServer(server: http.Server | undefined) {
  if (!server?.listening) return;
  const closed = once(server, "close");
  server.closeAllConnections(); server.close();
  await Promise.race([closed, delay(2_000)]);
}
async function closeSocket(socket: WebSocket | undefined) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close"); socket.close();
  await Promise.race([closed, delay(2_000)]);
}
const connectEventClient = (base: string) => new Promise<WebSocket>((resolve, reject) => {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws/events`, { headers: { authorization: `Bearer ${token}` } });
  socket.once("open", () => resolve(socket)); socket.once("error", reject);
});
async function openAppPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(value => window.localStorage.setItem("wmux.token", value), token);
  await page.goto(url);
  await page.locator("main.app-shell").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".retro-boot-screen").waitFor({ state: "detached", timeout: 20_000 });
  return page;
}

test("M2 twenty synthetic roots use one actual Unix-socket transport with bounded requests", {
  timeout: 30_000,
  skip: process.platform !== "linux" ? "requires a private Unix socket" : false,
}, async () => {
  const directory = fs.mkdtempSync("/tmp/wm2-load-"), socketPath = path.join(directory, "n.sock");
  const records = Array.from({ length: 20 }, (_, index) => ({
    schemaVersion: 3, sessionId: `root_${index}`, bindingId: `${String(index).padStart(21, "b")}x`, receipt: `r${String(index).padStart(42, "x")}`,
    createdAt: Date.now(), promptTurnId: `turn_${index}`, socketPath,
  }));
  let connections = 0, activeRequests = 0, peakRequests = 0;
  const nativeServer = http.createServer(), native = new WebSocketServer({ server: nativeServer });
  native.on("connection", socket => {
    connections += 1;
    socket.on("message", async raw => {
      const request = JSON.parse(raw.toString()); if (!Object.hasOwn(request, "id")) return;
      activeRequests += 1; peakRequests = Math.max(peakRequests, activeRequests);
      try {
        await delay(2);
        const index = Number(String(request.params?.threadId ?? "").split("_")[1]);
        const result = request.method === "initialize" ? { protocolVersion: "0.153.4" }
          : request.method === "thread/read" ? { thread: { id: `root_${index}`, sessionId: `native_${index}`, parentThreadId: null, name: `Synthetic ${index}`, status: { type: "active", activeFlags: [] } } }
          : request.method === "thread/turns/list" ? { data: [{ id: `turn_${index}`, status: "inProgress", startedAt: 1, completedAt: null }], nextCursor: null, backwardsCursor: null }
          : (() => { throw new Error(`unexpected RPC ${request.method}`); })();
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      } finally { activeRequests -= 1; }
    });
  });
  try {
    await new Promise<void>(resolve => nativeServer.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);
    const lifecycle: unknown[] = [];
    const result = await runCodexObservationSupervisor({
      list: () => records, load: (sessionId: string, bindingId: string) => records.find(item => item.sessionId === sessionId && item.bindingId === bindingId)!,
      lock: async (record: any, action: any) => action(record), nextSequence: (() => { let next = 0; return () => ++next; })(),
      post: async (endpoint: string, body: any) => { if (endpoint.endsWith("resolve")) return { sessionId: body.sessionId, turnId: body.sessionId.replace("root", "turn") }; if (endpoint.endsWith("lifecycle")) lifecycle.push(body); return {}; },
      maxCycles: 1, random: () => 0.5, sleep: async () => {},
    });
    assert.equal(result.reason, "cycle_limit");
    assert.equal(connections, 1, "twenty roots share one actual socket-bound transport");
    assert.ok(peakRequests <= 4, `requests remained bounded at four (observed ${peakRequests})`);
    assert.equal(lifecycle.length, 20, "all twenty socket-bound roots received lifecycle samples");
  } finally {
    for (const client of native.clients) client.terminate(); native.close(); await closeServer(nativeServer);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Production HTTP/PTTY binding and observer worker, disposable native socket.
 * Engineering recovery evidence only; this is not native Codex-client UAT. */
test("M2 systemd-owned observer replacement, endpoint isolation, and isolated server recovery", {
  timeout: 90_000,
  skip: !systemdAvailable ? "requires a Linux systemd user manager; run on the external POSIX runner" : false,
}, async () => {
  // Keep sockaddr_un below its Linux limit. The prior long mkdtemp fixture
  // failed before it could qualify actual systemd replacement.
  const directory = fs.mkdtempSync("/tmp/wm2-"), home = path.join(directory, "h");
  const runtime = path.join(home, ".wmux", "codex-plugin"), socketDirectory = path.join(directory, "s");
  const socketPath = path.join(socketDirectory, "n.sock");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 }); fs.mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  assert.ok(Buffer.byteLength(socketPath) < 100, "fixture socket path leaves Unix-domain headroom");
  const beforeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === "HOME" || key === "CODEX_HOME" || key.startsWith("WMUX_")));
  for (const key of Object.keys(process.env)) if (key.startsWith("WMUX_")) delete process.env[key];
  Object.assign(process.env, { HOME: home, CODEX_HOME: home, WMUX_CODEX_PLUGIN_RUNTIME_DIR: runtime, WMUX_CODEX_SOCKET_PATH: socketPath });

  let phase: "active" | "completed" = "active", nativeName = "Native before systemd replacement", currentTurn = "recovery_turn";
  const nativeMethods: string[] = [], nativeServer = http.createServer(), native = new WebSocketServer({ server: nativeServer });
  native.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(raw.toString()); nativeMethods.push(request.method);
    if (!Object.hasOwn(request, "id")) return;
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: "0.153.4" };
    else if (request.method === "thread/read") result = { thread: { id: "recovery_root", sessionId: "native_recovery_root", parentThreadId: null, name: nativeName, status: phase === "completed" ? { type: "idle" } : { type: "active", activeFlags: [] } } };
    else if (request.method === "thread/turns/list") result = { data: [{ id: currentTurn, status: phase === "completed" ? "completed" : "inProgress", startedAt: 1, completedAt: phase === "completed" ? 2 : null, durationMs: phase === "completed" ? 1 : null }], nextCursor: null, backwardsCursor: null };
    else throw new Error(`unexpected native RPC method: ${request.method}`);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }));
  await new Promise<void>(resolve => nativeServer.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);
  // `npm test` runs before `npm run build`. Keep the ordinary systemd/socket
  // lane source-only, and load the bundled candidate classes only for the
  // explicit browser qualification invocation.
  let CreateServer: any = createHttpServer, StateStoreClass: any = StateStore,
    SettingsStoreClass: any = SettingsStore, AgentTimelineStoreClass: any = AgentTimelineStore,
    AgentSessionServiceClass: any = AgentSessionService, SessionManagerClass: any = SessionManager;
  if (browserQualification) {
    assert.ok(fs.existsSync(path.resolve("dist/client/index.html")), "browser qualification requires npm run build");
    const loadBuilt = (entry: string) => import(entry);
    const httpModule = await loadBuilt("../dist/server/http.js");
    const stateModule = await loadBuilt("../dist/server/state.js");
    const settingsModule = await loadBuilt("../dist/server/settings.js");
    const timelineModule = await loadBuilt("../dist/server/agent-timeline.js");
    const agentsModule = await loadBuilt("../dist/server/agent-sessions.js");
    const sessionsModule = await loadBuilt("../dist/server/session-manager.js");
    CreateServer = httpModule.createHttpServer; StateStoreClass = stateModule.StateStore;
    SettingsStoreClass = settingsModule.SettingsStore; AgentTimelineStoreClass = timelineModule.AgentTimelineStore;
    AgentSessionServiceClass = agentsModule.AgentSessionService; SessionManagerClass = sessionsModule.SessionManager;
  }
  const machines: MachineConfig[] = [{ id: "local", name: "Fixture", kind: "local", sessionBackend: "pty", cwd: directory, command: [process.execPath, "-e", "process.stdin.setRawMode(true);process.stdin.on('data',data=>process.stdout.write(data))"] }];
  const state = new StateStoreClass(machines, path.join(directory, "state.json"));
  const settings = new SettingsStoreClass(path.join(directory, "settings.json"));
  const agents = new AgentSessionServiceClass(state, AgentTimelineStoreClass.persistent(path.join(directory, "timeline.json")));
  let sessions = new SessionManagerClass(state, machines, "", () => undefined, () => undefined, undefined, () => ({}), "", "shared-or-login", agents);
  const options = { auth: { enabled: true, token, helperToken, loginEnabled: false, sessionSecret: "test-only", browserAuthMode: "shared-or-login" }, healthResolvers: { machines: async () => [], streams: async () => [] }, agentSessions: agents };
  let server = await CreateServer("127.0.0.1", state, machines, sessions, settings, options);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let address = server.address(); assert.ok(address && typeof address !== "string");
  let base = `http://127.0.0.1:${address.port}`;
  fs.mkdirSync(path.join(home, ".wmux"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".wmux", "url"), base, { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".wmux", "helper-token"), helperToken, { mode: 0o600 });
  const unit = `wmux-m2-${process.pid}-${Date.now().toString(36)}.service`;
  let firstEventClient: WebSocket | undefined, secondEventClient: WebSocket | undefined;
  let browser: Browser | undefined, firstBrowser: BrowserContext | undefined, secondBrowser: BrowserContext | undefined;
  let firstPage: Page | undefined, secondPage: Page | undefined;
  let badNativeServer: http.Server | undefined, badNative: WebSocketServer | undefined;
  try {
    const workspace = state.createWorkspace("local"), paneId = workspace.tabs[0].panes[0].id;
    const first = await issue("recovery_root", currentTurn);
    const oldReceipt = loadBinding("recovery_root", first.bindingId).receipt;
    sessions.writePane(paneId, `${first.marker}\n`, 80, 24);
    await until(() => { try { return sessions.codexTerminalBindings.resolve("recovery_root", loadBinding("recovery_root", first.bindingId).receipt) ? true : undefined; } catch { return undefined; } }, "ordinary PTY terminal proof");
    const recordFile = fs.readdirSync(runtime).find(name => name.endsWith(".json")); assert.ok(recordFile);
    const sequence = () => Number(JSON.parse(fs.readFileSync(path.join(runtime, recordFile), "utf8")).lifecycleSequence || 0);

    // Unique test-owned systemd unit; never touches production wmux/observer/Codex.
    await command("systemd-run", ["--user", "--unit", unit, "--property=Restart=always", "--property=RestartSec=200ms", "--setenv", `HOME=${home}`, "--setenv", `CODEX_HOME=${home}`, "--setenv", `WMUX_CODEX_PLUGIN_RUNTIME_DIR=${runtime}`, "--setenv", `WMUX_CODEX_SOCKET_PATH=${socketPath}`, process.execPath, path.join(scripts, "wmux-observer.mjs"), "--service"]);
    await until(async () => { const pid = Number((await command("systemctl", ["--user", "show", unit, "--property=MainPID", "--value"])).stdout.trim()); return pid > 0 ? pid : undefined; }, "systemd worker start");
    await until(() => state.findPaneContext(paneId)?.workspace.name === nativeName ? true : undefined, "initial automatic title");
    const pin = await fetch(`${base}/api/workspaces/${workspace.id}/tabs/${workspace.tabs[0].id}/title`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ title: "Pinned tab survives restart" }) });
    assert.equal(pin.status, 200, "fixture pins the tab through the real title route");
    const firstPid = Number((await command("systemctl", ["--user", "show", unit, "--property=MainPID", "--value"])).stdout.trim());
    const activeSequence = sequence(); phase = "completed";
    await until(() => state.snapshot().delegations.find(item => item.paneId === paneId && item.state === "completed") ? true : undefined, "terminal lifecycle");
    await until(() => sequence() > activeSequence ? sequence() : undefined, "terminal sequence increment");
    const notifications = state.snapshot().notifications.filter(item => item.paneId === paneId).map(item => item.id);
    nativeName = "Native current before systemd replacement";
    await until(() => state.findPaneContext(paneId)?.workspace.name === nativeName ? true : undefined, "current native title on automatic workspace");
    const beforeKill = sequence();
    await command("systemctl", ["--user", "kill", "--kill-who=main", "--signal=SIGKILL", unit]);
    await until(async () => { const pid = Number((await command("systemctl", ["--user", "show", unit, "--property=MainPID", "--value"])).stdout.trim()); return pid > 0 && pid !== firstPid ? pid : undefined; }, "systemd replacement after SIGKILL");
    await until(() => sequence() > beforeKill ? sequence() : undefined, "replacement sequence increment");
    await delay(2_300);
    assert.deepEqual(state.snapshot().notifications.filter(item => item.paneId === paneId).map(item => item.id), notifications, "replacement is exact-once for terminal notification");
    assert.ok(fs.existsSync(path.join(runtime, "observation-supervisor.lock")), "replacement reused the kernel-backed supervisor lock");

    // A bad endpoint backs off while the good endpoint keeps the current name.
    const badWorkspace = state.createWorkspace("local"), badPaneId = badWorkspace.tabs[0].panes[0].id;
    const badIssue = await issue("other_root", "other_turn");
    sessions.writePane(badPaneId, `${badIssue.marker}\n`, 80, 24);
    await until(() => { try { return sessions.codexTerminalBindings.resolve("other_root", loadBinding("other_root", badIssue.bindingId).receipt) ? true : undefined; } catch { return undefined; } }, "second ordinary PTY terminal proof");
    saveBinding({ ...loadBinding("other_root", badIssue.bindingId), socketPath: path.join(socketDirectory, "bad.sock") });
    await until(() => sessions.codexTerminalBindings.diagnostics(state.snapshot().workspaces).bindings
      .some(item => item.sessionId === "other_root" && item.naming?.status === "backing_off") ? true : undefined, "failed endpoint backoff");
    assert.equal(state.findPaneContext(paneId)?.workspace.name, nativeName, "healthy endpoint remains current while another endpoint backs off");
    const badSocketPath = path.join(socketDirectory, "bad.sock");
    badNativeServer = http.createServer(); badNative = new WebSocketServer({ server: badNativeServer });
    badNative.on("connection", socket => socket.on("message", raw => {
      const request = JSON.parse(raw.toString()); if (!Object.hasOwn(request, "id")) return;
      const result = request.method === "initialize" ? { protocolVersion: "0.153.4" }
        : request.method === "thread/read" ? { thread: { id: "other_root", sessionId: "native_other_root", parentThreadId: null, name: "Recovered endpoint current name", status: { type: "active", activeFlags: [] } } }
        : request.method === "thread/turns/list" ? { data: [{ id: "other_turn", status: "inProgress", startedAt: 1, completedAt: null }], nextCursor: null, backwardsCursor: null }
        : (() => { throw new Error(`unexpected recovered-endpoint RPC ${request.method}`); })();
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    }));
    await new Promise<void>(resolve => badNativeServer!.listen(badSocketPath, resolve)); fs.chmodSync(badSocketPath, 0o600);
    await until(() => sessions.codexTerminalBindings.diagnostics(state.snapshot().workspaces).bindings
      .some(item => item.sessionId === "other_root" && item.naming?.status === "active") ? true : undefined, "failed endpoint recovery");
    assert.equal(state.findPaneContext(badPaneId)?.workspace.name, "Recovered endpoint current name", "restored endpoint applies its current name");
    assert.equal(state.findPaneContext(paneId)?.workspace.name, nativeName, "healthy endpoint and its exact-once terminal state survive endpoint recovery");

    firstEventClient = await connectEventClient(base); secondEventClient = await connectEventClient(base);
    const route = `${base}/workspaces/${workspace.id}/tabs/${workspace.tabs[0].id}`;
    const workspaceRow = `a[role="treeitem"][href="/workspaces/${workspace.id}/tabs/${workspace.tabs[0].id}"]`;
    if (browserQualification) {
      browser = await chromium.launch({ headless: true });
      const browserOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
      firstBrowser = await browser.newContext(browserOptions); secondBrowser = await browser.newContext(browserOptions);
      firstPage = await openAppPage(firstBrowser, route); secondPage = await openAppPage(secondBrowser, route);
      await firstPage.locator(workspaceRow).waitFor({ state: "visible" }); await secondPage.locator(workspaceRow).waitFor({ state: "visible" });
      assert.match(await firstPage.locator(workspaceRow).getAttribute("aria-label") ?? "", new RegExp(nativeName), "first app page renders the automatic workspace name");
      assert.match(await secondPage.locator(workspaceRow).getAttribute("aria-label") ?? "", new RegExp(nativeName), "second app page renders the automatic workspace name");
      assert.equal(await firstPage.locator('span[title="Pinned tab survives restart"]').count(), 1, "first app page renders pinned tab ownership");
      assert.equal(await secondPage.locator('span[title="Pinned tab survives restart"]').count(), 1, "second app page renders pinned tab ownership");
      // There are no other fixture viewers. Dropping both therefore verifies that
      // an idle receipt and its backend outlive every browser attachment.
      await firstPage.goto("about:blank"); await secondPage.goto("about:blank");
      nativeName = "Native after every viewer disconnect";
      await until(() => state.findPaneContext(paneId)?.workspace.name === nativeName ? true : undefined, "idle native rename with every viewer disconnected");
      const stillResolved = await fetch(`${base}/api/codex-bindings/resolve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${helperToken}` }, body: JSON.stringify({ sessionId: "recovery_root", receipt: oldReceipt }) });
      assert.equal(stillResolved.status, 200, "the same receipt remains live after every viewer disconnects");
      await firstPage.goto(route); await secondPage.goto(route);
      await firstPage.locator(workspaceRow).waitFor({ state: "visible" }); await secondPage.locator(workspaceRow).waitFor({ state: "visible" });
      await until(async () => (await firstPage!.locator(workspaceRow).getAttribute("aria-label"))?.includes(nativeName) ? true : undefined, "first reopened app page receives idle rename");
      await until(async () => (await secondPage!.locator(workspaceRow).getAttribute("aria-label"))?.includes(nativeName) ? true : undefined, "second reopened app page receives idle rename");
    }
    const firstClosed = once(firstEventClient, "close"), secondClosed = once(secondEventClient, "close");
    // HTTP server.close() deliberately waits for upgraded sockets. These are
    // the two disposable browser clients being reconnected, so terminate them
    // before the isolated server restart rather than waiting on a live client.
    firstEventClient.terminate(); secondEventClient.terminate();
    await Promise.all([firstClosed, secondClosed]);
    if (browserQualification) { await firstPage!.goto("about:blank"); await secondPage!.goto("about:blank"); }
    await closeServer(server); sessions.disposeAll();
    sessions = new SessionManagerClass(state, machines);
    server = await CreateServer("127.0.0.1", state, machines, sessions, settings, { ...options, agentSessions: undefined });
    // Reuse the same endpoint: pages reload through the actual replacement,
    // rather than being redirected to a new fixture port.
    server.listen(address.port, "127.0.0.1"); await once(server, "listening");
    address = server.address(); assert.ok(address && typeof address !== "string"); base = `http://127.0.0.1:${address.port}`;
    fs.writeFileSync(path.join(home, ".wmux", "url"), base, { mode: 0o600 });
    firstEventClient = await connectEventClient(base); secondEventClient = await connectEventClient(base);
    if (browserQualification) {
      await firstPage!.goto(route); await secondPage!.goto(route);
      await firstPage!.locator(workspaceRow).waitFor({ state: "visible" }); await secondPage!.locator(workspaceRow).waitFor({ state: "visible" });
      assert.equal(await firstPage!.locator('span[title="Pinned tab survives restart"]').count(), 1, "first app reconnect preserves pinned tab in DOM");
      assert.equal(await secondPage!.locator('span[title="Pinned tab survives restart"]').count(), 1, "second app reconnect preserves pinned tab in DOM");
    }
    const rejected = await fetch(`${base}/api/codex-bindings/resolve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${helperToken}` }, body: JSON.stringify({ sessionId: "recovery_root", receipt: oldReceipt }) });
    assert.equal(rejected.status, 404, "isolated wmux restart rejects an old receipt");
    const nameBeforeFreshProof = state.findPaneContext(paneId)?.workspace.name;
    await delay(2_300); assert.equal(state.findPaneContext(paneId)?.workspace.name, nameBeforeFreshProof, "old persisted receipt did not regain title authority");
    phase = "active"; currentTurn = "fresh_turn"; nativeName = "Native after fresh terminal proof";
    const fresh = await issue("recovery_root", currentTurn);
    sessions.writePane(paneId, `${fresh.marker}\n`, 80, 24);
    await until(() => { try { return sessions.codexTerminalBindings.resolve("recovery_root", loadBinding("recovery_root", fresh.bindingId).receipt) ? true : undefined; } catch { return undefined; } }, "fresh ordinary PTY terminal proof");
    await until(() => state.findPaneContext(paneId)?.workspace.name === nativeName ? true : undefined, "fresh receipt restores automatic title");
    if (browserQualification) {
      await until(async () => (await firstPage!.locator(workspaceRow).getAttribute("aria-label"))?.includes(nativeName) ? true : undefined, "first app page receives fresh automatic title");
      await until(async () => (await secondPage!.locator(workspaceRow).getAttribute("aria-label"))?.includes(nativeName) ? true : undefined, "second app page receives fresh automatic title");
    }
    assert.equal(nativeMethods.some(method => ["thread/name/set", "thread/start", "turn/start"].includes(method)), false, "observer native RPC remains read-only");
  } finally {
    await closeSocket(firstEventClient); await closeSocket(secondEventClient);
    await firstBrowser?.close(); await secondBrowser?.close(); await browser?.close();
    for (const client of badNative?.clients ?? []) client.terminate(); badNative?.close(); await closeServer(badNativeServer);
    await command("systemctl", ["--user", "stop", unit]).catch(() => undefined);
    await command("systemctl", ["--user", "reset-failed", unit]).catch(() => undefined);
    sessions.disposeAll(); await closeServer(server);
    for (const client of native.clients) client.terminate(); native.close(); await closeServer(nativeServer);
    state.flush(); fs.rmSync(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (key === "HOME" || key === "CODEX_HOME" || key.startsWith("WMUX_")) delete process.env[key];
    Object.assign(process.env, beforeEnvironment);
  }
});
