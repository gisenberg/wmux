import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import {
  isAllowedRegistrationAddress,
  normalizeIpAddress,
  observedClientAddress,
  parseTrustedProxyAddresses,
} from "../src/server/proxy-address.js";

const requestFrom = (remoteAddress: string, forwarded?: string): http.IncomingMessage =>
  ({
    socket: { remoteAddress },
    headers: forwarded ? { "x-forwarded-for": forwarded } : {},
  }) as unknown as http.IncomingMessage;

test("normalizes valid IP literals and rejects hostnames, ports, and malformed values", () => {
  assert.equal(normalizeIpAddress("::ffff:192.0.2.4"), "192.0.2.4");
  assert.equal(normalizeIpAddress("0:0:0:0:0:0:0:1"), "::1");
  assert.equal(normalizeIpAddress("host.example"), undefined);
  assert.equal(normalizeIpAddress("192.0.2.4:1234"), undefined);
  assert.equal(normalizeIpAddress("unknown"), undefined);
});

test("trusted proxy configuration accepts exact IPs only", () => {
  assert.deepEqual([...parseTrustedProxyAddresses("192.0.2.1, 0:0:0:0:0:0:0:1")], ["192.0.2.1", "::1"]);
  assert.throws(() => parseTrustedProxyAddresses("proxy.internal"), /non-IP value/);
  assert.throws(() => parseTrustedProxyAddresses("192.0.2.0\/24"), /non-IP value/);
});

test("registration callbacks stay on loopback, Tailscale, RFC1918, or ULA addresses", () => {
  assert.equal(isAllowedRegistrationAddress("127.0.0.1"), true);
  assert.equal(isAllowedRegistrationAddress("100.70.0.8"), true);
  assert.equal(isAllowedRegistrationAddress("192.168.1.20"), true);
  assert.equal(isAllowedRegistrationAddress("fd7a:115c:a1e0::1"), true);
  assert.equal(isAllowedRegistrationAddress("198.51.100.8"), false);
  assert.equal(isAllowedRegistrationAddress("2001:db8::1"), false);
});

test("an untrusted peer cannot spoof its dial-back address", () => {
  const request = requestFrom("::ffff:100.70.0.20", "10.0.0.99");
  assert.equal(observedClientAddress(request, new Set()), "100.70.0.20");
});

test("walks a validated X-Forwarded-For chain from explicitly trusted proxies", () => {
  const request = requestFrom("10.0.0.2", "100.70.0.8, 10.0.0.1");
  const trusted = new Set(["10.0.0.1", "10.0.0.2"]);
  assert.equal(observedClientAddress(request, trusted), "100.70.0.8");
});

test("rejects malformed or public addresses supplied by a trusted proxy", () => {
  const invalid = requestFrom("10.0.0.2", "attacker.example, 10.0.0.1");
  const publicAddress = requestFrom("10.0.0.2", "198.51.100.8, 10.0.0.1");
  const trusted = new Set(["10.0.0.1", "10.0.0.2"]);
  assert.equal(observedClientAddress(invalid, trusted), undefined);
  assert.equal(observedClientAddress(publicAddress, trusted), undefined);
});

test("a trusted proxy must supply at least one valid untrusted client hop", () => {
  const missing = requestFrom("10.0.0.2");
  const allTrusted = requestFrom("10.0.0.2", "10.0.0.1");
  const trusted = new Set(["10.0.0.1", "10.0.0.2"]);
  assert.equal(observedClientAddress(missing, trusted), undefined);
  assert.equal(observedClientAddress(allTrusted, trusted), undefined);
});
