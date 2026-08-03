import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  deriveExternalE2eRegistrationToken,
  resolveExternalE2eToken,
} from "../e2e/config-auth.js";
import { defaultE2ePort, resolveE2ePort } from "../e2e/config-port.js";
import { createExternalApiRequestContext } from "../e2e/external-api-request.js";

test("the E2E fixture port defaults to the standard isolated port", () => {
  assert.equal(resolveE2ePort(undefined), defaultE2ePort);
  assert.equal(resolveE2ePort("  "), defaultE2ePort);
});

test("the E2E fixture port accepts an explicit valid port", () => {
  assert.equal(resolveE2ePort("3492"), 3492);
  assert.equal(resolveE2ePort(" 43871 "), 43871);
});

test("the E2E fixture port rejects malformed and out-of-range values", () => {
  for (const value of ["0", "65536", "-1", "3492junk", "3.5", "NaN"]) {
    assert.throws(() => resolveE2ePort(value), /Invalid WMUX_E2E_PORT/);
  }
});

test("external E2E requires a bounded per-run authentication secret", () => {
  assert.equal(resolveExternalE2eToken(undefined, undefined), undefined);
  assert.throws(() => resolveExternalE2eToken("http://100.64.0.1:3491", undefined), /WMUX_E2E_TOKEN/);
  assert.throws(() => resolveExternalE2eToken("http://100.64.0.1:3491", "short"), /WMUX_E2E_TOKEN/);
  for (const invalid of [` ${"x".repeat(43)}`, `${"x".repeat(43)} `, "é".repeat(43), `${"x".repeat(42)} y`]) {
    assert.throws(() => resolveExternalE2eToken("http://100.64.0.1:3491", invalid), /WMUX_E2E_TOKEN/);
  }
  const token = "x".repeat(43);
  assert.equal(resolveExternalE2eToken("http://100.64.0.1:3491", token), token);
  const registrationToken = deriveExternalE2eRegistrationToken(token);
  assert.match(registrationToken, /^[\x21-\x7e]+$/);
  assert.notEqual(registrationToken, token);
});

test("external E2E API auth stays in a same-origin redirect-refusing native adapter", async () => {
  const token = "external-api-secret-xxxxxxxxxxxxxxxxxxxxxxxx";
  let authorization = "";
  let redirectTargetRequests = 0;
  const target = http.createServer((_request, response) => {
    redirectTargetRequests += 1;
    response.end("unexpected");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress === "string") throw new Error("target unavailable");
  const source = http.createServer((request, response) => {
    authorization = request.headers.authorization ?? "";
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/capture` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const sourceAddress = source.address();
  if (!sourceAddress || typeof sourceAddress === "string") throw new Error("source unavailable");
  const context = createExternalApiRequestContext(`http://127.0.0.1:${sourceAddress.port}`, token);
  try {
    const response = await context.get("/api/health");
    assert.equal(response.status(), 200);
    assert.equal(authorization, `Bearer ${token}`);
    const redirect = await context.get("/redirect");
    assert.equal(redirect.status(), 302);
    assert.equal(redirectTargetRequests, 0);
    await assert.rejects(context.get(`http://127.0.0.1:${targetAddress.port}/capture`), /configured wmux origin/);
  } finally {
    await context.dispose();
    await Promise.all([
      new Promise<void>((resolve) => source.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
  }
});
