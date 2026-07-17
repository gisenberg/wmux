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
