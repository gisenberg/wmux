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
import { localMachine } from "./machines.js";
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

export const configSchema = z.object({
  machines: z.array(machineSchema).optional(),
  // Container deployments may not want to expose a shell inside the wmux container.
  localMachine: z.boolean().optional(),
  keybindings: keybindingOverridesSchema.optional(),
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
}

const candidates = (): string[] => process.env.WMUX_CONFIG_PATH
  ? [path.resolve(process.env.WMUX_CONFIG_PATH)]
  : [path.resolve(process.cwd(), "wmux.config.json"), path.join(os.homedir(), ".wmux", "config.json")];

export const loadConfig = (): AppConfig => {
  for (const candidate of candidates()) {
    if (!fs.existsSync(candidate)) continue;
    const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
    const parsed = configSchema.parse(raw);
    const machines = parsed.machines ?? [];
    const keybindings = resolveKeybindings(parsed.keybindings as KeybindingOverrides | undefined);
    const hasLocal = machines.some((machine) => machine.id === "local");
    if (hasLocal || parsed.localMachine === false) return { machines, keybindings };
    return { machines: [localMachine(), ...machines], keybindings };
  }
  if (process.env.WMUX_CONFIG_PATH) {
    throw new Error(`WMUX_CONFIG_PATH does not exist: ${path.resolve(process.env.WMUX_CONFIG_PATH)}`);
  }
  return { machines: [localMachine()], keybindings: resolveKeybindings() };
};
