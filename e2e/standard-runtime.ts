import fs from "node:fs";
import path from "node:path";
import { deriveExternalE2eRegistrationToken } from "./config-auth.js";

interface StandardE2eRuntimeOptions {
  baseURL: string;
  workingDirectory?: string;
  authToken?: string;
}

export interface StandardE2eRuntime {
  directory: string;
  environment: Record<string, string>;
}

export const prepareStandardE2eRuntime = ({
  baseURL,
  workingDirectory = process.cwd(),
  authToken,
}: StandardE2eRuntimeOptions): StandardE2eRuntime => {
  const directory = path.resolve("test-results", `e2e-runtime-${process.pid}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);

  const home = path.join(directory, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);

  const configPath = path.join(directory, "wmux.config.json");
  const fixtureConfig = JSON.parse(
    fs.readFileSync(path.resolve("e2e", "fixtures", "wmux.config.json"), "utf8"),
  ) as {
    machines: Array<Record<string, unknown>>;
  };
  for (const machine of fixtureConfig.machines) {
    if (machine.id === "local") machine.cwd = workingDirectory;
  }
  fs.writeFileSync(configPath, JSON.stringify(fixtureConfig, null, 2));

  return {
    directory,
    environment: {
      HOME: home,
      WMUX_DISABLE_AUTH: authToken ? "0" : "1",
      ...(authToken ? { WMUX_TOKEN: authToken } : {}),
      WMUX_REGISTRATION_TOKEN: authToken
        ? deriveExternalE2eRegistrationToken(authToken)
        : "e2e-registration-token",
      WMUX_CONFIG_PATH: configPath,
      WMUX_MANAGED_CONFIG_PATH: path.join(directory, "managed-config.json"),
      WMUX_STATE_PATH: path.join(directory, "state.json"),
      WMUX_SETTINGS_PATH: path.join(directory, "settings.json"),
      WMUX_AGENT_TIMELINE_PATH: path.join(directory, "agent-timelines.json"),
      WMUX_ATTACHMENT_DIR: path.join(directory, "attachments"),
      WMUX_PUBLIC_URL: baseURL,
      WMUX_HELPER_URL: baseURL,
      WMUX_CERT_FILE: "",
      WMUX_KEY_FILE: "",
      PATH: `${path.resolve("e2e", "fixtures", "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  };
};
