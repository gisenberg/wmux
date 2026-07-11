import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { streamPathForMachine } from "./streams.js";
import type { MachineConfig, MachineStatus, PtySpawnSpec, SessionBackend } from "./types.js";
import {
  buildWindowsHealthProbeScript,
  buildWindowsPowerShellBootstrapUrl,
  encodePowerShellCommand,
  expectedWindowsAgentVersion,
} from "./windows-helpers.js";
import { probeWindowsAgent, shouldUseWindowsAgent } from "./windows-agent.js";

const DEFAULT_TERM = "xterm-256color";
const remotePathBootstrap = (): string => `export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"`;
const WINDOWS_HEALTH_CACHE_MS = 15_000;
const POSIX_RUNTIME_VERSION = "v1";

interface WindowsHealthProbe {
  reachable: boolean;
  reason?: string;
  health?: Record<string, unknown>;
  backendDetail?: string;
}

const windowsHealthCache = new Map<string, { checkedAt: number; result: WindowsHealthProbe }>();

export const localMachine = (): MachineConfig => ({
  id: "local",
  name: os.hostname(),
  kind: "local",
  cwd: os.homedir(),
  sessionBackend: "auto",
});

export const defaultShell = (): string => {
  if (process.platform === "win32") return process.env.ComSpec ?? "powershell.exe";
  return process.env.SHELL ?? "/bin/bash";
};

/** Everything a backend needs to build a spawn spec, computed once up front. */
interface SpawnContext {
  cols: number;
  rows: number;
  extraEnv: Record<string, string>;
  env: Record<string, string>;
  /** cwd honoring WMUX_START_CWD (used by pty/durable/command transports). */
  startCwd: string;
  /** cwd ignoring WMUX_START_CWD (used by the powershell WSMan transport). */
  configuredCwd: string;
}

/**
 * A transport backend owns the per-kind behavior that used to be re-derived as
 * scattered `machine.kind === … && backend === …` branches. `resolveBackend`
 * performs the single kind/command dispatch; every call site goes through it.
 */
interface Backend {
  spawnSpec(machine: MachineConfig, ctx: SpawnContext): PtySpawnSpec;
  readCwd(machine: MachineConfig, paneId: string): string | undefined;
  canRefreshClient(machine: MachineConfig): boolean;
  refreshClient(machine: MachineConfig, paneId: string): boolean;
  dispose(machine: MachineConfig, paneId: string): void;
}

// Defaults for transports that are not restart-durable.
const nonDurableBackend = {
  readCwd: (): undefined => undefined,
  canRefreshClient: (): boolean => false,
  refreshClient: (): boolean => false,
  dispose: (): void => undefined,
};

const commandBackend: Backend = {
  ...nonDurableBackend,
  spawnSpec: (machine, { startCwd, env }) => ({
    file: machine.command![0],
    args: machine.command!.slice(1),
    cwd: startCwd,
    env,
    title: machine.name,
    trackProcessTitle: true,
  }),
};

const sshBackend: Backend = {
  spawnSpec: (machine, { cols, rows, extraEnv, env, startCwd }) => {
    const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
    if (!target) throw new Error(`Machine ${machine.id} is missing host`);
    const args = ["-t"];
    if (machine.port) args.push("-p", String(machine.port));
    args.push(target);
    const remoteEnv = {
      ...extraEnv,
      WMUX_MACHINE_ID: machine.id,
      WMUX_MACHINE_NAME: machine.name,
      COLORTERM: "truecolor",
      CLICOLOR: "1",
    };
    const sessionName = durableSessionName(extraEnv.WMUX_PANE_ID);
    const remotePathExport = remotePathBootstrap();
    const remoteCommand =
      `${remotePathExport}; ${installRemoteHelpersScript(machine)} ` +
      durableShellScript({
        backend: machine.sessionBackend ?? "auto",
        sessionName,
        cwd: startCwd,
        cols,
        rows,
        shellCommand: interactiveShellCommand(`"\${SHELL:-/bin/sh}"`, sessionName),
        extraEnv: remoteEnv,
        helperPathExport: `export PATH="$wmux_helper_dir:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH";`,
        useSystemdScope: false,
      });
    args.push(`/bin/sh -lc ${shellQuote(remoteCommand)}`);
    return { file: "ssh", args, cwd: os.homedir(), env, title: machine.name, trackProcessTitle: false };
  },
  readCwd: (machine, paneId) => durableSessionCwdImpl(machine, paneId),
  canRefreshClient: () => false,
  refreshClient: () => false,
  dispose: (machine, paneId) => disposeDurableSessionImpl(machine, paneId),
};

const powershellBackend: Backend = {
  ...nonDurableBackend,
  spawnSpec: (machine, { env, configuredCwd }) => {
    if (!machine.host) throw new Error(`Machine ${machine.id} is missing host`);
    const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Enter-PSSession -ComputerName ${JSON.stringify(machine.host)}`,
    ];
    return { file: shell, args, cwd: configuredCwd, env, title: machine.name, trackProcessTitle: true };
  },
};

const powershellSshBackend: Backend = {
  ...nonDurableBackend,
  spawnSpec: (machine, { extraEnv, env, startCwd }) => {
    if (!machine.host) throw new Error(`Machine ${machine.id} is missing host`);
    const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
    const args = ["-tt"];
    if (machine.port) args.push("-p", String(machine.port));
    const bootstrapUrl = buildWindowsPowerShellBootstrapUrl(machine, startCwd, extraEnv);
    const bootstrapCommand = `iex (irm ${powershellQuote(bootstrapUrl)})`;
    args.push(
      target,
      machine.shell ?? "pwsh",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-NoExit",
      "-EncodedCommand",
      encodePowerShellCommand(bootstrapCommand),
    );
    return { file: "ssh", args, cwd: os.homedir(), env, title: machine.name, trackProcessTitle: false };
  },
};

const serviceBackend: Backend = {
  ...nonDurableBackend,
  spawnSpec: () => {
    throw new Error("Remote wmux service machines are not implemented yet");
  },
};

const localBackend: Backend = {
  spawnSpec: (machine, { cols, rows, extraEnv, env, startCwd }) => {
    const backend = machine.sessionBackend ?? "auto";
    if (backend !== "pty") {
      const sessionName = durableSessionName(extraEnv.WMUX_PANE_ID);
      const innerScript = durableShellScript({
        backend,
        sessionName,
        cwd: startCwd,
        cols,
        rows,
        shellCommand: interactiveShellCommand(shellQuote(machine.shell ?? defaultShell()), sessionName),
        extraEnv,
        helperPathExport: `export PATH=${shellQuote(`${process.cwd()}/scripts`)}":$PATH";`,
        useSystemdScope: false,
      });
      return {
        file: "/bin/sh",
        args: [stageLocalRuntime(sessionName, innerScript)],
        cwd: startCwd,
        env,
        title: machine.name,
        trackProcessTitle: false,
      };
    }
    return {
      file: machine.shell ?? defaultShell(),
      args: [],
      cwd: startCwd,
      env,
      title: path.basename(machine.shell ?? defaultShell()),
      trackProcessTitle: true,
    };
  },
  readCwd: (machine, paneId) => durableSessionCwdImpl(machine, paneId),
  canRefreshClient: (machine) => {
    const backend = machine.sessionBackend ?? "auto";
    return !machine.command?.length && (backend === "auto" || backend === "tmux");
  },
  refreshClient: (machine, paneId) => refreshDurableSessionClientImpl(machine, paneId),
  dispose: (machine, paneId) => disposeDurableSessionImpl(machine, paneId),
};

const resolveBackend = (machine: MachineConfig): Backend => {
  if (machine.command?.length) return commandBackend;
  switch (machine.kind) {
    case "ssh":
      return sshBackend;
    case "powershell":
      return powershellBackend;
    case "powershell-ssh":
      return powershellSshBackend;
    case "service":
      return serviceBackend;
    default:
      return localBackend;
  }
};

const buildSpawnEnv = (machine: MachineConfig, extraEnv: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = DEFAULT_TERM;
  env.COLORTERM = "truecolor";
  env.WMUX_MACHINE_ID = machine.id;
  env.WMUX_MACHINE_NAME = machine.name;
  env.PATH = `${process.cwd()}/scripts${path.delimiter}${env.PATH ?? ""}`;
  for (const [key, value] of Object.entries(extraEnv)) {
    env[key] = value;
  }
  return env;
};

export const buildSpawnSpec = (
  machine: MachineConfig,
  cols: number,
  rows: number,
  extraEnv: Record<string, string> = {},
): PtySpawnSpec => {
  const env = buildSpawnEnv(machine, extraEnv);
  const configuredCwd = machine.cwd ?? os.homedir();
  const startCwd = sanitizeCwd(extraEnv.WMUX_START_CWD) ?? configuredCwd;
  return resolveBackend(machine).spawnSpec(machine, { cols, rows, extraEnv, env, startCwd, configuredCwd });
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const powershellQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export const durableSessionName = (paneId?: string): string =>
  `wmux_${(paneId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}`;

// Staging for generated shell rc files. XDG_RUNTIME_DIR (a per-user 0700
// tmpfs) or ~/.wmux/run — never the shared /tmp, where a predictable path
// would let another local user pre-create the directory or a symlink and
// control the rc files a wmux shell sources.
const runtimeStageDirScript = `
wmux_run_base="\${XDG_RUNTIME_DIR:-\${HOME:-\${TMPDIR:-/tmp}}/.wmux/run}";
mkdir -p "$wmux_run_base" 2>/dev/null || true;
chmod 700 "$wmux_run_base" 2>/dev/null || true;`;

const interactiveShellCommand = (shellValue: string, sessionName: string): string => {
  return `
wmux_shell=${shellValue};
wmux_shell_name="\${wmux_shell##*/}";${runtimeStageDirScript}
wmux_shell_dir="$wmux_run_base/wmux-shell-${sessionName}";
mkdir -p "$wmux_shell_dir" 2>/dev/null || true;
case "$wmux_shell_name" in
  zsh)
    cat > "$wmux_shell_dir/.zshenv" <<'__WMUX_ZSHENV__'
if [ -n "\${WMUX_ORIGINAL_ZDOTDIR:-}" ] && [ -r "$WMUX_ORIGINAL_ZDOTDIR/.zshenv" ]; then
  source "$WMUX_ORIGINAL_ZDOTDIR/.zshenv"
fi
if [ -n "\${WMUX_ZDOTDIR:-}" ]; then
  export ZDOTDIR="$WMUX_ZDOTDIR"
fi
__WMUX_ZSHENV__
    cat > "$wmux_shell_dir/.zshrc" <<'__WMUX_ZSHRC__'
if [ -n "\${WMUX_ORIGINAL_ZDOTDIR:-}" ] && [ -r "$WMUX_ORIGINAL_ZDOTDIR/.zshrc" ]; then
  source "$WMUX_ORIGINAL_ZDOTDIR/.zshrc"
fi
_wmux_emit_cwd() {
  emulate -L zsh
  _wmux_install_cursor_bindings
  printf '\\033]7;file://%s%s\\a' "\${HOST:-$(hostname 2>/dev/null || printf wmux)}" "$PWD"
  _wmux_emit_control cursor=1
}
_wmux_emit_control() {
  emulate -L zsh
  if [[ -n "\${TMUX:-}" ]]; then
    printf '\\033Ptmux;\\033\\033]777;wmux;%s\\a\\033\\\\' "$1"
  else
    printf '\\033]777;wmux;%s\\a' "$1"
  fi
}
_wmux_emit_cursor_inactive() {
  emulate -L zsh
  _wmux_emit_control cursor=0
}
_wmux_query_cursor_position() {
  emulate -L zsh
  local old_stty response char body row col
  old_stty=$(stty -g < /dev/tty 2>/dev/null) || old_stty=
  stty raw -echo min 0 time 10 < /dev/tty 2>/dev/null || true
  printf '\\033[6n' > /dev/tty
  response=
  while read -rk 1 char < /dev/tty; do
    response+="$char"
    [[ "$char" == R || \${#response} -ge 32 ]] && break
  done
  [[ -n "$old_stty" ]] && stty "$old_stty" < /dev/tty 2>/dev/null || true
  body=\${response#*$'\\033['}
  body=\${body%%R*}
  row=\${body%%;*}
  col=\${body#*;}
  [[ "$row" == <-> && "$col" == <-> ]] || return 1
  printf '%s;%s\\n' "$row" "$col"
}
_wmux_buffer_cell_width() {
  emulate -L zsh
  local char="$1" current_width="$2"
  if [[ "$char" == $'\\t' ]]; then
    printf '%s\\n' $(( ((current_width / 8) + 1) * 8 - current_width ))
  elif [[ "$char" < $' ' || "$char" == $'\\177' ]]; then
    printf '2\\n'
  else
    printf '1\\n'
  fi
}
_wmux_cursor_offset_for_cell() {
  emulate -L zsh
  local target_col="$1" target_row="$2" current_col="$3" current_row="$4" buffer="$5" point="$6" columns="\${7:-\${COLUMNS:-80}}"
  local -i len width_to_cursor width start target offset char_width
  len=\${#buffer}
  (( point < 0 )) && point=0
  (( point > len )) && point=$len
  width_to_cursor=0
  for (( offset = 1; offset <= point; offset += 1 )); do
    char_width=$(_wmux_buffer_cell_width "\${buffer[offset]}" "$width_to_cursor")
    width_to_cursor=$(( width_to_cursor + char_width ))
  done
  start=$(( (current_row - 1) * columns + current_col - 1 - width_to_cursor ))
  target=$(( (target_row - 1) * columns + target_col - 1 ))
  (( target <= start )) && { printf '0\\n'; return; }
  width=0
  for (( offset = 1; offset <= len; offset += 1 )); do
    (( start + width >= target )) && { printf '%s\\n' $(( offset - 1 )); return; }
    char_width=$(_wmux_buffer_cell_width "\${buffer[offset]}" "$width")
    width=$(( width + char_width ))
  done
  printf '%s\\n' "$len"
}
_wmux_click_cursor() {
  emulate -L zsh
  local payload char target_col target_row current current_row current_col next_cursor extra
  payload=
  while read -rk 1 char; do
    [[ "$char" == '~' ]] && break
    payload+="$char"
    (( \${#payload} >= 32 )) && return
  done
  IFS=';' read -r target_col target_row current_col current_row extra <<< "$payload"
  [[ "$target_col" == <-> && "$target_row" == <-> ]] || return
  if [[ "$current_col" != <-> || "$current_row" != <-> ]]; then
    current=$(_wmux_query_cursor_position) || return
    current_row=\${current%%;*}
    current_col=\${current#*;}
  fi
  next_cursor=$(_wmux_cursor_offset_for_cell "$target_col" "$target_row" "$current_col" "$current_row" "$BUFFER" "$CURSOR" "\${COLUMNS:-80}") || return
  CURSOR=$next_cursor
  _wmux_emit_control cursor=1
  zle redisplay
}
_wmux_install_cursor_bindings() {
  emulate -L zsh
  zle -N _wmux_click_cursor 2>/dev/null || true
  bindkey $'\\033[9000;' _wmux_click_cursor 2>/dev/null || true
  bindkey -M emacs $'\\033[9000;' _wmux_click_cursor 2>/dev/null || true
  bindkey -M viins $'\\033[9000;' _wmux_click_cursor 2>/dev/null || true
  bindkey -M vicmd $'\\033[9000;' _wmux_click_cursor 2>/dev/null || true
}
autoload -Uz add-zsh-hook 2>/dev/null || true
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook precmd _wmux_emit_cwd
  add-zsh-hook preexec _wmux_emit_cursor_inactive
else
  precmd_functions=(_wmux_emit_cwd $precmd_functions)
  preexec_functions=(_wmux_emit_cursor_inactive $preexec_functions)
fi
_wmux_install_cursor_bindings
_wmux_emit_cwd
__WMUX_ZSHRC__
    export WMUX_ORIGINAL_ZDOTDIR="\${ZDOTDIR:-$HOME}";
    export WMUX_ZDOTDIR="$wmux_shell_dir";
    export ZDOTDIR="$wmux_shell_dir";
    exec "$wmux_shell" -i
    ;;
  bash)
    cat > "$wmux_shell_dir/bashrc" <<'__WMUX_BASHRC__'
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
_wmux_emit_cwd() {
  _wmux_install_cursor_bindings
  printf '\\033]7;file://%s%s\\a' "\${HOSTNAME:-$(hostname 2>/dev/null || printf wmux)}" "$PWD"
  _wmux_emit_control cursor=1
}
_wmux_emit_control() {
  if [[ -n "\${TMUX:-}" ]]; then
    printf '\\033Ptmux;\\033\\033]777;wmux;%s\\a\\033\\\\' "$1"
  else
    printf '\\033]777;wmux;%s\\a' "$1"
  fi
}
_wmux_emit_cursor_inactive() {
  [[ "\${_wmux_suppress_cursor_inactive:-}" == 1 ]] && return
  _wmux_emit_control cursor=0
}
_wmux_query_cursor_position() {
  local old_stty response char body row col
  old_stty=$(stty -g < /dev/tty 2>/dev/null) || old_stty=
  stty raw -echo min 0 time 10 < /dev/tty 2>/dev/null || true
  printf '\\033[6n' > /dev/tty
  response=
  while IFS= read -r -s -n 1 char < /dev/tty; do
    response+="$char"
    [[ "$char" == R || \${#response} -ge 32 ]] && break
  done
  [[ -n "$old_stty" ]] && stty "$old_stty" < /dev/tty 2>/dev/null || true
  body=\${response#*$'\\033['}
  body=\${body%%R*}
  row=\${body%%;*}
  col=\${body#*;}
  [[ "$row" =~ ^[0-9]+$ && "$col" =~ ^[0-9]+$ ]] || return 1
  printf '%s;%s\\n' "$row" "$col"
}
_wmux_buffer_cell_width() {
  local char="$1" current_width="$2"
  if [[ "$char" == $'\\t' ]]; then
    printf '%s\\n' $(( ((current_width / 8) + 1) * 8 - current_width ))
  elif [[ "$char" < $' ' || "$char" == $'\\177' ]]; then
    printf '2\\n'
  else
    printf '1\\n'
  fi
}
_wmux_cursor_offset_for_cell() {
  local target_col="$1" target_row="$2" current_col="$3" current_row="$4" buffer="$5" point="$6" columns="\${7:-\${COLUMNS:-80}}"
  local len width_to_cursor width start target offset char_width
  len=\${#buffer}
  (( point < 0 )) && point=0
  (( point > len )) && point=$len
  width_to_cursor=0
  for (( offset = 0; offset < point; offset += 1 )); do
    char_width=$(_wmux_buffer_cell_width "\${buffer:offset:1}" "$width_to_cursor")
    width_to_cursor=$(( width_to_cursor + char_width ))
  done
  start=$(( (current_row - 1) * columns + current_col - 1 - width_to_cursor ))
  target=$(( (target_row - 1) * columns + target_col - 1 ))
  (( target <= start )) && { printf '0\\n'; return; }
  width=0
  for (( offset = 0; offset < len; offset += 1 )); do
    (( start + width >= target )) && { printf '%s\\n' "$offset"; return; }
    char_width=$(_wmux_buffer_cell_width "\${buffer:offset:1}" "$width")
    width=$(( width + char_width ))
  done
  printf '%s\\n' "$len"
}
_wmux_click_cursor() {
  local _wmux_suppress_cursor_inactive=1
  local payload char target_col target_row current current_row current_col next_cursor extra
  payload=
  while IFS= read -r -s -n 1 char; do
    [[ "$char" == '~' ]] && break
    payload+="$char"
    (( \${#payload} >= 32 )) && return
  done
  IFS=';' read -r target_col target_row current_col current_row extra <<< "$payload"
  [[ "$target_col" =~ ^[0-9]+$ && "$target_row" =~ ^[0-9]+$ ]] || return
  if [[ ! "$current_col" =~ ^[0-9]+$ || ! "$current_row" =~ ^[0-9]+$ ]]; then
    current=$(_wmux_query_cursor_position) || return
    current_row=\${current%%;*}
    current_col=\${current#*;}
  fi
  next_cursor=$(_wmux_cursor_offset_for_cell "$target_col" "$target_row" "$current_col" "$current_row" "$READLINE_LINE" "$READLINE_POINT" "\${COLUMNS:-80}") || return
  READLINE_POINT=$next_cursor
  _wmux_emit_control cursor=1
}
_wmux_install_cursor_bindings() {
  bind -x '"\\e[9000;": _wmux_click_cursor' 2>/dev/null || true
  bind -m emacs -x '"\\e[9000;": _wmux_click_cursor' 2>/dev/null || true
  bind -m vi-insert -x '"\\e[9000;": _wmux_click_cursor' 2>/dev/null || true
  bind -m vi-command -x '"\\e[9000;": _wmux_click_cursor' 2>/dev/null || true
}
case ";\${PROMPT_COMMAND:-};" in
  *";_wmux_emit_cwd;"*) ;;
  *) PROMPT_COMMAND="_wmux_emit_cwd\${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac
_wmux_install_cursor_bindings
if [ -z "$(trap -p DEBUG)" ]; then
  trap '_wmux_emit_cursor_inactive' DEBUG
fi
_wmux_emit_cwd
__WMUX_BASHRC__
    exec "$wmux_shell" --rcfile "$wmux_shell_dir/bashrc" -i
    ;;
  *)
    exec "$wmux_shell" -i
    ;;
esac
`;
};

export const readDurableSessionCwd = (machine: MachineConfig, paneId: string): string | undefined =>
  resolveBackend(machine).readCwd(machine, paneId);

const durableSessionCwdImpl = (machine: MachineConfig, paneId: string): string | undefined => {
  const backend = machine.sessionBackend ?? "auto";
  if (backend === "screen" || backend === "pty" || backend === "agent" || machine.command?.length) return undefined;
  if (machine.kind !== "local" && machine.kind !== "ssh") return undefined;
  const sessionName = durableSessionName(paneId);
  const query =
    `${machine.kind === "ssh" ? `${remotePathBootstrap()}; ` : ""}` +
    `command -v tmux >/dev/null 2>&1 && tmux display-message -p -t ${shellQuote(sessionName)} '#{pane_current_path}' 2>/dev/null`;

  const result =
    machine.kind === "local"
      ? spawnSync("/bin/sh", ["-lc", query], { encoding: "utf8", timeout: 1500 })
      : readRemoteDurableSessionCwd(machine, query);

  if (!result || result.status !== 0) return undefined;
  return sanitizeCwd(result.stdout.split(/\r?\n/)[0]);
};

export const canRefreshDurableSessionClient = (machine: MachineConfig): boolean =>
  resolveBackend(machine).canRefreshClient(machine);

export const refreshDurableSessionClient = (machine: MachineConfig, paneId: string): boolean =>
  resolveBackend(machine).refreshClient(machine, paneId);

const refreshDurableSessionClientImpl = (machine: MachineConfig, paneId: string): boolean => {
  if (!canRefreshDurableSessionClient(machine)) return false;
  const sessionName = durableSessionName(paneId);
  const clients = spawnSync("tmux", ["list-clients", "-t", sessionName, "-F", "#{client_name}"], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (clients.status !== 0 || !clients.stdout.trim()) return false;
  let refreshed = false;
  for (const client of clients.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const result = spawnSync("tmux", ["refresh-client", "-t", client], { stdio: "ignore", timeout: 1000 });
    refreshed ||= result.status === 0;
  }
  return refreshed;
};

const readRemoteDurableSessionCwd = (
  machine: MachineConfig,
  query: string,
): { status: number | null; stdout: string } | undefined => {
  if (!machine.host) return undefined;
  const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3"];
  if (machine.port) args.push("-p", String(machine.port));
  args.push(target, query);
  return spawnSync("ssh", args, { encoding: "utf8", timeout: 4000 });
};

const sanitizeCwd = (value?: string): string | undefined => {
  const cwd = value?.trim();
  if (!cwd || cwd.length > 4096) return undefined;
  if (/[\x00-\x1f\x7f]/.test(cwd)) return undefined;
  if (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd)) return undefined;
  return cwd;
};

interface DurableShellInput {
  backend: SessionBackend;
  sessionName: string;
  cwd?: string;
  cols: number;
  rows: number;
  shellCommand: string;
  extraEnv: Record<string, string>;
  helperPathExport?: string;
  useSystemdScope: boolean;
}

const durableShellScript = ({
  backend,
  sessionName,
  cwd,
  cols,
  rows,
  shellCommand,
  extraEnv,
  helperPathExport,
}: DurableShellInput): string => {
  const exports = Object.entries(extraEnv)
    .filter(([, value]) => value)
    .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
    .join(" ");
  // Persist the wmux URL/token to ~/.wmux on the target at every (re)attach.
  // Shells inside pre-existing durable sessions keep their original env, so
  // helpers and agent hooks there rely on this file fallback to reach an
  // authenticated server (same contract as ~/.wmux/token on the server host).
  const credentialWrites = [
    extraEnv.WMUX_TOKEN ? `printf '%s\\n' ${shellQuote(extraEnv.WMUX_TOKEN)} > "$HOME/.wmux/token" 2>/dev/null || true;` : "",
    extraEnv.WMUX_URL ? `printf '%s\\n' ${shellQuote(extraEnv.WMUX_URL)} > "$HOME/.wmux/url" 2>/dev/null || true;` : "",
  ].filter(Boolean);
  const persistCredentials = credentialWrites.length > 0
    ? `( umask 077; mkdir -p "$HOME/.wmux" 2>/dev/null || true; ${credentialWrites.join(" ")} );`
    : "";
  const pathExport = helperPathExport ?? "";
  const startDir = cwd ? `cd ${shellQuote(cwd)} 2>/dev/null || true;` : "";
  const paneCommand = `${startDir} ${exports} ${pathExport} ${shellCommand}`;
  const tmuxCreateCommand = [
    "tmux",
    "-u",
    "new-session",
    "-d",
    "-s",
    shellQuote(sessionName),
    "-x",
    String(Math.max(2, Math.floor(cols))),
    "-y",
    String(Math.max(1, Math.floor(rows))),
    "--",
    shellQuote(paneCommand),
  ].join(" ");
  const tmuxTarget = shellQuote(sessionName);
  const tmuxAttachCommand = `tmux -u attach-session -t ${tmuxTarget}`;
  const tmuxCommand = [
    `tmux has-session -t ${tmuxTarget} 2>/dev/null || ${tmuxCreateCommand}`,
    `tmux set-option -t ${tmuxTarget} history-limit 100000 >/dev/null 2>&1 || true`,
    `tmux set-option -t ${tmuxTarget} mouse on >/dev/null 2>&1 || true`,
    `tmux set-option -t ${tmuxTarget} allow-passthrough on >/dev/null 2>&1 || true`,
    `tmux set-option -s user-keys[99] ${shellQuote("\\033[9000\\;")} >/dev/null 2>&1 || true`,
    `tmux bind-key -n User99 send-keys Escape ${shellQuote("[9000\\;")} >/dev/null 2>&1 || true`,
    `exec ${tmuxAttachCommand}`,
  ].join("; ");
  const screenRc = [
    "defscrollback 100000",
    "scrollback 100000",
    "altscreen off",
    "defmousetrack off",
    "mousetrack off",
    "termcapinfo xterm* ti@:te@",
    "termcapinfo screen* ti@:te@",
  ].join("\\n");
  const screenConfigScript = `${runtimeStageDirScript} wmux_screenrc="$wmux_run_base/wmux-screen-${sessionName}.rc"; printf '%s\\n' ${shellQuote(screenRc)} > "$wmux_screenrc";`;
  const screenAttach = `${screenConfigScript} screen -c "$wmux_screenrc" -S ${shellQuote(sessionName)} -x`;
  const screenCreate = `screen -c "$wmux_screenrc" -S ${shellQuote(sessionName)} -U -h 100000 /bin/sh -lc ${shellQuote(paneCommand)}`;
  const fallbackShell = `${startDir} ${exports} ${pathExport} echo '[wmux] tmux/screen not found; session will not survive wmux restart.' >&2; ${shellCommand}`;

  if (backend === "tmux") {
    return `${persistCredentials} if command -v tmux >/dev/null 2>&1; then ${tmuxCommand}; fi; echo '[wmux] tmux is required for this machine sessionBackend.' >&2; ${fallbackShell}`;
  }
  if (backend === "screen") {
    return `${persistCredentials} if command -v screen >/dev/null 2>&1; then ${screenAttach} || exec ${screenCreate}; exit $?; fi; echo '[wmux] screen is required for this machine sessionBackend.' >&2; ${fallbackShell}`;
  }
  return `${persistCredentials} if command -v tmux >/dev/null 2>&1; then ${tmuxCommand}; fi; if command -v screen >/dev/null 2>&1; then ${screenAttach} || exec ${screenCreate}; exit $?; fi; ${fallbackShell}`;
};

const stageLocalRuntime = (sessionName: string, innerScript: string): string => {
  const base = process.env.XDG_RUNTIME_DIR?.startsWith("/")
    ? process.env.XDG_RUNTIME_DIR
    : path.join(os.homedir(), ".wmux", "run");
  const runtimeDir = path.join(base, "wmux", "runtimes");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  const runtimePath = path.join(runtimeDir, `${POSIX_RUNTIME_VERSION}-${sessionName}.sh`);
  const temporaryPath = `${runtimePath}.${process.pid}.tmp`;
  const unit = `wmux-pane-${sessionName}`.replace(/[^A-Za-z0-9_.@-]/g, "_").slice(0, 80);
  const runtime = `#!/bin/sh
if [ "\${WMUX_RUNTIME_SCOPED:-}" != 1 ] && command -v systemd-run >/dev/null 2>&1 && [ -n "\${XDG_RUNTIME_DIR:-}" ]; then
  exec systemd-run --user --scope --quiet --collect --unit ${shellQuote(unit)} env WMUX_RUNTIME_SCOPED=1 /bin/sh "$0"
fi
${innerScript}
`;
  fs.writeFileSync(temporaryPath, runtime, { mode: 0o700 });
  fs.renameSync(temporaryPath, runtimePath);
  fs.chmodSync(runtimePath, 0o700);
  return runtimePath;
};

export const disposeDurableSession = (machine: MachineConfig, paneId: string): void =>
  resolveBackend(machine).dispose(machine, paneId);

const disposeDurableSessionImpl = (machine: MachineConfig, paneId: string): void => {
  const backend = machine.sessionBackend ?? "auto";
  if (backend === "pty" || backend === "agent" || machine.command?.length) return;
  if (machine.kind !== "local" && machine.kind !== "ssh") return;
  const sessionName = durableSessionName(paneId);
  const killScript = [
    machine.kind === "ssh" ? remotePathBootstrap() : "",
    backend !== "screen" ? `command -v tmux >/dev/null 2>&1 && tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null || true` : "",
    backend !== "tmux" ? `command -v screen >/dev/null 2>&1 && screen -S ${shellQuote(sessionName)} -X quit 2>/dev/null || true` : "",
  ]
    .filter(Boolean)
    .join("; ");
  if (machine.kind === "local") {
    spawnSync("/bin/sh", ["-lc", killScript], { stdio: "ignore" });
    return;
  }
  if (!machine.host) return;
  const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
  const args = ["-o", "BatchMode=yes"];
  if (machine.port) args.push("-p", String(machine.port));
  args.push(target, killScript);
  spawnSync("ssh", args, { stdio: "ignore", timeout: 5000 });
};

const remoteHelperDir = (): string => "${XDG_CACHE_HOME:-$HOME/.cache}/wmux/bin";

const installRemoteHelpersScript = (machine: MachineConfig): string => {
  const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? "127.0.0.1";
  const wmuxPort = process.env.WMUX_PORT ?? "3478";
  const wmuxUrl = process.env.WMUX_PUBLIC_URL ?? process.env.WMUX_URL ?? `http://${streamHost}:${wmuxPort}`;
  const streamPath = streamPathForMachine(machine.id);
  const streamConfig = JSON.stringify(
    {
      machine: machine.id,
      server: streamHost,
      wmuxUrl,
      rtspUrl: `rtsp://${streamHost}:8554/${streamPath}`,
      onDemand: true,
      pollInterval: 2,
      backend: "auto",
      framerate: 15,
      maxWidth: 1920,
      bitrate: "3500k",
    },
    null,
    2,
  );
  return `
wmux_helper_dir="${remoteHelperDir()}";
mkdir -p "$wmux_helper_dir";
mkdir -p "$HOME/.wmux" 2>/dev/null || true;
wmux_stream_agent_config="$HOME/.wmux/stream-agent.json";
wmux_stream_agent_defaults="$HOME/.wmux/stream-agent.defaults.json";
cat > "$wmux_stream_agent_defaults" <<'__WMUX_STREAM_AGENT_CONFIG__'
${streamConfig}
__WMUX_STREAM_AGENT_CONFIG__
if [ ! -f "$wmux_stream_agent_config" ]; then
  cp "$wmux_stream_agent_defaults" "$wmux_stream_agent_config" 2>/dev/null || true;
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$wmux_stream_agent_config" "$wmux_stream_agent_defaults" <<'__WMUX_STREAM_AGENT_CONFIG_MERGE__' 2>/dev/null || true
import json
import sys

config_path, defaults_path = sys.argv[1], sys.argv[2]
with open(defaults_path, "r", encoding="utf-8") as handle:
    defaults = json.load(handle)
try:
    with open(config_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
except Exception:
    config = {}
if not isinstance(config, dict):
    config = {}
changed = False
for key in ("machine", "server", "wmuxUrl", "rtspUrl", "onDemand", "pollInterval"):
    if key not in config:
        config[key] = defaults[key]
        changed = True
if changed:
    with open(config_path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\\n")
__WMUX_STREAM_AGENT_CONFIG_MERGE__
fi;
cat > "$wmux_helper_dir/wmux-media" <<'__WMUX_MEDIA_HELPER__'
${remoteMediaHelper}
__WMUX_MEDIA_HELPER__
cat > "$wmux_helper_dir/wmux-notify" <<'__WMUX_NOTIFY_HELPER__'
${remoteNotifyHelper}
__WMUX_NOTIFY_HELPER__
cat > "$wmux_helper_dir/wmux-title" <<'__WMUX_TITLE_HELPER__'
${remoteTitleHelper}
__WMUX_TITLE_HELPER__
cat > "$wmux_helper_dir/wmux-agent-event" <<'__WMUX_AGENT_EVENT_HELPER__'
${localHelperScript("wmux-agent-event")}
__WMUX_AGENT_EVENT_HELPER__
cat > "$wmux_helper_dir/wmux-run" <<'__WMUX_RUN_HELPER__'
${localHelperScript("wmux-run")}
__WMUX_RUN_HELPER__
cat > "$wmux_helper_dir/wmux-copy" <<'__WMUX_COPY_HELPER__'
${localHelperScript("wmux-copy")}
__WMUX_COPY_HELPER__
cat > "$wmux_helper_dir/wmux-stream-agent" <<'__WMUX_STREAM_AGENT_HELPER__'
${localHelperScript("wmux-stream-agent")}
__WMUX_STREAM_AGENT_HELPER__
cat > "$wmux_helper_dir/wmux-stream-agent-service" <<'__WMUX_STREAM_AGENT_SERVICE_HELPER__'
${localHelperScript("wmux-stream-agent-service")}
__WMUX_STREAM_AGENT_SERVICE_HELPER__
cat > "$wmux_helper_dir/wmux-sunshine-setup" <<'__WMUX_SUNSHINE_SETUP_HELPER__'
${localHelperScript("wmux-sunshine-setup")}
__WMUX_SUNSHINE_SETUP_HELPER__
chmod +x "$wmux_helper_dir/wmux-media" "$wmux_helper_dir/wmux-notify" "$wmux_helper_dir/wmux-title" "$wmux_helper_dir/wmux-agent-event" "$wmux_helper_dir/wmux-run" "$wmux_helper_dir/wmux-copy" "$wmux_helper_dir/wmux-stream-agent" "$wmux_helper_dir/wmux-stream-agent-service" "$wmux_helper_dir/wmux-sunshine-setup";
ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_helper_dir/wmux-clip" 2>/dev/null || true;
ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_helper_dir/wclip" 2>/dev/null || true;
ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_helper_dir/wmclip" 2>/dev/null || true;
wmux_old_ifs="$IFS";
IFS=":";
wmux_candidate_path="$PATH:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/bin";
for wmux_path_dir in $wmux_candidate_path; do
  case "$wmux_path_dir" in
    "$HOME"/*)
      mkdir -p "$wmux_path_dir" 2>/dev/null || true;
      if [ -d "$wmux_path_dir" ] && [ -w "$wmux_path_dir" ]; then
        ln -sf "$wmux_helper_dir/wmux-media" "$wmux_path_dir/wmux-media" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-notify" "$wmux_path_dir/wmux-notify" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-title" "$wmux_path_dir/wmux-title" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-agent-event" "$wmux_path_dir/wmux-agent-event" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-run" "$wmux_path_dir/wmux-run" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_path_dir/wmux-copy" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_path_dir/wmux-clip" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_path_dir/wclip" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_path_dir/wmclip" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-stream-agent" "$wmux_path_dir/wmux-stream-agent" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-stream-agent-service" "$wmux_path_dir/wmux-stream-agent-service" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-sunshine-setup" "$wmux_path_dir/wmux-sunshine-setup" 2>/dev/null || true;
      fi;
      ;;
  esac;
done;
IFS="$wmux_old_ifs";
`;
};

const localHelperScript = (name: string): string => {
  try {
    return fs.readFileSync(path.join(process.cwd(), "scripts", name), "utf8");
  } catch {
    return `#!/bin/sh\necho '${name} is unavailable on this host' >&2\nexit 127\n`;
  }
};

const remoteMediaHelper = `#!/usr/bin/env python3
import argparse
import base64
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import urllib.request

parser = argparse.ArgumentParser(prog="wmux-media")
parser.add_argument("--url", default=os.environ.get("WMUX_URL", "http://127.0.0.1:3478"))
parser.add_argument("--pane", default=os.environ.get("WMUX_PANE_ID", ""))
parser.add_argument("--workspace", default=os.environ.get("WMUX_WORKSPACE_ID", ""))
parser.add_argument("--tab", default=os.environ.get("WMUX_TAB_ID", ""))
parser.add_argument("--mime", default="")
parser.add_argument("--name", default="")
parser.add_argument("--mode", choices=("auto", "kitty", "http"), default=os.environ.get("WMUX_MEDIA_MODE", "auto"))
parser.add_argument("file")
args = parser.parse_args()

if not os.path.isfile(args.file):
    print(f"wmux-media: not a file: {args.file}", file=sys.stderr)
    sys.exit(2)

name = args.name or os.path.basename(args.file)
mime_type = args.mime or mimetypes.guess_type(args.file)[0] or "application/octet-stream"

if args.mode != "http" and mime_type.startswith("image/") and shutil.which("kitten"):
    result = subprocess.run(
        [
            "kitten",
            "icat",
            "--transfer-mode=stream",
            "--passthrough=tmux",
            "--align=left",
            "--engine=builtin",
            "--stdin=no",
            args.file,
        ]
    )
    if result.returncode == 0:
        sys.exit(0)
    if args.mode == "kitty":
        sys.exit(result.returncode or 1)

if args.mode == "kitty":
    print(f"wmux-media: kitten is not available or could not display {args.file}", file=sys.stderr)
    sys.exit(1)

with open(args.file, "rb") as handle:
    data = base64.b64encode(handle.read()).decode("ascii")

payload = {"name": name, "mimeType": mime_type, "data": data}
if args.pane:
    payload["paneId"] = args.pane
if args.workspace:
    payload["workspaceId"] = args.workspace
if args.tab:
    payload["tabId"] = args.tab

request = urllib.request.Request(
    args.url.rstrip("/") + "/api/media",
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json", **({"authorization": "Bearer " + os.environ["WMUX_TOKEN"]} if os.environ.get("WMUX_TOKEN") else {})},
    method="POST",
)
with urllib.request.urlopen(request, timeout=15):
    pass
`;

const remoteNotifyHelper = `#!/usr/bin/env python3
import argparse
import json
import os
import urllib.request

parser = argparse.ArgumentParser(prog="wmux-notify")
parser.add_argument("--url", default=os.environ.get("WMUX_URL", "http://127.0.0.1:3478"))
parser.add_argument("--title", default="wmux")
parser.add_argument("--subtitle", default="")
parser.add_argument("--body", default="")
parser.add_argument("--pane", default=os.environ.get("WMUX_PANE_ID", ""))
parser.add_argument("--workspace", default=os.environ.get("WMUX_WORKSPACE_ID", ""))
parser.add_argument("--tab", default=os.environ.get("WMUX_TAB_ID", ""))
parser.add_argument("message", nargs="?")
args = parser.parse_args()

payload = {"title": args.title, "subtitle": args.subtitle, "body": args.body or args.message or ""}
if args.pane:
    payload["paneId"] = args.pane
if args.workspace:
    payload["workspaceId"] = args.workspace
if args.tab:
    payload["tabId"] = args.tab

request = urllib.request.Request(
    args.url.rstrip("/") + "/api/notifications",
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json", **({"authorization": "Bearer " + os.environ["WMUX_TOKEN"]} if os.environ.get("WMUX_TOKEN") else {})},
    method="POST",
)
with urllib.request.urlopen(request, timeout=15):
    pass
`;

const remoteTitleHelper = `#!/usr/bin/env python3
import argparse
import json
import os
import urllib.request

parser = argparse.ArgumentParser(prog="wmux-title")
parser.add_argument("--url", default=os.environ.get("WMUX_URL", "http://127.0.0.1:3478"))
parser.add_argument("--workspace", default=os.environ.get("WMUX_WORKSPACE_ID", ""))
parser.add_argument("--tab", default=os.environ.get("WMUX_TAB_ID", ""))
parser.add_argument("--title", default="")
parser.add_argument("--descriptor", default="")
parser.add_argument("--manual", action="store_true")
parser.add_argument("--tab-always", action="store_true")
parser.add_argument("positional_title", nargs="?")
args = parser.parse_args()

title = args.title or args.positional_title or ""
if not args.workspace or not title:
    parser.error("--workspace and --title are required")

if args.manual:
    path = f"/api/workspaces/{args.workspace}/title"
    payload = {"title": title}
else:
    path = f"/api/workspaces/{args.workspace}/auto-title"
    payload = {"title": title, "tabOnlyIfMultiple": not args.tab_always}
    if args.tab:
        payload["tabId"] = args.tab
    if args.descriptor:
        payload["descriptor"] = args.descriptor

request = urllib.request.Request(
    args.url.rstrip("/") + path,
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json", **({"authorization": "Bearer " + os.environ["WMUX_TOKEN"]} if os.environ.get("WMUX_TOKEN") else {})},
    method="POST",
)
with urllib.request.urlopen(request, timeout=15):
    pass
`;

const probeTcp = (host: string, port: number, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

const probeWindowsPowerShellSsh = async (
  machine: MachineConfig,
  localEndpoint: string,
): Promise<WindowsHealthProbe> => {
  if (!machine.host) return { reachable: false, reason: "missing host" };
  const wmuxUrl =
    process.env.WMUX_PUBLIC_URL ??
    process.env.WMUX_URL ??
    `http://${localEndpoint}:${process.env.WMUX_PORT ?? "3478"}`;
  const cacheKey = `${machine.id}:${machine.user ?? ""}@${machine.host}:${machine.port ?? 22}:${wmuxUrl}`;
  const cached = windowsHealthCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < WINDOWS_HEALTH_CACHE_MS) return cached.result;

  const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3"];
  if (machine.port) args.push("-p", String(machine.port));
  const script = buildWindowsHealthProbeScript(wmuxUrl);
  args.push(target, machine.shell ?? "pwsh", "-NoLogo", "-NoProfile", "-Command", "-");
  const result = await runSshProbe(args, script, 7_000);
  const health = parseWindowsHealth(result.stdout);
  const probe: WindowsHealthProbe =
    result.status === 0 && health
      ? {
          reachable: true,
          health,
          backendDetail: windowsBackendDetail(health),
        }
      : {
          reachable: false,
          reason: result.timedOut
            ? "PowerShell SSH health check timed out"
            : `PowerShell SSH health check failed${result.stderr ? `: ${trimProbeError(result.stderr)}` : ""}`,
          health: health ?? undefined,
          backendDetail: backendDetail(machine),
        };
  windowsHealthCache.set(cacheKey, { checkedAt: Date.now(), result: probe });
  return probe;
};

const runSshProbe = (
  args: string[],
  script: string | undefined,
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> =>
  new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 500).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: error.message, timedOut });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
    child.stdin.end(script ? `${script}\n` : undefined);
  });

const parseWindowsHealth = (stdout: string): Record<string, unknown> | undefined => {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* keep searching */
    }
  }
  return undefined;
};

const windowsBackendDetail = (health: Record<string, unknown>): string => {
  const version = typeof health.powerShellVersion === "string" ? `pwsh ${health.powerShellVersion}` : "pwsh";
  const helpers =
    health.helpersReady !== true
      ? `helpers ${health.helperCount ?? 0}/${health.helperTotal ?? "?"}`
      : health.helpersCurrent === false
        ? "helpers stale (respawn a pane to restage)"
        : "helpers ready";
  const streamTask = typeof health.streamTaskState === "string" ? `stream task ${health.streamTaskState}` : "stream task unknown";
  const agentTask = typeof health.agentTaskState === "string" ? `agent task ${health.agentTaskState}` : "agent task unknown";
  const sunshine =
    health.sunshine === true
      ? health.sunshineApiReachable === true
        ? "sunshine ready"
        : "sunshine installed"
      : "sunshine missing";
  const captureTools = [
    health.ffmpeg === true ? "ffmpeg" : "",
    health.python === true || health.py === true ? "python" : "",
  ].filter(Boolean);
  const tools = captureTools.length ? captureTools.join("+") : "capture tools missing";
  return `SSH-launched PowerShell; ${version}; ${helpers}; ${streamTask}; ${agentTask}; ${sunshine}; ${tools}`;
};

const trimProbeError = (stderr: string): string => {
  const cleaned = stderr.replace(/#< CLIXML[\s\S]*/g, "PowerShell returned an error").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 240);
};

const commandExists = (command: string): boolean => {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command);
  }
  const result =
    process.platform === "win32"
      ? spawnSync("where.exe", [command], { stdio: "ignore" })
      : spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
          stdio: "ignore",
        });
  return result.status === 0;
};

export const resolveMachineStatuses = async (
  machines: MachineConfig[],
  localEndpoint = "127.0.0.1",
): Promise<MachineStatus[]> => {
  return Promise.all(
    machines.map(async (machine) => {
      const checkedAt = new Date().toISOString();
      const publicMachine = publicMachineStatusBase(machine);
      if (machine.kind === "local") {
        return {
          ...publicMachine,
          reachable: true,
          checkedAt,
          endpoint: localEndpoint === "localhost" ? "127.0.0.1" : localEndpoint,
          backendDetail: localBackendDetail(machine),
        };
      }
      if (machine.kind === "powershell" && process.platform !== "win32") {
        const hasPwsh = commandExists("pwsh");
        return {
          ...publicMachine,
          reachable: false,
          reason: hasPwsh
            ? "WSMan PowerShell remoting is not supported from this non-Windows wmux host"
            : "local pwsh client is not installed; WSMan PowerShell remoting is not supported from this non-Windows wmux host",
          checkedAt,
          endpoint: machine.host ? `${machine.host}:${machine.port ?? 5985}` : undefined,
          backendDetail: "PowerShell remoting transport unavailable",
        };
      }
      if (!machine.host) {
        return {
          ...publicMachine,
          reachable: false,
          reason: "missing host",
          checkedAt,
          backendDetail: backendDetail(machine),
        };
      }
      if (machine.kind === "powershell-ssh") {
        const hasSsh = commandExists("ssh");
        const port = machine.port ?? 22;
        const agent = shouldUseWindowsAgent(machine) ? await probeWindowsAgent(machine) : undefined;
        if (shouldUseWindowsAgent(machine)) {
          const sshReachable = hasSsh ? await probeTcp(machine.host, port, 900) : false;
          const agentReachable = agent?.reachable === true;
          return {
            ...publicMachine,
            reachable: agentReachable,
            checkedAt,
            endpoint: agent?.url ?? `${machine.host}:${machine.agentPort ?? 3481}`,
            backendDetail: windowsStatusDetail(backendDetail(machine), agent),
            runtimeVersion: agent?.health?.version,
            helperBundleVersion: agent?.health?.helperBundleVersion,
            reason: agentReachable ? undefined : `Windows agent unavailable: ${agent?.reason ?? "unknown error"}`,
            health: {
              sshReachable,
              agentReachable: agent?.reachable ?? false,
              agentUrl: agent?.url,
              agentHealth: agent?.health,
              agentReason: agent?.reason,
            },
          };
        }
        const reachable = hasSsh ? await probeTcp(machine.host, port, 900) : false;
        const health = reachable
          ? await probeWindowsPowerShellSsh(machine, localEndpoint)
          : {
              reachable: false,
              reason: hasSsh ? `no TCP response on ${machine.host}:${port}` : "local ssh client is not installed or not executable",
            };
        return {
          ...publicMachine,
          reachable: health.reachable,
          checkedAt,
          endpoint: `${machine.host}:${port}`,
          backendDetail: windowsStatusDetail(health.backendDetail ?? backendDetail(machine), agent),
          reason: health.reason,
          health: {
            ...(health.health ?? {}),
            ...(agent
              ? {
                  agentReachable: agent.reachable,
                  agentUrl: agent.url,
                  agentHealth: agent.health,
                  agentReason: agent.reason,
                }
              : {}),
          },
        };
      }
      const port = machine.port ?? (machine.kind === "ssh" ? 22 : machine.kind === "powershell" ? 5985 : 3478);
      const reachable = await probeTcp(machine.host, port, 900);
      return {
        ...publicMachine,
        reachable,
        checkedAt,
        endpoint: `${machine.host}:${port}`,
        backendDetail: backendDetail(machine),
        reason: reachable ? undefined : `no TCP response on ${machine.host}:${port}`,
      };
    }),
  );
};

const publicMachineStatusBase = (machine: MachineConfig): Omit<MachineStatus, "reachable" | "checkedAt"> => ({
  id: machine.id,
  name: machine.name,
  kind: machine.kind,
  host: machine.host,
  user: machine.user,
  port: machine.port,
  sessionBackend: machine.sessionBackend,
  agentUrl: machine.agentUrl,
  agentPort: machine.agentPort,
  stream: machine.stream
    ? {
        provider: machine.stream.provider,
        gatewayUrl: machine.stream.gatewayUrl,
        gatewayOpenUrl: machine.stream.gatewayOpenUrl,
      }
    : undefined,
});

const localBackendDetail = (machine: MachineConfig): string => {
  const backend = machine.sessionBackend ?? "auto";
  if (backend === "pty") return "raw PTY; not restart-durable";
  const tmux = commandExists("tmux") ? "tmux available" : "tmux missing";
  const screen = commandExists("screen") ? "screen available" : "screen missing";
  return `${backend} backend; ${tmux}; ${screen}`;
};

export const backendDetail = (machine: MachineConfig): string => {
  const backend = machine.sessionBackend ?? "auto";
  if (machine.kind === "ssh") return `SSH client; ${backend} durable backend on attach`;
  if (machine.kind === "powershell") return "PowerShell remoting; no durable backend";
  if (machine.kind === "powershell-ssh" && backend === "agent") return "Windows agent backend";
  if (machine.kind === "powershell-ssh") return "SSH-launched PowerShell; no durable backend";
  if (machine.kind === "service") return "wmux remote service probe";
  return localBackendDetail(machine);
};

const windowsStatusDetail = (
  detail: string,
  agent: Awaited<ReturnType<typeof probeWindowsAgent>> | undefined,
): string => {
  if (!agent) return detail;
  const backend = agent.health?.backend ? ` ${agent.health.backend}` : "";
  const dependency =
    agent.health?.backend === "conpty" && agent.health.conptyAvailable === false ? "; pywinpty missing" : "";
  const expectedVersion = expectedWindowsAgentVersion();
  const versionNote =
    agent.reachable && expectedVersion && agent.health?.version && agent.health.version !== expectedVersion
      ? ` (expected ${expectedVersion} — restart the agent task to update)`
      : "";
  const agentDetail = agent.reachable
    ? `agent ${agent.health?.version ?? "ready"}${versionNote}${backend} at ${agent.url}${dependency}`
    : `agent unavailable at ${agent.url ?? "unknown URL"}`;
  return `${detail}; ${agentDetail}`;
};
