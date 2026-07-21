import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (filePath: string): string => fs.readFileSync(filePath, "utf8");

test("user service persists the helper callback URL and uses it for local stream defaults", () => {
  const installer = read("scripts/install-user-service.sh");
  assert.match(installer, /HELPER_URL="\$\{WMUX_HELPER_URL:-\}"/);
  assert.match(installer, /HELPER_URL="\$\{HELPER_URL#.*\}"/);
  assert.match(installer, /HELPER_URL="\$\{HELPER_URL%.*\}"/);
  assert.match(installer, /HELPER_URL="\$\{PUBLIC_URL\}"/);
  assert.match(installer, /"wmuxUrl": "\$\{HELPER_URL\}"/);
  assert.match(installer, /Environment=WMUX_HELPER_URL=\$\{HELPER_URL\}/);
});

test("service and Docker deployment templates pass through WMUX_HELPER_URL", () => {
  assert.match(read("deploy/wmux.service.example"), /^Environment=WMUX_HELPER_URL=$/m);
  assert.match(read("deploy/docker/docker-compose.yml"), /WMUX_HELPER_URL: "\$\{WMUX_HELPER_URL:-\}"/);
  assert.match(read("deploy/docker/.env.example"), /WMUX_HELPER_URL=/);
});

test("user service passes through explicit bind-range overrides", () => {
  const installer = read("scripts/install-user-service.sh");
  assert.match(installer, /ALLOWED_BIND_RANGES="\$\{WMUX_ALLOWED_BIND_RANGES:-\}"/);
  assert.match(installer, /Environment=WMUX_ALLOWED_BIND_RANGES=\$\{ALLOWED_BIND_RANGES\}/);
  assert.match(read("deploy/wmux.service.example"), /^Environment=WMUX_ALLOWED_BIND_RANGES=$/m);
});

test("service and Docker launchers pass scoped auth mode and token paths", () => {
  const installer = read("scripts/install-user-service.sh");
  const service = read("deploy/wmux.service.example");
  const compose = read("deploy/docker/docker-compose.yml");
  assert.match(installer, /BROWSER_AUTH_MODE="\$\{WMUX_BROWSER_AUTH_MODE:-shared-or-login\}"/);
  assert.match(installer, /Environment=WMUX_AUTOMATION_TOKEN_PATH=\$\{AUTOMATION_TOKEN_PATH\}/);
  assert.match(installer, /Environment=WMUX_HELPER_TOKEN_PATH=\$\{HELPER_TOKEN_PATH\}/);
  assert.match(installer, /chmod 700 "\$\{HOME\}\/\.wmux"/);
  assert.match(service, /^Environment=WMUX_BROWSER_AUTH_MODE=shared-or-login$/m);
  assert.match(compose, /WMUX_AUTOMATION_TOKEN: "\$\{WMUX_AUTOMATION_TOKEN:-\}"/);
  assert.match(compose, /WMUX_HELPER_TOKEN: "\$\{WMUX_HELPER_TOKEN:-\}"/);
  assert.match(read("deploy/docker/Dockerfile"), /chmod 700 \/home\/node\/\.wmux/);
});
