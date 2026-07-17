import net from "node:net";
import { isAllowedRegistrationAddress, normalizeIpAddress } from "./proxy-address.js";

const addressValue = (address: string): bigint => {
  if (net.isIP(address) === 4) {
    return address.split(".").reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
  }
  const [left = "", right = ""] = address.split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const missing = 8 - leftParts.length - rightParts.length;
  const parts = [...leftParts, ...Array.from({ length: missing }, () => "0"), ...rightParts];
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
};

const matchesAllowedRange = (host: string, entry: string): boolean => {
  const [rawNetwork, rawPrefix] = entry.split("/");
  const network = normalizeIpAddress(rawNetwork);
  if (!network) throw new Error(`WMUX_ALLOWED_BIND_RANGES contains a non-IP value: ${entry}`);
  const version = net.isIP(network);
  const bits = version === 4 ? 32 : 128;
  const prefix = rawPrefix === undefined ? bits : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits || entry.split("/").length > 2) {
    throw new Error(`WMUX_ALLOWED_BIND_RANGES contains an invalid CIDR: ${entry}`);
  }
  const normalizedHost = normalizeIpAddress(host);
  if (!normalizedHost || net.isIP(normalizedHost) !== version) return false;
  const shift = BigInt(bits - prefix);
  return (addressValue(normalizedHost) >> shift) === (addressValue(network) >> shift);
};

const isExplicitlyAllowedBindHost = (host: string): boolean =>
  (process.env.WMUX_ALLOWED_BIND_RANGES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => matchesAllowedRange(host, entry));

export const isAllowedBindHost = (host: string): boolean => {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const normalized = normalizeIpAddress(host);
  if (normalized === "0.0.0.0" || normalized === "::") return false;
  if (isAllowedRegistrationAddress(host)) return true;
  return isExplicitlyAllowedBindHost(host);
};

const normalizeHost = (value: string | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > -1 ? trimmed.slice(1, end) : trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  return colon > -1 ? trimmed.slice(0, colon) : trimmed;
};

export const isAllowedRequestHost = (hostHeader: string | undefined, bindHost: string): boolean => {
  const host = normalizeHost(hostHeader);
  if (!host) return false;
  if (host === bindHost || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".ts.net")) return true;
  if (net.isIP(host)) return isAllowedBindHost(host);
  const allowed = (process.env.WMUX_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.includes(host);
};

export const isAllowedOrigin = (origin: string | undefined, bindHost: string): boolean => {
  if (!origin) return true;
  if (origin === "null") return false;
  try {
    const parsed = new URL(origin);
    return isAllowedRequestHost(parsed.host, bindHost);
  } catch {
    return false;
  }
};
