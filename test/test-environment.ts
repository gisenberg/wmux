import os from "node:os";
import path from "node:path";
import { protectWindowsStateDirectory } from "../src/server/private-permissions.js";
import { configureWindowsHostTools } from "../src/server/host-shell.js";

// The Windows test runner provides a distinct home for every test file.
protectWindowsStateDirectory(path.join(os.homedir(), ".wmux"));
configureWindowsHostTools();
// Match the UTF-8 terminal protocol when Python writes into captured pipes.
process.env.PYTHONUTF8 = "1";
