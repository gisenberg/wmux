import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const adapter = path.resolve("plugins/wmux/scripts/codex-name.mjs");

function fake(source: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-name-"));
  const executable = path.join(directory, "codex");
  fs.writeFileSync(executable, `#!${process.execPath}\n${source}`);
  fs.chmodSync(executable, 0o755);
  return { directory, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

async function invoke(source: string, sessionId = "thread_123", title?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const fixture = fake(source);
  const priorPath = process.env.PATH;
  const priorToken = process.env.WMUX_TOKEN;
  const priorThread = process.env.CODEX_THREAD_ID;
  process.env.PATH = `${fixture.directory}:${priorPath}`;
  process.env.WMUX_TOKEN = "private-wmux-secret";
  process.env.CODEX_THREAD_ID = "wrong_inherited_thread";
  const priorExtra = Object.fromEntries(Object.keys(extraEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, extraEnv);
  try {
    const { withCodexName } = await import(`${adapter}?${Math.random()}`);
    return await withCodexName(sessionId, title);
  } finally {
    process.env.PATH = priorPath;
    if (priorToken === undefined) delete process.env.WMUX_TOKEN; else process.env.WMUX_TOKEN = priorToken;
    if (priorThread === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = priorThread;
    for (const [key, value] of Object.entries(priorExtra)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fixture.dispose();
  }
}

const normalServer = `
let name = null; const lines = []; process.stdin.on('data', data => { for (const line of data.toString().split('\\n')) { if (!line) continue; const m = JSON.parse(line); lines.push(m); if (m.method === 'initialize') out(m.id, {}); else if (m.method === 'thread/read') out(m.id, {thread:{id:m.params.threadId,name}}); else if (m.method === 'thread/name/set') { name = '  Cañonical Name  '; out(m.id, {}); } } });
function out(id, result) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n'); }
`;

test("reads only the explicit thread and keeps wmux credentials out of its child", async () => {
  const source = normalServer.replace("let name = null;", "if (process.env.WMUX_TOKEN || process.env.CODEX_THREAD_ID) process.exit(9); let name = '  Read Name  ';");
  assert.deepEqual(await invoke(source), { name: "Read Name", codexNameSet: false });
});

test("reads, sets, and reads back the canonical accepted name in exact order", async () => {
  const strictServer = `
let step = 0; const fail = () => process.exit(8); process.stdin.on('data', data => { for (const line of data.toString().split('\\n')) { if (!line) continue; const m = JSON.parse(line); const expected = [
  () => m.method === 'initialize' && m.params?.clientInfo?.name === 'wmux_name' && m.params?.clientInfo?.version === '0.3.0' && out(m.id, {}),
  () => m.method === 'initialized',
  () => m.method === 'thread/read' && m.params?.threadId === 'thread_123' && m.params?.includeTurns === false && out(m.id, {thread:{id:'thread_123',name:null}}),
  () => m.method === 'thread/name/set' && m.params?.threadId === 'thread_123' && m.params?.name === 'Requested Name' && out(m.id, {}),
  () => m.method === 'thread/read' && m.params?.threadId === 'thread_123' && m.params?.includeTurns === false && out(m.id, {thread:{id:'thread_123',name:'  Cañonical Name  '}})
][step++]; if (!expected || expected() === false) fail(); } }); function out(id,result) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n'); }
`;
  assert.deepEqual(await invoke(strictServer, "thread_123", "  Requested Name  "), { name: "Cañonical Name", codexNameSet: true });
});

test("rejects invalid explicit ids and names before launching Codex", async () => {
  await assert.rejects(invoke(normalServer, "bad id"), /thread id is invalid/);
  await assert.rejects(invoke(normalServer, "thread_123", " \u0000 "), /name must be/);
});

test("fails closed when a read returns another thread id", async () => {
  const source = normalServer.replace("id:m.params.threadId", "id:'other_thread'");
  await assert.rejects(invoke(source), /protocol error/);
});

test("contains protocol errors, early exits, timeouts, and oversized output", async () => {
  await assert.rejects(invoke("process.stdin.on('data', () => process.stdout.write('not json\\n'))"), /protocol error/);
  await assert.rejects(invoke("process.exit(2)"), /Codex name adapter (exited|unavailable)/);
  await assert.rejects(invoke("process.stdin.resume()"), /timed out/);
  await assert.rejects(invoke("process.stdin.on('data', () => process.stdout.write('x'.repeat(1024 * 1024 + 1)))"), /output exceeded/);
});

test("reports partial set state and terminates a failed protocol child", async () => {
  const marker = path.join(os.tmpdir(), `wmux-codex-name-term-${process.pid}-${Date.now()}`);
  const source = `
process.on('SIGTERM', () => require('node:fs').writeFileSync(process.env.CODEX_NAME_TEST_MARKER, 'terminated'));
process.stdin.on('data', () => process.stdout.write('not json\\n'));
`;
  try {
    await assert.rejects(invoke(source, "thread_123", undefined, { CODEX_NAME_TEST_MARKER: marker }), (error: any) => {
      assert.match(error.message, /protocol error/);
      assert.equal(error.codexNameSet, false);
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fs.readFileSync(marker, "utf8"), "terminated");
    const setFailure = `
let phase = 0; process.stdin.on('data', data => { for (const line of data.toString().split('\\n')) { if (!line) continue; const m = JSON.parse(line); if (m.method === 'initialize') out(m.id, {}); else if (m.method === 'thread/read') out(m.id, {thread:{id:'thread_123',name:null}}); else if (m.method === 'thread/name/set') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{message:'private failure'}})+'\\n'); } }); function out(id,result) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n'); }
`;
    await assert.rejects(invoke(setFailure, "thread_123", "Name"), (error: any) => {
      assert.equal(error.codexNameSet, "unknown");
      assert.doesNotMatch(error.message, /private failure/);
      return true;
    });
    const readbackFailure = `
let reads = 0; process.stdin.on('data', data => { for (const line of data.toString().split('\\n')) { if (!line) continue; const m = JSON.parse(line); if (m.method === 'initialize' || m.method === 'thread/name/set') out(m.id, {}); else if (m.method === 'thread/read') out(m.id, {thread:{id: ++reads === 1 ? 'thread_123' : 'other_thread',name:null}}); } }); function out(id,result) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n'); }
`;
    await assert.rejects(invoke(readbackFailure, "thread_123", "Name"), (error: any) => {
      assert.equal(error.codexNameSet, true);
      return true;
    });
  } finally { fs.rmSync(marker, { force: true }); }
});
