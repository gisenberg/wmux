import assert from "node:assert/strict";
import test from "node:test";
import { LoginAttemptThrottle } from "../src/server/login-throttle.js";

test("login attempts are charged before work and recover after the window", () => {
  const throttle = new LoginAttemptThrottle(2, 1_000, 8);
  assert.deepEqual(throttle.attempt("100.64.0.1", 10_000), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(throttle.attempt("100.64.0.1", 10_001), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(throttle.attempt("100.64.0.1", 10_002), { allowed: false, retryAfterMs: 998 });
  assert.deepEqual(throttle.attempt("100.64.0.1", 11_001), { allowed: true, retryAfterMs: 0 });
});

test("successful login reset and per-address isolation", () => {
  const throttle = new LoginAttemptThrottle(1, 1_000, 8);
  assert.equal(throttle.attempt("100.64.0.1", 10_000).allowed, true);
  assert.equal(throttle.attempt("100.64.0.2", 10_000).allowed, true);
  assert.equal(throttle.attempt("100.64.0.1", 10_001).allowed, false);
  throttle.reset("100.64.0.1");
  assert.equal(throttle.attempt("100.64.0.1", 10_002).allowed, true);
});

test("login throttle evicts the least recently used address at its cap", () => {
  const throttle = new LoginAttemptThrottle(1, 10_000, 2);
  throttle.attempt("100.64.0.1", 10_000);
  throttle.attempt("100.64.0.2", 10_001);
  throttle.attempt("100.64.0.3", 10_002);
  assert.equal(throttle.attempt("100.64.0.1", 10_003).allowed, true);
});
