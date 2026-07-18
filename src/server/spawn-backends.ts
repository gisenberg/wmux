import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canRefreshDurableSessionClient, durableSessionName } from "./durable-session.js";
import { streamPathForMachine } from "./streams.js";
import { resolveHelperUrl } from "./helper-url.js";
import type { MachineConfig, PtySpawnSpec, SessionBackend } from "./types.js";
import { sshControlArgs } from "./ssh-control.js";
import {
  buildWindowsPowerShellBootstrapUrl,
  encodePowerShellCommand,
} from "./windows-helpers.js";

const DEFAULT_TERM = "xterm-256color";
const remotePathBootstrap = (): string => `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"`;
export const POSIX_RUNTIME_VERSION = "v1";
export const POSIX_SSH_RUNTIME_VERSION = "v1";

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
}

const commandBackend: Backend = {
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
        helperPathExport: `export PATH="$wmux_helper_dir:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH";`,
        useSystemdScope: false,
      });
    const runtimePath = stageSshRuntime(machine, target, sessionName, remoteCommand, extraEnv.WMUX_PANE_ID);
    return { file: "/bin/sh", args: [runtimePath], cwd: os.homedir(), env, title: machine.name, trackProcessTitle: false };
  },
};

const powershellBackend: Backend = {
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
  spawnSpec: (machine, { extraEnv, env, startCwd }) => {
    if (!machine.host) throw new Error(`Machine ${machine.id} is missing host`);
    const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
    const args = ["-tt", ...sshControlArgs(extraEnv.WMUX_PANE_ID, true)];
    if (machine.port) args.push("-p", String(machine.port));
    const { WMUX_BOOTSTRAP_TOKEN: bootstrapToken, ...remoteEnv } = extraEnv;
    const bootstrapUrl = buildWindowsPowerShellBootstrapUrl(machine, startCwd, remoteEnv, bootstrapToken);
    const bootstrapCommand = `iex (irm ${powershellQuote(bootstrapUrl)})`;
    args.push(target, machine.shell ?? "pwsh", "-NoLogo");
    if (machine.loadPowerShellProfile !== true) args.push("-NoProfile");
    args.push(
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
        helperPathExport: `export PATH=${shellQuote(`${process.cwd()}/scripts`)}":$HOME/.local/bin:$PATH";`,
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
    const shell = machine.shell ?? defaultShell();
    return {
      file: "/bin/sh",
      args: ["-lc", `wmux-agent-profile apply --quiet || true; exec ${shellQuote(shell)}`],
      cwd: startCwd,
      env,
      title: path.basename(shell),
      trackProcessTitle: true,
    };
  },
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
  env.PATH = `${process.cwd()}/scripts${path.delimiter}${path.join(os.homedir(), ".local", "bin")}${path.delimiter}${env.PATH ?? ""}`;
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
    extraEnv.WMUX_TOKEN ? `printf '%s\\n' ${shellQuote(extraEnv.WMUX_TOKEN)} > "$HOME/.wmux/token" 2>/dev/null && chmod 600 "$HOME/.wmux/token" 2>/dev/null || true;` : "",
    extraEnv.WMUX_URL ? `printf '%s\\n' ${shellQuote(extraEnv.WMUX_URL)} > "$HOME/.wmux/url" 2>/dev/null && chmod 600 "$HOME/.wmux/url" 2>/dev/null || true;` : "",
  ].filter(Boolean);
  const persistCredentials = credentialWrites.length > 0
    ? `( umask 077; mkdir -p "$HOME/.wmux" 2>/dev/null || true; ${credentialWrites.join(" ")} );`
    : "";
  const pathExport = helperPathExport ?? "";
  const agentProfileApply = `${pathExport} if command -v wmux-agent-profile >/dev/null 2>&1; then wmux-agent-profile apply --quiet || true; fi;`;
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
    return `${persistCredentials} ${agentProfileApply} if command -v tmux >/dev/null 2>&1; then ${tmuxCommand}; fi; echo '[wmux] tmux is required for this machine sessionBackend.' >&2; ${fallbackShell}`;
  }
  if (backend === "screen") {
    return `${persistCredentials} ${agentProfileApply} if command -v screen >/dev/null 2>&1; then ${screenAttach} || exec ${screenCreate}; exit $?; fi; echo '[wmux] screen is required for this machine sessionBackend.' >&2; ${fallbackShell}`;
  }
  return `${persistCredentials} ${agentProfileApply} if command -v tmux >/dev/null 2>&1; then ${tmuxCommand}; fi; if command -v screen >/dev/null 2>&1; then ${screenAttach} || exec ${screenCreate}; exit $?; fi; ${fallbackShell}`;
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
  // The tmux server remains in its first transient scope after an attach
  // client exits. Each later browser attach therefore needs a fresh scope
  // name; reusing one pane-scoped name makes systemd reject the reattach while
  // the durable session is still doing exactly what it should: staying alive.
  const unitPrefix = `wmux-pane-${sessionName}`.replace(/[^A-Za-z0-9_.@-]/g, "_").slice(0, 43);
  const unit = `${unitPrefix}-${randomUUID()}`;
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

const stageSshRuntime = (
  machine: MachineConfig,
  target: string,
  sessionName: string,
  innerScript: string,
  paneId: string,
): string => {
  const base = process.env.XDG_RUNTIME_DIR?.startsWith("/")
    ? process.env.XDG_RUNTIME_DIR
    : path.join(os.homedir(), ".wmux", "run");
  const runtimeDir = path.join(base, "wmux", "ssh-runtimes");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);

  const stem = `${POSIX_SSH_RUNTIME_VERSION}-${sessionName}`;
  const payloadPath = path.join(runtimeDir, `${stem}.payload.sh`);
  const wrapperPath = path.join(runtimeDir, `${stem}.sh`);
  const remoteName = `${stem}.sh`;
  const temporaryPayloadPath = `${payloadPath}.${process.pid}.tmp`;
  const temporaryWrapperPath = `${wrapperPath}.${process.pid}.tmp`;
  const sshOptions = [
    ...sshControlArgs(paneId, true),
    ...(machine.port ? ["-p", String(machine.port)] : []),
  ].map(shellQuote).join(" ");
  const remoteRuntimeExpression = `\${XDG_CACHE_HOME:-\$HOME/.cache}/wmux/runtimes/${remoteName}`;
  const stageCommand = `
set -eu
wmux_runtime_dir="\${XDG_CACHE_HOME:-$HOME/.cache}/wmux/runtimes"
mkdir -p "$wmux_runtime_dir"
chmod 700 "$wmux_runtime_dir" 2>/dev/null || true
wmux_runtime="$wmux_runtime_dir/${remoteName}"
wmux_runtime_tmp="$wmux_runtime.tmp.$$"
trap 'rm -f "$wmux_runtime_tmp"' EXIT HUP INT TERM
cat > "$wmux_runtime_tmp"
chmod 700 "$wmux_runtime_tmp"
mv -f "$wmux_runtime_tmp" "$wmux_runtime"
trap - EXIT HUP INT TERM
`;
  const launchCommand = `exec /bin/sh "${remoteRuntimeExpression}"`;
  const payload = `#!/bin/sh
rm -f "$0" 2>/dev/null || true
${innerScript}
`;
  const wrapper = `#!/bin/sh
set -eu
wmux_payload=${shellQuote(payloadPath)}
wmux_wrapper=$0
wmux_cleanup() { rm -f "$wmux_payload" "$wmux_wrapper"; }
trap wmux_cleanup EXIT HUP INT TERM
ssh -T ${sshOptions} ${shellQuote(target)} ${shellQuote(stageCommand)} < "$wmux_payload"
rm -f "$wmux_payload"
trap - EXIT HUP INT TERM
rm -f "$wmux_wrapper"
exec ssh -t ${sshOptions} ${shellQuote(target)} ${shellQuote(launchCommand)}
`;

  fs.writeFileSync(temporaryPayloadPath, payload, { mode: 0o600 });
  fs.renameSync(temporaryPayloadPath, payloadPath);
  fs.chmodSync(payloadPath, 0o600);
  fs.writeFileSync(temporaryWrapperPath, wrapper, { mode: 0o700 });
  fs.renameSync(temporaryWrapperPath, wrapperPath);
  fs.chmodSync(wrapperPath, 0o700);
  return wrapperPath;
};

const remoteHelperDir = (): string => "${XDG_CACHE_HOME:-$HOME/.cache}/wmux/bin";

const installRemoteHelpersScript = (machine: MachineConfig): string => {
  const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? "127.0.0.1";
  const wmuxPort = process.env.WMUX_PORT ?? "3478";
  const wmuxUrl = resolveHelperUrl(`http://${streamHost}:${wmuxPort}`);
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
${localHelperScript("wmux-media")}
__WMUX_MEDIA_HELPER__
cat > "$wmux_helper_dir/wmux-notify" <<'__WMUX_NOTIFY_HELPER__'
${localHelperScript("wmux-notify")}
__WMUX_NOTIFY_HELPER__
cat > "$wmux_helper_dir/wmux-title" <<'__WMUX_TITLE_HELPER__'
${localHelperScript("wmux-title")}
__WMUX_TITLE_HELPER__
cat > "$wmux_helper_dir/wmux-agent-event" <<'__WMUX_AGENT_EVENT_HELPER__'
${localHelperScript("wmux-agent-event")}
__WMUX_AGENT_EVENT_HELPER__
cat > "$wmux_helper_dir/wmux-hooks" <<'__WMUX_HOOKS_HELPER__'
${localHelperScript("wmux-hooks")}
__WMUX_HOOKS_HELPER__
cat > "$wmux_helper_dir/wmux-run" <<'__WMUX_RUN_HELPER__'
${localHelperScript("wmux-run")}
__WMUX_RUN_HELPER__
cat > "$wmux_helper_dir/wmux-opencode-run" <<'__WMUX_OPENCODE_RUN_HELPER__'
${localHelperScript("wmux-opencode-run")}
__WMUX_OPENCODE_RUN_HELPER__
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
cat > "$wmux_helper_dir/wmux-agent-profile" <<'__WMUX_AGENT_PROFILE_HELPER__'
${localHelperScript("wmux-agent-profile")}
__WMUX_AGENT_PROFILE_HELPER__
chmod +x "$wmux_helper_dir/wmux-media" "$wmux_helper_dir/wmux-notify" "$wmux_helper_dir/wmux-title" "$wmux_helper_dir/wmux-agent-event" "$wmux_helper_dir/wmux-hooks" "$wmux_helper_dir/wmux-run" "$wmux_helper_dir/wmux-opencode-run" "$wmux_helper_dir/wmux-copy" "$wmux_helper_dir/wmux-stream-agent" "$wmux_helper_dir/wmux-stream-agent-service" "$wmux_helper_dir/wmux-sunshine-setup" "$wmux_helper_dir/wmux-agent-profile";
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
        ln -sf "$wmux_helper_dir/wmux-hooks" "$wmux_path_dir/wmux-hooks" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-run" "$wmux_path_dir/wmux-run" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-opencode-run" "$wmux_path_dir/wmux-opencode-run" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_path_dir/wmux-copy" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_path_dir/wmux-clip" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_path_dir/wclip" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-copy" "$wmux_path_dir/wmclip" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-stream-agent" "$wmux_path_dir/wmux-stream-agent" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-stream-agent-service" "$wmux_path_dir/wmux-stream-agent-service" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-sunshine-setup" "$wmux_path_dir/wmux-sunshine-setup" 2>/dev/null || true;
        ln -sf "$wmux_helper_dir/wmux-agent-profile" "$wmux_path_dir/wmux-agent-profile" 2>/dev/null || true;
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
