import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHelperUrl } from "../src/server/helper-url.js";

const withUrlEnv = (env: Record<string, string | undefined>, run: () => void): void => {
  const saved = { ...process.env };
  try {
    for (const key of ["WMUX_HELPER_URL", "WMUX_PUBLIC_URL", "WMUX_URL"]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    run();
  } finally {
    process.env = saved;
  }
};

test("helper URL takes precedence over the browser-facing public URL", () => {
  withUrlEnv(
    { WMUX_HELPER_URL: "http://10.0.0.2:3478", WMUX_PUBLIC_URL: "https://wmux.tailnet.ts.net", WMUX_URL: "http://legacy:3478" },
    () => assert.equal(resolveHelperUrl("http://fallback:3478"), "http://10.0.0.2:3478"),
  );
});

test("helper URL retains public, legacy, and local fallback behavior", () => {
  withUrlEnv({ WMUX_PUBLIC_URL: "https://wmux.tailnet.ts.net" }, () =>
    assert.equal(resolveHelperUrl("http://fallback:3478"), "https://wmux.tailnet.ts.net"),
  );
  withUrlEnv({ WMUX_URL: "http://legacy:3478" }, () =>
    assert.equal(resolveHelperUrl("http://fallback:3478"), "http://legacy:3478"),
  );
  withUrlEnv({}, () => assert.equal(resolveHelperUrl("http://fallback:3478"), "http://fallback:3478"));
});

test("blank helper URL values fall through to the next configured callback URL", () => {
  withUrlEnv(
    { WMUX_HELPER_URL: " \t", WMUX_PUBLIC_URL: " https://wmux.tailnet.ts.net ", WMUX_URL: "http://legacy:3478" },
    () => assert.equal(resolveHelperUrl("http://fallback:3478"), "https://wmux.tailnet.ts.net"),
  );
  withUrlEnv({ WMUX_HELPER_URL: "", WMUX_PUBLIC_URL: "\n", WMUX_URL: "  " }, () =>
    assert.equal(resolveHelperUrl("http://fallback:3478"), "http://fallback:3478"),
  );
});
