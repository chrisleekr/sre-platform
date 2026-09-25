import { datadogLifecycle } from './lifecycle';
import * as z from 'zod';
import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import { dataSourceEntityCoverage } from '../../entity-coverage';
import { resolveTimeMs } from '../../time';
import type {
  ConnectorTool,
  IDataSourceConnector,
  ProbeResult,
  ToolRunOptions,
  TriageContext,
} from '../../types';
import { boundedSignal } from '../../request-signal';
import { obj, str } from '../../values';
import { datadogTopology } from './topology';
import { topologyFetch } from '../../topology-transport';

/** Injectable so the REST calls are unit-testable without the network. */
type FetchLike = typeof fetch;

/**
 * The nine documented Datadog sites (getting_started/site). base is always `https://api.<site>`.
 * Allowlisting the closed set is stronger than an SSRF/DNS guard and needs none: the origin is
 * fully determined by our own code, so the API and application keys can only ever reach a real
 * Datadog host, never an attacker-chosen one (CWE-918). Datadog is SaaS, so there is no self-hosted
 * URL to accept (unlike GitLab/k8s).
 */
const DD_SITES: ReadonlySet<string> = new Set([
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'uk1.datadoghq.com',
  'ddog-gov.com',
  'us2.ddog-gov.com',
]);
const DEFAULT_SITE = 'datadoghq.com';

/**
 * Datadog reads require BOTH an API key and an application key (docs: "Requests that read data
 * require full access and also require an application key"). Both are secrets, so both live in the
 * single AES-GCM credential as named-key JSON; the non-secret site lives in settings,
 * mirroring the k8s apiUrl/caCert split. The credential contract (one opaque string) is unchanged.
 */
const DdCreds = z.object({ apiKey: z.string().min(1), appKey: z.string().min(1) });

const API_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const DEFAULT_FROM = 'now-15m';
const DEFAULT_TO = 'now';

const DATADOG_CONNECTOR = {
  type: 'datadog',
  capabilities: {
    alertLifecycle: 'events_and_read',
    topology: 'inventory',
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'none',
    events: 'authenticated',
  },
} as const;

function resolveBase(settings: Record<string, unknown>): string {
  const site = str(settings.site) ?? DEFAULT_SITE;
  if (!DD_SITES.has(site)) throw new Error(`datadog connector: unknown site '${site}'`);
  return `https://api.${site}`;
}

async function resolveHeaders(config: ConnectorConfig): Promise<Record<string, string>> {
  let creds: z.infer<typeof DdCreds>;
  try {
    creds = DdCreds.parse(JSON.parse(await config.getCredential()));
  } catch {
    throw new Error('datadog connector: credential must be JSON {"apiKey","appKey"}');
  }
  return { 'DD-API-KEY': creds.apiKey, 'DD-APPLICATION-KEY': creds.appKey };
}

/**
 * Resolve a time expression to epoch milliseconds. Accepts Datadog date-math (`now`, `now-15m`), a
 * bare epoch (seconds or millis, disambiguated by magnitude), or any Date-parseable string (ISO
 * 8601). Used only where an endpoint needs an absolute number (error-tracking wants millis,
 * query_metrics wants seconds); the logs/spans/events searches take date-math strings verbatim.
 */
const resolveMs = (expression: string, nowMs: number) =>
  resolveTimeMs(expression, nowMs, 'datadog');

function clampLimit(n?: number): number {
  return Math.min(Math.max(1, Math.floor(n ?? DEFAULT_LIMIT)), MAX_LIMIT);
}

/**
 * Build a validated absolute GET URL under the pinned host. The path is resolved with WHATWG URL
 * normalization (so `..` collapses) and two assertions close SSRF/traversal: the origin must equal
 * the allowlisted base origin, and the pathname must stay under `/api/`. GET-only by construction,
 * so no tool routed through here can mutate.
 */
export function buildGetUrl(
  base: string,
  path: string,
  query?: Record<string, string | number>,
): string {
  const baseUrl = new URL(base.replace(/\/+$/, '') + '/');
  const u = new URL(path.replace(/^\/+/, ''), baseUrl);
  if (u.origin !== baseUrl.origin)
    throw new Error('datadog connector: path escapes the configured host');
  if (!u.pathname.startsWith('/api/'))
    throw new Error('datadog connector: path must be under /api/');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

async function ddGet(
  fetchImpl: FetchLike,
  base: string,
  headers: Record<string, string>,
  path: string,
  query?: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = buildGetUrl(base, path, query);
  // The keys ride DD-API-KEY/DD-APPLICATION-KEY headers, never the URL. fetch has no default
  // timeout; bound it so a slow host cannot wedge the tool call and worker slot (CWE-400). A 3xx
  // must not bounce the keys to another host, so redirect:'error'.
  const res = await fetchImpl(url, {
    headers,
    signal: boundedSignal(API_TIMEOUT_MS, signal),
    redirect: 'error',
  });
  if (!res.ok) throw datadogHttpError(res);
  return res.json();
}

/**
 * POST to a FIXED read path (the caller passes a constant from the search map, never a user value),
 * so this cannot reach a mutating endpoint. base is allowlisted, so no URL guard is needed here.
 */
async function ddPost(
  fetchImpl: FetchLike,
  base: string,
  headers: Record<string, string>,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: boundedSignal(API_TIMEOUT_MS, signal),
    redirect: 'error',
  });
  if (!res.ok) throw datadogHttpError(res);
  return res.json();
}

type SearchDomain = 'logs' | 'spans' | 'events' | 'error_tracking';

function datadogHttpError(response: Response) {
  const header = response.status === 429 ? response.headers.get('retry-after') : null;
  const delay =
    header && /^\d+$/.test(header)
      ? Number(header) * 1000
      : header
        ? Date.parse(header) - Date.now()
        : 300_000;
  return Object.assign(new Error(`datadog api ${response.status}`), {
    status: response.status,
    ...(response.status === 429
      ? {
          retryAfterMs: Number.isFinite(delay)
            ? Math.max(300_000, Math.min(delay, 86_400_000))
            : 300_000,
        }
      : {}),
  });
}

/**
 * Map a search domain to its fixed read path and request body. The bodies are NOT uniform across
 * products: logs/events are flat `{filter,sort,page}` taking date-math strings; spans wraps the same
 * in `data.attributes`; error-tracking uses `data.attributes.{query,from,to,track}` with epoch-ms
 * bounds and a required track (default `trace`, i.e. APM errors). The path is a constant per domain,
 * so the model selects a read endpoint by enum and can never supply a POST path.
 */
function buildSearch(
  domain: SearchDomain,
  query: string,
  from: string,
  to: string,
  limit: number,
  nowMs: number,
): { path: string; body: unknown } {
  const flat = (path: string) => ({
    path,
    body: { filter: { query, from, to }, sort: '-timestamp', page: { limit } },
  });
  switch (domain) {
    case 'logs':
      return flat('/api/v2/logs/events/search');
    case 'events':
      return flat('/api/v2/events/search');
    case 'spans':
      return {
        path: '/api/v2/spans/events/search',
        body: {
          data: {
            attributes: { filter: { query, from, to }, sort: '-timestamp', page: { limit } },
            type: 'search_request',
          },
        },
      };
    case 'error_tracking':
      return {
        path: '/api/v2/error-tracking/issues/search',
        body: {
          data: {
            attributes: {
              query,
              from: resolveMs(from, nowMs),
              to: resolveMs(to, nowMs),
              track: 'trace',
            },
            type: 'search_request',
          },
        },
      };
  }
}

/** Reduce a v2 log event to the fields triage needs; bound the message so a first-pass stays small. */
function mapLog(raw: unknown): Record<string, unknown> {
  const a = obj(obj(raw).attributes);
  return {
    at: str(a.timestamp),
    status: str(a.status),
    service: str(a.service),
    message: str(a.message)?.slice(0, 500),
  };
}

/** Bind a Zod input schema to a typed run body, returning the erased ConnectorTool (mirror of k8s/gitlab). */
function dtool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>, options?: ToolRunOptions) => Promise<unknown>;
}): ConnectorTool {
  return def as ConnectorTool;
}

/**
 * Datadog granular triage tools. Three tools give full read breadth over the
 * pinned SaaS host: `api_get` is a GET-only passthrough over the whole `/api/...` surface (monitors,
 * hosts, SLOs, dashboards, incidents, APM services, metric metadata, list endpoints); `search` is
 * the POST power-search across logs / APM spans / events / error-tracking; `query_metrics` reads a
 * metric timeseries. Every read requires both keys. GET-only + enum-selected fixed POST paths mean
 * no tool can mutate. Output redaction is the dispatch layer's single choke point, so there is
 * no bespoke sanitizer here. Datadog's triage reads are arbitrary application content (logs / spans
 * / events, like k8s pod logs). Where a read IS structured (a key-management endpoint reachable via
 * `api_get` returns the secret under a `key`/`token`-named field), the dispatch pass redacts it by
 * key name. The only residual is a secret in a non-sensitively-named free-text field whose value the
 * format scrub misses (e.g. a hex token inside a webhook `url`) — the same accepted best-effort limit
 * as k8s pod logs and GitLab job traces; network egress and per-tenant key handling stay authoritative.
 */
function makeDatadogTools(config: ConnectorConfig, fetchImpl: FetchLike): ConnectorTool[] {
  const settings = config.settings;
  const conn = async (): Promise<{ base: string; headers: Record<string, string> }> => ({
    base: resolveBase(settings),
    headers: await resolveHeaders(config),
  });

  return [
    dtool({
      name: 'api_get',
      description:
        'GET any Datadog REST endpoint by path (e.g. "api/v1/monitor", "api/v1/monitor/123", ' +
        '"api/v2/error-tracking/issues/{id}", "api/v1/slo"). Read-only. Optional query params. Use ' +
        'this for anything the search and metric tools do not cover: monitors, SLOs, hosts, ' +
        'dashboards, incidents, APM services, metric metadata.',
      inputSchema: z.object({
        path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
      run: async ({ path, query }, call) => {
        const { base, headers } = await conn();
        return ddGet(fetchImpl, base, headers, path, query, call?.signal);
      },
    }),
    dtool({
      name: 'search',
      description:
        'Search Datadog observability data. domain selects the source: "logs" (application logs), ' +
        '"spans" (APM traces), "events" (the event stream), "error_tracking" (grouped error issues, ' +
        'APM track). query is Datadog search syntax (e.g. "service:api status:error"). from/to are ' +
        'ISO 8601 or relative (now-15m); anchor them to the incident onset, not the current time. ' +
        'Returns newest-first, bounded by limit (default 25).',
      inputSchema: z.object({
        domain: z.enum(['logs', 'spans', 'events', 'error_tracking']),
        query: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().optional(),
      }),
      run: async ({ domain, query, from, to, limit }, call) => {
        const { base, headers } = await conn();
        const { path, body } = buildSearch(
          domain,
          query ?? '*',
          from ?? DEFAULT_FROM,
          to ?? DEFAULT_TO,
          clampLimit(limit),
          Date.now(),
        );
        return ddPost(fetchImpl, base, headers, path, body, call?.signal);
      },
    }),
    dtool({
      name: 'query_metrics',
      description:
        'Query a metric timeseries over a window. query is the metric query (e.g. ' +
        '"avg:system.cpu.user{service:api}"). from/to are ISO 8601 or relative (now-1h); anchor them ' +
        'to the incident onset. Returns the pointlist for each matching series.',
      inputSchema: z.object({
        query: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      run: async ({ query, from, to }, call) => {
        const { base, headers } = await conn();
        const nowMs = Date.now();
        return ddGet(
          fetchImpl,
          base,
          headers,
          '/api/v1/query',
          {
            from: Math.floor(resolveMs(from ?? 'now-1h', nowMs) / 1000),
            to: Math.floor(resolveMs(to ?? DEFAULT_TO, nowMs) / 1000),
            query,
          },
          call?.signal,
        );
      },
    }),
  ];
}

/**
 * Creates a Datadog adapter with bounded logs, metrics, events, and monitor reads.
 *
 * @remarks Investigation tools read on demand; topology discovery is scheduled separately.
 * The probe validates both API and application keys, without requiring APM.
 * @param config - Tenant-scoped Datadog settings and credential accessor.
 * @param fetchImpl - HTTP transport used for Datadog API requests.
 */
export function makeDatadogConnector(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
): IDataSourceConnector {
  return createDataSourceConnector(config, DATADOG_CONNECTOR, {
    alertLifecycle: datadogLifecycle(async (path, query) =>
      ddGet(fetchImpl, resolveBase(config.settings), await resolveHeaders(config), path, query),
    ),
    topology: datadogTopology(config, () => {
      const boundedFetch = topologyFetch(fetchImpl);
      return {
        async logs(body) {
          return ddPost(
            boundedFetch,
            resolveBase(config.settings),
            await resolveHeaders(config),
            '/api/v2/logs/events/search',
            body,
          );
        },
        async spans() {
          const { path, body } = buildSearch('spans', '*', 'now-15m', 'now', MAX_LIMIT, Date.now());
          return ddPost(
            boundedFetch,
            resolveBase(config.settings),
            await resolveHeaders(config),
            path,
            body,
          );
        },
        async catalog(path, query) {
          return ddGet(
            boundedFetch,
            resolveBase(config.settings),
            await resolveHeaders(config),
            path,
            query,
          );
        },
      };
    }),
    entityCoverage: dataSourceEntityCoverage(
      config.id,
      ['metrics', 'logs'],
      ['service', 'workload', 'namespace', 'node', 'cluster', 'endpoint', 'database', 'host'],
    ),
    async fetchTriageContext(query): Promise<TriageContext> {
      const base = resolveBase(config.settings);
      const headers = await resolveHeaders(config);
      const body = {
        filter: {
          query: `service:${query.service} status:error`,
          from: `now-${query.windowMinutes}m`,
          to: 'now',
        },
        sort: '-timestamp',
        page: { limit: DEFAULT_LIMIT },
      };
      const data = await ddPost(fetchImpl, base, headers, '/api/v2/logs/events/search', body);
      const events = Array.isArray(obj(data).data) ? (obj(data).data as unknown[]) : [];
      return {
        source: 'datadog',
        data: {
          service: query.service,
          windowMinutes: query.windowMinutes,
          errorLogs: events.map(mapLog),
        },
      };
    },
    tools: () => makeDatadogTools(config, fetchImpl),
    async probe(): Promise<ProbeResult> {
      const warnings: string[] = [];
      let base: string;
      let headers: Record<string, string>;
      try {
        base = resolveBase(config.settings);
        headers = await resolveHeaders(config);
      } catch (e) {
        warnings.push(e instanceof Error ? e.message : 'datadog connector: configuration error');
        return { status: 'unhealthy', reachable: false, authorized: false, warnings };
      }
      const stat = async (path: string): Promise<number | null> => {
        try {
          const res = await fetchImpl(`${base}${path}`, {
            headers,
            signal: AbortSignal.timeout(API_TIMEOUT_MS),
            redirect: 'error',
          });
          return res.status;
        } catch {
          return null;
        }
      };
      // /api/v1/validate checks the API key only; a monitor read then proves the application key.
      const validateStatus = await stat('/api/v1/validate');
      if (validateStatus === null) {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: [...warnings, 'datadog api did not respond'],
        };
      }
      const apiKeyOk = validateStatus === 200;
      if (!apiKeyOk) warnings.push('datadog reachable but the api key is invalid');
      const checks: Record<string, boolean> = {};
      if (apiKeyOk) {
        const readStatus = await stat('/api/v1/monitor/search?per_page=1');
        if (readStatus === 200) checks.canRead = true;
        else if (readStatus === 401 || readStatus === 403) {
          // 401 (app key invalid) and 403 (app key unauthorized) are both conclusive: the app key
          // cannot read, so the connector is not usable. Datadog needs the app key for every read.
          checks.canRead = false;
          warnings.push('api key valid but the application key lacks read access');
        } else {
          // transient (null/timeout/5xx): leave canRead unknown so a blip doesn't disable a
          // connector whose api key already validated.
          warnings.push('could not verify application key read access (transient error)');
        }
      }
      const status = apiKeyOk && (checks.canRead ?? true) ? 'healthy' : 'unhealthy';
      return { status, reachable: true, authorized: apiKeyOk, warnings, checks };
    },
  });
}

export const datadogConnectorDefinition = defineConnector({
  ...DATADOG_CONNECTOR,
  create: makeDatadogConnector,
});
