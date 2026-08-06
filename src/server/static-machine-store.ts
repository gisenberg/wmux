import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configSchema, machineSchema } from "./config.js";
import { sessionAgentOriginForEndpoint } from "./session-agent-origin.js";
import type { MachineConfig } from "./types.js";

const defaultPath = (): string => path.join(os.homedir(), ".wmux", "config.json");

const editableKeys = new Set([
  "id",
  "name",
  "kind",
  "platform",
  "host",
  "user",
  "port",
  "shell",
  "cwd",
  "command",
  "sessionBackend",
  "loadPowerShellProfile",
  "agentUrl",
  "agentPort",
  "stream",
]);
const editableStreamKeys = new Set(["provider", "gatewayUrl", "gatewayOpenUrl"]);

export class StaticMachineStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class StaticMachineStore extends EventEmitter {
  private machines: MachineConfig[];
  private baseConfig: Record<string, unknown>;

  constructor(
    initialMachines: MachineConfig[],
    private readonly filePath: string = process.env.WMUX_MANAGED_CONFIG_PATH ?? defaultPath(),
  ) {
    super();
    this.machines = initialMachines.map(cleanStaticMachine);
    this.baseConfig = this.loadBaseConfig();
  }

  snapshot(): MachineConfig[] {
    return structuredClone(this.machines);
  }

  publicSnapshot(): ManagedStaticMachine[] {
    return this.machines.map(publicMachine);
  }

  create(input: unknown): MachineConfig {
    const machine = parseEditableMachine(input);
    if (this.machines.some((candidate) => candidate.id === machine.id)) {
      throw new StaticMachineStoreError(409, "machine_id_exists");
    }
    this.replace([...this.machines, machine]);
    return structuredClone(machine);
  }

  update(id: string, input: unknown): MachineConfig {
    const index = this.machines.findIndex((machine) => machine.id === id);
    if (index < 0) throw new StaticMachineStoreError(404, "unknown_static_machine");
    const existing = this.machines[index];
    const parsed = parseEditableMachine(input);
    if (parsed.id !== id) throw new StaticMachineStoreError(409, "machine_id_immutable");
    if (
      existing.agentToken
      && sessionAgentOriginForEndpoint(existing) !== sessionAgentOriginForEndpoint(parsed)
    ) {
      throw new StaticMachineStoreError(409, "agent_endpoint_immutable_with_token");
    }
    const machine: MachineConfig = {
      ...parsed,
      agentToken: existing.agentToken,
      stream: parsed.stream
        ? {
            ...parsed.stream,
            gatewayToken: existing.stream?.gatewayToken,
          }
        : undefined,
    };
    const next = [...this.machines];
    next[index] = machine;
    this.replace(next);
    return structuredClone(machine);
  }

  delete(id: string): boolean {
    const next = this.machines.filter((machine) => machine.id !== id);
    if (next.length === this.machines.length) return false;
    this.replace(next);
    return true;
  }

  private replace(machines: MachineConfig[]): void {
    const parsed = configSchema.safeParse({
      ...this.baseConfig,
      managedMachineCatalog: true,
      machines,
      localMachine: false,
    });
    if (!parsed.success) throw new StaticMachineStoreError(400, "invalid_machine");
    this.machines = machines.map(cleanStaticMachine);
    this.persist();
    this.emit("change", this.snapshot());
  }

  private loadBaseConfig(): Record<string, unknown> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const input = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("managed config must be a JSON object");
      }
      const parsed = configSchema.safeParse(input);
      if (!parsed.success) throw new Error("managed config failed validation");
      const { machines: _machines, localMachine: _localMachine, ...rest } =
        input as Record<string, unknown>;
      return rest;
    } catch (error) {
      throw new Error(
        `wmux managed config is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    const directoryExists = fs.existsSync(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!directoryExists) fs.chmodSync(directory, 0o700);
    const temporary = `${this.filePath}.tmp`;
    const backup = `${this.filePath}.bak`;
    const payload = {
      ...this.baseConfig,
      managedMachineCatalog: true,
      localMachine: false,
      machines: this.machines,
    };
    configSchema.parse(payload);
    try {
      const handle = fs.openSync(temporary, "w", 0o600);
      try {
        fs.writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.chmodSync(temporary, 0o600);
      if (fs.existsSync(this.filePath)) {
        const current = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
        configSchema.parse(current);
        fs.copyFileSync(this.filePath, backup);
        fs.chmodSync(backup, 0o600);
      }
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
}

export interface ManagedStaticMachine extends Omit<
  MachineConfig,
  "agentToken" | "stream" | "source" | "registeredAt" | "lastSeenAt" | "expiresAt" | "online"
> {
  stream?: Omit<NonNullable<MachineConfig["stream"]>, "gatewayToken">;
  hasAgentToken: boolean;
  hasGatewayToken: boolean;
}

const publicMachine = (machine: MachineConfig): ManagedStaticMachine => {
  const {
    agentToken,
    source: _source,
    registeredAt: _registeredAt,
    lastSeenAt: _lastSeenAt,
    expiresAt: _expiresAt,
    online: _online,
    stream,
    ...safe
  } = machine;
  const { gatewayToken, ...publicStream } = stream ?? {};
  return {
    ...structuredClone(safe),
    stream: stream ? structuredClone(publicStream) : undefined,
    hasAgentToken: Boolean(agentToken),
    hasGatewayToken: Boolean(gatewayToken),
  };
};

const cleanStaticMachine = (machine: MachineConfig): MachineConfig => {
  const {
    source: _source,
    registeredAt: _registeredAt,
    lastSeenAt: _lastSeenAt,
    expiresAt: _expiresAt,
    online: _online,
    ...staticMachine
  } = machine;
  return structuredClone(staticMachine);
};

const parseEditableMachine = (input: unknown): MachineConfig => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StaticMachineStoreError(400, "invalid_machine");
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !editableKeys.has(key))) {
    throw new StaticMachineStoreError(400, "unsupported_machine_field");
  }
  if (record.stream !== undefined) {
    if (!record.stream || typeof record.stream !== "object" || Array.isArray(record.stream)) {
      throw new StaticMachineStoreError(400, "invalid_machine");
    }
    if (Object.keys(record.stream as Record<string, unknown>).some((key) => !editableStreamKeys.has(key))) {
      throw new StaticMachineStoreError(400, "unsupported_machine_field");
    }
  }
  const parsed = machineSchema.safeParse(record);
  if (!parsed.success) throw new StaticMachineStoreError(400, "invalid_machine");
  return parsed.data;
};
