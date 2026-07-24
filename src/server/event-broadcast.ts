import type { WebSocket } from "ws";
import { resolveKeybindings } from "../shared/keybindings.js";
import {
  DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  MAX_DELEGATION_WAIT_TIMEOUT_SECONDS,
  MIN_DELEGATION_WAIT_TIMEOUT_SECONDS,
  type DelegationConfig,
} from "../shared/protocol.js";
import type { StateStore } from "./state.js";
import type { SettingsStore } from "./settings.js";
import type { StreamRequestStore } from "./streams.js";
import type {
  EventServerMessage,
  KeybindingMap,
  MachineConfig,
  MachineStatus,
  StreamStatus,
  TerminalClipboard,
  TerminalMedia,
  TerminalNotification,
} from "./types.js";

export const HEALTH_EPOCH_PROCESS_STRIDE = 1024;

export const healthEpochForProcessStart = (startedAtMs: number): number => {
  const epoch = Math.trunc(startedAtMs) * HEALTH_EPOCH_PROCESS_STRIDE;
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("unsafe health epoch process start");
  }
  return epoch;
};

export const nextHealthEpoch = (current: number): number => {
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("health epoch exhausted");
  }
  return current + 1;
};

export const PROCESS_HEALTH_EPOCH_BASE = healthEpochForProcessStart(Date.now());

interface EventBroadcastOptions {
  bindHost: string;
  state: StateStore;
  settings: SettingsStore;
  streamRequests: StreamRequestStore;
  currentMachines: () => MachineConfig[];
  machineStatusResolver: (
    machines: MachineConfig[],
    bindHost: string,
  ) => Promise<MachineStatus[]>;
  streamStatusResolver: (
    machines: MachineConfig[],
    bindHost: string,
    requests: StreamRequestStore,
  ) => Promise<StreamStatus[]>;
  terminalFontFamily?: string;
  keybindings?: KeybindingMap;
  delegation?: DelegationConfig;
  refreshIntervals?: {
    machines?: number;
    streams?: number;
  };
}

const samePublicHealth = <T extends { checkedAt: string }>(
  previous: T[],
  next: T[],
): boolean =>
  JSON.stringify(previous.map(({ checkedAt: _checkedAt, ...status }) => status))
  === JSON.stringify(next.map(({ checkedAt: _checkedAt, ...status }) => status));

export class EventBroadcastRuntime {
  private readonly eventSockets = new Set<WebSocket>();
  private machineStatuses: MachineStatus[] = [];
  private streamStatuses: StreamStatus[] = [];
  private machineRefresh: Promise<void> | null = null;
  private streamRefresh: Promise<void> | null = null;
  private streamMutationRevision = 0;
  private machineStatusKey = "";
  private streamStatusKey = "";
  private machinePublishRequested = false;
  private streamPublishRequested = false;
  private healthEpoch = PROCESS_HEALTH_EPOCH_BASE;
  private readonly machineHealthTimer: NodeJS.Timeout;
  private readonly streamHealthTimer: NodeJS.Timeout;

  constructor(private readonly options: EventBroadcastOptions) {
    options.state.on("change", this.onStateChange);
    options.settings.on("change", this.onSettingsChange);
    options.state.on("notification", this.onNotification);
    options.state.on("media", this.onMedia);
    options.state.on("clipboard", this.onClipboard);

    this.machineHealthTimer = setInterval(
      () => this.refreshInBackground(
        "machines",
        () => this.refreshMachineStatuses(true, true),
      ),
      options.refreshIntervals?.machines ?? 15_000,
    );
    this.streamHealthTimer = setInterval(
      () => this.refreshInBackground(
        "streams",
        () => this.refreshStreamStatuses(true, true),
      ),
      options.refreshIntervals?.streams ?? 5_000,
    );
    this.machineHealthTimer.unref();
    this.streamHealthTimer.unref();
  }

  readonly currentPayload = () => {
    const snapshot = this.options.state.snapshot();
    return {
      revision: snapshot.revision,
      workspaceTreeRevision: snapshot.workspaceTreeRevision,
      healthEpoch: this.healthEpoch,
      machines: this.currentMachineStatuses(),
      workspaces: snapshot.workspaces,
      activeWorkspaceId: snapshot.activeWorkspaceId,
      notifications: snapshot.notifications,
      agentEvents: snapshot.agentEvents,
      delegations: snapshot.delegations,
      runs: snapshot.runs,
      delegation: this.options.delegation ?? {
        preferHeadless: false,
        waitTimeoutSeconds: DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS,
        waitTimeoutBoundsSeconds: {
          min: MIN_DELEGATION_WAIT_TIMEOUT_SECONDS,
          max: MAX_DELEGATION_WAIT_TIMEOUT_SECONDS,
        },
      },
      terminalFontFamily:
        this.options.terminalFontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY,
      settings: this.options.settings.snapshot(),
      keybindings: this.options.keybindings ?? resolveKeybindings(),
      settingsDefaults: this.options.settings.defaultsSnapshot(),
      streams: this.streamStatuses,
    };
  };

  readonly bootstrapFresh = async () => {
    await Promise.all([
      this.refreshMachineStatuses(false),
      this.refreshStreamStatuses(false),
    ]);
    return this.currentPayload();
  };

  readonly refreshMachineStatuses = async (
    publish = true,
    force = false,
  ): Promise<void> => {
    this.machinePublishRequested ||= publish;
    if (this.machineRefresh) {
      await this.machineRefresh;
      if (this.machineStatusKey !== this.machineInputKey()) {
        await this.refreshMachineStatuses(publish);
      }
      return;
    }
    const expectedKey = this.machineInputKey();
    if (!force && this.machineStatusKey === expectedKey) {
      const changed = this.updatePublicMachineStatuses(this.machineStatuses);
      if (changed && this.machinePublishRequested) {
        this.publishHealth({ machines: this.machineStatuses });
      }
      this.machinePublishRequested = false;
      return;
    }

    const machines = this.options.currentMachines();
    const refreshKey = this.machineInputKey();
    this.machineRefresh = this.options
      .machineStatusResolver(machines, this.options.bindHost)
      .then((next) => {
        if (refreshKey !== this.machineInputKey()) return;
        const changed = this.updatePublicMachineStatuses(next);
        this.machineStatusKey = refreshKey;
        if (changed && this.machinePublishRequested) {
          this.publishHealth({ machines: this.machineStatuses });
        }
        this.machinePublishRequested = false;
      })
      .finally(() => {
        this.machineRefresh = null;
      });
    await this.machineRefresh;
    if (this.machineStatusKey !== this.machineInputKey()) {
      await this.refreshMachineStatuses(publish);
    }
  };

  readonly refreshStreamStatuses = async (
    publish = true,
    force = false,
  ): Promise<void> => {
    this.streamPublishRequested ||= publish;
    if (this.streamRefresh) {
      await this.streamRefresh;
      if (this.streamStatusKey !== this.streamInputKey()) {
        await this.refreshStreamStatuses(publish);
      }
      return;
    }
    const expectedKey = this.streamInputKey();
    if (!force && this.streamStatusKey === expectedKey) {
      this.streamPublishRequested = false;
      return;
    }

    const machines = this.options.currentMachines();
    const refreshKey = this.streamInputKey();
    this.streamRefresh = (async () => {
      const next = await this.options.streamStatusResolver(
        machines,
        this.options.bindHost,
        this.options.streamRequests,
      );
      if (refreshKey !== this.streamInputKey()) return;
      const changed = !samePublicHealth(this.streamStatuses, next);
      this.streamStatuses = next;
      this.streamStatusKey = refreshKey;
      if (changed && this.streamPublishRequested) {
        this.publishHealth({ streams: this.streamStatuses });
      }
      this.streamPublishRequested = false;
    })().finally(() => {
      this.streamRefresh = null;
    });
    await this.streamRefresh;
    if (this.streamStatusKey !== this.streamInputKey()) {
      await this.refreshStreamStatuses(publish);
    }
  };

  getMachineStatuses = (): MachineStatus[] => this.machineStatuses;

  getStreamStatuses = (): StreamStatus[] => this.streamStatuses;

  markStreamMutation = (): void => {
    this.streamMutationRevision += 1;
  };

  refreshInBackground = (
    kind: "machines" | "streams",
    refresh: () => Promise<void>,
  ): void => {
    void refresh().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`wmux: ${kind} health refresh failed: ${detail}`);
    });
  };

  addEventSocket(ws: WebSocket): void {
    this.eventSockets.add(ws);
    ws.on("close", () => {
      this.eventSockets.delete(ws);
    });
    this.sendEventMessage(ws, { type: "ready" });
  }

  dispose(): void {
    clearInterval(this.machineHealthTimer);
    clearInterval(this.streamHealthTimer);
    this.options.state.off("change", this.onStateChange);
    this.options.settings.off("change", this.onSettingsChange);
    this.options.state.off("notification", this.onNotification);
    this.options.state.off("media", this.onMedia);
    this.options.state.off("clipboard", this.onClipboard);
  }

  private machineCatalogFingerprint(): string {
    return JSON.stringify(
      this.options.currentMachines().map(({
        registeredAt: _registeredAt,
        lastSeenAt: _lastSeenAt,
        expiresAt: _expiresAt,
        ...machine
      }) => machine),
    );
  }

  private streamCatalogFingerprint(): string {
    return JSON.stringify(
      this.options.currentMachines().map((machine) => ({
        id: machine.id,
        host: machine.host,
        stream: machine.stream,
      })),
    );
  }

  private machineInputKey(): string {
    return this.machineCatalogFingerprint();
  }

  private streamInputKey(): string {
    return `${this.streamMutationRevision}:${this.streamCatalogFingerprint()}`;
  }

  private currentMachineStatuses(
    statuses = this.machineStatuses,
  ): MachineStatus[] {
    const latest = new Map(
      this.options.currentMachines().map((machine) => [machine.id, machine]),
    );
    return statuses.map((status) => {
      const machine = latest.get(status.id);
      if (!machine) return status;
      return {
        ...status,
        source: machine.source,
        registeredAt: machine.registeredAt,
        lastSeenAt: machine.lastSeenAt,
        expiresAt: machine.expiresAt,
        online: machine.online,
      };
    });
  }

  private updatePublicMachineStatuses(next: MachineStatus[]): boolean {
    const publicNext = this.currentMachineStatuses(next);
    const changed = !samePublicHealth(this.machineStatuses, publicNext);
    this.machineStatuses = publicNext;
    return changed;
  }

  private sendEventMessage(ws: WebSocket, message: EventServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  private broadcastEventMessage(message: EventServerMessage): void {
    if (this.eventSockets.size === 0) return;
    const serialized = JSON.stringify(message);
    for (const ws of this.eventSockets) {
      if (ws.readyState === ws.OPEN) ws.send(serialized);
    }
  }

  private broadcastSnapshot(reason: string): void {
    if (this.eventSockets.size === 0) return;
    const snapshot = this.currentPayload();
    this.broadcastEventMessage({
      type: "snapshot",
      reason,
      revision: snapshot.revision,
      state: snapshot,
    });
  }

  private publishHealth(
    delta: { machines?: MachineStatus[]; streams?: StreamStatus[] },
  ): void {
    this.healthEpoch = nextHealthEpoch(this.healthEpoch);
    this.broadcastEventMessage({
      type: "health",
      revision: this.options.state.snapshot().revision,
      healthEpoch: this.healthEpoch,
      ...delta,
    });
  }

  private readonly onStateChange = (): void => {
    this.broadcastSnapshot("state");
  };

  private readonly onSettingsChange = (): void => {
    this.broadcastSnapshot("settings");
  };

  private readonly onNotification = (
    notification: TerminalNotification,
  ): void => {
    this.broadcastEventMessage({ type: "notification", notification });
  };

  private readonly onMedia = (media: TerminalMedia): void => {
    this.broadcastEventMessage({ type: "media", media });
  };

  private readonly onClipboard = (clipboard: TerminalClipboard): void => {
    this.broadcastEventMessage({ type: "clipboard", clipboard });
  };
}
