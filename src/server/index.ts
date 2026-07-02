import { isAllowedBindHost } from "./bind.js";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { SettingsStore } from "./settings.js";
import { SessionManager } from "./session-manager.js";
import { StateStore } from "./state.js";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
};

const main = async (): Promise<void> => {
  const host = arg("--host", process.env.WMUX_HOST ?? "127.0.0.1");
  const port = Number(arg("--port", process.env.WMUX_PORT ?? "3478"));
  const dev = process.argv.includes("--dev");
  if (!isAllowedBindHost(host)) {
    throw new Error(
      `Refusing to bind ${host}. Use loopback, Tailscale 100.64.0.0/10, or an RFC1918/internal interface.`,
    );
  }

  const config = loadConfig();
  const state = new StateStore(config.machines);
  const settings = new SettingsStore();
  const sessionManager = new SessionManager(state, config.machines);
  const server = await createHttpServer(host, state, config.machines, sessionManager, settings, { dev });
  server.listen(port, host, () => {
    console.log(`wmux listening on http://${host}:${port}${dev ? " (dev)" : ""}`);
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
