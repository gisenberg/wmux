import assert from "node:assert/strict";
import test from "node:test";
import { BackendObservation } from "../src/server/backend-observation.js";
import { durableShellScript } from "../src/server/spawn-backends.js";
import { spawnSync } from "node:child_process";

test("startup backend reports are stripped across every byte boundary", () => {
  for (let boundary = 0; boundary < 90; boundary += 1) {
    const observer = new BackendObservation();
    const data = `before\x1b]777;wmux-backend;${observer.nonce};tmux\x07after`;
    const result = observer.consume(data.slice(0, boundary)) + observer.consume(data.slice(boundary));
    assert.equal(result, "beforeafter");
    assert.equal(observer.mode, "tmux");
  }
});

test("unrelated and malformed reports cannot claim backend durability", () => {
  const observer = new BackendObservation();
  const unrelated = "\x1b]777;wmux-backend;different;tmux\x07";
  assert.equal(observer.consume(unrelated), unrelated);
  const malformed = `\x1b]777;wmux-backend;${observer.nonce};${"x".repeat(1000)}`;
  assert.equal(observer.consume(malformed), malformed);
  assert.equal(observer.mode, "pending");
  assert.equal(observer.consume(`\x1b]777;wmux-backend;${observer.nonce};raw\x07shell`), "shell");
  assert.equal(observer.mode, "raw");
});

test("auto startup reports raw fallback when no durable executable is available", () => {
  const observer = new BackendObservation();
  const script = durableShellScript({
    backend: "auto", sessionName: "wmux_observation_fixture", cols: 80, rows: 24,
    shellCommand: "printf 'WMUX_RAW_SHELL'", extraEnv: { WMUX_BACKEND_NONCE: observer.nonce },
    useSystemdScope: false,
  });
  const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: "/nonexistent" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(observer.consume(result.stdout), "WMUX_RAW_SHELL");
  assert.equal(observer.mode, "raw");
});
