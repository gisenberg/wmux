import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REPOSITORY_GIT_COMMANDS,
  RepositoryReviewError,
  RepositoryReviewService,
  parseNumstat,
  parsePorcelainV2,
  spawnGitCommand,
  type GitCommandOptions,
  type GitCommandResult,
  type GitCommandRunner,
} from "../src/server/repository-review.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

const write = (root: string, relativePath: string, content: string | Buffer): void => {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

interface Fixture {
  directory: string;
  repository: string;
  nestedCwd: string;
}

const createFixture = (): Fixture => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-repository-review-"));
  const repository = path.join(directory, "working tree ü");
  const submoduleSource = path.join(directory, "submodule source");
  fs.mkdirSync(repository);
  fs.mkdirSync(submoduleSource);
  git(submoduleSource, ["init", "-q"]);
  git(submoduleSource, ["config", "user.name", "wmux test"]);
  git(submoduleSource, ["config", "user.email", "wmux@example.invalid"]);
  write(submoduleSource, "tracked.txt", "submodule baseline\n");
  git(submoduleSource, ["add", "--", "."]);
  git(submoduleSource, ["commit", "-qm", "submodule baseline"]);

  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.name", "wmux test"]);
  git(repository, ["config", "user.email", "wmux@example.invalid"]);
  write(repository, ".gitignore", "ignored.txt\n");
  write(repository, "rename me.txt", "rename baseline\n");
  write(repository, "delete me.txt", "delete baseline\n");
  write(repository, "mode-only.sh", "#!/bin/sh\nexit 0\n");
  write(repository, "binary.bin", Buffer.from([0, 1, 2, 3]));
  write(repository, "space ü.txt", "unicode baseline\n");
  write(repository, "huge.txt", "baseline\n");
  git(repository, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSource, "submodule"]);
  git(repository, ["add", "--", "."]);
  git(repository, ["commit", "-qm", "baseline"]);

  fs.renameSync(path.join(repository, "rename me.txt"), path.join(repository, "renamed ü.txt"));
  git(repository, ["add", "-A", "--", "rename me.txt", "renamed ü.txt"]);
  fs.rmSync(path.join(repository, "delete me.txt"));
  fs.chmodSync(path.join(repository, "mode-only.sh"), 0o755);
  write(repository, "binary.bin", Buffer.from([0, 4, 5, 6]));
  write(repository, "space ü.txt", "unicode changed\nsafe\u001b[31m\u202etext\n");
  write(repository, "huge.txt", `${Array.from({ length: 2_000 }, (_, index) => `changed-${index}`).join("\n")}\n`);
  write(repository, "untracked space ü.txt", "first\nsecond\n");
  write(repository, "untracked-binary.bin", Buffer.from([0, 9, 8, 7]));
  write(repository, "invalid-utf8.txt", Buffer.from([0x66, 0x6f, 0x80, 0x6f]));
  write(repository, "empty.txt", "");
  write(repository, "long-line.txt", `${"x".repeat(512)}\n`);
  write(repository, "ignored.txt", "must remain excluded\n");
  write(repository, "evil\u001b[31m.txt", "unsafe path\n");
  write(directory, "outside-secret.txt", "must not be read\n");
  fs.symlinkSync(path.join(directory, "outside-secret.txt"), path.join(repository, "outside-link"));
  const nonUtf8Path = Buffer.concat([
    Buffer.from(`${repository}${path.sep}`),
    Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]),
  ]);
  fs.writeFileSync(nonUtf8Path, "undecodable path\n");
  write(path.join(repository, "submodule"), "tracked.txt", "dirty submodule\n");
  const nestedCwd = path.join(repository, "nested", "cwd");
  fs.mkdirSync(nestedCwd, { recursive: true });
  return { directory, repository, nestedCwd };
};

const createState = (
  directory: string,
  machines: MachineConfig[],
  machineId: string,
  cwd: string,
): { state: StateStore; paneId: string } => {
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const workspace = state.createWorkspace(machineId, cwd);
  return { state, paneId: workspace.tabs[0].panes[0].id };
};

const successfulResult = (stdout = Buffer.alloc(0), status = 0): GitCommandResult => ({
  status,
  stdout,
  stderr: Buffer.alloc(0),
  outputLimited: false,
  timedOut: false,
  cancelled: false,
  outputBytes: stdout.length,
});

test("repository commands and environment are fixed and client-independent", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-repository-commands-"));
  const repository = path.join(directory, "repo");
  fs.mkdirSync(repository);
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local", cwd: "/server/fallback" }];
  const { state, paneId } = createState(directory, machines, "local", repository);
  const calls: Array<{ args: readonly string[]; options: GitCommandOptions }> = [];
  const runner: GitCommandRunner = async (args, options) => {
    calls.push({ args, options });
    if (args === REPOSITORY_GIT_COMMANDS.discover) return successfulResult(Buffer.from(`${repository}\n`));
    if (args === REPOSITORY_GIT_COMMANDS.head) return successfulResult(Buffer.from(`${"a".repeat(40)}\n`));
    return successfulResult();
  };
  const service = new RepositoryReviewService(state, machines, {
    runner,
    environment: {
      PATH: process.env.PATH,
      HOME: "/server/home",
      GIT_DIR: "/attacker/git",
      GIT_WORK_TREE: "/attacker/tree",
      GIT_CONFIG_GLOBAL: "/attacker/config",
    },
  });
  try {
    await service.workingTreeSnapshot(paneId);
    assert.deepEqual(calls.map((call) => call.args), [
      REPOSITORY_GIT_COMMANDS.discover,
      REPOSITORY_GIT_COMMANDS.head,
      REPOSITORY_GIT_COMMANDS.status,
      REPOSITORY_GIT_COMMANDS.stagedPatch,
      REPOSITORY_GIT_COMMANDS.workingTreePatch,
      REPOSITORY_GIT_COMMANDS.stagedNumstat,
      REPOSITORY_GIT_COMMANDS.workingTreeNumstat,
      REPOSITORY_GIT_COMMANDS.head,
      REPOSITORY_GIT_COMMANDS.status,
      REPOSITORY_GIT_COMMANDS.stagedPatch,
      REPOSITORY_GIT_COMMANDS.workingTreePatch,
    ]);
    assert.equal(calls[0].options.cwd, repository);
    assert.ok(calls.slice(1).every((call) => call.options.cwd === fs.realpathSync(repository)));
    for (const { options } of calls) {
      assert.equal(options.env.GIT_PAGER, "cat");
      assert.equal(options.env.PAGER, "cat");
      assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0");
      assert.equal(options.env.GIT_EXTERNAL_DIFF, "");
      assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
      assert.equal(options.env.GIT_CONFIG_SYSTEM, "/dev/null");
      assert.equal(options.env.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(options.env.GIT_ATTR_NOSYSTEM, "1");
      assert.equal(options.env.GIT_DIR, undefined);
      assert.equal(options.env.GIT_WORK_TREE, undefined);
    }
  } finally {
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("porcelain normalization preserves metadata and replaces unsafe paths", () => {
  const invalidPath = Buffer.from([0x62, 0x61, 0x64, 0xff]);
  const output = Buffer.concat([
    Buffer.from("1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb space ü.txt\0"),
    Buffer.from("2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 renamed.txt\0old name.txt\0"),
    Buffer.from("1 .D N... 100644 100644 000000 aaaaaaa bbbbbbb deleted.txt\0"),
    Buffer.from("1 .M S.M. 160000 160000 160000 aaaaaaa bbbbbbb submodule\0"),
    Buffer.from("? ../escape\0? evil\u001b[31m.txt\0? "),
    invalidPath,
    Buffer.from("\0"),
  ]);
  const files = parsePorcelainV2(output, 128);
  assert.equal(files.length, 7);
  assert.deepEqual(files[0], {
    key: Buffer.from("space ü.txt").toString("hex"),
    rawPath: Buffer.from("space ü.txt"),
    path: "space ü.txt",
    pathEncoding: "utf8",
    indexStatus: "modified",
    workingTreeStatus: "unmodified",
    tracked: true,
    binary: "unknown",
    submodule: false,
    submoduleState: undefined,
    headMode: "100644",
    indexMode: "100644",
    workingTreeMode: "100644",
    modeOnly: "unknown",
    originalPath: undefined,
    originalPathEncoding: undefined,
  });
  assert.equal(files[1].indexStatus, "renamed");
  assert.equal(files[1].originalPath, "old name.txt");
  assert.equal(files[2].workingTreeStatus, "deleted");
  assert.equal(files[3].submodule, true);
  assert.equal(files[3].submoduleState, ".M.");
  assert.equal(files[4].pathEncoding, "sanitized");
  assert.equal(files[4].rawPath, undefined);
  assert.equal(files[5].pathEncoding, "sanitized");
  assert.equal(files[6].pathEncoding, "undecodable");
  assert.ok(files.slice(4).every((file) => !/[\u001b\u202e]/u.test(file.path)));
});

test("numstat parsing handles binary files and rename records", () => {
  const output = Buffer.from("-\t-\tbinary.bin\u00002\t1\t\u0000old.txt\u0000new.txt\u0000");
  const parsed = parseNumstat(output);
  assert.deepEqual(parsed.get(Buffer.from("binary.bin").toString("hex")), {
    binary: true,
    additions: null,
    deletions: null,
  });
  assert.deepEqual(parsed.get(Buffer.from("new.txt").toString("hex")), {
    binary: false,
    additions: 2,
    deletions: 1,
  });
});

test("working tree snapshots cover tracked, untracked, binary, mode, submodule, and unsafe data", async () => {
  const fixture = createFixture();
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const { state, paneId } = createState(fixture.directory, machines, "local", fixture.nestedCwd);
  const service = new RepositoryReviewService(state, machines, {
    limits: {
      patchBytes: 1024 * 1024,
      lineCount: 10_000,
      longLineBytes: 64,
      untrackedFileBytes: 128,
    },
  });
  try {
    const first = await service.workingTreeSnapshot(paneId);
    const second = await service.workingTreeSnapshot(paneId);
    assert.equal(first.consistency, "verified");
    assert.equal(first.contentRevision, second.contentRevision);
    assert.match(first.contentRevision, /^sha256:[a-f0-9]{64}$/);
    assert.match(first.headRevision ?? "", /^[a-f0-9]{40,64}$/);
    assert.equal(first.ignoredFilesExcluded, true);
    assert.equal(first.files.some((file) => file.path === "ignored.txt"), false);

    const renamed = first.files.find((file) => file.path === "renamed ü.txt");
    assert.equal(renamed?.indexStatus, "renamed");
    assert.equal(renamed?.originalPath, "rename me.txt");
    assert.equal(first.files.find((file) => file.path === "delete me.txt")?.workingTreeStatus, "deleted");
    assert.equal(first.files.find((file) => file.path === "binary.bin")?.binary, "yes");
    assert.equal(first.files.find((file) => file.path === "mode-only.sh")?.modeOnly, true);
    assert.equal(first.files.find((file) => file.path === "submodule")?.submodule, true);
    assert.ok(first.files.some((file) => file.path === "space ü.txt"));

    const untracked = first.files.find((file) => file.path === "untracked space ü.txt");
    assert.equal(untracked?.tracked, false);
    assert.match(untracked?.untrackedPatch?.text ?? "", /new file mode 100644/);
    assert.match(untracked?.untrackedPatch?.text ?? "", /\+first/);
    const untrackedBinary = first.files.find((file) => file.path === "untracked-binary.bin");
    assert.equal(untrackedBinary?.binary, "yes");
    assert.equal(untrackedBinary?.contentOmitted, "binary");
    assert.equal(untrackedBinary?.untrackedPatch, undefined);
    const invalidUtf8 = first.files.find((file) => file.path === "invalid-utf8.txt");
    assert.equal(invalidUtf8?.binary, "yes");
    assert.equal(invalidUtf8?.contentOmitted, "binary");
    const empty = first.files.find((file) => file.path === "empty.txt");
    assert.doesNotMatch(empty?.untrackedPatch?.text ?? "", /^@@/m);
    const outsideLink = first.files.find((file) => file.path === "outside-link");
    assert.equal(outsideLink?.contentOmitted, "symlink");
    assert.doesNotMatch(JSON.stringify(first), /must not be read/);
    const longLine = first.files.find((file) => file.path === "long-line.txt");
    assert.ok(longLine?.untrackedPatch?.truncationReasons.includes("long-line"));
    assert.ok(longLine?.untrackedPatch?.truncationReasons.includes("untracked-bytes"));
    assert.ok(first.workingTreePatch.truncationReasons.includes("long-line"));
    assert.doesNotMatch(first.workingTreePatch.text, /[\u001b\u202e]/u);

    const sanitized = first.files.filter((file) => file.pathEncoding !== "utf8");
    assert.ok(sanitized.some((file) => file.pathEncoding === "sanitized"));
    assert.ok(sanitized.some((file) => file.pathEncoding === "undecodable"));
    assert.ok(sanitized.some((file) => file.contentOmitted === "unsafe-path"));
    assert.ok(sanitized.some((file) => file.contentOmitted === "undecodable-path"));
    assert.doesNotMatch(JSON.stringify(first), /[\u001b\u202e]/u);
  } finally {
    state.flush();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("snapshot limits report patch and file truncation without claiming completeness", async () => {
  const fixture = createFixture();
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const { state, paneId } = createState(fixture.directory, machines, "local", fixture.repository);
  const service = new RepositoryReviewService(state, machines, {
    limits: {
      patchBytes: 512,
      fileCount: 3,
      lineCount: 20,
      hunkCount: 2,
      longLineBytes: 32,
      untrackedFileBytes: 64,
    },
  });
  try {
    const snapshot = await service.workingTreeSnapshot(paneId);
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.filesTruncated, true);
    assert.equal(snapshot.files.length, 3);
    assert.ok(snapshot.observedFileCount > snapshot.files.length);
    assert.ok(
      snapshot.stagedPatch.truncated
      || snapshot.workingTreePatch.truncated
      || snapshot.files.some((file) => file.untrackedPatch?.truncated),
    );
  } finally {
    state.flush();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("patch byte, hunk, line, long-line, and Git-output limits are explicit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-repository-patch-limits-"));
  const repository = path.join(directory, "repo");
  fs.mkdirSync(repository);
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const { state, paneId } = createState(directory, machines, "local", repository);
  const patch = Buffer.from([
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    `-${"a".repeat(80)}`,
    `+${"b".repeat(80)}`,
    "@@ -10 +10 @@",
    "-old",
    "+new",
    "",
  ].join("\n"));
  const runnerWithPatch = (outputLimited = false): GitCommandRunner => async (args) => {
    if (args === REPOSITORY_GIT_COMMANDS.discover) return successfulResult(Buffer.from(`${repository}\n`));
    if (args === REPOSITORY_GIT_COMMANDS.head) return successfulResult(Buffer.from(`${"a".repeat(40)}\n`));
    if (args === REPOSITORY_GIT_COMMANDS.stagedPatch) {
      return {
        ...successfulResult(patch),
        outputLimited,
        status: outputLimited ? null : 0,
      };
    }
    return successfulResult();
  };
  const reasonFor = async (
    limits: ConstructorParameters<typeof RepositoryReviewService>[2]["limits"],
    reason: string,
  ): Promise<void> => {
    const snapshot = await new RepositoryReviewService(state, machines, {
      runner: runnerWithPatch(),
      limits,
    }).workingTreeSnapshot(paneId);
    assert.ok(snapshot.stagedPatch.truncationReasons.includes(
      reason as typeof snapshot.stagedPatch.truncationReasons[number],
    ));
    assert.equal(snapshot.complete, false);
  };
  try {
    await reasonFor({ patchBytes: 32 }, "patch-bytes");
    await reasonFor({ hunkCount: 1 }, "hunks");
    await reasonFor({ lineCount: 3 }, "lines");
    await reasonFor({ longLineBytes: 16 }, "long-line");
    const limited = await new RepositoryReviewService(state, machines, {
      runner: runnerWithPatch(true),
    }).workingTreeSnapshot(paneId);
    assert.equal(limited.consistency, "best-effort");
    assert.ok(limited.stagedPatch.truncationReasons.includes("git-output"));
    assert.equal(limited.complete, false);
  } finally {
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("non-local panes and invalid canonical cwd fail before Git execution", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-repository-target-"));
  const machines: MachineConfig[] = [
    { id: "remote", name: "Remote", kind: "ssh", host: "example.invalid" },
    { id: "local", name: "Local", kind: "local" },
  ];
  const remote = createState(directory, machines, "remote", "/tmp");
  let calls = 0;
  const runner: GitCommandRunner = async () => {
    calls += 1;
    return successfulResult();
  };
  try {
    await assert.rejects(
      new RepositoryReviewService(remote.state, machines, { runner }).workingTreeSnapshot(remote.paneId),
      (error: unknown) =>
        error instanceof RepositoryReviewError
        && error.code === "repository_review_non_local"
        && error.status === 422,
    );
    const localWorkspace = remote.state.createWorkspace("local", "../client-cwd");
    await assert.rejects(
      new RepositoryReviewService(remote.state, machines, { runner })
        .workingTreeSnapshot(localWorkspace.tabs[0].panes[0].id),
      (error: unknown) =>
        error instanceof RepositoryReviewError
        && error.code === "repository_cwd_invalid",
    );
    assert.equal(calls, 0);
  } finally {
    remote.state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unborn repository returns a bounded untracked snapshot with no HEAD", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-repository-unborn-"));
  const repository = path.join(directory, "repo");
  fs.mkdirSync(repository);
  git(repository, ["init", "-q"]);
  write(repository, "first.txt", "first\n");
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const { state, paneId } = createState(directory, machines, "local", repository);
  try {
    const snapshot = await new RepositoryReviewService(state, machines).workingTreeSnapshot(paneId);
    assert.equal(snapshot.headRevision, null);
    assert.equal(snapshot.consistency, "verified");
    assert.equal(snapshot.files.find((file) => file.path === "first.txt")?.tracked, false);
    const totalLimited = await new RepositoryReviewService(state, machines, {
      limits: { untrackedFileBytes: 100, totalUntrackedBytes: 4 },
    }).workingTreeSnapshot(paneId);
    assert.ok(
      totalLimited.files.find((file) => file.path === "first.txt")
        ?.untrackedPatch?.truncationReasons.includes("untracked-total-bytes"),
    );
    assert.equal(totalLimited.complete, false);
  } finally {
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("non-repository, process failure, timeout, cancellation, and concurrent changes are typed", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-repository-errors-"));
  const repository = path.join(directory, "repo");
  fs.mkdirSync(repository);
  const machines: MachineConfig[] = [{ id: "local", name: "Local", kind: "local" }];
  const { state, paneId } = createState(directory, machines, "local", repository);
  const runErrorCase = async (
    runner: GitCommandRunner,
    code: RepositoryReviewError["code"],
  ): Promise<void> => {
    await assert.rejects(
      new RepositoryReviewService(state, machines, { runner }).workingTreeSnapshot(paneId),
      (error: unknown) => error instanceof RepositoryReviewError && error.code === code,
    );
  };
  try {
    await runErrorCase(async () => successfulResult(Buffer.alloc(0), 128), "repository_not_found");

    let call = 0;
    await runErrorCase(async (args) => {
      call += 1;
      if (args === REPOSITORY_GIT_COMMANDS.discover) return successfulResult(Buffer.from(`${repository}\n`));
      if (call === 3) return successfulResult(Buffer.alloc(0), 2);
      return successfulResult(Buffer.from(`${"a".repeat(40)}\n`));
    }, "repository_process_failed");

    await runErrorCase(async () => ({
      ...successfulResult(),
      timedOut: true,
      status: null,
    }), "repository_timeout");

    const controller = new AbortController();
    const cancellingRunner: GitCommandRunner = async (_args, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve({
          ...successfulResult(),
          status: null,
          cancelled: true,
        }), { once: true });
      });
    const cancelled = new RepositoryReviewService(state, machines, { runner: cancellingRunner })
      .workingTreeSnapshot(paneId, controller.signal);
    controller.abort();
    await assert.rejects(
      cancelled,
      (error: unknown) =>
        error instanceof RepositoryReviewError
        && error.code === "repository_cancelled",
    );

    let statusCalls = 0;
    await runErrorCase(async (args) => {
      if (args === REPOSITORY_GIT_COMMANDS.discover) return successfulResult(Buffer.from(`${repository}\n`));
      if (args === REPOSITORY_GIT_COMMANDS.head) return successfulResult(Buffer.from(`${"a".repeat(40)}\n`));
      if (args === REPOSITORY_GIT_COMMANDS.status) {
        statusCalls += 1;
        return successfulResult(Buffer.from(statusCalls === 1 ? "? first.txt\0" : "? second.txt\0"));
      }
      return successfulResult();
    }, "repository_changed");
  } finally {
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the Git process runner kills a timed-out or cancelled child", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-repository-runner-"));
  const executable = path.join(directory, "git");
  fs.writeFileSync(executable, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o700 });
  const environment = { PATH: directory };
  try {
    const timedOut = await spawnGitCommand(["status"], {
      cwd: directory,
      env: environment,
      timeoutMs: 25,
      maxOutputBytes: 1024,
    });
    assert.equal(timedOut.timedOut, true);
    assert.notEqual(timedOut.status, 0);

    const controller = new AbortController();
    const cancelledPromise = spawnGitCommand(["status"], {
      cwd: directory,
      env: environment,
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    const cancelled = await cancelledPromise;
    assert.equal(cancelled.cancelled, true);
    assert.notEqual(cancelled.status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
