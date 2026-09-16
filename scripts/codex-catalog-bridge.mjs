import { queryCodexCatalog, CodexCatalogRpcError } from "../dist/server/codex-catalog-rpc.js";

const MAX_INPUT = 16 * 1024;
const invalid = () => Object.assign(new Error("invalid"), { reason: "invalid_request" });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const main = async () => {
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const fail = () => { clearTimeout(timer); process.stdin.destroy(); reject(invalid()); };
    const timer = setTimeout(fail, 4_000);
    process.stdin.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_INPUT) fail(); else chunks.push(chunk);
    });
    process.stdin.once("error", fail);
    process.stdin.once("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
  });
  let input;
  try { input = JSON.parse(buffer.toString("utf8")); }
  catch { throw invalid(); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  if (Object.keys(input).some(key => !["socketPath", "operation", "threadId", "cursor", "archived"].includes(key))) throw invalid();
  const result = await queryCodexCatalog(input);
  write({ ok: true, result });
};

try { await main(); }
catch (error) {
  const reason = error instanceof CodexCatalogRpcError ? error.reason : error?.reason === "invalid_request" ? "invalid_request" : "socket_unavailable";
  write({ ok: false, error: reason });
}
