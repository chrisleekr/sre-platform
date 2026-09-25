import type { ConnectorConfig } from '../../registry';
import { assertSafeHttpOrHttpsUrl, type HostLookup } from '../../ssrf';
import { resolveTimeMs } from '../../time';
import { obj, str } from '../../values';
import { boundedSignal } from '../../request-signal';

/** Injectable so the REST calls are unit-testable without the network. */
export type FetchLike = typeof fetch;

export const API_TIMEOUT_MS = 8000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const TRIAGE_ALERT_CAP = 25;

// Grafana UIDs, datasource UIDs, and alert-rule UIDs are opaque tokens (letters, digits, `-`, `_`).
// Validate a model-controlled segment against this before interpolating so a crafted value cannot
// traverse the path or smuggle a query.
export const UID_RE = /^[A-Za-z0-9_-]+$/;

export function validateUid(field: string, value: string): string {
  if (!UID_RE.test(value)) throw new Error(`grafana connector: invalid ${field} '${value}'`);
  return value;
}

export function clampLimit(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  return Math.min(Math.max(1, Math.floor(n)), MAX_LIMIT);
}

/**
 * Resolve a time expression to epoch milliseconds (what the annotations API wants). Accepts date-math
 * (`now`, `now-1h`), a bare epoch (seconds or millis, disambiguated by magnitude), or any Date-parseable
 * string (ISO 8601). Mirrors the Prometheus/Datadog resolver so time inputs behave identically across
 * connectors; the triage prompt anchors these to the incident onset, not wall-clock now.
 */
const resolveMs = (expression: string, nowMs: number) =>
  resolveTimeMs(expression, nowMs, 'grafana');

/** Optional time → epoch-ms string, or undefined when absent (endpoint applies its own default). */
export function optMs(expr: string | undefined, nowMs: number): string | undefined {
  return expr === undefined || expr === '' ? undefined : String(resolveMs(expr, nowMs));
}

export interface TlsOpts {
  ca?: string;
  rejectUnauthorized?: boolean;
}
/** Bun's fetch accepts a `tls` option that the DOM RequestInit type omits (mirrors prometheus/argocd). */
type FetchInit = RequestInit & { tls?: TlsOpts };

/**
 * Bun fetch `tls` for server trust from settings: a pinned CA (a private/self-signed Grafana ingress
 * that system trust cannot verify) and/or the explicit insecure escape hatch. Same vocabulary as the
 * Prometheus/ArgoCD connectors. Grafana auth is a service-account bearer token, so there is no client
 * cert here.
 */
export function buildServerTls(settings: Record<string, unknown>): TlsOpts | undefined {
  const caCert = str(settings.caCert);
  const insecure = settings.insecureSkipTLSVerify === true;
  if (caCert && insecure) return { ca: caCert, rejectUnauthorized: false };
  if (caCert) return { ca: caCert };
  if (insecure) return { rejectUnauthorized: false };
  return undefined;
}

export interface GrafanaConnectorOptions {
  allowedLoopbackOrigins?: readonly string[];
}

/** Grafana base from settings: HTTP(S) plus SSRF validation for a self-hosted server. */
export async function resolveBase(
  settings: Record<string, unknown>,
  lookup: HostLookup,
  options: GrafanaConnectorOptions,
): Promise<string> {
  const raw = str(settings.baseUrl);
  if (!raw) throw new Error('grafana connector: baseUrl is required');
  const url = await assertSafeHttpOrHttpsUrl(raw, lookup, {
    allowPrivate: true,
    allowedLoopbackOrigins: options.allowedLoopbackOrigins,
  });
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

type QueryValue = string | number | boolean | string[];

/**
 * Build a validated absolute GET URL under the SSRF-checked host. The path is WHATWG-normalized (so `..`
 * collapses) and three assertions close SSRF/traversal: the origin must equal the validated base origin,
 * the pathname must stay under `<base>/api/` (a path-prefixed reverse proxy still validates), and the
 * pathname must carry no percent-encoding. The last one lets the `api_get` proxy denylist compare decoded
 * segments without an encoded `datasources/%70roxy` slipping past. Grafana paths are UIDs, fixed segments,
 * and hyphenated names, none of which need `%`; query values live in the search component. GET-only by
 * construction, so no tool routed through here can mutate.
 */
export function buildGetUrl(
  base: string,
  path: string,
  query?: Record<string, QueryValue | undefined>,
): string {
  const baseUrl = new URL(base.replace(/\/+$/, '') + '/');
  const u = new URL(path.replace(/^\/+/, ''), baseUrl);
  if (u.origin !== baseUrl.origin)
    throw new Error('grafana connector: path escapes the configured host');
  if (!u.pathname.startsWith(`${baseUrl.pathname}api/`))
    throw new Error('grafana connector: path must be under /api/');
  if (u.pathname.includes('%'))
    throw new Error('grafana connector: percent-encoded path segments are not allowed');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) {
        for (const item of v) if (item !== '') u.searchParams.append(k, String(item));
      } else {
        u.searchParams.set(k, String(v));
      }
    }
  }
  return u.toString();
}

/**
 * Refuse the datasource proxy/resources paths in `api_get`. Grafana is an aggregator: `/api/ds/query`
 * (POST, already blocked by GET-only construction) and `GET /api/datasources/proxy/*` +
 * `GET /api/datasources/uid/:uid/resources/*` tunnel a raw downstream-datasource response, which can echo
 * a credential the datasource itself did not redact. Denying them keeps this connector to Grafana's own
 * (secret-redacted) API, so there is exactly one no-un-redacted-secret invariant and no bespoke scrubber.
 * `%` is already rejected by buildGetUrl, so a decoded segment comparison is sufficient. The broad
 * `includes('resources')` intentionally over-blocks (fail-closed): it covers both the uid- and legacy
 * numeric-id resources variants, at the cost of refusing a datasource whose uid is literally `resources`
 * (implausible; `list_datasources` still reads it). Over-blocking here is safe; a bypass would not be.
 */
export function isDeniedProxyPath(pathname: string): boolean {
  const segs = pathname.split('/').filter(Boolean);
  const dsIdx = segs.indexOf('datasources');
  if (dsIdx === -1) return false;
  const rest = segs.slice(dsIdx + 1);
  return rest[0] === 'proxy' || rest.includes('resources');
}

/** The connection primitives shared by every read path (tools, first-pass, probe). */
export interface GrafanaClient {
  base: string;
  token: string;
  serverTls: TlsOpts | undefined;
  /** Caller cancellation for tool reads; absent on probe and first-pass paths. */
  signal?: AbortSignal;
}

export async function connect(
  config: ConnectorConfig,
  lookup: HostLookup,
  options: GrafanaConnectorOptions,
): Promise<GrafanaClient> {
  const base = await resolveBase(config.settings, lookup, options);
  // A missing credential throws here and propagates (the tool degrades to error, never a fake read).
  const token = (await config.getCredential()).trim();
  if (!token) throw new Error('grafana connector: credential (service-account token) is required');
  return { base, token, serverTls: buildServerTls(config.settings) };
}

/** Request init: the service-account token rides a header (never the URL), 8s timeout, no redirects. */
export function gInit(client: GrafanaClient): FetchInit {
  return {
    headers: { Authorization: `Bearer ${client.token}`, Accept: 'application/json' },
    signal: boundedSignal(API_TIMEOUT_MS, client.signal),
    redirect: 'error',
    tls: client.serverTls,
  };
}

/** GET a Grafana endpoint and parse JSON. */
export async function gget(
  fetchImpl: FetchLike,
  client: GrafanaClient,
  path: string,
  query?: Record<string, QueryValue | undefined>,
): Promise<unknown> {
  const res = await fetchImpl(buildGetUrl(client.base, path, query), gInit(client));
  if (!res.ok) throw Object.assign(new Error(`grafana api ${res.status}`), { status: res.status });
  return res.json();
}

export interface AlertShape {
  alertname: string | undefined;
  severity: string | undefined;
  state: string | undefined;
  startsAt: string | undefined;
  labels: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

/** Reduce a Grafana Alertmanager v2 alert to the fields first-pass triage needs. */
export function mapAlert(raw: unknown): AlertShape {
  const a = obj(raw);
  const labels = obj(a.labels);
  return {
    alertname: str(labels.alertname),
    severity: str(labels.severity),
    state: str(obj(a.status).state),
    startsAt: str(a.startsAt),
    labels,
    annotations: obj(a.annotations),
  };
}

/** Best-effort: does an alert reference the incident's service? Grafana has no universal service label. */
export function referencesService(a: AlertShape, service: string): boolean {
  const l = a.labels;
  return str(l.service) === service || str(l.job) === service || str(l.app) === service;
}

/** Bind a Zod input schema to a typed run body, returning the erased ConnectorTool (mirror of siblings). */
