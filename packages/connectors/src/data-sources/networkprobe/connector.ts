import { resolveCname as dnsResolveCname } from 'node:dns/promises';
import net from 'node:net';
import * as z from 'zod';
import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import { staticEntityCoverage } from '../../entity-coverage';
import { dnsLookup, isBlockedIp, type HostLookup } from '../../ssrf';
import type {
  ConnectorTool,
  IDataSourceConnector,
  ProbeResult,
  ToolRunOptions,
  TriageContext,
} from '../../types';
import type { ProbeSocketDeps, RawTlsResult } from './types';
import { defaultHttpHead, defaultTcpConnect, defaultTlsConnect } from './socket';

export type { ProbeSocketDeps } from './types';
export { headRequestTarget, headSliceIfComplete, parseHttpHead } from './socket';

// On-demand network reachability probe. Unlike every other connector this has no
// backend, credential, or settings: its inputs are arbitrary incident-discovered hostnames, so it is
// the one connector where DNS-rebind is the primary threat, not a marginal one. The guard is a true
// resolve-once-validate-pin: resolve the host, reject if ANY resolved IP is non-public (isBlockedIp
// with no allowPrivate), then connect to that exact validated IP (never re-resolve). Public-only,
// metadata-only (no response body is ever read), one connection per call (no ranges/loops), so the
// tool surface cannot express a port scan. Egress network policy + IMDSv2 is the deploy-time
// backstop, this app-layer pin is defense-in-depth.

const TCP_TIMEOUT_MS = 5000;
const TLS_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 8000;
const DNS_TIMEOUT_MS = 3000;
const DEFAULT_PORT = 443;

const NETWORK_PROBE_CONNECTOR = {
  type: 'networkprobe',
  capabilities: {
    alertLifecycle: 'none',
    topology: 'on_demand',
    availability: 'ready',
    configuration: 'builtin',
    instances: 'singleton',
    investigation: 'tools',
    polling: 'none',
    events: 'none',
  },
} as const;

/** A literal IP needs no DNS round-trip; mirror ssrf.ts's private isLiteralIp. */
function isLiteralIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

function ipFamily(ip: string): 'IPv4' | 'IPv6' {
  return ip.includes(':') ? 'IPv6' : 'IPv4';
}

/**
 * Canonicalize an IP literal before classification. isBlockedIp matches IPv6 by fixed textual shapes and
 * never compresses, so a non-canonical spelling (0:0:0:0:0:0:0:1, ::01) would slip its '::1' loopback
 * check and be dialed straight to ::1. Every other isBlockedIp caller feeds a WHATWG-parsed url.hostname
 * (already compressed); this connector takes a raw model-supplied host, so it must canonicalize here.
 * Reuse the WHATWG IPv6 serializer (which also rejects zone-ids and junk); reject a malformed IPv4.
 */
function canonicalizeLiteral(h: string): string {
  if (!h.includes(':')) {
    if (net.isIP(h) !== 4) throw new Error('networkprobe: invalid host');
    return h;
  }
  try {
    return new URL(`http://[${h}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error('networkprobe: invalid host');
  }
}

/** Reject a rejection that outlives its deadline; the dangling op is harmless. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

// -------- pure helpers (fully unit-tested) --------

/**
 * Resolve-once-validate-pin. A literal IP is validated directly (no DNS); a hostname is resolved and
 * EVERY address validated, so a split DNS answer of [public, private] is rejected wholesale (an
 * attacker cannot get us to pick the private one). Public-only: isBlockedIp with no allowPrivate.
 * Returns the validated IPs; the caller connects to one of them, never re-resolving.
 */
export async function resolvePublicTarget(
  host: string,
  lookup: HostLookup,
): Promise<{ host: string; ips: string[] }> {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h || /\s/.test(h)) throw new Error('networkprobe: invalid host');
  if (h === 'localhost' || h.endsWith('.localhost'))
    throw new Error('networkprobe: host not allowed');

  if (isLiteralIp(h)) {
    const canonical = canonicalizeLiteral(h);
    if (isBlockedIp(canonical))
      throw new Error('networkprobe: host resolves to a non-public address');
    return { host: canonical, ips: [canonical] };
  }

  const ips = await withTimeout(lookup(h), DNS_TIMEOUT_MS, 'networkprobe: dns');
  if (ips.length === 0) throw new Error('networkprobe: host does not resolve');
  if (ips.some((ip) => isBlockedIp(ip)))
    throw new Error('networkprobe: host resolves to a non-public address');
  return { host: h, ips };
}

/** Shape a peer cert into the triage payload: leaf fields + trust verdict + computed expiry. */
export function mapCert(raw: RawTlsResult, nowMs: number): Record<string, unknown> {
  const c = raw.cert;
  const validToMs = c.valid_to ? Date.parse(c.valid_to) : NaN;
  const daysToExpiry = Number.isFinite(validToMs)
    ? Math.floor((validToMs - nowMs) / 86_400_000)
    : null;
  return {
    authorized: raw.authorized,
    authorizationError: raw.authorizationError,
    protocol: raw.protocol,
    cipher: raw.cipher,
    subject: c.subject ?? null,
    issuer: c.issuer ?? null,
    valid_from: c.valid_from ?? null,
    valid_to: c.valid_to ?? null,
    subjectAltName: c.subjectaltname ?? null,
    serialNumber: c.serialNumber ?? null,
    fingerprint256: c.fingerprint256 ?? null,
    daysToExpiry,
    expired: Number.isFinite(validToMs) ? validToMs < nowMs : null,
  };
}

function withDefaults(deps: Partial<ProbeSocketDeps>): ProbeSocketDeps {
  return {
    lookup: deps.lookup ?? dnsLookup,
    resolveCname: deps.resolveCname ?? ((h) => dnsResolveCname(h).catch(() => [])),
    tcpConnect: deps.tcpConnect ?? defaultTcpConnect,
    tlsConnect: deps.tlsConnect ?? defaultTlsConnect,
    httpHead: deps.httpHead ?? defaultHttpHead,
  };
}

// -------- tools --------

function stool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>) => Promise<unknown>;
}): ConnectorTool {
  return {
    ...def,
    run: (input: z.infer<S>, options?: ToolRunOptions) =>
      untilAborted(() => def.run(input), options?.signal),
  } as ConnectorTool;
}

/**
 * Refuse to start once the caller is cancelled, and stop waiting when it cancels mid-probe. The
 * socket is not threaded through the injected socket layer, so it still ends at its own short
 * timeout; only the caller is released early.
 */
async function untilAborted<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return start();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    start()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const portSchema = z.number().int().min(1).max(65535).optional();

function makeNetworkProbeTools(deps: ProbeSocketDeps): ConnectorTool[] {
  return [
    stool({
      name: 'resolve_dns',
      description:
        'Resolve a hostname to its A/AAAA addresses and CNAME chain (pure DNS lookup, no connection). ' +
        'Each address is tagged public true/false; a host that resolves into private/metadata space is ' +
        'REPORTED (a real misconfiguration signal), not hidden. Use to answer "where does this name point".',
      inputSchema: z.object({ host: z.string() }),
      run: async ({ host }) => {
        const h = host
          .trim()
          .toLowerCase()
          .replace(/^\[|\]$/g, '');
        if (!h) throw new Error('networkprobe: invalid host');
        if (isLiteralIp(h)) {
          const canonical = canonicalizeLiteral(h);
          return {
            host: canonical,
            addresses: [
              { ip: canonical, family: ipFamily(canonical), public: !isBlockedIp(canonical) },
            ],
            cname: [],
          };
        }
        const ips = await withTimeout(deps.lookup(h), DNS_TIMEOUT_MS, 'networkprobe: dns');
        const cname = await withTimeout(
          deps.resolveCname(h),
          DNS_TIMEOUT_MS,
          'networkprobe: dns',
        ).catch(() => []);
        return {
          host: h,
          addresses: ips.map((ip) => ({ ip, family: ipFamily(ip), public: !isBlockedIp(ip) })),
          cname,
        };
      },
    }),
    stool({
      name: 'check_reachable',
      description:
        'Open a single TCP connection to host:port and report reachability + latency (the "is it up" ' +
        'check). No data is sent or read. host may be a hostname or a public IP literal; port defaults to 443.',
      inputSchema: z.object({ host: z.string(), port: portSchema }),
      run: async ({ host, port }) => {
        const p = port ?? DEFAULT_PORT;
        const { host: h, ips } = await resolvePublicTarget(host, deps.lookup);
        const targetIp = ips[0]!;
        try {
          const latencyMs = await deps.tcpConnect(targetIp, p, TCP_TIMEOUT_MS);
          return { host: h, targetIp, port: p, reachable: true, latencyMs };
        } catch (e) {
          return {
            host: h,
            targetIp,
            port: p,
            reachable: false,
            error: e instanceof Error ? e.message : 'connect failed',
          };
        }
      },
    }),
    stool({
      name: 'inspect_tls',
      description:
        'Complete a TLS handshake to host:port and return the leaf certificate + trust verdict: subject, ' +
        'issuer, validity dates, SAN, fingerprint, negotiated protocol/cipher, computed daysToExpiry/expired, ' +
        'and authorized/authorizationError. Reports broken certs (expired, self-signed, wrong host) as data ' +
        'rather than failing. port defaults to 443.',
      inputSchema: z.object({ host: z.string(), port: portSchema }),
      run: async ({ host, port }) => {
        const p = port ?? DEFAULT_PORT;
        const { host: h, ips } = await resolvePublicTarget(host, deps.lookup);
        const targetIp = ips[0]!;
        const raw = await deps.tlsConnect(targetIp, h, p, TLS_TIMEOUT_MS);
        return { host: h, targetIp, port: p, ...mapCert(raw, Date.now()) };
      },
    }),
    stool({
      name: 'http_meta',
      description:
        'Send a single HTTP HEAD to a URL and return only the status code and response headers (no body is ' +
        'ever read). Redirects are NOT followed: a 3xx returns its status + Location for the model to probe ' +
        'as a fresh call. url must be http or https; the host may be a public IP literal. For https, ' +
        'tlsAuthorized:false means the certificate did not verify, so status and headers may come from an ' +
        'interceptor rather than the host, and targetWithheld:true means only / was requested, so the status is for / and not the given path.',
      inputSchema: z.object({ url: z.string() }),
      run: async ({ url }) => {
        let u: URL;
        try {
          u = new URL(url);
        } catch {
          throw new Error('networkprobe: invalid url');
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
          throw new Error('networkprobe: url must be http or https');
        const scheme = u.protocol === 'https:' ? 'https' : 'http';
        const { host: h, ips } = await resolvePublicTarget(u.hostname, deps.lookup);
        const targetIp = ips[0]!;
        const port = u.port ? Number(u.port) : scheme === 'https' ? 443 : 80;
        const path = `${u.pathname}${u.search}` || '/';
        const result = await deps.httpHead(
          targetIp,
          u.host,
          h,
          port,
          scheme,
          path,
          HTTP_TIMEOUT_MS,
        );
        return { url: u.toString(), targetIp, ...result };
      },
    }),
  ];
}

/**
 * Creates the on-demand network probe adapter without a persistent provider backend.
 *
 * @remarks Targets are resolved once, validated as public, and pinned for the socket operation.
 * @param config - Built-in connector identity and settings.
 * @param deps - Injectable DNS and socket operations used by probes.
 */
export function makeNetworkProbeConnector(
  config: ConnectorConfig,
  deps: Partial<ProbeSocketDeps> = {},
): IDataSourceConnector {
  const d = withDefaults(deps);
  return createDataSourceConnector(config, NETWORK_PROBE_CONNECTOR, {
    entityCoverage: staticEntityCoverage(['availability'], ['endpoint', 'host']),
    async snapshot() {
      throw new Error(
        'networkprobe has no snapshot: probes are on-demand against a supplied target',
      );
    },
    async fetchTriageContext(query): Promise<TriageContext> {
      return {
        source: 'networkprobe',
        data: {
          service: query.service,
          windowMinutes: query.windowMinutes,
          note: 'networkprobe is on-demand only; no first-pass seed without a target host',
        },
      };
    },
    tools: () => makeNetworkProbeTools(d),
    async probe(): Promise<ProbeResult> {
      return {
        status: 'not_applicable',
        reachable: false,
        authorized: false,
        warnings: [
          'networkprobe has no backend to test; its tools probe supplied targets on demand',
        ],
      };
    },
  });
}

export const networkProbeConnectorDefinition = defineConnector({
  ...NETWORK_PROBE_CONNECTOR,
  create: makeNetworkProbeConnector,
});
