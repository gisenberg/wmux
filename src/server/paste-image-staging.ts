import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineConfig } from "./types.js";
import { sshControlOnlyArgs, sshControlPath } from "./ssh-control.js";
import {
  deleteWindowsAgentPasteImage,
  stageWindowsAgentPasteImage,
  WindowsAgentPasteImageUnsupportedError,
} from "./windows-agent.js";

export const MAX_PASTE_IMAGE_BYTES = 8 * 1024 * 1024;
export const PASTE_IMAGE_TTL_MS = 60 * 60 * 1000;

export interface ValidatedPasteImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  extension: "png" | "jpg" | "webp" | "gif";
}

export interface StagedPasteImage extends ValidatedPasteImage {
  stageId: string;
  targetPath: string;
  bytes: number;
  expiresAt: string;
}

export class PasteImageStageError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export const validatePasteImage = (data: Buffer): ValidatedPasteImage => {
  if (data.length === 0) throw new PasteImageStageError(400, "paste_image_empty");
  if (data.length > MAX_PASTE_IMAGE_BYTES) throw new PasteImageStageError(413, "paste_image_too_large");
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (data.length >= 6 && (data.toString("ascii", 0, 6) === "GIF87a" || data.toString("ascii", 0, 6) === "GIF89a")) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  throw new PasteImageStageError(415, "paste_image_unsupported_type");
};

interface StageRecord extends StagedPasteImage {
  paneId: string;
  machine: MachineConfig;
  adapter: "local" | "ssh" | "powershell-ssh" | "windows-agent";
}

export interface PasteImageStager {
  stage(paneId: string, machine: MachineConfig, data: Buffer): Promise<StagedPasteImage>;
  discard(paneId: string, stageId: string): Promise<boolean>;
  cleanupPane(paneId: string, machine: MachineConfig): Promise<void>;
  dispose(): void;
}

export class PasteImageStaging implements PasteImageStager {
  private readonly records = new Map<string, StageRecord>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly root: string;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(root = pasteImageRoot()) {
    this.root = root;
    this.sweepLocalFiles();
    this.sweepTimer = setInterval(() => void this.sweep(), 10 * 60 * 1000);
    this.sweepTimer.unref?.();
  }

  async stage(paneId: string, machine: MachineConfig, data: Buffer): Promise<StagedPasteImage> {
    if (this.inFlight.has(paneId)) throw new PasteImageStageError(429, "paste_image_stage_busy");
    const validated = validatePasteImage(data);
    const stageId = `paste-${crypto.randomBytes(18).toString("hex")}`;
    const expiresAt = new Date(Date.now() + PASTE_IMAGE_TTL_MS).toISOString();
    let finishInFlight!: () => void;
    this.inFlight.set(paneId, new Promise((resolve) => { finishInFlight = resolve; }));
    try {
      let targetPath: string;
      let adapter: StageRecord["adapter"];
      if (machine.command?.length || machine.kind === "service" || machine.kind === "powershell") {
        throw new PasteImageStageError(422, "paste_image_target_unsupported");
      }
      if (machine.kind === "local") {
        adapter = "local";
        targetPath = await this.stageLocal(paneId, stageId, validated.extension, data);
      } else if (machine.kind === "ssh") {
        adapter = "ssh";
        targetPath = await stageSshImage(machine, paneId, stageId, validated.extension, data, false);
      } else if (machine.kind === "powershell-ssh" && machine.sessionBackend === "agent") {
        adapter = "windows-agent";
        targetPath = await stageWindowsAgentPasteImage(machine, paneId, stageId, validated.extension, data);
      } else if (machine.kind === "powershell-ssh") {
        adapter = "powershell-ssh";
        targetPath = await stageSshImage(machine, paneId, stageId, validated.extension, data, true);
      } else {
        throw new PasteImageStageError(422, "paste_image_target_unsupported");
      }
      try {
        validateTargetPath(targetPath, adapter);
      } catch (error) {
        await discardStagedTarget({ paneId, stageId, targetPath, extension: validated.extension, machine, adapter })
          .catch(() => undefined);
        throw error;
      }
      const result: StageRecord = {
        stageId,
        paneId,
        targetPath,
        mimeType: validated.mimeType,
        extension: validated.extension,
        bytes: data.length,
        expiresAt,
        machine: structuredClone(machine),
        adapter,
      };
      this.records.set(stageId, result);
      return publicStage(result);
    } catch (error) {
      if (error instanceof PasteImageStageError) throw error;
      if (error instanceof WindowsAgentPasteImageUnsupportedError) {
        throw new PasteImageStageError(422, "paste_image_target_unsupported");
      }
      throw new PasteImageStageError(502, "paste_image_stage_failed");
    } finally {
      this.inFlight.delete(paneId);
      finishInFlight();
    }
  }

  async discard(paneId: string, stageId: string): Promise<boolean> {
    const record = this.records.get(stageId);
    if (!record || record.paneId !== paneId) return false;
    this.records.delete(stageId);
    await discardRecord(record);
    return true;
  }

  async cleanupPane(paneId: string, machine: MachineConfig): Promise<void> {
    await this.inFlight.get(paneId);
    const records = [...this.records.values()].filter((record) => record.paneId === paneId);
    for (const record of records) {
      this.records.delete(record.stageId);
      await discardRecord(record).catch(() => undefined);
    }
    if (machine.kind === "ssh" || (machine.kind === "powershell-ssh" && machine.sessionBackend !== "agent")) {
      closeSshControl(machine, paneId);
    }
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
  }

  private async stageLocal(paneId: string, stageId: string, extension: string, data: Buffer): Promise<string> {
    await ensurePrivateDirectory(this.root);
    const paneDir = path.join(this.root, crypto.createHash("sha256").update(paneId).digest("hex").slice(0, 24));
    await ensurePrivateDirectory(paneDir);
    const targetPath = path.join(paneDir, `${stageId}.${extension}`);
    const handle = await fs.promises.open(targetPath, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
      await handle.chmod(0o600);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.promises.rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return targetPath;
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const record of [...this.records.values()]) {
      if (Date.parse(record.expiresAt) > now) continue;
      this.records.delete(record.stageId);
      await discardRecord(record).catch(() => undefined);
    }
    this.sweepLocalFiles();
  }

  private sweepLocalFiles(): void {
    if (!fs.existsSync(this.root)) return;
    const cutoff = Date.now() - PASTE_IMAGE_TTL_MS;
    for (const directory of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[0-9a-f]{24}$/.test(directory.name)) continue;
      const directoryPath = path.join(this.root, directory.name);
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(directoryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !/^paste-[0-9a-f]{36}\.(?:png|jpg|webp|gif)$/.test(file.name)) continue;
        const filePath = path.join(directoryPath, file.name);
        try {
          if (fs.statSync(filePath).mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
        } catch {
          // Opportunistic cleanup retries on the next sweep.
        }
      }
      try {
        if (fs.readdirSync(directoryPath).length === 0) fs.rmdirSync(directoryPath);
      } catch {
        // The directory may have changed concurrently.
      }
    }
  }
}

const pasteImageRoot = (): string => {
  if (process.env.WMUX_PASTE_IMAGE_DIR) return path.resolve(process.env.WMUX_PASTE_IMAGE_DIR);
  const base = process.env.XDG_RUNTIME_DIR?.startsWith("/")
    ? process.env.XDG_RUNTIME_DIR
    : path.join(os.homedir(), ".wmux", "run");
  return path.join(base, "wmux", "paste-images");
};

const publicStage = (record: StageRecord): StagedPasteImage => ({
  stageId: record.stageId,
  targetPath: record.targetPath,
  mimeType: record.mimeType,
  extension: record.extension,
  bytes: record.bytes,
  expiresAt: record.expiresAt,
});

const validateTargetPath = (targetPath: string, adapter: StageRecord["adapter"]): void => {
  if (!targetPath || targetPath.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(targetPath)) {
    throw new Error("invalid staged path");
  }
  const absolute = adapter === "local"
    ? path.isAbsolute(targetPath)
    : adapter === "powershell-ssh" || adapter === "windows-agent"
      ? /^[A-Za-z]:[\\/]/.test(targetPath)
      : targetPath.startsWith("/");
  if (!absolute) {
    throw new Error("staged path is not absolute");
  }
};

const sshTarget = (machine: MachineConfig): string => {
  if (!machine.host) throw new Error("missing SSH host");
  return machine.user ? `${machine.user}@${machine.host}` : machine.host;
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export const posixPasteImageStageScript = (stageId: string, extension: string): string => {
  assertStageComponents(stageId, extension);
  return `set -eu
umask 077
wmux_base="\${XDG_RUNTIME_DIR:-\${TMPDIR:-$HOME/.cache}}/wmux/paste-images"
mkdir -p "$wmux_base"
chmod 700 "$wmux_base" 2>/dev/null || true
find "$wmux_base" -type f -mmin +60 -exec rm -f {} \\; 2>/dev/null || true
wmux_path="$wmux_base/${stageId}.${extension}"
set -C
cat > "$wmux_path"
chmod 600 "$wmux_path"
printf '%s' "$wmux_path"
`;
};

export const powershellPasteImageStageScript = (stageId: string, extension: string): string => {
  assertStageComponents(stageId, extension);
  return `
$ErrorActionPreference='Stop'
$Root=Join-Path $env:LOCALAPPDATA 'wmux\\paste-images'
[IO.Directory]::CreateDirectory($Root) | Out-Null
Get-ChildItem -LiteralPath $Root -File -ErrorAction SilentlyContinue | Where-Object LastWriteTimeUtc -lt ([DateTime]::UtcNow.AddHours(-1)) | Remove-Item -Force -ErrorAction SilentlyContinue
$Path=Join-Path $Root '${stageId}.${extension}'
$Input=[Console]::OpenStandardInput()
$File=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $Input.CopyTo($File) } finally { $File.Dispose() }
[Console]::Out.Write($Path)
`;
};

const stageSshImage = async (
  machine: MachineConfig,
  paneId: string,
  stageId: string,
  extension: string,
  data: Buffer,
  powershell: boolean,
): Promise<string> => {
  await requireSshControl(machine, paneId);
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...sshControlOnlyArgs(paneId)];
  if (machine.port) args.push("-p", String(machine.port));
  args.push(sshTarget(machine));
  if (powershell) {
    args.push(machine.shell ?? "pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(powershellPasteImageStageScript(stageId, extension), "utf16le").toString("base64"));
  } else {
    args.push(`exec /bin/sh -c ${shellQuote(posixPasteImageStageScript(stageId, extension))}`);
  }
  return runBinarySsh(args, data);
};

export const runBinarySsh = (args: string[], data: Buffer): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(Buffer.concat(chunks).toString("utf8").trim());
  };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    finish(new Error("SSH image staging timed out"));
  }, 20_000);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 8192) {
      child.kill("SIGTERM");
      finish(new Error("SSH image staging returned too much data"));
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  child.once("error", (error) => finish(error));
  child.once("close", (code) => finish(code === 0 ? undefined : new Error("SSH image staging failed")));
  child.stdin.once("error", (error) => finish(error));
  child.stdin.end(data);
});

interface StagedTargetIdentity {
  paneId: string;
  stageId: string;
  targetPath: string;
  extension: string;
  machine: MachineConfig;
  adapter: StageRecord["adapter"];
}

const discardRecord = async (record: StageRecord): Promise<void> => discardStagedTarget(record);

const discardStagedTarget = async (record: StagedTargetIdentity): Promise<void> => {
  if (record.adapter === "local") {
    fs.rmSync(record.targetPath, { force: true });
    return;
  }
  if (record.adapter === "windows-agent") {
    await deleteWindowsAgentPasteImage(record.machine, record.paneId, record.stageId);
    return;
  }
  await requireSshControl(record.machine, record.paneId, 1000);
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", ...sshControlOnlyArgs(record.paneId)];
  if (record.machine.port) args.push("-p", String(record.machine.port));
  args.push(sshTarget(record.machine));
  if (record.adapter === "powershell-ssh") {
    args.push(
      record.machine.shell ?? "pwsh",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(powershellPasteImageDeleteScript(record.stageId, record.extension), "utf16le").toString("base64"),
    );
  } else {
    args.push(`exec /bin/sh -c ${shellQuote(posixPasteImageDeleteScript(record.stageId, record.extension))}`);
  }
  await runBinarySsh(args, Buffer.alloc(0));
};

export const posixPasteImageDeleteScript = (stageId: string, extension: string): string => {
  assertStageComponents(stageId, extension);
  return `set -eu
wmux_base="\${XDG_RUNTIME_DIR:-\${TMPDIR:-$HOME/.cache}}/wmux/paste-images"
rm -f "$wmux_base/${stageId}.${extension}"
`;
};

export const powershellPasteImageDeleteScript = (stageId: string, extension: string): string => {
  assertStageComponents(stageId, extension);
  return `
$ErrorActionPreference='Stop'
$Root=Join-Path $env:LOCALAPPDATA 'wmux\\paste-images'
$Path=Join-Path $Root '${stageId}.${extension}'
Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
`;
};

const requireSshControl = async (machine: MachineConfig, paneId: string, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await checkSshControl(machine, paneId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("pane SSH control connection is unavailable");
};

const checkSshControl = (machine: MachineConfig, paneId: string): Promise<boolean> => new Promise((resolve) => {
  const args = ["-S", sshControlPath(paneId), "-O", "check"];
  if (machine.port) args.push("-p", String(machine.port));
  args.push(sshTarget(machine));
  const child = spawn("ssh", args, { stdio: "ignore" });
  let settled = false;
  const finish = (result: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    finish(false);
  }, 750);
  child.once("error", () => finish(false));
  child.once("close", (code) => finish(code === 0));
});

const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("paste image directory is not private");
  await fs.promises.chmod(directory, 0o700);
};

const assertStageComponents = (stageId: string, extension: string): void => {
  if (!/^paste-[0-9a-f]{36}$/.test(stageId) || !/^(?:png|jpg|webp|gif)$/.test(extension)) {
    throw new Error("invalid paste image stage identity");
  }
};

const closeSshControl = (machine: MachineConfig, paneId: string): void => {
  const controlPath = sshControlPath(paneId);
  const args = ["-S", controlPath, "-O", "exit"];
  if (machine.port) args.push("-p", String(machine.port));
  args.push(sshTarget(machine));
  const child = spawn("ssh", args, { stdio: "ignore" });
  child.once("error", () => fs.rmSync(controlPath, { force: true }));
  child.once("close", () => fs.rmSync(controlPath, { force: true }));
};
