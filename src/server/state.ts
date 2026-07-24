import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createId } from "./id.js";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  parsePersistedState,
  type ParsedPersistedState,
  UnsupportedStateVersionError,
} from "./state-schema.js";
import type {
  LayoutNode,
  MachineConfig,
  PaneState,
  PersistedState,
  SurfaceTab,
  TerminalMedia,
  TerminalClipboard,
  TerminalNotification,
  TerminalRun,
  TitleSource,
  Workspace,
  WorkspaceReorderPosition,
} from "./types.js";

const now = (): string => new Date().toISOString();
const stateMachines = (machines: MachineConfig[]): MachineConfig[] =>
  machines.map(({
    agentToken: _agentToken,
    loadPowerShellProfile: _loadPowerShellProfile,
    source: _source,
    registeredAt: _registeredAt,
    lastSeenAt: _lastSeenAt,
    expiresAt: _expiresAt,
    online: _online,
    ...machine
  }) => structuredClone(machine));

const defaultPath = (): string => path.join(os.homedir(), ".wmux", "state.json");

interface PaneContext {
  workspace: Workspace;
  tab: SurfaceTab;
  pane: PaneState;
}

export interface WorkspaceCreationIds {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface TabCreationIds {
  tabId: string;
  paneId: string;
}

export interface SplitCreationIds {
  paneId: string;
}

export class StateIdConflictError extends Error {
  constructor(readonly id: string) {
    super(`state id is already in use: ${id}`);
    this.name = "StateIdConflictError";
  }
}

interface TargetInput {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
}

interface CreateNotificationInput extends TargetInput {
  title: string;
  subtitle?: string;
  body?: string;
}

interface CreateMediaInput extends TargetInput {
  name: string;
  mimeType: string;
  data: string;
}

interface CreateClipboardInput extends TargetInput {
  text: string;
}

interface RecordRunEventInput extends TargetInput {
  runId?: string;
  command?: string;
  status?: "started" | "completed" | "failed";
  exitCode?: number | null;
  startedAt?: string;
  completedAt?: string;
}

interface SetAutoTitleInput {
  workspaceId: string;
  title: string;
  tabId?: string;
  descriptor?: string;
  tabOnlyIfMultiple?: boolean;
}

// Terminal title/cwd updates stream from the PTY constantly, so persistence is
// debounced: mutations mark the store dirty and emit "change" immediately (so
// the UI stays live), and the actual disk write is coalesced onto this trailing
// window. flush() forces a synchronous write for shutdown/tests.
const WRITE_DEBOUNCE_MS = 150;

export class WorkspaceDepthError extends Error {
  readonly code = "workspace_depth";
  constructor() { super("workspace tree exceeds maximum depth"); this.name = "WorkspaceDepthError"; }
}

export class StateStore extends EventEmitter {
  private state: PersistedState;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    machines: MachineConfig[],
    private readonly filePath: string = process.env.WMUX_STATE_PATH ?? defaultPath(),
  ) {
    super();
    this.state = this.load(machines);
    this.flush();
  }

  snapshot(): PersistedState {
    return structuredClone(this.state);
  }

  commitMutation<T>(
    mutate: (state: PersistedState) => {
      result: T;
      changed: boolean;
      notifications?: TerminalNotification[];
    },
  ): T {
    const outcome = mutate(this.state);
    if (outcome.changed) this.save();
    for (const notification of outcome.notifications ?? []) {
      this.emit("notification", structuredClone(notification));
    }
    return structuredClone(outcome.result);
  }

  /** Replace the machine catalog after a dynamic registration change. */
  updateMachines(machines: MachineConfig[]): boolean {
    const nextMachines = stateMachines(machines);
    if (JSON.stringify(this.state.machines) === JSON.stringify(nextMachines)) return false;
    this.state.machines = nextMachines;
    this.save();
    return true;
  }

  hasMachineReferences(machineId: string): boolean {
    return this.state.workspaces.some((workspace) =>
      workspace.tabs.some((tab) => tab.panes.some((pane) => pane.machineId === machineId)),
    );
  }

  save(): void {
    this.state.revision = Math.max(0, Math.floor(this.state.revision || 0)) + 1;
    this.dirty = true;
    this.emit("change");
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  /** Persist any pending changes synchronously, cancelling the debounce timer. */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty && fs.existsSync(this.filePath)) return;
    this.writeToDisk();
    this.dirty = false;
  }

  private writeToDisk(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Write to a temp file and rename so a crash or ENOSPC mid-write can never
    // truncate the live state file — rename is atomic on the same filesystem.
    const tempPath = `${this.filePath}.tmp`;
    try {
      const handle = fs.openSync(tempPath, "w", 0o600);
      try {
        fs.writeFileSync(handle, JSON.stringify(this.state, null, 2));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.chmodSync(tempPath, 0o600);
      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, this.backupPath());
        fs.chmodSync(this.backupPath(), 0o600);
      }
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  createWorkspace(
    machineId: string,
    cwd?: string,
    createdBy: "user" | "agent" = "user",
    parentWorkspaceId?: string,
    ids?: WorkspaceCreationIds,
  ): Workspace {
    if (parentWorkspaceId && createdBy !== "agent") throw new Error("only agent workspaces may have a parent");
    if (parentWorkspaceId && !this.state.workspaces.some((workspace) => workspace.id === parentWorkspaceId)) throw new Error("parent workspace not found");
    if (parentWorkspaceId && this.depthForParent(parentWorkspaceId) >= 4) throw new WorkspaceDepthError();
    if (ids) {
      const existing = this.state.workspaces.find((workspace) => workspace.id === ids.workspaceId);
      if (existing) {
        const tab = existing.tabs.find((candidate) => candidate.id === ids.tabId);
        const pane = tab?.panes.find((candidate) => candidate.id === ids.paneId);
        if (existing.machineId === machineId && pane?.machineId === machineId) return existing;
        throw new StateIdConflictError(ids.workspaceId);
      }
      this.assertTabIdAvailable(ids.tabId);
      this.assertPaneIdAvailable(ids.paneId);
    }
    const pane = this.createPane(machineId, cwd, ids?.paneId);
    const tab: SurfaceTab = {
      id: ids?.tabId ?? createId("tab"),
      title: "Shell",
      titleSource: "default",
      activePaneId: pane.id,
      layout: { type: "pane", paneId: pane.id },
      panes: [pane],
      createdAt: now(),
    };
    const workspace: Workspace = {
      id: ids?.workspaceId ?? createId("ws"),
      name: this.nextWorkspaceName(machineId),
      ...(createdBy === "agent" ? { createdBy } : {}),
      ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
      nameSource: "default",
      descriptor: this.machineDescriptor(machineId),
      descriptorSource: "default",
      machineId,
      activeTabId: tab.id,
      tabs: [tab],
      createdAt: now(),
      updatedAt: now(),
    };
    if (parentWorkspaceId) this.state.workspaces.splice(this.childInsertIndex(parentWorkspaceId), 0, workspace);
    else this.state.workspaces.unshift(workspace);
    this.state.activeWorkspaceId = workspace.id;
    this.bumpWorkspaceTreeRevision();
    this.save();
    return workspace;
  }

  reorderWorkspace(
    workspaceId: string,
    targetWorkspaceId: string | undefined,
    position: WorkspaceReorderPosition,
  ): boolean {
    return this.reorderWorkspaceResult(workspaceId, targetWorkspaceId, position).ok;
  }

  reorderWorkspaceResult(workspaceId: string, targetWorkspaceId: string | undefined, position: WorkspaceReorderPosition, expectedRevision?: number): { ok: boolean; status?: "not_found" | "conflict" | "cycle" | "invalid_outdent" | "depth"; changed?: boolean } {
    if (expectedRevision !== undefined && expectedRevision !== this.state.workspaceTreeRevision) return { ok: false, status: "conflict" };
    const sourceIndex = this.state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    const targetIndex = targetWorkspaceId ? this.state.workspaces.findIndex((workspace) => workspace.id === targetWorkspaceId) : -1;
    if (sourceIndex < 0 || (position !== "out-of" && targetIndex < 0)) return { ok: false, status: "not_found" };
    const source = this.state.workspaces[sourceIndex];
    const sourceEnd = this.subtreeEnd(sourceIndex);
    if (workspaceId === targetWorkspaceId || (targetIndex > sourceIndex && targetIndex < sourceEnd)) return { ok: false, status: "cycle" };
    let parentWorkspaceId: string | undefined;
    let insertionIndex: number;
    if (position === "into") { parentWorkspaceId = targetWorkspaceId; insertionIndex = targetIndex + 1; }
    else if (position === "out-of") {
      if (!source.parentWorkspaceId) return { ok: false, status: "invalid_outdent" };
      const parentIndex = this.state.workspaces.findIndex((workspace) => workspace.id === source.parentWorkspaceId);
      parentWorkspaceId = this.state.workspaces[parentIndex].parentWorkspaceId;
      insertionIndex = this.subtreeEnd(parentIndex);
    } else {
      parentWorkspaceId = this.state.workspaces[targetIndex].parentWorkspaceId;
      insertionIndex = position === "before" ? targetIndex : this.subtreeEnd(targetIndex);
    }
    if (this.depthForParent(parentWorkspaceId) + this.subtreeHeight(sourceIndex) > 3) return { ok: false, status: "depth" };
    const subtree = this.state.workspaces.splice(sourceIndex, sourceEnd - sourceIndex);
    if (sourceIndex < insertionIndex) insertionIndex -= subtree.length;
    subtree[0] = { ...source, ...(parentWorkspaceId ? { parentWorkspaceId } : {}) };
    if (!parentWorkspaceId) delete subtree[0].parentWorkspaceId;
    if (insertionIndex === sourceIndex && source.parentWorkspaceId === parentWorkspaceId) { this.state.workspaces.splice(sourceIndex, 0, ...subtree); return { ok: true, changed: false }; }
    this.state.workspaces.splice(insertionIndex, 0, ...subtree);
    this.bumpWorkspaceTreeRevision(); this.save();
    return { ok: true, changed: true };
  }

  createTab(workspaceId: string, machineId?: string, cwd?: string, ids?: TabCreationIds): SurfaceTab {
    const workspace = this.requireWorkspace(workspaceId);
    const targetMachineId = machineId ?? workspace.machineId;
    if (ids) {
      const existing = workspace.tabs.find((tab) => tab.id === ids.tabId);
      if (existing) {
        const pane = existing.panes.find((candidate) => candidate.id === ids.paneId);
        if (pane?.machineId === targetMachineId) return existing;
        throw new StateIdConflictError(ids.tabId);
      }
      this.assertTabIdAvailable(ids.tabId);
      this.assertPaneIdAvailable(ids.paneId);
    }
    const pane = this.createPane(targetMachineId, cwd, ids?.paneId);
    const tab: SurfaceTab = {
      id: ids?.tabId ?? createId("tab"),
      title: "Shell",
      titleSource: "default",
      activePaneId: pane.id,
      layout: { type: "pane", paneId: pane.id },
      panes: [pane],
      createdAt: now(),
    };
    workspace.tabs.push(tab);
    workspace.activeTabId = tab.id;
    workspace.updatedAt = now();
    this.save();
    return tab;
  }

  splitPane(
    tabId: string,
    paneId: string,
    direction: "horizontal" | "vertical",
    machineId?: string,
    cwd?: string,
    ids?: SplitCreationIds,
  ): SurfaceTab {
    const { workspace, tab } = this.requireTab(tabId);
    const sourcePane = tab.panes.find((pane) => pane.id === paneId);
    if (!sourcePane) throw new Error("pane not found");
    const targetMachineId = machineId ?? sourcePane.machineId;
    if (ids) {
      const existing = tab.panes.find((pane) => pane.id === ids.paneId);
      if (existing) {
        if (
          existing.machineId === targetMachineId
          && hasDirectSplit(tab.layout, paneId, ids.paneId, direction)
        ) return tab;
        throw new StateIdConflictError(ids.paneId);
      }
      this.assertPaneIdAvailable(ids.paneId);
    }
    const pane = this.createPane(targetMachineId, cwd, ids?.paneId);
    tab.panes.push(pane);
    tab.layout = replacePane(tab.layout, paneId, {
      type: "split",
      direction,
      ratio: 0.5,
      first: { type: "pane", paneId },
      second: { type: "pane", paneId: pane.id },
    });
    tab.activePaneId = pane.id;
    workspace.updatedAt = now();
    this.save();
    return tab;
  }

  setSplitRatio(tabId: string, path: string, ratio: number): SurfaceTab {
    const { workspace, tab } = this.requireTab(tabId);
    const split = splitAtPath(tab.layout, path);
    if (!split) throw new Error("split not found");
    split.ratio = clampSplitRatio(ratio);
    workspace.updatedAt = now();
    this.save();
    return structuredClone(tab);
  }

  removePane(paneId: string): boolean {
    const context = this.findPaneContext(paneId);
    if (!context) return false;
    const { workspace, tab } = context;
    if (tab.panes.length <= 1) return false;

    const nextLayout = removePaneFromLayout(tab.layout, paneId);
    if (!nextLayout) return false;
    tab.layout = nextLayout;
    tab.panes = tab.panes.filter((pane) => pane.id !== paneId);
    this.state.notifications = this.state.notifications.filter(
      (notification) => notification.paneId !== paneId,
    );
    this.state.agentEvents = this.state.agentEvents.filter((event) => event.paneId !== paneId);
    this.state.runs = this.state.runs.filter((run) => run.paneId !== paneId);
    if (tab.activePaneId === paneId) {
      tab.activePaneId = firstPaneId(tab.layout) ?? tab.panes[0]?.id ?? "";
    }
    workspace.updatedAt = now();
    this.save();
    return true;
  }

  removeTab(workspaceId: string, tabId: string): string[] {
    const workspace = this.requireWorkspace(workspaceId);
    if (workspace.tabs.length <= 1) return [];
    const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return [];
    const paneIds = tab.panes.map((pane) => pane.id);
    workspace.tabs = workspace.tabs.filter((candidate) => candidate.id !== tabId);
    if (workspace.activeTabId === tabId) {
      workspace.activeTabId = workspace.tabs.at(-1)?.id ?? workspace.tabs[0]?.id ?? "";
    }
    this.state.notifications = this.state.notifications.filter(
      (notification) => notification.tabId !== tabId,
    );
    this.state.agentEvents = this.state.agentEvents.filter((event) => event.tabId !== tabId);
    this.state.runs = this.state.runs.filter((run) => run.tabId !== tabId);
    workspace.updatedAt = now();
    this.save();
    return paneIds;
  }

  removeWorkspace(workspaceId: string): string[] {
    const index = this.state.workspaces.findIndex((candidate) => candidate.id === workspaceId);
    const workspace = this.state.workspaces[index];
    if (!workspace) return [];
    const paneIds = workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.id));
    const promotedChildren = this.state.workspaces.filter((candidate) => candidate.parentWorkspaceId === workspaceId);
    for (const child of promotedChildren) {
      if (workspace.parentWorkspaceId) child.parentWorkspaceId = workspace.parentWorkspaceId;
      else delete child.parentWorkspaceId;
    }
    this.state.workspaces.splice(index, 1);
    this.state.notifications = this.state.notifications.filter(
      (notification) => notification.workspaceId !== workspaceId,
    );
    this.state.agentEvents = this.state.agentEvents.filter((event) => event.workspaceId !== workspaceId);
    this.state.runs = this.state.runs.filter((run) => run.workspaceId !== workspaceId);
    if (this.state.activeWorkspaceId === workspaceId) {
      this.state.activeWorkspaceId = promotedChildren[0]?.id ?? this.state.workspaces[index]?.id ?? this.state.workspaces[index - 1]?.id ?? "";
    }
    this.bumpWorkspaceTreeRevision();
    this.save();
    return paneIds;
  }

  closeWorkspaceAfterExit(workspaceId: string): void {
    this.removeWorkspace(workspaceId);
  }

  updatePane(paneId: string, patch: Partial<PaneState>): void {
    for (const workspace of this.state.workspaces) {
      for (const tab of workspace.tabs) {
        const pane = tab.panes.find((candidate) => candidate.id === paneId);
        if (!pane) continue;
        Object.assign(pane, patch);
        workspace.updatedAt = now();
        this.save();
        return;
      }
    }
  }

  setWorkspaceTitle(workspaceId: string, title: string, source: TitleSource = "user"): Workspace {
    const workspace = this.requireWorkspace(workspaceId);
    workspace.name = cleanTitle(title, workspace.name);
    workspace.nameSource = source;
    workspace.updatedAt = now();
    this.save();
    return structuredClone(workspace);
  }

  clearWorkspaceTitle(workspaceId: string): Workspace {
    const workspace = this.requireWorkspace(workspaceId);
    workspace.name = this.nextWorkspaceName(workspace.machineId);
    workspace.nameSource = "default";
    workspace.updatedAt = now();
    this.save();
    return structuredClone(workspace);
  }

  setTabTitle(workspaceId: string, tabId: string, title: string, source: TitleSource = "user"): SurfaceTab {
    const workspace = this.requireWorkspace(workspaceId);
    const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error("tab not found");
    tab.title = cleanTitle(title, tab.title);
    tab.titleSource = source;
    workspace.updatedAt = now();
    this.save();
    return structuredClone(tab);
  }

  setAutoTitle(input: SetAutoTitleInput): { workspace: Workspace; tab?: SurfaceTab; workspaceApplied: boolean; tabApplied: boolean } {
    const workspace = this.requireWorkspace(input.workspaceId);
    const title = cleanTitle(input.title, "");
    if (!title) throw new Error("title is required");

    let workspaceApplied = false;
    let tabApplied = false;
    if (workspace.nameSource !== "user") {
      workspace.name = title;
      workspace.nameSource = "auto";
      workspaceApplied = true;
    }

    if (typeof input.descriptor === "string" && workspace.descriptorSource !== "user") {
      workspace.descriptor = cleanDescriptor(input.descriptor, "");
      workspace.descriptorSource = workspace.descriptor ? "auto" : "default";
      workspaceApplied = true;
    }

    let tab: SurfaceTab | undefined;
    if (input.tabId && (!input.tabOnlyIfMultiple || workspace.tabs.length > 1)) {
      tab = workspace.tabs.find((candidate) => candidate.id === input.tabId);
      if (!tab) throw new Error("tab not found");
      if (tab.titleSource !== "user") {
        tab.title = title;
        tab.titleSource = "auto";
        tabApplied = true;
      }
    }

    if (workspaceApplied || tabApplied) {
      workspace.updatedAt = now();
      this.save();
    }
    return {
      workspace: structuredClone(workspace),
      tab: tab ? structuredClone(tab) : undefined,
      workspaceApplied,
      tabApplied,
    };
  }

  findPane(paneId: string): PaneState | null {
    return this.findPaneContext(paneId)?.pane ?? null;
  }

  findPaneContext(paneId: string): PaneContext | null {
    for (const workspace of this.state.workspaces) {
      for (const tab of workspace.tabs) {
        const pane = tab.panes.find((candidate) => candidate.id === paneId);
        if (pane) return { workspace, tab, pane };
      }
    }
    return null;
  }

  createNotification(input: CreateNotificationInput): TerminalNotification {
    const target = this.resolveNotificationTarget(input);
    const notification: TerminalNotification = {
      id: createId("note"),
      workspaceId: target.workspace.id,
      tabId: target.tab.id,
      paneId: target.pane.id,
      title: cleanText(input.title, "wmux"),
      subtitle: cleanText(input.subtitle ?? "", ""),
      body: cleanText(input.body ?? "", ""),
      createdAt: now(),
      read: false,
    };
    this.state.notifications.unshift(notification);
    this.state.notifications = this.state.notifications.slice(0, 200);
    target.workspace.updatedAt = now();
    this.save();
    this.emit("notification", structuredClone(notification));
    return structuredClone(notification);
  }

  createMedia(input: CreateMediaInput): TerminalMedia {
    const target = this.resolveNotificationTarget(input);
    const media: TerminalMedia = {
      id: createId("media"),
      workspaceId: target.workspace.id,
      tabId: target.tab.id,
      paneId: target.pane.id,
      name: cleanText(input.name, "media"),
      mimeType: cleanText(input.mimeType, "application/octet-stream").slice(0, 120),
      data: input.data.replace(/\s+/g, ""),
      createdAt: now(),
    };
    target.workspace.updatedAt = now();
    this.save();
    this.emit("media", structuredClone(media));
    return structuredClone(media);
  }

  createClipboard(input: CreateClipboardInput): TerminalClipboard {
    const target = this.resolveNotificationTarget(input);
    const clipboard: TerminalClipboard = {
      id: createId("clip"),
      workspaceId: target.workspace.id,
      tabId: target.tab.id,
      paneId: target.pane.id,
      text: input.text.slice(0, 2 * 1024 * 1024),
      createdAt: now(),
    };
    this.emit("clipboard", structuredClone(clipboard));
    return structuredClone(clipboard);
  }

  recordRunEvent(input: RecordRunEventInput): TerminalRun {
    const target = this.resolveNotificationTarget(input);
    const status = input.status ?? "completed";
    const startedAt = validIsoDate(input.startedAt) ?? now();
    const completedAt = status === "started" ? undefined : validIsoDate(input.completedAt) ?? now();
    const command = cleanText(input.command ?? "", "command").slice(0, 500);
    const id = cleanEventId(input.runId) || createId("run");
    const existingIndex = this.state.runs.findIndex((candidate) => candidate.id === id);

    if (existingIndex !== -1) {
      const [existing] = this.state.runs.splice(existingIndex, 1);
      existing.workspaceId = target.workspace.id;
      existing.tabId = target.tab.id;
      existing.paneId = target.pane.id;
      existing.command = command || existing.command;
      existing.status = status;
      existing.exitCode = input.exitCode ?? null;
      existing.startedAt = validIsoDate(input.startedAt) ?? existing.startedAt;
      if (completedAt) {
        existing.completedAt = completedAt;
      } else {
        delete existing.completedAt;
      }
      this.state.runs.unshift(existing);
      this.state.runs = this.state.runs.slice(0, 300);
      target.workspace.updatedAt = now();
      this.save();
      this.emit("run", structuredClone(existing));
      return structuredClone(existing);
    }

    const run: TerminalRun = {
      id,
      workspaceId: target.workspace.id,
      tabId: target.tab.id,
      paneId: target.pane.id,
      command,
      status,
      exitCode: input.exitCode ?? null,
      startedAt,
      completedAt,
    };
    if (!completedAt) delete run.completedAt;
    this.state.runs.unshift(run);
    this.state.runs = this.state.runs.slice(0, 300);
    target.workspace.updatedAt = now();
    this.save();
    this.emit("run", structuredClone(run));
    return structuredClone(run);
  }

  markNotificationRead(notificationId: string): void {
    const notification = this.state.notifications.find((candidate) => candidate.id === notificationId);
    if (!notification || notification.read) return;
    notification.read = true;
    this.save();
  }

  markWorkspaceNotificationsRead(workspaceId: string, save = true): void {
    let changed = false;
    for (const notification of this.state.notifications) {
      if (notification.workspaceId === workspaceId && !notification.read) {
        notification.read = true;
        changed = true;
      }
    }
    if (changed && save) this.save();
  }

  markPaneNotificationsRead(paneId: string, save = true): void {
    let changed = false;
    for (const notification of this.state.notifications) {
      if (notification.paneId === paneId && !notification.read) {
        notification.read = true;
        changed = true;
      }
    }
    if (changed && save) this.save();
  }

  private load(machines: MachineConfig[]): PersistedState {
    const safeMachines = stateMachines(machines);
    if (fs.existsSync(this.filePath)) {
      const restored = this.tryLoadPersisted();
      if (restored) {
        const beforeNormalization = JSON.stringify(restored.state);
        const normalized = { ...this.normalizeRestoredState(restored.state), machines: safeMachines };
        this.dirty = restored.migrated || JSON.stringify(normalized) !== beforeNormalization;
        return normalized;
      }
      // Corrupt/unreadable state: quarantine the bad file rather than crashing
      // startup. Prefer the last validated rolling backup before starting fresh.
      this.quarantineStateFile();
    }
    if (fs.existsSync(this.backupPath())) {
      const backup = this.tryLoadPersisted(this.backupPath());
      if (backup) {
        console.error(`wmux: recovered state from ${this.backupPath()}`);
        this.dirty = true;
        return { ...this.normalizeRestoredState(backup.state), machines: safeMachines };
      }
      this.quarantineStateFile(this.backupPath());
    }
    const state: PersistedState = {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      revision: 0,
      workspaceTreeRevision: 0,
      machines: safeMachines,
      workspaces: [],
      activeWorkspaceId: "",
      notifications: [],
      agentEvents: [],
      delegations: [],
      runs: [],
    };
    this.state = state;
    const initialMachineId = machines.find((machine) => machine.source !== "registered")?.id;
    if (!initialMachineId) return state;
    const workspace = this.createWorkspace(initialMachineId);
    return { ...state, activeWorkspaceId: workspace.id };
  }

  private tryLoadPersisted(filePath = this.filePath): ParsedPersistedState | null {
    try {
      return parsePersistedState(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
    } catch (error) {
      if (error instanceof UnsupportedStateVersionError) throw error;
      return null;
    }
  }

  private quarantineStateFile(filePath = this.filePath): void {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const quarantinePath = `${filePath}.corrupt-${stamp}`;
      fs.renameSync(filePath, quarantinePath);
      console.error(`wmux: unreadable state file quarantined to ${quarantinePath}`);
    } catch (error) {
      console.error(`wmux: failed to quarantine unreadable state file: ${error instanceof Error ? error.message : error}`);
    }
  }

  private backupPath(): string {
    return `${this.filePath}.bak`;
  }

  private createPane(machineId: string, cwd?: string, paneId = createId("pane")): PaneState {
    return {
      id: paneId,
      machineId,
      title: "Shell",
      cwd,
      status: "idle",
      createdAt: now(),
    };
  }

  private nextWorkspaceName(machineId: string): string {
    const count = this.state.workspaces.length + 1;
    return machineId === "local" ? `Local ${count}` : `${machineId} ${count}`;
  }

  private machineDescriptor(machineId: string, machines = this.state.machines): string {
    const machine = machines.find((candidate) => candidate.id === machineId);
    return machine?.name ?? machineId;
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.state.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error("workspace not found");
    return workspace;
  }

  private assertTabIdAvailable(tabId: string): void {
    if (this.state.workspaces.some((workspace) => workspace.tabs.some((tab) => tab.id === tabId))) {
      throw new StateIdConflictError(tabId);
    }
  }

  private assertPaneIdAvailable(paneId: string): void {
    if (this.findPaneContext(paneId)) throw new StateIdConflictError(paneId);
  }

  private requireTab(tabId: string): { workspace: Workspace; tab: SurfaceTab } {
    for (const workspace of this.state.workspaces) {
      const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
      if (tab) return { workspace, tab };
    }
    throw new Error("tab not found");
  }

  private resolveNotificationTarget(input: TargetInput): PaneContext {
    if (input.paneId) {
      const context = this.findPaneContext(input.paneId);
      if (!context) throw new Error("pane not found");
      return context;
    }

    const workspace = input.workspaceId
      ? this.requireWorkspace(input.workspaceId)
      : this.requireWorkspace(this.state.activeWorkspaceId);
    const tab = input.tabId
      ? workspace.tabs.find((candidate) => candidate.id === input.tabId)
      : workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId);
    if (!tab) throw new Error("tab not found");
    const pane = tab.panes.find((candidate) => candidate.id === tab.activePaneId) ?? tab.panes[0];
    if (!pane) throw new Error("pane not found");
    return { workspace, tab, pane };
  }

  private normalizeRestoredState(state: PersistedState): PersistedState {
    state.revision = Math.max(0, Math.floor(state.revision || 0));
    state.workspaceTreeRevision = Math.max(0, Math.floor(state.workspaceTreeRevision || 0));
    state.notifications ??= [];
    state.agentEvents ??= [];
    state.delegations ??= [];
    state.runs ??= [];
    for (const workspace of state.workspaces) {
      workspace.nameSource ??= isDefaultWorkspaceName(workspace.name, workspace.machineId) ? "default" : "user";
      workspace.descriptor ??= this.machineDescriptor(workspace.machineId, state.machines ?? []);
      workspace.descriptorSource ??= "default";
      // Retroactively scrub markup that older builds let into agent-derived
      // names, but never touch a title the user set by hand.
      if (workspace.nameSource !== "user") workspace.name = cleanTitle(workspace.name, workspace.name);
      if (workspace.descriptorSource !== "user" && workspace.descriptor) {
        workspace.descriptor = cleanDescriptor(workspace.descriptor, workspace.descriptor);
      }
      for (const tab of workspace.tabs) {
        tab.titleSource ??= tab.title === "Shell" ? "default" : "user";
        if (tab.titleSource !== "user") tab.title = cleanTitle(tab.title, tab.title);
        for (const pane of tab.panes) {
          if (pane.status === "running") {
            pane.status = "idle";
            pane.exitCode = undefined;
          }
        }
      }
    }
    return state;
  }

  private subtreeEnd(index: number): number {
    const id = this.state.workspaces[index]?.id;
    let cursor = index + 1;
    while (cursor < this.state.workspaces.length && this.isDescendantOf(this.state.workspaces[cursor], id)) cursor += 1;
    return cursor;
  }

  private isDescendantOf(workspace: Workspace, ancestorId: string | undefined): boolean {
    let parent = workspace.parentWorkspaceId;
    while (parent) { if (parent === ancestorId) return true; parent = this.state.workspaces.find((candidate) => candidate.id === parent)?.parentWorkspaceId; }
    return false;
  }

  private childInsertIndex(parentId: string): number { return this.state.workspaces.findIndex((workspace) => workspace.id === parentId) + 1; }
  private depthForParent(parentId: string | undefined): number {
    let depth = 0; let parent = parentId;
    while (parent) { depth += 1; parent = this.state.workspaces.find((workspace) => workspace.id === parent)?.parentWorkspaceId; }
    return depth;
  }
  private subtreeHeight(index: number): number {
    const rootId = this.state.workspaces[index].id;
    let height = 0;
    for (let cursor = index + 1; cursor < this.subtreeEnd(index); cursor += 1) {
      let depth = 0;
      let parent = this.state.workspaces[cursor].parentWorkspaceId;
      while (parent && parent !== rootId) { depth += 1; parent = this.state.workspaces.find((candidate) => candidate.id === parent)?.parentWorkspaceId; }
      if (parent === rootId) height = Math.max(height, depth + 1);
    }
    return height;
  }
  private bumpWorkspaceTreeRevision(): void { this.state.workspaceTreeRevision += 1; }
}

const replacePane = (node: LayoutNode, paneId: string, replacement: LayoutNode): LayoutNode => {
  if (node.type === "pane") return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    first: replacePane(node.first, paneId, replacement),
    second: replacePane(node.second, paneId, replacement),
  };
};

const hasDirectSplit = (
  node: LayoutNode,
  sourcePaneId: string,
  createdPaneId: string,
  direction: "horizontal" | "vertical",
): boolean => {
  if (node.type === "pane") return false;
  if (
    node.direction === direction
    && node.first.type === "pane"
    && node.first.paneId === sourcePaneId
    && node.second.type === "pane"
    && node.second.paneId === createdPaneId
  ) return true;
  return hasDirectSplit(node.first, sourcePaneId, createdPaneId, direction)
    || hasDirectSplit(node.second, sourcePaneId, createdPaneId, direction);
};

const removePaneFromLayout = (node: LayoutNode, paneId: string): LayoutNode | null => {
  if (node.type === "pane") return node.paneId === paneId ? null : node;
  const first = removePaneFromLayout(node.first, paneId);
  const second = removePaneFromLayout(node.second, paneId);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
};

const firstPaneId = (node: LayoutNode): string | null => {
  if (node.type === "pane") return node.paneId;
  return firstPaneId(node.first) ?? firstPaneId(node.second);
};

const splitAtPath = (node: LayoutNode, pathValue: string): Extract<LayoutNode, { type: "split" }> | null => {
  if (!/^[01]*$/.test(pathValue)) return null;
  let current: LayoutNode = node;
  for (const segment of pathValue) {
    if (current.type !== "split") return null;
    current = segment === "0" ? current.first : current.second;
  }
  return current.type === "split" ? current : null;
};

const clampSplitRatio = (value: number): number => {
  const numeric = Number.isFinite(value) ? value : 0.5;
  return Math.min(0.85, Math.max(0.15, numeric));
};

// Titles/descriptors are frequently derived from agent prompt/transcript text,
// which carries Claude Code's injected XML-ish wrappers (system reminders, slash
// command envelopes, local command output). Drop those noise blocks and any
// stray tags so they never leak into workspace/tab names.
const NOISE_BLOCK_TAGS = [
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "function_calls",
  "function_results",
];

export const stripMarkup = (value: string): string => {
  let result = value;
  for (const tag of NOISE_BLOCK_TAGS) {
    result = result.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  // Remove any remaining opening/closing tags (keep their inner text).
  result = result.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  return result;
};

const cleanText = (value: string, fallback: string): string => {
  const cleaned = stripMarkup(value).replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 500);
};

const cleanTitle = (value: string, fallback: string): string => {
  const cleaned = stripMarkup(value).replace(/\s+/g, " ").replace(/[.!?。]+$/u, "").trim();
  return (cleaned || fallback).slice(0, 50);
};

const cleanDescriptor = (value: string, fallback: string): string => {
  const cleaned = stripMarkup(value).replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 120);
};

const cleanEventId = (value?: string): string => {
  const cleaned = (value ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return cleaned;
};

const validIsoDate = (value?: string): string | null => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const isDefaultWorkspaceName = (name: string, machineId: string): boolean => {
  if (/^Local \d+$/.test(name)) return true;
  return name === `${machineId} 1` || new RegExp(`^${escapeRegExp(machineId)} \\d+$`).test(name);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
