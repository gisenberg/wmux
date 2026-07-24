import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildMobileThreadItems } from "../src/client/src/MobileAgentSurface.js";
import { AgentSessionService } from "../src/server/agent-sessions.js";
import {
  AgentTimelineStore,
  UnsupportedAgentTimelineVersionError,
} from "../src/server/agent-timeline.js";
import { StateStore } from "../src/server/state.js";
import type {
  MachineConfig,
  WorkingTreeSnapshot,
} from "../src/server/types.js";

const machines: MachineConfig[] = [
  { id: "local", name: "Local", kind: "local" },
];

const snapshotFixture = (): WorkingTreeSnapshot => ({
  kind: "working-tree",
  contentRevision: "content",
  headRevision: "head",
  consistency: "verified",
  ignoredFilesExcluded: true,
  complete: true,
  filesTruncated: false,
  observedFileCount: 1,
  files: [{
    path: "src/app.ts",
    pathEncoding: "utf8",
    indexStatus: "unmodified",
    workingTreeStatus: "modified",
    tracked: true,
    binary: "no",
    submodule: false,
    modeOnly: false,
  }],
  stagedPatch: {
    text: "",
    capturedBytes: 0,
    hunkCount: 0,
    lineCount: 0,
    truncated: false,
    truncationReasons: [],
  },
  workingTreePatch: {
    text: "+changed",
    capturedBytes: 8,
    hunkCount: 1,
    lineCount: 1,
    truncated: false,
    truncationReasons: [],
  },
  limits: {
    timeoutMs: 10_000,
    totalGitOutputBytes: 1_024,
    patchBytes: 1_024,
    fileCount: 100,
    hunkCount: 100,
    lineCount: 1_000,
    pathBytes: 4_096,
    longLineBytes: 16_384,
    untrackedFileBytes: 1_024,
    totalUntrackedBytes: 4_096,
  },
});

test("agent timelines survive restart and render without terminal activity", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-agent-timeline-"),
  );
  try {
    const statePath = path.join(directory, "state.json");
    const timelinePath = path.join(directory, "agent-timelines.json");
    const state = new StateStore(machines, statePath);
    const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
    const service = new AgentSessionService(
      state,
      AgentTimelineStore.persistent(timelinePath),
    );
    service.recordAgentEvent({
      paneId,
      runId: "turn-one",
      sessionId: "session-one",
      agent: "codex",
      status: "running",
      title: "Timeline test",
      summary: "Codex is working",
      prompt: "Inspect the repository.",
    });
    state.flush();

    const reloadedState = new StateStore(machines, statePath);
    const reloaded = new AgentSessionService(
      reloadedState,
      AgentTimelineStore.persistent(timelinePath),
    );
    const timeline = reloaded.timelineForSession("session-one");
    assert.deepEqual(
      timeline?.entries.map((entry) => [entry.kind, entry.text]),
      [
        ["prompt", "Inspect the repository."],
        ["status", "Codex is working"],
      ],
    );

    reloaded.recordAgentEvent({
      paneId,
      runId: "turn-one",
      sessionId: "session-one",
      agent: "codex",
      status: "completed",
      title: "Timeline test",
      summary: "Codex completed",
      message: "Repository inspection complete.",
    });
    const archive = reloaded.archiveRepositorySnapshot(
      paneId,
      snapshotFixture(),
    );
    assert.ok(archive);
    assert.deepEqual(archive.filesTouched, ["src/app.ts"]);
    assert.equal(
      reloaded.repositorySnapshot(archive.id)?.workingTreePatch.text,
      "+changed",
    );

    const persistedTimeline = AgentTimelineStore
      .persistent(timelinePath)
      .snapshot()[0];
    const mobileItems = buildMobileThreadItems(
      persistedTimeline.workspaceId,
      paneId,
      [],
      [],
      [],
      [],
      [persistedTimeline],
    );
    assert.deepEqual(
      mobileItems
        .filter((item) => item.kind === "timeline")
        .map((item) => item.entry.kind),
      ["prompt", "status", "outcome", "snapshot"],
    );
    assert.equal(
      mobileItems.some((item) => item.kind === "agent"),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("agent timeline files refuse schema downgrade", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-agent-timeline-version-"),
  );
  try {
    const timelinePath = path.join(directory, "agent-timelines.json");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify({ schemaVersion: 2, sessions: [] }),
    );
    assert.throws(
      () => AgentTimelineStore.persistent(timelinePath),
      UnsupportedAgentTimelineVersionError,
    );
    assert.equal(fs.existsSync(timelinePath), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("missing lifecycle entries recover from the delegation ledger", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-agent-timeline-recovery-"),
  );
  try {
    const statePath = path.join(directory, "state.json");
    const timelinePath = path.join(directory, "agent-timelines.json");
    const state = new StateStore(machines, statePath);
    const paneId = state.snapshot().workspaces[0].tabs[0].panes[0].id;
    new AgentSessionService(state).recordAgentEvent({
      paneId,
      runId: "recovered-turn",
      sessionId: "recovered-session",
      agent: "codex",
      status: "completed",
      summary: "Recovered completion",
      message: "Recovered outcome text.",
    });
    state.flush();

    const recovered = new AgentSessionService(
      new StateStore(machines, statePath),
      AgentTimelineStore.persistent(timelinePath),
    );
    assert.deepEqual(
      recovered
        .timelineForSession("recovered-session")
        ?.entries.map((entry) => [entry.kind, entry.text]),
      [["outcome", "Recovered outcome text."]],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
