import fs from "node:fs";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "../shared/protocol.js";
import { loadAuthConfig, loadRegistrationAuthConfig } from "./auth.js";
import { isAllowedBindHost } from "./bind.js";
import { loadConfig } from "./config.js";
import { HostRegistry } from "./host-registry.js";
import { createHttpServer } from "./http.js";
import { resolveHelperUrl } from "./helper-url.js";
import { parseTrustedProxyAddresses } from "./proxy-address.js";
import { SettingsStore } from "./settings.js";
import { terminalThemeEnvironment } from "./terminal-theme.js";
import { SessionManager } from "./session-manager.js";
import { StateStore } from "./state.js";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
};

const stringOption = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const optionalArg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index === -1) return stringOption(fallback);
  return stringOption(process.argv[index + 1]) ?? stringOption(fallback);
};

const loadTlsOptions = (): HttpsServerOptions | undefined => {
  const certFile = optionalArg("--cert-file", process.env.WMUX_CERT_FILE);
  const keyFile = optionalArg("--key-file", process.env.WMUX_KEY_FILE);
  if (!certFile && !keyFile) return undefined;
  if (!certFile || !keyFile) {
    throw new Error("Both WMUX_CERT_FILE and WMUX_KEY_FILE are required for HTTPS.");
  }
  return {
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
  };
};

const main = async (): Promise<void> => {
  const host = arg("--host", process.env.WMUX_HOST ?? "127.0.0.1");
  const port = Number(arg("--port", process.env.WMUX_PORT ?? "3478"));
  const dev = process.argv.includes("--dev");
  const tls = loadTlsOptions();
  const protocol = tls ? "https" : "http";
  const configuredPublicUrl = stringOption(process.env.WMUX_PUBLIC_URL);
  const publicUrl = configuredPublicUrl ?? `${protocol}://${host}:${port}`;
  if (!configuredPublicUrl) process.env.WMUX_PUBLIC_URL = publicUrl;
  if (!isAllowedBindHost(host)) {
    throw new Error(
      `Refusing to bind ${host}. Use loopback, Tailscale 100.64.0.0/10, RFC1918, IPv6 ULA, or explicitly allow the address with WMUX_ALLOWED_BIND_RANGES.`,
    );
  }

  const config = loadConfig();
  const auth = loadAuthConfig();
  const registrationAuth = loadRegistrationAuthConfig();
  if (auth.enabled && auth.token === registrationAuth.token) {
    throw new Error("WMUX_REGISTRATION_TOKEN must differ from the main wmux access token.");
  }
  const trustedProxies = parseTrustedProxyAddresses();
  let stateStore: StateStore | undefined;
  let sessionManagerRef: SessionManager | undefined;
  const hostRegistry = new HostRegistry(
    config.machines,
    undefined,
    undefined,
    (machineId) => !stateStore || stateStore.hasMachineReferences(machineId),
    undefined,
    (machineId) => sessionManagerRef?.hasLiveSessionsForMachine(machineId) ?? false,
  );
  const currentMachines = (): typeof config.machines => hostRegistry.machines();
  const state = new StateStore(currentMachines());
  stateStore = state;
  hostRegistry.sweep();
  state.updateMachines(currentMachines());
  const settings = new SettingsStore(undefined, {
    terminalFontSize: config.terminalFontSize,
  });
  const sessionManager = new SessionManager(
    state,
    currentMachines,
    auth.token,
    (machineId) => hostRegistry.bootstrapToken(machineId),
    () => hostRegistry.sweep(),
    undefined,
    () => terminalThemeEnvironment(settings.snapshot().colorScheme),
  );
  sessionManagerRef = sessionManager;
  const server = await createHttpServer(host, state, currentMachines, sessionManager, settings, {
    dev,
    auth,
    tls,
    hostRegistry,
    registrationToken: registrationAuth.token,
    trustedProxies,
    keybindings: config.keybindings,
    terminalFontFamily: config.terminalFontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY,
  });
  // Persist the helper callback URL next to ~/.wmux/token: helpers and agent hooks
  // in existing durable panes read this before their stale inherited env.
  try {
    const wmuxDir = path.join(os.homedir(), ".wmux");
    fs.mkdirSync(wmuxDir, { recursive: true });
    const helperUrlPath = path.join(wmuxDir, "url");
    fs.writeFileSync(helperUrlPath, `${resolveHelperUrl(publicUrl)}\n`, { mode: 0o600 });
    fs.chmodSync(helperUrlPath, 0o600);
  } catch {
    // Best-effort; helpers fall back to their localhost default.
  }

  server.listen(port, host, () => {
    console.log(`wmux listening on ${protocol}://${host}:${port}${dev ? " (dev)" : ""}`);
    if (auth.enabled) {
      if (auth.tokenGenerated) {
        console.log(`wmux: access requires a token. Open ${publicUrl}/?token=${auth.token} once per browser.`);
      } else if (auth.tokenPath) {
        console.log(`wmux: access requires the token stored at ${auth.tokenPath}; existing tokens are not printed on restart.`);
      } else {
        console.log("wmux: access requires the token loaded from WMUX_TOKEN; environment tokens are not printed.");
      }
    } else {
      console.log("wmux: authentication disabled (WMUX_DISABLE_AUTH=1); relying on network boundary only.");
    }
    if (registrationAuth.tokenPath) {
      console.log(`wmux: host registration token stored at ${registrationAuth.tokenPath}.`);
    } else {
      console.log("wmux: host registration token loaded from environment.");
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`wmux: received ${signal}, shutting down`);
    // Persist pending state and reap non-durable child processes so a restart
    // doesn't orphan raw PTYs / ssh clients or lose debounced writes.
    state.flush();
    hostRegistry.dispose();
    sessionManager.disposeAll();
    server.close(() => process.exit(0));
    // Backstop if connections keep the server open past the grace period.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => shutdown(signal));
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
