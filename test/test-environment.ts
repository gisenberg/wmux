import os from "node:os";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

// Worker threads inherit this preload through execArgv. node-pty's ConPTY
// output worker would then fail to resolve the TypeScript imports below and
// exit, leaving nothing to drain ConPTY output while the main thread blocks
// in its synchronous connect. Configure the process from the main thread
// only, and import lazily so workers never load these modules.
if (isMainThread) {
  const { protectWindowsStateDirectory } = await import("../src/server/private-permissions.js");
  const { configureWindowsHostTools } = await import("../src/server/host-shell.js");
  // The Windows test runner provides a distinct home for every test file.
  protectWindowsStateDirectory(path.join(os.homedir(), ".wmux"));
  configureWindowsHostTools();
  // Match the UTF-8 terminal protocol when Python writes into captured pipes.
  process.env.PYTHONUTF8 = "1";
}
