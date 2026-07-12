import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveStreamStatuses, streamPathForMachine } from "../src/server/streams.js";
import type { MachineConfig } from "../src/server/types.js";

const localMachine: MachineConfig = { id: "local", name: "Local Server", kind: "local" };
const moonlightMachine: MachineConfig = {
  id: "gaming",
  name: "gaming",
  kind: "powershell-ssh",
  stream: { provider: "moonlight-gateway", gatewayUrl: "http://gateway:3490", gatewayToken: "tok" },
} as MachineConfig;

const withStubbedFetch = async (
  responses: Record<string, unknown>,
  run: () => Promise<void>,
): Promise<string[]> => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const [needle, body] of Object.entries(responses)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
};

test("resolves mediamtx and moonlight machines through their providers, preserving order", async () => {
  const localPath = streamPathForMachine("local");
  await withStubbedFetch(
    {
      "/v3/paths/list": { items: [{ name: localPath, ready: true, readers: [{}, {}], readyTime: "2026-07-05T00:00:00Z" }] },
      "/api/wmux/health": { ok: true, viewerCount: 1, startedAt: "2026-07-05T01:00:00Z", upstream: { ok: true } },
    },
    async () => {
      const statuses = await resolveStreamStatuses([moonlightMachine, localMachine], "127.0.0.1");
      assert.deepEqual(
        statuses.map((s) => [s.machineId, s.provider, s.live]),
        [
          ["gaming", "moonlight-gateway", true],
          ["local", "mediamtx", true],
        ],
      );
      const [gaming, local] = statuses;
      assert.ok(Number.isFinite(Date.parse(gaming.checkedAt)));
      assert.equal(gaming.checkedAt, local.checkedAt);
      assert.equal(gaming.inputEnabled, true);
      assert.equal(gaming.viewerCount, 1);
      assert.ok(gaming.openUrl.includes("token=tok"));
      assert.equal(local.viewerCount, 2);
      assert.ok(local.publishRtspUrl?.includes(localPath));
    },
  );
});

test("skips the MediaMTX API entirely when no machine uses it", async () => {
  const calls = await withStubbedFetch(
    { "/api/wmux/health": { ok: true, upstream: { ok: true } } },
    async () => {
      await resolveStreamStatuses([moonlightMachine], "127.0.0.1");
    },
  );
  assert.ok(calls.every((url) => !url.includes("/v3/paths/list")));
});

test("reports upstream failure reasons for a live gateway with a dead upstream", async () => {
  await withStubbedFetch(
    { "/api/wmux/health": { ok: true, upstream: { ok: false, status: 502 } } },
    async () => {
      const [status] = await resolveStreamStatuses([moonlightMachine], "127.0.0.1");
      assert.equal(status.live, false);
      assert.ok(status.reason?.includes("502"), `expected upstream reason, got ${status.reason}`);
      assert.equal(status.reasonKind, "upstream");
    },
  );
});

test("reports target failure reasons for a live gateway with a dead Moonlight target", async () => {
  await withStubbedFetch(
    { "/api/wmux/health": { ok: false, upstream: { ok: true }, target: { ok: false, reason: "host probe timed out" } } },
    async () => {
      const [status] = await resolveStreamStatuses([moonlightMachine], "127.0.0.1");
      assert.equal(status.live, false);
      assert.equal(status.reason, "host probe timed out");
      assert.equal(status.reasonKind, "target");
    },
  );
});

test("surfaces MediaMTX unavailability as a reason on offline streams", async () => {
  await withStubbedFetch({}, async () => {
    const [status] = await resolveStreamStatuses([localMachine], "127.0.0.1");
    assert.equal(status.live, false);
    assert.ok(status.reason);
    assert.equal(status.reasonKind, "provider");
  });
});
