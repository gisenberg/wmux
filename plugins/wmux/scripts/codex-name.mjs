import { spawn } from "node:child_process";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_OUTPUT = 1024 * 1024;
const TIMEOUT_MS = 6000;

function safeError(kind) { return new Error(`Codex name adapter ${kind}.`); }

function normalizedName(value) {
  if (typeof value !== "string") throw safeError("received an invalid name");
  const name = value.normalize("NFC").trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(name)) throw new Error("Codex name must be 1 to 80 printable characters.");
  return name;
}

function childEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^WMUX_.*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(key)) delete env[key];
  }
  // A selected thread is always explicit in the requests below. Do not let an
  // incidental parent selection become an alternate source of identity.
  delete env.CODEX_THREAD_ID;
  return env;
}

/**
 * Read or set one explicitly identified local Codex thread name. This starts a
 * short-lived stdio App Server; it never connects to a daemon or starts a turn.
 */
export async function withCodexName(sessionId, title) {
  let codexNameSet = false;
  const annotate = (cause) => {
    const error = cause instanceof Error ? cause : safeError("failed");
    error.codexNameSet = codexNameSet;
    return error;
  };
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw annotate(new Error("Codex thread id is invalid."));
  let requestedName;
  try { requestedName = title === undefined ? undefined : normalizedName(title); }
  catch (cause) { throw annotate(cause); }
  let child;
  let settled = false;
  let timer;
  let stdout = "";
  let nextId = 0;
  const pending = new Map();

  const fail = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const stop = () => {
    if (!child || child.killed || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const escalation = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 250);
    escalation.unref();
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (settled) { reject(safeError("exited")); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error && pending.delete(id)) reject(safeError("exited"));
      });
    } catch {
      pending.delete(id);
      reject(safeError("exited"));
    }
  });
  const receive = (line) => {
    let message;
    try { message = JSON.parse(line); } catch { fail(safeError("protocol error")); stop(); return; }
    if (!message || typeof message !== "object" || !Object.hasOwn(message, "id")) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (Object.hasOwn(message, "error") || !Object.hasOwn(message, "result")) waiter.reject(safeError("request failed"));
    else waiter.resolve(message.result);
  };
  const readThread = async () => {
    const result = await request("thread/read", { threadId: sessionId, includeTurns: false });
    const thread = result?.thread;
    if (!thread || thread.id !== sessionId || !(thread.name === null || typeof thread.name === "string")) throw safeError("protocol error");
    return thread.name === null ? null : normalizedName(thread.name);
  };

  try {
    child = spawn("codex", ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: childEnvironment() });
    child.stderr.resume(); // Drain diagnostics, but never surface potentially sensitive contents.
    child.stdin.on("error", () => fail(safeError("exited")));
    child.stdout.setEncoding("utf8");
    child.once("error", () => fail(safeError("unavailable")));
    child.once("exit", () => fail(safeError("exited")));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) { fail(safeError("output exceeded its limit")); stop(); return; }
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_OUTPUT) { fail(safeError("output exceeded its limit")); stop(); return; }
        receive(line);
      }
    });
    timer = setTimeout(() => { fail(safeError("timed out")); stop(); }, TIMEOUT_MS);
    const initialized = await request("initialize", { clientInfo: { name: "wmux_name", version: "0.3.0" } });
    if (initialized === undefined) throw safeError("protocol error");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const before = await readThread();
    if (requestedName === undefined) return { name: before, codexNameSet: false };
    codexNameSet = "unknown";
    await request("thread/name/set", { threadId: sessionId, name: requestedName });
    codexNameSet = true;
    return { name: await readThread(), codexNameSet };
  } catch (cause) {
    if (cause instanceof Error && /^Codex (name|thread) /.test(cause.message)) throw annotate(cause);
    throw annotate(safeError("failed"));
  } finally {
    settled = true;
    clearTimeout(timer);
    stop();
  }
}
