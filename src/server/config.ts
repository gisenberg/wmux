import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { localMachine } from "./machines.js";
import type { MachineConfig } from "./types.js";

const machineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["local", "ssh", "powershell", "powershell-ssh", "service"]),
  host: z.string().optional(),
  user: z.string().optional(),
  port: z.number().int().positive().optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  command: z.array(z.string()).min(1).optional(),
  sessionBackend: z.enum(["auto", "pty", "tmux", "screen"]).optional(),
});

const configSchema = z.object({
  machines: z.array(machineSchema).optional(),
});

export interface AppConfig {
  machines: MachineConfig[];
}

const candidates = (): string[] => [
  path.resolve(process.cwd(), "wmux.config.json"),
  path.join(os.homedir(), ".wmux", "config.json"),
];

export const loadConfig = (): AppConfig => {
  for (const candidate of candidates()) {
    if (!fs.existsSync(candidate)) continue;
    const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
    const parsed = configSchema.parse(raw);
    const machines = parsed.machines ?? [];
    const hasLocal = machines.some((machine) => machine.id === "local");
    return { machines: hasLocal ? machines : [localMachine(), ...machines] };
  }
  return { machines: [localMachine()] };
};
