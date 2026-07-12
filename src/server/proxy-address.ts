import type http from "node:http";
import net from "node:net";

/** Normalize an IP literal for comparison and reject hostnames/ports. */
export const normalizeIpAddress = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("::ffff:")) {
    const mapped = trimmed.slice(7);
    if (net.isIP(mapped) === 4) return mapped;
  }
  const version = net.isIP(trimmed);
  if (version === 4) return trimmed;
  if (version !== 6) return undefined;
  try {
    return new URL(`http://[${trimmed}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
};

/** Parse the exact proxy IPs whose X-Forwarded-For values wmux may trust. */
export const parseTrustedProxyAddresses = (raw = process.env.WMUX_TRUSTED_PROXIES ?? ""): ReadonlySet<string> => {
  const addresses = new Set<string>();
  for (const item of raw.split(",")) {
    const candidate = item.trim();
    if (!candidate) continue;
    const normalized = normalizeIpAddress(candidate);
    if (!normalized) {
      throw new Error(`WMUX_TRUSTED_PROXIES contains a non-IP value: ${candidate}`);
    }
    addresses.add(normalized);
  }
  return addresses;
};

/** Registration callbacks must stay inside the same private-network boundary as wmux. */
export const isAllowedRegistrationAddress = (value: string | undefined): boolean => {
  const address = normalizeIpAddress(value);
  if (!address) return false;
  if (net.isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    );
  }
  return address === "::1" || /^(?:fc|fd)[0-9a-f]{2}:/i.test(address);
};

/**
 * Resolve the peer to dial back. X-Forwarded-For is considered only when the
 * socket peer is explicitly trusted, and every hop must be a valid IP literal.
 */
export const observedClientAddress = (
  request: http.IncomingMessage,
  trustedProxies: ReadonlySet<string>,
): string | undefined => {
  const peer = normalizeIpAddress(request.socket.remoteAddress);
  if (!peer || !trustedProxies.has(peer)) return isAllowedRegistrationAddress(peer) ? peer : undefined;

  const forwarded = request.headers["x-forwarded-for"];
  const rawValues = Array.isArray(forwarded) ? forwarded : forwarded ? [forwarded] : [];
  const rawHops = rawValues.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (rawHops.length === 0) return undefined;
  if (rawHops.length > 32) return undefined;

  const hops = rawHops.map(normalizeIpAddress);
  if (hops.some((hop) => !hop)) return undefined;

  const chain = [...(hops as string[]), peer];
  while (chain.length > 1 && trustedProxies.has(chain[chain.length - 1])) chain.pop();
  const observed = chain[chain.length - 1];
  if (trustedProxies.has(observed)) return undefined;
  return isAllowedRegistrationAddress(observed) ? observed : undefined;
};
