/**
 * Engine network policy: which addresses a plugin may reach (host side).
 *
 * Phase 4 gives plugins a controlled HTTP capability. "Controlled" has to
 * include WHERE a plugin may point it, otherwise an untrusted plugin can
 * use the host as a proxy into networks it should never touch:
 *
 *   - loopback services on the machine running the engine
 *   - RFC 1918 / CGNAT hosts inside the operator's LAN
 *   - link-local cloud metadata endpoints (169.254.169.254,
 *     fd00:ec2::254), which on AWS/GCP/Azure hand out temporary
 *     instance credentials
 *
 * This module is the single place that decides whether a request target
 * is allowed. It is pure host logic: no QuickJS, no filesystem, and it
 * performs network I/O only through the injected DNS resolver.
 *
 * Design notes
 * ------------
 * Trust model: ARCHITECTURE.md states a plugin is untrusted code
 * constrained by the engine. Internal network access was never a
 * documented, intentional capability — it was an omission. So the
 * DEFAULT policy is "public internet only" and the host application
 * opts in to private ranges explicitly (`allowPrivateNetwork: true`),
 * which is what local development and the deterministic test suite use.
 *
 * Address matching uses Node's built-in `net.BlockList`, which also
 * matches IPv4 rules against IPv4-mapped IPv6 addresses (`::ffff:7f00:1`
 * is caught by the `127.0.0.0/8` rule). `BlockList.check()` MUST be given
 * an explicit family: without it, IPv6 detection is unreliable.
 *
 * Obfuscated IPv4 literals (decimal `2130706433`, hex `0x7f.1`, octal
 * `0177.0.0.1`, even unicode digits) are normalised to dotted-quad form
 * by the WHATWG URL parser before this module ever sees them, so they
 * cannot be used to smuggle a blocked address past the check.
 *
 * Tunnel prefixes that embed an IPv4 address (6to4 `2002::/16`, NAT64
 * `64:ff9b::/96`, Teredo `2001::/32`) are blocked outright: BlockList
 * does not decode the embedded address, so allowing them would leave a
 * smuggling path.
 *
 * Residual risk (documented, not hidden): hostname checks resolve DNS
 * and then the request resolves DNS again, so a hostile authoritative
 * server can return a public address first and a private one second
 * (DNS rebinding / TOCTOU). Closing that fully needs connection-level
 * address pinning, which is beyond a lightweight engine. Deployments
 * running untrusted plugins should also apply OS/network-level egress
 * controls. This is engine-level defence in depth, not an OS boundary —
 * the same caveat ARCHITECTURE.md already states for the sandbox.
 */
import { lookup } from "node:dns/promises";
import type { LookupAllOptions } from "node:dns";
import net from "node:net";

import type { HttpErrorCode } from "./http.js";

/**
 * Engine-controlled network policy.
 *
 * Plugins can never influence this: it is supplied by the host
 * application when it constructs the engine.
 */
export interface NetworkPolicy {
  /**
   * When `false` (the default) loopback, private, link-local, and other
   * reserved address ranges are unreachable and hostnames that resolve
   * into them are rejected. When `true` every http(s) address is
   * reachable — intended for local development and deterministic tests
   * that serve fixtures from a local server.
   */
  allowPrivateNetwork: boolean;
}

/** The safe production default: public internet only. */
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  allowPrivateNetwork: false,
};

/** Coarse classification of an IP address, used for error messages. */
export type AddressClass =
  | "loopback"
  | "private"
  | "link-local"
  | "reserved"
  | "multicast"
  | "public";

/** Resolves a hostname to its addresses. Injectable for deterministic tests. */
export type AddressResolver = (hostname: string) => Promise<string[]>;

/** The outcome of a target check. Never throws for policy decisions. */
export type NetworkDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** The structured HTTP error code the caller should surface. */
      code: HttpErrorCode;
      message: string;
    };

// ---------------------------------------------------------------------------
// Blocked ranges
// ---------------------------------------------------------------------------

/** IPv4 CIDR blocks a plugin may not reach under the default policy. */
const BLOCKED_IPV4: readonly (readonly [network: string, prefix: number, klass: AddressClass])[] = [
  ["0.0.0.0", 8, "reserved"], // "this" network
  ["10.0.0.0", 8, "private"], // RFC 1918
  ["100.64.0.0", 10, "reserved"], // RFC 6598 CGNAT / shared address space
  ["127.0.0.0", 8, "loopback"], // RFC 1122 loopback
  ["169.254.0.0", 16, "link-local"], // RFC 3927 — includes cloud metadata
  ["172.16.0.0", 12, "private"], // RFC 1918
  ["192.0.0.0", 24, "reserved"], // RFC 6890 IETF protocol assignments
  ["192.0.2.0", 24, "reserved"], // RFC 5737 TEST-NET-1
  ["192.88.99.0", 24, "reserved"], // RFC 7526 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16, "private"], // RFC 1918
  ["198.18.0.0", 15, "reserved"], // RFC 2544 benchmarking
  ["198.51.100.0", 24, "reserved"], // RFC 5737 TEST-NET-2
  ["203.0.113.0", 24, "reserved"], // RFC 5737 TEST-NET-3
  ["224.0.0.0", 4, "multicast"], // RFC 5771 multicast
  ["240.0.0.0", 4, "reserved"], // RFC 1112 reserved for future use
  ["255.255.255.255", 32, "reserved"], // RFC 919 limited broadcast
];

/** IPv6 CIDR blocks a plugin may not reach under the default policy. */
const BLOCKED_IPV6: readonly (readonly [network: string, prefix: number, klass: AddressClass])[] = [
  ["::", 128, "reserved"], // RFC 4291 unspecified
  ["::1", 128, "loopback"], // RFC 4291 loopback
  ["64:ff9b::", 96, "reserved"], // RFC 6052 NAT64 (embeds IPv4 — blocked)
  ["64:ff9b:1::", 48, "reserved"], // RFC 8215 local-use NAT64
  ["100::", 64, "reserved"], // RFC 6666 discard-only
  ["2001::", 32, "reserved"], // RFC 4380 Teredo (embeds IPv4 — blocked)
  ["2001:2::", 48, "reserved"], // RFC 5180 benchmarking
  ["2001:db8::", 32, "reserved"], // RFC 3849 documentation
  ["2002::", 16, "reserved"], // RFC 3056 6to4 (embeds IPv4 — blocked)
  ["fc00::", 7, "private"], // RFC 4193 unique local address
  ["fe80::", 10, "link-local"], // RFC 4291 link-local
  ["ff00::", 8, "multicast"], // RFC 4291 multicast
];

/** Address → class, for the blocked ranges only. */
const CLASS_BY_RANGE = new Map<string, AddressClass>();

function buildBlockList(): net.BlockList {
  const list = new net.BlockList();
  for (const [network, prefix, klass] of BLOCKED_IPV4) {
    list.addSubnet(network, prefix, "ipv4");
    CLASS_BY_RANGE.set(`4:${network}/${prefix}`, klass);
  }
  for (const [network, prefix, klass] of BLOCKED_IPV6) {
    list.addSubnet(network, prefix, "ipv6");
    CLASS_BY_RANGE.set(`6:${network}/${prefix}`, klass);
  }
  return list;
}

const BLOCKED = buildBlockList();

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** True when `address` is a blocked IPv4 or IPv6 literal. */
function isBlockedLiteral(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  // The family argument is REQUIRED: BlockList.check() mis-detects IPv6
  // (including IPv4-mapped forms) when it is left to inference.
  return BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Classify an IP literal. Returns "public" for allowed addresses and
 * `null` for strings that are not IP literals at all.
 */
export function classifyAddress(address: string): AddressClass | null {
  const family = net.isIP(address);
  if (family === 0) return null;
  if (!isBlockedLiteral(address)) return "public";
  const tag = `${family}:`;
  for (const [key, klass] of CLASS_BY_RANGE) {
    if (!key.startsWith(tag)) continue;
    const [network, prefix] = key.slice(tag.length).split("/");
    if (network === undefined || prefix === undefined) continue;
    const probe = new net.BlockList();
    probe.addSubnet(network, Number(prefix), family === 4 ? "ipv4" : "ipv6");
    if (probe.check(address, family === 4 ? "ipv4" : "ipv6")) return klass;
  }
  return "reserved";
}

/** True when an IP literal may be requested under the default policy. */
export function isAddressAllowed(address: string): boolean {
  return net.isIP(address) !== 0 && !isBlockedLiteral(address);
}

/**
 * Strip the brackets `URL` keeps around an IPv6 hostname
 * (`"[::1]"` → `"::1"`). Non-IPv6 hosts are returned unchanged.
 */
export function hostFromUrl(url: URL): string {
  const host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

/** Bound on the policy DNS lookup so a slow resolver cannot stall a request. */
const DNS_TIMEOUT_MS = 5_000;

/** Default resolver: the operating system's DNS, all addresses, bounded. */
export const systemResolver: AddressResolver = async (hostname) => {
  // `signal` IS honoured at runtime (Node >= 15.4) but is missing from the
  // @types/node 20 overload for `{ all: true }`, so the options are built
  // as a variable (excess-property checks apply only to fresh literals).
  const options: LookupAllOptions & { signal?: AbortSignal } = {
    all: true,
    verbatim: true,
    signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
  };
  const records = await lookup(hostname, options);
  return records.map((record) => record.address);
};

// ---------------------------------------------------------------------------
// Target check
// ---------------------------------------------------------------------------

/**
 * Decide whether `url` may be requested under `policy`.
 *
 * Called for the initial URL AND for every redirect hop, so a redirect
 * can never be used to reach a blocked address. Returns a structured
 * decision; it never throws for a policy rejection.
 *
 * @param resolver Injectable DNS resolver (tests supply a fixed one so
 *   the suite stays offline and deterministic).
 */
export async function checkRequestTarget(
  url: URL,
  policy: NetworkPolicy,
  resolver: AddressResolver = systemResolver,
): Promise<NetworkDecision> {
  if (policy.allowPrivateNetwork) {
    return { allowed: true };
  }

  const host = hostFromUrl(url);
  if (host.length === 0) {
    return {
      allowed: false,
      code: "HTTP_INVALID_URL",
      message: "The URL has no host",
    };
  }

  // 1. IP literal — decide directly, no DNS.
  if (net.isIP(host) !== 0) {
    if (isBlockedLiteral(host)) {
      return {
        allowed: false,
        code: "HTTP_FORBIDDEN_TARGET",
        message: `Requests to ${classifyAddress(host)} addresses are not allowed by the engine network policy (${host})`,
      };
    }
    return { allowed: true };
  }

  // 2. "localhost" is reserved for the loopback interface by convention
  //    and is blocked without a DNS round-trip.
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return {
      allowed: false,
      code: "HTTP_FORBIDDEN_TARGET",
      message:
        "Requests to 'localhost' are not allowed by the engine network policy",
    };
  }

  // 3. Hostname — resolve and check EVERY address, so a name that maps
  //    to a mix of public and private addresses is still rejected.
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    return {
      allowed: false,
      code: "HTTP_NETWORK_ERROR",
      message: `Hostname '${host}' could not be resolved`,
    };
  }
  if (addresses.length === 0) {
    return {
      allowed: false,
      code: "HTTP_NETWORK_ERROR",
      message: `Hostname '${host}' did not resolve to any address`,
    };
  }
  for (const address of addresses) {
    if (isBlockedLiteral(address)) {
      return {
        allowed: false,
        code: "HTTP_FORBIDDEN_TARGET",
        message: `Hostname '${host}' resolves to a ${classifyAddress(address)} address (${address}), which the engine network policy does not allow`,
      };
    }
  }
  return { allowed: true };
}
