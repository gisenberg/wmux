import { spawn } from "node:child_process";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  captureOutput?: boolean;
  maxOutputBytes?: number;
}

export const runCommand = (
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> =>
  new Promise((resolve) => {
    const captureOutput = options.captureOutput !== false;
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    const child = spawn(command, args, {
      stdio: ["ignore", captureOutput ? "pipe" : "ignore", captureOutput ? "pipe" : "ignore"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: Buffer): string =>
      current.length >= maxOutputBytes ? current : `${current}${chunk.toString("utf8")}`.slice(0, maxOutputBytes);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    };
    child.on("error", () => finish(null));
    child.on("close", (status) => finish(status));
    timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    timer?.unref();
  });
