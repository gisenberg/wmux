import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import type {
  RepositoryBinaryState,
  RepositoryFileStatus,
  RepositoryFileSummary,
  RepositoryPatch,
  RepositoryPatchTruncationReason,
  RepositoryPathEncoding,
  RepositoryReviewErrorCode,
  RepositorySnapshotLimits,
  WorkingTreeSnapshot,
} from "../shared/protocol.js";
import type { MachineSource } from "./types.js";
import type { StateStore } from "./state.js";

export const DEFAULT_REPOSITORY_SNAPSHOT_LIMITS: RepositorySnapshotLimits = {
  timeoutMs: 10_000,
  totalGitOutputBytes: 16 * 1024 * 1024,
  patchBytes: 2 * 1024 * 1024,
  fileCount: 1_000,
  hunkCount: 4_000,
  lineCount: 30_000,
  pathBytes: 4_096,
  longLineBytes: 16 * 1024,
  untrackedFileBytes: 256 * 1024,
  totalUntrackedBytes: 4 * 1024 * 1024,
};

export const REPOSITORY_GIT_PREFIX = [
  "--no-pager",
  "-c", "color.ui=false",
  "-c", "core.quotepath=false",
  "-c", "core.pager=cat",
] as const;

export const REPOSITORY_GIT_COMMANDS = {
  discover: [...REPOSITORY_GIT_PREFIX, "rev-parse", "--path-format=absolute", "--show-toplevel"],
  head: [...REPOSITORY_GIT_PREFIX, "rev-parse", "--verify", "HEAD"],
  status: [
    ...REPOSITORY_GIT_PREFIX,
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--ignored=no",
  ],
  stagedPatch: [
    ...REPOSITORY_GIT_PREFIX,
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
    "--patch",
    "--full-index",
    "--submodule=short",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--",
  ],
  workingTreePatch: [
    ...REPOSITORY_GIT_PREFIX,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
    "--patch",
    "--full-index",
    "--submodule=short",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--",
  ],
  stagedNumstat: [
    ...REPOSITORY_GIT_PREFIX,
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
    "--numstat",
    "-z",
    "--",
  ],
  workingTreeNumstat: [
    ...REPOSITORY_GIT_PREFIX,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
    "--numstat",
    "-z",
    "--",
  ],
} as const;

export class RepositoryReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: RepositoryReviewErrorCode,
  ) {
    super(code);
  }
}

export interface GitCommandResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  outputLimited: boolean;
  timedOut: boolean;
  cancelled: boolean;
  outputBytes: number;
}

export interface GitCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export type GitCommandRunner = (
  args: readonly string[],
  options: GitCommandOptions,
) => Promise<GitCommandResult>;

const SAFE_GIT_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_EXTERNAL_DIFF: "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  LC_ALL: "C",
  LANG: "C",
};

export const repositoryGitEnvironment = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && !key.startsWith("GIT_")) env[key] = value;
  }
  return { ...env, ...SAFE_GIT_ENVIRONMENT };
};

export const spawnGitCommand: GitCommandRunner = (
  args,
  options,
) => new Promise((resolve) => {
  if (options.signal?.aborted) {
    resolve({
      status: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      outputLimited: false,
      timedOut: false,
      cancelled: true,
      outputBytes: 0,
    });
    return;
  }

  const child = spawn("git", [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let capturedBytes = 0;
  let outputBytes = 0;
  let outputLimited = false;
  let timedOut = false;
  let cancelled = false;
  let settled = false;

  const kill = (): void => {
    if (!child.killed) child.kill("SIGKILL");
  };
  const capture = (target: Buffer[], chunk: Buffer): void => {
    outputBytes += chunk.length;
    const available = Math.max(0, options.maxOutputBytes - capturedBytes);
    if (available > 0) {
      const captured = chunk.subarray(0, available);
      target.push(captured);
      capturedBytes += captured.length;
    }
    if (chunk.length > available && !outputLimited) {
      outputLimited = true;
      kill();
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));

  const onAbort = (): void => {
    cancelled = true;
    kill();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  timer.unref();

  const finish = (status: number | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    resolve({
      status,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      outputLimited,
      timedOut,
      cancelled,
      outputBytes,
    });
  };
  child.on("error", () => finish(null));
  child.on("close", finish);
});

interface ParsedPath {
  display: string;
  encoding: RepositoryPathEncoding;
  key: string;
  raw?: Buffer;
}

interface ParsedFile extends RepositoryFileSummary {
  key: string;
  rawPath?: Buffer;
}

interface Numstat {
  binary: boolean;
  additions: number | null;
  deletions: number | null;
}

interface PatchBudget {
  bytes: number;
  hunks: number;
  lines: number;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const directionControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const unsafePathControls = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const safeHashLabel = (kind: "unsafe" | "non-utf8", raw: Buffer): string =>
  `[${kind}-path:${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}]`;

const parsePath = (raw: Buffer, maxBytes: number): ParsedPath => {
  const key = raw.toString("hex");
  let decoded: string;
  try {
    decoded = strictUtf8.decode(raw);
  } catch {
    return { display: safeHashLabel("non-utf8", raw), encoding: "undecodable", key };
  }
  const components = decoded.split(/[\\/]/u);
  const unsafe = raw.length === 0
    || raw.length > maxBytes
    || path.posix.isAbsolute(decoded)
    || path.win32.isAbsolute(decoded)
    || components.some((component) => component === ".." || component === "")
    || unsafePathControls.test(decoded);
  if (unsafe) {
    return { display: safeHashLabel("unsafe", raw), encoding: "sanitized", key };
  }
  return { display: decoded, encoding: "utf8", key, raw };
};

const statusName = (status: string, untracked = false): RepositoryFileStatus => {
  if (untracked) return "untracked";
  switch (status) {
    case ".":
    case " ":
      return "unmodified";
    case "M":
      return "modified";
    case "T":
      return "type-changed";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
};

const splitRecord = (record: Buffer, fieldCount: number): { fields: string[]; remainder: Buffer } | undefined => {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const space = record.indexOf(0x20, start);
    if (space < 0) return undefined;
    fields.push(record.subarray(start, space).toString("ascii"));
    start = space + 1;
  }
  return { fields, remainder: record.subarray(start) };
};

const statusRecords = (output: Buffer): Buffer[] => {
  const records: Buffer[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) break;
    records.push(output.subarray(start, end));
    start = end + 1;
  }
  return records;
};

export const parsePorcelainV2 = (
  output: Buffer,
  maxPathBytes: number,
): ParsedFile[] => {
  const records = statusRecords(output);
  const files: ParsedFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const kind = record.subarray(0, 1).toString("ascii");
    if (kind === "?") {
      if (record[1] !== 0x20) continue;
      const parsedPath = parsePath(record.subarray(2), maxPathBytes);
      files.push({
        key: parsedPath.key,
        rawPath: parsedPath.raw,
        path: parsedPath.display,
        pathEncoding: parsedPath.encoding,
        indexStatus: "untracked",
        workingTreeStatus: "untracked",
        tracked: false,
        binary: "unknown",
        submodule: false,
        modeOnly: false,
      });
      continue;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    const fieldCount = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    const parsed = splitRecord(record, fieldCount);
    if (!parsed) continue;
    const [recordKind, xy, submodule, headMode, indexMode, workingTreeMode] = parsed.fields;
    if (recordKind !== kind || !xy || xy.length !== 2) continue;
    const currentPath = parsePath(parsed.remainder, maxPathBytes);
    const originalRecord = kind === "2" ? records[index + 1] : undefined;
    const originalPath = originalRecord ? parsePath(originalRecord, maxPathBytes) : undefined;
    if (kind === "2" && originalRecord) index += 1;
    files.push({
      key: currentPath.key,
      rawPath: currentPath.raw,
      path: currentPath.display,
      pathEncoding: currentPath.encoding,
      originalPath: originalPath?.display,
      originalPathEncoding: originalPath?.encoding,
      indexStatus: statusName(xy[0]),
      workingTreeStatus: statusName(xy[1]),
      tracked: true,
      binary: "unknown",
      submodule: submodule.startsWith("S"),
      submoduleState: submodule.startsWith("S") ? submodule.slice(1) : undefined,
      headMode,
      indexMode,
      workingTreeMode,
      modeOnly: "unknown",
    });
  }
  return files;
};

const parseNumstatPath = (
  records: Buffer[],
  index: number,
): { path: Buffer; nextIndex: number } | undefined => {
  const record = records[index];
  const firstTab = record.indexOf(0x09);
  const secondTab = firstTab < 0 ? -1 : record.indexOf(0x09, firstTab + 1);
  if (secondTab < 0) return undefined;
  const inlinePath = record.subarray(secondTab + 1);
  if (inlinePath.length > 0) return { path: inlinePath, nextIndex: index };
  if (index + 2 >= records.length) return undefined;
  return { path: records[index + 2], nextIndex: index + 2 };
};

export const parseNumstat = (output: Buffer): Map<string, Numstat> => {
  const records = statusRecords(output);
  const result = new Map<string, Numstat>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const firstTab = record.indexOf(0x09);
    const secondTab = firstTab < 0 ? -1 : record.indexOf(0x09, firstTab + 1);
    const parsedPath = parseNumstatPath(records, index);
    if (firstTab < 0 || secondTab < 0 || !parsedPath) continue;
    const additionsText = record.subarray(0, firstTab).toString("ascii");
    const deletionsText = record.subarray(firstTab + 1, secondTab).toString("ascii");
    const binary = additionsText === "-" || deletionsText === "-";
    result.set(parsedPath.path.toString("hex"), {
      binary,
      additions: binary ? null : Number(additionsText),
      deletions: binary ? null : Number(deletionsText),
    });
    index = parsedPath.nextIndex;
  }
  return result;
};

const utf8Prefix = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return result;
};

const sanitizePatchText = (
  raw: Buffer,
  outputLimited: boolean,
  limits: RepositorySnapshotLimits,
  budget: PatchBudget,
  initialReasons: RepositoryPatchTruncationReason[] = [],
): RepositoryPatch => {
  const reasons = new Set(initialReasons);
  let decoded: string;
  try {
    decoded = strictUtf8.decode(raw);
  } catch {
    decoded = raw.toString("utf8");
    reasons.add("undecodable");
  }
  const normalized = decoded
    .replace(/\r\n?/g, "\n")
    .replace(unsafeControls, "")
    .replace(directionControls, "");
  if (normalized !== decoded.replace(/\r\n?/g, "\n")) reasons.add("sanitized");
  decoded = normalized;
  if (outputLimited) reasons.add("git-output");
  const hadTrailingNewline = decoded.endsWith("\n");
  const sourceLines = decoded.split("\n");
  if (hadTrailingNewline) sourceLines.pop();
  const kept: string[] = [];
  let capturedBytes = 0;
  let hunkCount = 0;
  let lineCount = 0;
  for (const sourceLine of sourceLines) {
    if (sourceLine.startsWith("@@")) {
      if (budget.hunks >= limits.hunkCount) {
        reasons.add("hunks");
        break;
      }
      budget.hunks += 1;
      hunkCount += 1;
    }
    if (budget.lines >= limits.lineCount) {
      reasons.add("lines");
      break;
    }
    let line = sourceLine;
    if (Buffer.byteLength(line) > limits.longLineBytes) {
      line = `${utf8Prefix(line, Math.max(0, limits.longLineBytes - Buffer.byteLength("…")))}…`;
      reasons.add("long-line");
    }
    const separatorBytes = kept.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line);
    if (budget.bytes + separatorBytes + lineBytes > limits.patchBytes) {
      reasons.add("patch-bytes");
      break;
    }
    kept.push(line);
    budget.bytes += separatorBytes + lineBytes;
    capturedBytes += separatorBytes + lineBytes;
    budget.lines += 1;
    lineCount += 1;
  }
  decoded = kept.join("\n");
  if (hadTrailingNewline && kept.length === sourceLines.length && budget.bytes < limits.patchBytes) {
    decoded += "\n";
    budget.bytes += 1;
    capturedBytes += 1;
  }
  return {
    text: decoded,
    capturedBytes,
    hunkCount,
    lineCount,
    truncated: reasons.size > 0,
    truncationReasons: [...reasons],
  };
};

const isWithinRoot = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

interface UntrackedContent {
  raw: Buffer;
  mode: string;
  omitted?: RepositoryFileSummary["contentOmitted"];
  binary: RepositoryBinaryState;
  truncated: boolean;
  stable: boolean;
  signature: string;
  readBytes: number;
  truncationReason?: Extract<
    RepositoryPatchTruncationReason,
    "untracked-bytes" | "untracked-total-bytes"
  >;
}

const statSignature = (value: fs.Stats): string =>
  [value.dev, value.ino, value.mode, value.size, value.mtimeMs, value.ctimeMs].join(":");

const readUntrackedFile = async (
  repositoryRoot: string,
  file: ParsedFile,
  maxBytes: number,
  totalLimited: boolean,
): Promise<UntrackedContent> => {
  if (!file.rawPath || file.pathEncoding !== "utf8") {
    return {
      raw: Buffer.alloc(0),
      mode: "000000",
      omitted: file.pathEncoding === "sanitized" ? "unsafe-path" : "undecodable-path",
      binary: "unknown",
      truncated: false,
      stable: true,
      signature: `omitted:${file.key}`,
      readBytes: 0,
    };
  }
  const relativePath = strictUtf8.decode(file.rawPath);
  const candidate = path.resolve(repositoryRoot, relativePath);
  if (!isWithinRoot(repositoryRoot, candidate)) {
    return {
      raw: Buffer.alloc(0),
      mode: "000000",
      omitted: "undecodable-path",
      binary: "unknown",
      truncated: false,
      stable: true,
      signature: `outside:${file.key}`,
      readBytes: 0,
    };
  }
  let before: fs.Stats;
  try {
    before = await fs.promises.lstat(candidate);
  } catch {
    return {
      raw: Buffer.alloc(0),
      mode: "000000",
      binary: "unknown",
      truncated: false,
      stable: false,
      signature: "missing",
      readBytes: 0,
    };
  }
  if (before.isSymbolicLink()) {
    return {
      raw: Buffer.alloc(0),
      mode: "120000",
      omitted: "symlink",
      binary: "unknown",
      truncated: false,
      stable: true,
      signature: statSignature(before),
      readBytes: 0,
    };
  }
  if (!before.isFile()) {
    return {
      raw: Buffer.alloc(0),
      mode: "000000",
      omitted: "unsupported-file",
      binary: "unknown",
      truncated: false,
      stable: true,
      signature: statSignature(before),
      readBytes: 0,
    };
  }
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(candidate);
  } catch {
    return {
      raw: Buffer.alloc(0),
      mode: "000000",
      binary: "unknown",
      truncated: false,
      stable: false,
      signature: "unresolved",
      readBytes: 0,
    };
  }
  if (!isWithinRoot(repositoryRoot, realPath)) {
    return {
      raw: Buffer.alloc(0),
      mode: "000000",
      omitted: "unsupported-file",
      binary: "unknown",
      truncated: false,
      stable: true,
      signature: statSignature(before),
      readBytes: 0,
    };
  }
  if (maxBytes <= 0) {
    return {
      raw: Buffer.alloc(0),
      mode: before.mode & 0o111 ? "100755" : "100644",
      omitted: "limit",
      binary: "unknown",
      truncated: true,
      stable: true,
      signature: statSignature(before),
      readBytes: 0,
      truncationReason: "untracked-total-bytes",
    };
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(candidate, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      return {
        raw: Buffer.alloc(0),
        mode: "000000",
        binary: "unknown",
        truncated: false,
        stable: false,
        signature: "replaced",
        readBytes: 0,
      };
    }
    const captureBytes = Math.min(opened.size, maxBytes);
    const raw = Buffer.alloc(captureBytes);
    let offset = 0;
    while (offset < raw.length) {
      const result = await handle.read(raw, offset, raw.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const stable = opened.dev === after.dev
      && opened.ino === after.ino
      && opened.size === after.size
      && opened.mtimeMs === after.mtimeMs;
    const captured = raw.subarray(0, offset);
    let content = captured;
    let binary: RepositoryBinaryState = captured.includes(0) ? "yes" : "no";
    let omitted: UntrackedContent["omitted"];
    if (binary === "no") {
      try {
        strictUtf8.decode(captured);
      } catch {
        if (opened.size > maxBytes) {
          binary = "unknown";
          omitted = "limit";
          content = Buffer.alloc(0);
        } else {
          binary = "yes";
        }
      }
    }
    const truncated = opened.size > maxBytes;
    return {
      raw: content,
      mode: opened.mode & 0o111 ? "100755" : "100644",
      omitted,
      binary,
      truncated,
      stable,
      signature: statSignature(opened),
      readBytes: captured.length,
      truncationReason: truncated
        ? totalLimited
          ? "untracked-total-bytes"
          : "untracked-bytes"
        : undefined,
    };
  } catch {
    return {
      raw: Buffer.alloc(0),
      mode: "000000",
      binary: "unknown",
      truncated: false,
      stable: false,
      signature: "read-failed",
      readBytes: 0,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const synthesizeUntrackedPatch = (
  file: ParsedFile,
  content: UntrackedContent,
  limits: RepositorySnapshotLimits,
  budget: PatchBudget,
): RepositoryPatch | undefined => {
  if (content.omitted || content.binary !== "no") return undefined;
  const text = strictUtf8.decode(content.raw).replace(/\r\n?/g, "\n");
  const lines = text.length === 0
    ? []
    : text.endsWith("\n")
      ? text.slice(0, -1).split("\n")
      : text.split("\n");
  const header = [
    `diff --git a/${file.path} b/${file.path}`,
    `new file mode ${content.mode}`,
    "--- /dev/null",
    `+++ b/${file.path}`,
  ];
  if (lines.length > 0) header.push(`@@ -0,0 +1,${lines.length} @@`);
  const body = lines.map((line) => `+${line}`).join("\n");
  const raw = Buffer.from(`${header.join("\n")}\n${body}${body && text.endsWith("\n") ? "\n" : ""}`);
  return sanitizePatchText(
    raw,
    false,
    limits,
    budget,
    content.truncationReason ? [content.truncationReason] : [],
  );
};

const mergeBinaryMetadata = (
  files: ParsedFile[],
  staged: Map<string, Numstat>,
  workingTree: Map<string, Numstat>,
): void => {
  for (const file of files) {
    if (!file.tracked) continue;
    const stagedStat = staged.get(file.key);
    const workingTreeStat = workingTree.get(file.key);
    const stats = [stagedStat, workingTreeStat].filter((stat): stat is Numstat => Boolean(stat));
    file.binary = stats.some((stat) => stat.binary)
      ? "yes"
      : stats.length > 0
        ? "no"
        : "unknown";
    const modeChanged = file.headMode !== file.indexMode || file.indexMode !== file.workingTreeMode;
    const contentChanged = stats.some((stat) =>
      stat.binary || stat.additions !== 0 || stat.deletions !== 0);
    file.modeOnly = modeChanged && stats.length > 0 && !contentChanged;
  }
};

const publicFile = ({ key: _key, rawPath: _rawPath, ...file }: ParsedFile): RepositoryFileSummary => file;

const validateCwd = (value: string): string => {
  const cwd = value.trim();
  if (
    cwd.length === 0
    || cwd.length > 4_096
    || !path.isAbsolute(cwd)
    || /[\u0000-\u001f\u007f]/u.test(cwd)
  ) {
    throw new RepositoryReviewError(422, "repository_cwd_invalid");
  }
  return cwd;
};

interface RepositoryReviewOptions {
  limits?: Partial<RepositorySnapshotLimits>;
  runner?: GitCommandRunner;
  environment?: NodeJS.ProcessEnv;
}

export class RepositoryReviewService {
  private readonly limits: RepositorySnapshotLimits;
  private readonly runner: GitCommandRunner;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    private readonly state: StateStore,
    private readonly machineSource: MachineSource,
    options: RepositoryReviewOptions = {},
  ) {
    this.limits = { ...DEFAULT_REPOSITORY_SNAPSHOT_LIMITS, ...options.limits };
    this.runner = options.runner ?? spawnGitCommand;
    this.environment = repositoryGitEnvironment(options.environment);
  }

  async workingTreeSnapshot(paneId: string, signal?: AbortSignal): Promise<WorkingTreeSnapshot> {
    const context = this.state.findPaneContext(paneId);
    if (!context) throw new RepositoryReviewError(404, "pane_not_found");
    const machines = typeof this.machineSource === "function" ? this.machineSource() : this.machineSource;
    const machine = machines.find((candidate) => candidate.id === context.pane.machineId);
    if (!machine || machine.kind !== "local") {
      throw new RepositoryReviewError(422, "repository_review_non_local");
    }
    const cwd = validateCwd(context.pane.cwd ?? machine.cwd ?? os.homedir());
    const deadline = Date.now() + this.limits.timeoutMs;
    let gitOutputBytes = 0;
    const ensureActive = (): void => {
      if (signal?.aborted) throw new RepositoryReviewError(408, "repository_cancelled");
      if (Date.now() >= deadline) throw new RepositoryReviewError(504, "repository_timeout");
    };

    const run = async (
      args: readonly string[],
      commandCwd: string,
      maxOutputBytes: number,
      allowNonzero = false,
    ): Promise<GitCommandResult> => {
      ensureActive();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new RepositoryReviewError(504, "repository_timeout");
      const remainingBytes = this.limits.totalGitOutputBytes - gitOutputBytes;
      if (remainingBytes <= 0) throw new RepositoryReviewError(413, "repository_output_too_large");
      const result = await this.runner(args, {
        cwd: commandCwd,
        env: this.environment,
        timeoutMs: remainingMs,
        maxOutputBytes: Math.min(maxOutputBytes, remainingBytes),
        signal,
      });
      gitOutputBytes += Math.min(result.outputBytes, Math.min(maxOutputBytes, remainingBytes) + 1);
      if (result.cancelled) throw new RepositoryReviewError(408, "repository_cancelled");
      if (result.timedOut) throw new RepositoryReviewError(504, "repository_timeout");
      if (!result.outputLimited && result.status !== 0 && !allowNonzero) {
        throw new RepositoryReviewError(500, "repository_process_failed");
      }
      return result;
    };

    let discovery: GitCommandResult;
    try {
      discovery = await run(REPOSITORY_GIT_COMMANDS.discover, cwd, 16 * 1024);
    } catch (error) {
      if (
        error instanceof RepositoryReviewError
        && error.code === "repository_process_failed"
      ) {
        throw new RepositoryReviewError(422, "repository_not_found");
      }
      throw error;
    }
    if (discovery.outputLimited || discovery.status !== 0) {
      throw new RepositoryReviewError(422, "repository_not_found");
    }
    const rootOutput = discovery.stdout.toString("utf8").replace(/\r?\n$/u, "");
    const repositoryRoot = validateCwd(rootOutput);
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync(repositoryRoot);
    } catch {
      throw new RepositoryReviewError(422, "repository_not_found");
    }

    const headBefore = await run(REPOSITORY_GIT_COMMANDS.head, canonicalRoot, 512, true);
    const statusBefore = await run(REPOSITORY_GIT_COMMANDS.status, canonicalRoot, 2 * 1024 * 1024);
    const stagedBefore = await run(REPOSITORY_GIT_COMMANDS.stagedPatch, canonicalRoot, 2 * 1024 * 1024);
    const workingBefore = await run(REPOSITORY_GIT_COMMANDS.workingTreePatch, canonicalRoot, 2 * 1024 * 1024);
    const stagedNumstat = await run(REPOSITORY_GIT_COMMANDS.stagedNumstat, canonicalRoot, 1024 * 1024);
    const workingNumstat = await run(REPOSITORY_GIT_COMMANDS.workingTreeNumstat, canonicalRoot, 1024 * 1024);

    const parsedFiles = parsePorcelainV2(statusBefore.stdout, this.limits.pathBytes);
    mergeBinaryMetadata(
      parsedFiles,
      parseNumstat(stagedNumstat.stdout),
      parseNumstat(workingNumstat.stdout),
    );
    const filesTruncated = statusBefore.outputLimited || parsedFiles.length > this.limits.fileCount;
    const boundedFiles = parsedFiles.slice(0, this.limits.fileCount);
    const patchBudget: PatchBudget = { bytes: 0, hunks: 0, lines: 0 };
    const stagedPatch = sanitizePatchText(
      stagedBefore.stdout,
      stagedBefore.outputLimited,
      this.limits,
      patchBudget,
    );
    const workingTreePatch = sanitizePatchText(
      workingBefore.stdout,
      workingBefore.outputLimited,
      this.limits,
      patchBudget,
    );
    const revision = crypto.createHash("sha256")
      .update(headBefore.stdout)
      .update(statusBefore.stdout)
      .update(stagedBefore.stdout)
      .update(workingBefore.stdout);
    let untrackedStable = true;
    const untrackedContents = new Map<string, { content: UntrackedContent; maxBytes: number }>();
    let untrackedCaptureBytes = Math.floor(this.limits.totalUntrackedBytes / 2);
    for (const file of boundedFiles) {
      if (file.tracked) continue;
      ensureActive();
      const maxBytes = Math.min(this.limits.untrackedFileBytes, untrackedCaptureBytes);
      const totalLimited = maxBytes < this.limits.untrackedFileBytes;
      const content = await readUntrackedFile(canonicalRoot, file, maxBytes, totalLimited);
      ensureActive();
      untrackedCaptureBytes = Math.max(0, untrackedCaptureBytes - content.readBytes);
      untrackedContents.set(file.key, { content, maxBytes });
      file.binary = content.binary;
      file.contentOmitted = content.omitted ?? (content.binary === "yes" ? "binary" : undefined);
      file.untrackedPatch = synthesizeUntrackedPatch(file, content, this.limits, patchBudget);
      revision
        .update(file.key)
        .update(content.mode)
        .update(content.binary)
        .update(content.omitted ?? "")
        .update(content.truncated ? "truncated" : "complete")
        .update(content.raw);
      if (!content.stable) untrackedStable = false;
    }

    const verificationPossible = !statusBefore.outputLimited
      && !stagedBefore.outputLimited
      && !workingBefore.outputLimited;
    let consistency: WorkingTreeSnapshot["consistency"] = "best-effort";
    if (verificationPossible) {
      const headAfter = await run(REPOSITORY_GIT_COMMANDS.head, canonicalRoot, 512, true);
      const statusAfter = await run(REPOSITORY_GIT_COMMANDS.status, canonicalRoot, 2 * 1024 * 1024);
      const stagedAfter = await run(REPOSITORY_GIT_COMMANDS.stagedPatch, canonicalRoot, 2 * 1024 * 1024);
      const workingAfter = await run(REPOSITORY_GIT_COMMANDS.workingTreePatch, canonicalRoot, 2 * 1024 * 1024);
      if (
        headAfter.outputLimited
        || statusAfter.outputLimited
        || stagedAfter.outputLimited
        || workingAfter.outputLimited
      ) {
        consistency = "best-effort";
      } else if (
        !headBefore.stdout.equals(headAfter.stdout)
        || headBefore.status !== headAfter.status
        || !statusBefore.stdout.equals(statusAfter.stdout)
        || !stagedBefore.stdout.equals(stagedAfter.stdout)
        || !workingBefore.stdout.equals(workingAfter.stdout)
        || !untrackedStable
      ) {
        throw new RepositoryReviewError(409, "repository_changed");
      }
      for (const file of boundedFiles) {
        const captured = untrackedContents.get(file.key);
        if (!captured) continue;
        ensureActive();
        const after = await readUntrackedFile(
          canonicalRoot,
          file,
          captured.maxBytes,
          captured.content.truncationReason === "untracked-total-bytes",
        );
        ensureActive();
        const before = captured.content;
        if (
          !after.stable
          || before.signature !== after.signature
          || before.mode !== after.mode
          || before.binary !== after.binary
          || before.truncated !== after.truncated
          || before.omitted !== after.omitted
          || !before.raw.equals(after.raw)
        ) {
          throw new RepositoryReviewError(409, "repository_changed");
        }
      }
      consistency = "verified";
    }

    const headRevision = headBefore.status === 0
      ? headBefore.stdout.toString("ascii").trim()
      : null;
    const complete = !filesTruncated
      && consistency === "verified"
      && !stagedPatch.truncated
      && !workingTreePatch.truncated
      && boundedFiles.every((file) =>
        !file.untrackedPatch?.truncated
        && file.contentOmitted === undefined);
    return {
      kind: "working-tree",
      contentRevision: `sha256:${revision.digest("hex")}`,
      headRevision,
      consistency,
      ignoredFilesExcluded: true,
      complete,
      filesTruncated,
      observedFileCount: parsedFiles.length,
      files: boundedFiles.map(publicFile),
      stagedPatch,
      workingTreePatch,
      limits: { ...this.limits },
    };
  }
}
