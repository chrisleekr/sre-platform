import type { ConnectorConfig } from '../../registry';
import { assertSafeHttpOrHttpsUrl, type HostLookup } from '../../ssrf';
import { resolveTimeMs } from '../../time';
import { obj, str } from '../../values';
import { resolveAuth, type PromAuth, type PromFetchInit } from './auth';

/** Injectable so the REST calls are unit-testable without the network. */
export type FetchLike = typeof fetch;

export const API_TIMEOUT_MS = 8000;
/** Prometheus rejects a range query exceeding this many points per timeseries. */
export const MAX_POINTS = 11_000;
/** Target point count when a range step is not supplied (a readable series that "just works"). */
export const DEFAULT_POINTS = 250;
export const MIN_STEP_S = 15;
export const DEFAULT_RANGE_FROM = 'now-1h';
export const DEFAULT_TO = 'now';
export const TRIAGE_ALERT_CAP = 25;

/**
 * Resolve a time expression to epoch milliseconds. Accepts date-math (`now`, `now-1h`), a bare epoch
 * (seconds or millis, disambiguated by magnitude), or any Date-parseable string (ISO 8601). Mirrors
 * the Datadog resolver so `start`/`end` behave identically across both metrics connectors; Prometheus
 * params are then normalized to unix seconds at the call site.
 */
const resolveMs = (expression: string, nowMs: number) =>
  resolveTimeMs(expression, nowMs, 'prometheus');

/** Resolve a time expression to unix seconds (Prometheus wants seconds, fractional allowed). */
export function resolveSeconds(expr: string, nowMs: number): number {
  return Math.floor(resolveMs(expr, nowMs) / 1000);
}

/** Optional time → unix-seconds string, or undefined when absent (endpoint applies its own default). */
export function optSeconds(expr: string | undefined, nowMs: number): string | undefined {
  return expr === undefined || expr === '' ? undefined : String(resolveSeconds(expr, nowMs));
}

/**
 * A Prometheus range `step`: a bare number/seconds or a single-unit duration (`15s`, `1m`, `2h`, `1d`,
 * `1w`). Compound durations (`1h30m`) are refused with a clear message rather than mis-parsed.
 */
export function parseStepSeconds(step: string | number): number {
  if (typeof step === 'number') return step;
  const s = step.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(\d+)(s|m|h|d|w)$/.exec(s);
  if (m)
    return (
      Number(m[1]) *
      { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 }[m[2] as 's' | 'm' | 'h' | 'd' | 'w']
    );
  throw new Error(
    `prometheus connector: unparseable step '${step}' (use seconds or e.g. 15s, 1m, 1h)`,
  );
}

/** Step for a range: the supplied value, else a default that yields ~DEFAULT_POINTS points. */
export function resolveStepSeconds(
  step: string | number | undefined,
  rangeSeconds: number,
): number {
  if (step === undefined || step === '')
    return Math.max(MIN_STEP_S, Math.ceil(rangeSeconds / DEFAULT_POINTS));
  const seconds = parseStepSeconds(step);
  // A non-positive (or NaN) step yields Infinity points; reject precisely (Prometheus refuses it too).
  if (!(seconds > 0)) throw new Error('prometheus connector: step must be positive');
  return seconds;
}

export interface PrometheusConnectorOptions {
  allowedLoopbackOrigins?: readonly string[];
}

/** Prometheus base from settings: HTTP(S) plus SSRF validation for an in-VPC backend. */
export async function resolveBase(
  settings: Record<string, unknown>,
  lookup: HostLookup,
  options: PrometheusConnectorOptions,
): Promise<string> {
  const raw = str(settings.baseUrl);
  if (!raw) throw new Error('prometheus connector: baseUrl is required');
  const url = await assertSafeHttpOrHttpsUrl(raw, lookup, {
    allowPrivate: true,
    allowedLoopbackOrigins: options.allowedLoopbackOrigins,
  });
  if (url.protocol === 'http:' && settings.authType === 'mtls') {
    throw new Error('prometheus connector: mutual TLS requires HTTPS');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Bun fetch `tls` for server trust from settings: a pinned CA (a private/self-signed Prometheus that
 * system trust cannot verify) and/or the explicit insecure escape hatch. The `mtls` auth strategy adds
 * the client cert/key on top of this; server trust and client identity are orthogonal.
 */
export function buildServerTls(settings: Record<string, unknown>): PromFetchInit['tls'] {
  const caCert = str(settings.caCert);
  const insecure = settings.insecureSkipTLSVerify === true;
  if (caCert && insecure) return { ca: caCert, rejectUnauthorized: false };
  if (caCert) return { ca: caCert };
  if (insecure) return { rejectUnauthorized: false };
  return undefined;
}

type QueryValue = string | number | string[];

/**
 * Build a validated absolute GET URL under the pinned host. The path is WHATWG-normalized (so `..`
 * collapses) and two assertions close SSRF/traversal: the origin must equal the SSRF-checked base
 * origin, and the pathname must stay under `/api/`. Array values (Prometheus `match[]`) are appended,
 * not set. GET-only by construction, so no tool routed through here can mutate.
 */
export function buildGetUrl(
  base: string,
  path: string,
  query?: Record<string, QueryValue | undefined>,
): string {
  const baseUrl = new URL(base.replace(/\/+$/, '') + '/');
  const u = new URL(path.replace(/^\/+/, ''), baseUrl);
  if (u.origin !== baseUrl.origin)
    throw new Error('prometheus connector: path escapes the configured host');
  // Guard relative to the base path (which ends in '/'), so a path-prefixed backend — Mimir/Cortex/
  // Thanos serve the Prometheus API under e.g. /prometheus/api/v1 — still validates, while a `..`
  // traversal off the base is still refused.
  if (!u.pathname.startsWith(`${baseUrl.pathname}api/`))
    throw new Error('prometheus connector: path must be under /api/');
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

/** The connection primitives shared by every read path (tools, first-pass, probe). */
export interface PromClient {
  base: string;
  auth: PromAuth;
  serverTls: PromFetchInit['tls'];
}

export async function connect(
  config: ConnectorConfig,
  lookup: HostLookup,
  options: PrometheusConnectorOptions,
): Promise<PromClient> {
  const base = await resolveBase(config.settings, lookup, options);
  // A missing/malformed credential throws here and propagates (the tool degrades to error, never a
  // fake read). `none` (unauthenticated) is an explicit credential, not an absent one.
  const auth = resolveAuth(await config.getCredential());
  return { base, auth, serverTls: buildServerTls(config.settings) };
}

/** GET a Prometheus endpoint. The credential rides a header/tls (never the URL); 8s timeout; no redirects. */
export async function pget(
  fetchImpl: FetchLike,
  client: PromClient,
  path: string,
  query?: Record<string, QueryValue | undefined>,
): Promise<unknown> {
  const url = buildGetUrl(client.base, path, query);
  const init = await client.auth.apply({
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    redirect: 'error',
    tls: client.serverTls,
  });
  const res = await fetchImpl(url, init);
  if (!res.ok)
    throw Object.assign(new Error(`prometheus api ${res.status}`), { status: res.status });
  return res.json();
}

/**
 * POST form-encoded params to a FIXED read path (`/api/v1/query` or `/api/v1/query_range`, passed as a
 * constant, never a caller value). POST avoids the GET URL-length limit on long PromQL; the endpoint is
 * a read, so this cannot mutate. base is SSRF-validated, so no per-request URL guard is needed here.
 */
export async function ppost(
  fetchImpl: FetchLike,
  client: PromClient,
  path: string,
  form: Record<string, string>,
): Promise<unknown> {
  const body = new URLSearchParams(form).toString();
  const init = await client.auth.apply({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    redirect: 'error',
    tls: client.serverTls,
  });
  const res = await fetchImpl(`${client.base}${path}`, init);
  if (!res.ok) throw new Error(`prometheus api ${res.status}`);
  return res.json();
}

export interface AlertShape {
  alertname: string | undefined;
  state: string | undefined;
  severity: string | undefined;
  activeAt: string | undefined;
  labels: Record<string, unknown>;
}

/** Reduce a Prometheus alert to the fields triage needs. */
export function mapAlert(raw: unknown): AlertShape {
  const a = obj(raw);
  const labels = obj(a.labels);
  return {
    alertname: str(labels.alertname),
    state: str(a.state),
    severity: str(labels.severity),
    activeAt: str(a.activeAt),
    labels,
  };
}

/** Best-effort: does an alert reference the incident's service? Prometheus has no universal service label. */
export function referencesService(a: AlertShape, service: string): boolean {
  const l = a.labels;
  return str(l.service) === service || str(l.job) === service || str(l.app) === service;
}

/** Bind a Zod input schema to a typed run body, returning the erased ConnectorTool (mirror of k8s/gitlab). */
