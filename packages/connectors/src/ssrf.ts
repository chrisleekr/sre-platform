import { lookup as dnsLookupPromise } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Shared SSRF guard for tenant-configured connector base URLs (CWE-918). This is
 * defense-in-depth: resolve-and-validate closes the static-hostname-into-private-space gap the
 * old string-only host check missed. A residual TOCTOU remains (the actual fetch re-resolves the
 * name and could land on a rebind), so the authoritative control is the worker egress network
 * policy plus IMDSv2 at deploy time (issue); this layer is not a substitute for it.
 */

/** Resolves a hostname to its IP strings. Injectable so validation is unit-testable without DNS. */
export type HostLookup = (hostname: string) => Promise<string[]>;

/**
 * SSRF-check options. `allowPrivate` relaxes the guard to permit RFC1918/CGNAT (IPv4) and ULA (IPv6)
 * targets — for a backend that legitimately lives on a private network (e.g. a tenant's in-VPC
 * Prometheus). The always-dangerous ranges (unspecified, 169.254 link-local incl. cloud metadata,
 * IPv6 link/site-local) stay blocked regardless. Exact supervised loopback origins are admitted by the
 * URL guard, not this IP-range option. Default (options absent) keeps every range blocked.
 */
export interface IpCheckOptions {
  allowPrivate?: boolean;
}

export interface UrlCheckOptions extends IpCheckOptions {
  /** Restrict every resolved address to private networks, even when public HTTPS is allowed elsewhere. */
  requirePrivate?: boolean;
  /** Exact loopback origins exposed by supervised local-development tunnels. */
  allowedLoopbackOrigins?: readonly string[];
}

const privateNetworks = new BlockList();
privateNetworks.addSubnet('10.0.0.0', 8, 'ipv4');
privateNetworks.addSubnet('172.16.0.0', 12, 'ipv4');
privateNetworks.addSubnet('192.168.0.0', 16, 'ipv4');
privateNetworks.addSubnet('100.64.0.0', 10, 'ipv4');
privateNetworks.addSubnet('fc00::', 7, 'ipv6');

/**
 * Resolves every address record for an SSRF-validated hostname.
 *
 * @param hostname - Hostname to resolve before a connector request.
 */
export const dnsLookup: HostLookup = async (hostname) => {
  const rs = await dnsLookupPromise(hostname, { all: true });
  return rs.map((r) => r.address);
};

/** Decode two IPv6 hextets into a dotted IPv4 (e.g. 0808:0808 -> 8.8.8.8). */
function hextetsToV4(hexA: string, hexB: string): string {
  const a = parseInt(hexA, 16);
  const b = parseInt(hexB, 16);
  return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
}

/** True if a dotted-quad IPv4 is not a globally reachable unicast destination. */
function isBlockedIpv4(ip: string, opts?: IpCheckOptions): boolean {
  const octets = ip.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return true;
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  // Private/CGNAT ranges are the allowed target under allowPrivate; the always-dangerous ranges above
  // are checked first and still block.
  if (!opts?.allowPrivate) {
    if (a === 10) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  }
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark networks
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast and reserved space
  return false;
}

/**
 * Checks whether an address targets a range forbidden by the connector SSRF policy.
 *
 * @remarks Embedded IPv4 forms in mapped IPv6, 6to4, and NAT64 addresses use the same policy.
 * @param ip - IPv4 or IPv6 address to classify.
 * @param opts - Private-network exceptions allowed by the caller.
 */
export function isBlockedIp(ip: string, opts?: IpCheckOptions): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, '');

  // Pure IPv4.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isBlockedIpv4(h, opts);

  // Not IPv6 → nothing more to check.
  if (!h.includes(':')) return false;

  if (h === '::1') return true; // loopback
  if (h === '::' || h === '::0') return true; // unspecified

  // IPv4-mapped: extract the trailing IPv4 and validate that.
  const dotted = h.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedIpv4(dotted[1]!, opts);
  const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) return isBlockedIpv4(hextetsToV4(hexMapped[1]!, hexMapped[2]!), opts);
  // IPv4-compatible ::/96 (RFC 4291, deprecated): ::X:Y embeds an IPv4, e.g. ::7f00:1 == ::127.0.0.1.
  // Kept after the ::ffff hexMapped branch so mapped addresses match there first. Under allowPrivate it
  // decodes and re-checks; by default it stays fully blocked (byte-identical to before).
  const hexCompat = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexCompat) {
    if (!opts?.allowPrivate) return true;
    return isBlockedIpv4(hextetsToV4(hexCompat[1]!, hexCompat[2]!), opts);
  }

  const first = h.split(':')[0] ?? '';
  if (first.startsWith('ff')) return true; // multicast
  if (first === '100') return true; // discard-only 100::/64
  if (first === '2001') {
    const second = parseInt(h.split(':')[1] || '0', 16);
    if (second <= 0x1ff || second === 0xdb8) return true; // special-purpose and documentation
  }
  if (first === '3fff' || first === '5f00') return true; // documentation and segment routing
  if (first === '2002') {
    // 6to4 2002::/16 (RFC 3056) embeds an IPv4 in the next two hextets. Default: fully blocked. Under
    // allowPrivate: decode and re-check (a 6to4-wrapped private target is allowed, a link-local one not).
    if (!opts?.allowPrivate) return true;
    const m = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
    return m ? isBlockedIpv4(hextetsToV4(m[1]!, m[2]!), opts) : true;
  }
  if (h.startsWith('64:ff9b:')) {
    // NAT64 64:ff9b::/96 (RFC 6052) embeds an IPv4 in the trailing hextets (the dotted form was already
    // handled above). Default: fully blocked. Under allowPrivate: decode and re-check.
    if (!opts?.allowPrivate) return true;
    const m = h.match(/([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    return m ? isBlockedIpv4(hextetsToV4(m[1]!, m[2]!), opts) : true;
  }
  if (/^fe[89abcdef]/.test(first)) return true; // fe80::/10 link-local + fec0::/10 site-local (RFC 3879)
  // fc00::/7 unique-local: a private range, allowed under allowPrivate, blocked by default.
  if (/^f[cd]/.test(first)) return !opts?.allowPrivate;
  return false;
}

/** True if a hostname is a literal IP (dotted IPv4 or contains a colon for IPv6). */
function isLiteralIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

function allowsLoopbackOrigin(url: URL, host: string, opts?: UrlCheckOptions): boolean {
  if (host !== '127.0.0.1' && host !== '::1') return false;
  return Boolean(
    opts?.allowedLoopbackOrigins?.some((raw) => {
      try {
        return new URL(raw).origin === url.origin;
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Parse `raw`, enforce the caller's protocols, reject a literal blocked-IP or localhost host pre-DNS,
 * then resolve the host and reject if resolution is empty or ANY resolved IP is blocked.
 */
async function assertSafeUrl(
  raw: string,
  protocols: readonly string[],
  lookup: HostLookup = dnsLookup,
  opts?: UrlCheckOptions,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('connector: invalid baseUrl');
  }
  if (!protocols.includes(url.protocol)) {
    const expected = protocols.map((protocol) => protocol.replace(':', '')).join(' or ');
    throw new Error(`connector: baseUrl must be ${expected}`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopbackAllowed = allowsLoopbackOrigin(url, host, opts);
  // localhost resolves to loopback; blocked regardless of allowPrivate.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('connector: baseUrl host not allowed');
  }
  // A literal blocked IP must be caught before DNS (there is nothing to resolve).
  if (isLiteralIp(host) && isBlockedIp(host, opts) && !loopbackAllowed) {
    throw new Error('connector: baseUrl host not allowed');
  }

  // A validated literal needs no DNS round-trip, and a bracketed IPv6 literal must not be passed
  // (bracketed) to the resolver. host is already bracket-stripped and lowercased.
  const ips = isLiteralIp(host) ? [host] : await lookup(host);
  if (ips.length === 0) {
    throw new Error('connector: baseUrl host does not resolve');
  }
  // Explicit arrow (not a bare `isBlockedIp` reference) so `some`'s index arg is never passed as opts.
  if (!loopbackAllowed && ips.some((ip) => isBlockedIp(ip, opts))) {
    throw new Error('connector: baseUrl host not allowed');
  }
  if (
    opts?.requirePrivate &&
    ips.some((ip) => !isIP(ip) || !privateNetworks.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4'))
  ) {
    throw new Error('connector: HTTP requires an internal address; use HTTPS for public servers');
  }
  return url;
}

/**
 * Validates an HTTPS connector URL and every address to which its hostname resolves.
 *
 * @param raw - Tenant-configured connector URL.
 * @param lookup - DNS resolver used to validate resolved addresses.
 * @param opts - Private-network and supervised-loopback exceptions.
 */
export function assertSafeHttpsUrl(
  raw: string,
  lookup: HostLookup = dnsLookup,
  opts?: UrlCheckOptions,
): Promise<URL> {
  return assertSafeUrl(raw, ['https:'], lookup, opts);
}

/**
 * Validates an HTTP or HTTPS connector URL and every resolved address.
 *
 * @param raw - Tenant-configured connector URL.
 * @param lookup - DNS resolver used to validate resolved addresses.
 * @param opts - Private-network and supervised-loopback exceptions.
 */
export function assertSafeHttpOrHttpsUrl(
  raw: string,
  lookup: HostLookup = dnsLookup,
  opts?: UrlCheckOptions,
): Promise<URL> {
  return assertSafeUrl(raw, ['http:', 'https:'], lookup, opts);
}
