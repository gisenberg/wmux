import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  isKeybindingAction,
  parseKeyChord,
  resolveKeybindings,
  validateKeybindingMap,
  type KeybindingMap,
  type KeybindingOverrides,
} from "../shared/keybindings.js";
import {
  DEFAULT_DELEGATION_NOTIFICATION_BUDGET_SECONDS,
  DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS,
  MAX_DELEGATION_NOTIFICATION_BUDGET_SECONDS,
  MAX_DELEGATION_WAIT_TIMEOUT_SECONDS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_DELEGATION_NOTIFICATION_BUDGET_SECONDS,
  MIN_DELEGATION_WAIT_TIMEOUT_SECONDS,
  MIN_TERMINAL_FONT_SIZE,
  type DelegationConfig,
  type DelegationMode,
} from "../shared/protocol.js";
import { localMachine } from "./machines.js";
import {
  normalizeSessionAgentOrigin,
  sessionAgentOriginForEndpoint,
} from "./session-agent-origin.js";
import type { MachineConfig } from "./types.js";

const streamSchema = z.object({
  provider: z.enum(["mediamtx", "moonlight-gateway"]).optional(),
  gatewayUrl: z.string().url().optional(),
  gatewayOpenUrl: z.string().url().optional(),
  gatewayToken: z.string().optional(),
});

// ids and names end up in generated shell scripts, tmux session names, URLs,
// and filesystem paths, so they are constrained at load time instead of
// trusting every embedding site to quote them.
export const machineIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "machine id must be alphanumeric with - or _ (max 64 chars)");
export const machineNameSchema = z
  .string()
  .min(1)
  .max(80)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f\x7f'"`$\\]+$/, "machine name must not contain control characters or shell metacharacters");
const hostSchema = z
  .string()
  .regex(/^[A-Za-z0-9.:_-]+$/, "host must be a hostname or IP address")
  .optional();
export const userSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, "user must be a plain account name")
  .optional();

export const machineSchema = z.object({
  id: machineIdSchema,
  name: machineNameSchema,
  kind: z.enum(["local", "ssh", "powershell", "powershell-ssh", "service"]),
  platform: z.enum(["linux", "mac", "win"]).optional(),
  host: hostSchema,
  user: userSchema,
  port: z.number().int().positive().optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  command: z.array(z.string()).min(1).optional(),
  sessionBackend: z.enum(["auto", "pty", "tmux", "screen", "agent"]).optional(),
  loadPowerShellProfile: z.boolean().optional(),
  agentUrl: z.string().url().optional(),
  agentPort: z.number().int().min(1).max(65527, "agentPort must leave eight adjacent rollout ports").optional(),
  agentToken: z.string().optional(),
  stream: streamSchema.optional(),
}).superRefine((machine, context) => {
  if (machine.loadPowerShellProfile !== undefined && machine.kind !== "powershell-ssh") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["loadPowerShellProfile"],
      message: "loadPowerShellProfile is only valid for powershell-ssh machines",
    });
  }
  if (
    machine.sessionBackend === "agent"
    && !["local", "ssh", "powershell-ssh"].includes(machine.kind)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sessionBackend"],
      message: "agent is only valid for local, ssh, and powershell-ssh machines",
    });
  }
  if (machine.sessionBackend === "agent") {
    const parsedAgentUrl = machine.agentUrl
      ? normalizeSessionAgentOrigin(machine.agentUrl)
      : undefined;
    if (machine.agentUrl && !parsedAgentUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agentUrl"],
        message: "agentUrl must be a private/internal HTTP IPv4 origin with an explicit port and no credentials, path, query, or fragment",
      });
    }
    if (!sessionAgentOriginForEndpoint(machine)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [machine.agentUrl ? "agentUrl" : "host"],
        message: machine.host && !machine.agentUrl
          ? "session-agent hosts addressed by DNS require agentUrl with an explicit private/internal IPv4 address"
          : "session-agent endpoint must use an explicit private/internal IPv4 address",
      });
    }
    if (parsedAgentUrl && machine.agentPort !== undefined
      && Number(new URL(parsedAgentUrl).port) !== machine.agentPort) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agentPort"],
        message: "agentPort must match the explicit port in agentUrl",
      });
    }
  }
});

const keybindingOverridesSchema = z.record(z.array(z.string().min(1).max(80)).max(16)).superRefine((bindings, context) => {
  for (const [action, chords] of Object.entries(bindings)) {
    if (!isKeybindingAction(action)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [action],
        message: `unknown keybinding action ${JSON.stringify(action)}`,
      });
      continue;
    }
    for (const [index, chord] of chords.entries()) {
      try {
        parseKeyChord(chord);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [action, index],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
});

const delegationWaitTimeoutSchema = z.number()
  .finite()
  .min(MIN_DELEGATION_WAIT_TIMEOUT_SECONDS)
  .max(MAX_DELEGATION_WAIT_TIMEOUT_SECONDS);
const delegationNotificationBudgetSchema = z.number()
  .finite()
  .min(MIN_DELEGATION_NOTIFICATION_BUDGET_SECONDS)
  .max(MAX_DELEGATION_NOTIFICATION_BUDGET_SECONDS);

const delegationSchema = z.object({
  preferHeadless: z.boolean().optional(),
  waitTimeoutSeconds: z.object({
    review: delegationWaitTimeoutSchema.optional(),
    change: delegationWaitTimeoutSchema.optional(),
    deploy: delegationWaitTimeoutSchema.optional(),
  }).strict().optional(),
  notificationBudgetSeconds: z.object({
    running: delegationNotificationBudgetSchema.optional(),
    waiting: delegationNotificationBudgetSchema.optional(),
  }).strict().optional(),
}).strict();

export const configSchema = z.object({
  machines: z.array(machineSchema).optional(),
  // Container deployments may not want to expose a shell inside the wmux container.
  localMachine: z.boolean().optional(),
  // Written by the browser machine editor so its catalog survives checkout-local config precedence.
  managedMachineCatalog: z.literal(true).optional(),
  keybindings: keybindingOverridesSchema.optional(),
  terminalFontFamily: z.string().trim().min(1).max(256)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00-\x1f\x7f]+$/, "terminal font family must not contain control characters")
    .optional(),
  terminalFontSize: z.number().int().min(MIN_TERMINAL_FONT_SIZE).max(MAX_TERMINAL_FONT_SIZE).optional(),
  shellCommandTracking: z.boolean().optional(),
  delegation: delegationSchema.optional(),
}).superRefine((config, context) => {
  const overrides = config.keybindings as KeybindingOverrides | undefined;
  const errors = validateKeybindingMap(resolveKeybindings(overrides));
  for (const message of errors) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["keybindings"], message });
  }
});

export interface AppConfig {
  machines: MachineConfig[];
  keybindings: KeybindingMap;
  terminalFontFamily?: string;
  terminalFontSize?: number;
  shellCommandTracking: boolean;
  delegation: DelegationConfig;
}

const resolveDelegationConfig = (
  configured?: Partial<Record<DelegationMode, number>>,
  preferHeadless = false,
  notificationBudgets?: Partial<DelegationConfig["notificationBudgetSeconds"]>,
): DelegationConfig => ({
  preferHeadless,
  waitTimeoutSeconds: {
    ...DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS,
    ...configured,
  },
  notificationBudgetSeconds: {
    ...DEFAULT_DELEGATION_NOTIFICATION_BUDGET_SECONDS,
    ...notificationBudgets,
  },
  waitTimeoutBoundsSeconds: {
    min: MIN_DELEGATION_WAIT_TIMEOUT_SECONDS,
    max: MAX_DELEGATION_WAIT_TIMEOUT_SECONDS,
  },
});

const candidates = (): string[] => process.env.WMUX_CONFIG_PATH
  ? [path.resolve(process.env.WMUX_CONFIG_PATH)]
  : [path.resolve(process.cwd(), "wmux.config.json"), path.join(os.homedir(), ".wmux", "config.json")];

export const loadConfig = (): AppConfig => {
  for (const candidate of candidates()) {
    if (!fs.existsSync(candidate)) continue;
    let raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
    if (!process.env.WMUX_CONFIG_PATH) {
      const managedPath = path.join(os.homedir(), ".wmux", "config.json");
      if (candidate !== managedPath && fs.existsSync(managedPath)) {
        const managedRaw = JSON.parse(
          fs.readFileSync(managedPath, "utf8"),
        ) as Record<string, unknown>;
        if (managedRaw.managedMachineCatalog === true) {
          const managed = configSchema.parse(managedRaw);
          raw = {
            ...raw,
            machines: managed.machines,
            localMachine: managed.localMachine,
          };
        }
      }
    }
    const parsed = configSchema.parse(raw);
    const machines = parsed.machines ?? [];
    const keybindings = resolveKeybindings(parsed.keybindings as KeybindingOverrides | undefined);
    const hasLocal = machines.some((machine) => machine.id === "local");
    const configuredMachines = hasLocal || parsed.localMachine === false ? machines : [localMachine(), ...machines];
    return {
      machines: configuredMachines,
      keybindings,
      terminalFontFamily: parsed.terminalFontFamily,
      terminalFontSize: parsed.terminalFontSize,
      shellCommandTracking: parsed.shellCommandTracking ?? false,
      delegation: resolveDelegationConfig(
        parsed.delegation?.waitTimeoutSeconds,
        parsed.delegation?.preferHeadless,
        parsed.delegation?.notificationBudgetSeconds,
      ),
    };
  }
  if (process.env.WMUX_CONFIG_PATH) {
    throw new Error(`WMUX_CONFIG_PATH does not exist: ${path.resolve(process.env.WMUX_CONFIG_PATH)}`);
  }
  return {
    machines: [localMachine()],
    keybindings: resolveKeybindings(),
    shellCommandTracking: false,
    delegation: resolveDelegationConfig(),
  };
};
