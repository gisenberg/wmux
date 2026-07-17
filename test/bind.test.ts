import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedBindHost, isAllowedOrigin, isAllowedRequestHost } from "../src/server/bind.js";

const BIND = "100.101.102.103";

test("binds only to loopback, RFC1918, Tailscale, or IPv6 ULA by default", () => {
  assert.equal(isAllowedBindHost("127.0.0.1"), true);
  assert.equal(isAllowedBindHost("10.23.4.5"), true);
  assert.equal(isAllowedBindHost("172.31.4.5"), true);
  assert.equal(isAllowedBindHost("192.168.4.5"), true);
  assert.equal(isAllowedBindHost("100.64.0.1"), true);
  assert.equal(isAllowedBindHost("100.127.255.254"), true);
  assert.equal(isAllowedBindHost("fd12:3456:789a::1"), true);
  assert.equal(isAllowedBindHost("8.8.8.8"), false);
  assert.equal(isAllowedBindHost("2001:4860:4860::8888"), false);
  assert.equal(isAllowedBindHost("0.0.0.0"), false);
  assert.equal(isAllowedBindHost("::"), false);
});

test("honors explicit bind IP and CIDR allowlist entries", () => {
  const previous = process.env.WMUX_ALLOWED_BIND_RANGES;
  process.env.WMUX_ALLOWED_BIND_RANGES = "192.0.2.44, 198.51.100.0/24, 2001:db8:1234::/48";
  try {
    assert.equal(isAllowedBindHost("192.0.2.44"), true);
    assert.equal(isAllowedBindHost("198.51.100.9"), true);
    assert.equal(isAllowedBindHost("198.51.101.9"), false);
    assert.equal(isAllowedBindHost("2001:db8:1234::9"), true);
    assert.equal(isAllowedBindHost("2001:db8:1235::9"), false);
  } finally {
    if (previous === undefined) delete process.env.WMUX_ALLOWED_BIND_RANGES;
    else process.env.WMUX_ALLOWED_BIND_RANGES = previous;
  }
});

test("explicit ranges cannot enable wildcard listen addresses", () => {
  const previous = process.env.WMUX_ALLOWED_BIND_RANGES;
  process.env.WMUX_ALLOWED_BIND_RANGES = "0.0.0.0/0, ::/0";
  try {
    assert.equal(isAllowedBindHost("0.0.0.0"), false);
    assert.equal(isAllowedBindHost("::"), false);
  } finally {
    if (previous === undefined) delete process.env.WMUX_ALLOWED_BIND_RANGES;
    else process.env.WMUX_ALLOWED_BIND_RANGES = previous;
  }
});

test("rejects invalid explicit bind ranges", () => {
  const previous = process.env.WMUX_ALLOWED_BIND_RANGES;
  process.env.WMUX_ALLOWED_BIND_RANGES = "internal.example";
  try {
    assert.throws(() => isAllowedBindHost("192.0.2.44"), /non-IP value/);
  } finally {
    if (previous === undefined) delete process.env.WMUX_ALLOWED_BIND_RANGES;
    else process.env.WMUX_ALLOWED_BIND_RANGES = previous;
  }
});

test("accepts the exact bind host", () => {
  assert.equal(isAllowedRequestHost(BIND, BIND), true);
  assert.equal(isAllowedRequestHost(`${BIND}:3478`, BIND), true);
});

test("accepts loopback and tailnet names", () => {
  assert.equal(isAllowedRequestHost("localhost", BIND), true);
  assert.equal(isAllowedRequestHost("box.tailnet.ts.net", BIND), true);
});

test("accepts private-range IPs, rejects public IPs", () => {
  assert.equal(isAllowedRequestHost("192.168.1.5", BIND), true);
  assert.equal(isAllowedRequestHost("10.0.0.2", BIND), true);
  assert.equal(isAllowedRequestHost("8.8.8.8", BIND), false);
});

test("rejects an unknown host and an empty host", () => {
  assert.equal(isAllowedRequestHost("evil.example.com", BIND), false);
  assert.equal(isAllowedRequestHost(undefined, BIND), false);
});

test("honors WMUX_ALLOWED_HOSTS", () => {
  const prev = process.env.WMUX_ALLOWED_HOSTS;
  process.env.WMUX_ALLOWED_HOSTS = "wmux.internal, other.host";
  try {
    assert.equal(isAllowedRequestHost("wmux.internal", BIND), true);
    assert.equal(isAllowedRequestHost("unlisted.host", BIND), false);
  } finally {
    if (prev === undefined) delete process.env.WMUX_ALLOWED_HOSTS;
    else process.env.WMUX_ALLOWED_HOSTS = prev;
  }
});

test("origin: absent allowed, mismatched rejected, matching allowed", () => {
  assert.equal(isAllowedOrigin(undefined, BIND), true);
  assert.equal(isAllowedOrigin("null", BIND), false);
  assert.equal(isAllowedOrigin("https://evil.example.com", BIND), false);
  assert.equal(isAllowedOrigin(`http://${BIND}:3478`, BIND), true);
  assert.equal(isAllowedOrigin("https://box.ts.net", BIND), true);
});
