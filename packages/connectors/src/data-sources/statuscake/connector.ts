import * as z from 'zod';
import { statusCakeLifecycle } from './lifecycle';
import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import { dataSourceEntityCoverage } from '../../entity-coverage';
import type {
  ConnectorTool,
  IDataSourceConnector,
  ProbeResult,
  ToolRunOptions,
  TriageContext,
} from '../../types';
import { boundedSignal } from '../../request-signal';
import { obj, str } from '../../values';
import { statuscakeTopology } from './topology';
import { topologyFetch } from '../../topology-transport';
import { redactStatusCakeSecrets } from './setup';

/** Injectable so the REST calls are unit-testable without the network. */
type FetchLike = typeof fetch;

// SaaS, host-pinned in our own code (like Datadog/GitHub): the origin is fixed, so a tool input can
// only ever reach real StatusCake and no DNS/SSRF guard is needed for the API calls.
const STATUSCAKE_API = 'https://api.statuscake.com';
const API_TIMEOUT_MS = 8000;
const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;
const TRIAGE_SAMPLE = 100; // uptime tests pulled for the first-pass down-scan
const TRIAGE_DOWN_CAP = 25; // down tests returned in the first-pass seed

const STATUSCAKE_CONNECTOR = {
  type: 'statuscake',
  capabilities: {
    alertLifecycle: 'read',
    topology: 'inventory',
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'none',
    events: 'authenticated',
  },
} as const;

// The four structurally identical "test" resources: /v1/{type} list, /v1/{type}/{id} get. A validated
// enum maps to a fixed path prefix, so the type can never inject into the path.
const TEST_TYPES = ['uptime', 'ssl', 'pagespeed', 'heartbeat'] as const;
// Only uptime and pagespeed have a /history sub-endpoint; ssl and heartbeat are list/get only.
const HISTORY_TYPES = ['uptime', 'pagespeed'] as const;

// StatusCake resource ids are opaque tokens (numeric today); validate before interpolating so a
// crafted id cannot traverse the path.
const ID_RE = /^[A-Za-z0-9_-]+$/;

function validateId(value: string): string {
  if (!ID_RE.test(value)) throw new Error(`statuscake connector: invalid id '${value}'`);
  return value;
}

function clampPerPage(n: number | undefined): number {
  if (n === undefined) return DEFAULT_PER_PAGE;
  return Math.min(Math.max(1, Math.floor(n)), MAX_PER_PAGE);
}

type QueryValue = string | number | boolean;

/**
 * Build a validated absolute GET URL under the pinned host. The path is WHATWG-normalized (so `..`
 * collapses) and two assertions close SSRF/traversal: the origin must equal the pinned StatusCake
 * origin, and the pathname must stay under `/v1/`. GET-only by construction, so no tool routed through
 * here can mutate.
 */
export function buildGetUrl(path: string, query?: Record<string, QueryValue | undefined>): string {
  const baseUrl = new URL(`${STATUSCAKE_API}/`);
  const u = new URL(path.replace(/^\/+/, ''), baseUrl);
  if (u.origin !== baseUrl.origin)
    throw new Error('statuscake connector: path escapes the configured host');
  if (!u.pathname.startsWith('/v1/'))
    throw new Error('statuscake connector: path must be under /v1/');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === '') continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

async function connect(config: ConnectorConfig): Promise<string> {
  // A missing credential throws here and propagates (the tool degrades to error, never a fake read).
  const token = (await config.getCredential()).trim();
  if (!token) throw new Error('statuscake connector: credential (API token) is required');
  return token;
}

/** Request init: the bearer token rides a header (never the URL), 8s timeout, no redirects. */
function sInit(token: string, signal?: AbortSignal): RequestInit {
  return {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: boundedSignal(API_TIMEOUT_MS, signal),
    redirect: 'error',
  };
}

/** GET a StatusCake endpoint and parse JSON. `signal` is the tool caller's cancellation. */
async function sget(
  fetchImpl: FetchLike,
  token: string,
  path: string,
  query?: Record<string, QueryValue | undefined>,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetchImpl(buildGetUrl(path, query), sInit(token, signal));
  if (!res.ok)
    throw Object.assign(new Error(`statuscake api ${res.status}`), { status: res.status });
  // Contact-group ping URLs carry this platform's webhook secret.
  return redactStatusCakeSecrets(await res.json());
}

/** Standard page/per_page params (per_page clamped) shared by every collection tool. */
function pageParams(page: number | undefined, perPage: number | undefined) {
  return { page, limit: clampPerPage(perPage) };
}

interface DownTest {
  id: string | undefined;
  name: string | undefined;
  url: string | undefined;
  status: string | undefined;
  uptime: number | undefined;
  tags: unknown;
}

/** Reduce an uptime test to the fields the first-pass seed needs. */
function summarizeTest(raw: unknown): DownTest {
  const t = obj(raw);
  return {
    id: str(t.id) ?? (typeof t.id === 'number' ? String(t.id) : undefined),
    name: str(t.name),
    url: str(t.website_url),
    status: str(t.status),
    uptime: typeof t.uptime === 'number' ? t.uptime : undefined,
    tags: Array.isArray(t.tags) ? t.tags : undefined,
  };
}

function isDown(t: DownTest): boolean {
  return (t.status ?? '').toLowerCase() === 'down';
}

/** Best-effort: does a test reference the incident's service? StatusCake has no service field. */
function referencesService(t: DownTest, service: string): boolean {
  const needle = service.toLowerCase();
  if ((t.name ?? '').toLowerCase().includes(needle)) return true;
  if ((t.url ?? '').toLowerCase().includes(needle)) return true;
  const tags = Array.isArray(t.tags) ? t.tags : [];
  return tags.some((tag) => String(tag).toLowerCase() === needle);
}

/** Bind a Zod input schema to a typed run body, returning the erased ConnectorTool (mirror of siblings). */
function stool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>, options?: ToolRunOptions) => Promise<unknown>;
}): ConnectorTool {
  return def as ConnectorTool;
}

/**
 * StatusCake granular triage tools. Full read breadth over the tenant's StatusCake
 * account: the four structurally identical test resources (uptime/ssl/pagespeed/heartbeat) collapse
 * behind a validated `type` enum → fixed path prefix (list/get, plus history where the resource has
 * it); uptime's `periods`/`alerts` sub-resources are dedicated tools; maintenance-windows and
 * contact-groups round out coverage; `api_get` is a GET-only passthrough over the rest. No tool takes
 * a `method` and every path is confined to `/v1/`, so nothing can mutate. Pagination is model-driven:
 * each collection tool passes `page`/`per_page` (clamped) and returns the raw response including its
 * `metadata`. No bespoke sanitizer: StatusCake read data is external monitoring telemetry, not
 * manifests or a structured secret-field endpoint; the one residual (a token in a contact-group
 * integration URL) is the dispatch redaction's accepted best-effort limit, as with Datadog
 * webhook URLs and Prometheus scrape-target credentials. The platform's own webhook secret in a
 * contact-group `ping_url` is always redacted.
 */
function makeStatusCakeTools(config: ConnectorConfig, fetchImpl: FetchLike): ConnectorTool[] {
  const token = () => connect(config);

  return [
    stool({
      name: 'list_tests',
      description:
        'List checks of a given type with their status (the "what is up/down" inventory). type is ' +
        'one of uptime, ssl, pagespeed, heartbeat. Optional tags (comma-separated) and matchany ' +
        '(true = any tag, false = all tags) to scope to a service. Paginated: optional page/per_page; ' +
        'the response metadata carries page_count/total_count.',
      inputSchema: z.object({
        type: z.enum(TEST_TYPES),
        tags: z.string().optional(),
        matchany: z.boolean().optional(),
        page: z.number().int().positive().optional(),
        per_page: z.number().int().positive().optional(),
      }),
      run: async ({ type, tags, matchany, page, per_page }, call) => {
        const t = await token();
        return sget(
          fetchImpl,
          t,
          `/v1/${type}`,
          { tags, matchany, ...pageParams(page, per_page) },
          call?.signal,
        );
      },
    }),
    stool({
      name: 'get_test',
      description:
        'Get one check by type and id: full config and current status. type is uptime, ssl, ' +
        'pagespeed, or heartbeat. For ssl this carries the certificate expiry/validity fields (the ' +
        '"down because the cert expired" signal).',
      inputSchema: z.object({ type: z.enum(TEST_TYPES), id: z.string() }),
      run: async ({ type, id }, call) => {
        const t = await token();
        return sget(
          fetchImpl,
          t,
          `/v1/${type}/${encodeURIComponent(validateId(id))}`,
          undefined,
          call?.signal,
        );
      },
    }),
    stool({
      name: 'get_test_history',
      description:
        'Get the recent check-run history for a test (the raw pass/fail signal over time). type is ' +
        'uptime or pagespeed (ssl and heartbeat have no history endpoint). Cursor paginated: optional limit, before and after UNIX seconds.',
      inputSchema: z.object({
        type: z.enum(HISTORY_TYPES),
        id: z.string(),
        limit: z.number().int().positive().max(100).optional(),
        before: z.number().int().nonnegative().optional(),
        after: z.number().int().nonnegative().optional(),
      }),
      run: async ({ type, id, limit, before, after }, call) => {
        const t = await token();
        return sget(
          fetchImpl,
          t,
          `/v1/${type}/${encodeURIComponent(validateId(id))}/history`,
          {
            limit: clampPerPage(limit),
            before,
            after,
          },
          call?.signal,
        );
      },
    }),
    stool({
      name: 'get_uptime_periods',
      description:
        'Get the up/down periods for an uptime test — the downtime windows ("since when down"), each ' +
        'with a start, end, and duration. Cursor paginated: optional limit, before and after UNIX seconds.',
      inputSchema: z.object({
        id: z.string(),
        limit: z.number().int().positive().max(100).optional(),
        before: z.number().int().nonnegative().optional(),
        after: z.number().int().nonnegative().optional(),
      }),
      run: async ({ id, limit, before, after }, call) => {
        const t = await token();
        return sget(
          fetchImpl,
          t,
          `/v1/uptime/${encodeURIComponent(validateId(id))}/periods`,
          {
            limit: clampPerPage(limit),
            before,
            after,
          },
          call?.signal,
        );
      },
    }),
    stool({
      name: 'get_uptime_alerts',
      description:
        'Get the alerts StatusCake sent for an uptime test. Cursor paginated: optional limit, before and after UNIX seconds.',
      inputSchema: z.object({
        id: z.string(),
        limit: z.number().int().positive().max(100).optional(),
        before: z.number().int().nonnegative().optional(),
        after: z.number().int().nonnegative().optional(),
      }),
      run: async ({ id, limit, before, after }, call) => {
        const t = await token();
        return sget(
          fetchImpl,
          t,
          `/v1/uptime/${encodeURIComponent(validateId(id))}/alerts`,
          {
            limit: clampPerPage(limit),
            before,
            after,
          },
          call?.signal,
        );
      },
    }),
    stool({
      name: 'list_maintenance_windows',
      description:
        'List maintenance windows — scheduled periods where alerts are paused (is this "down" ' +
        'expected?). Paginated: optional page/per_page.',
      inputSchema: z.object({
        page: z.number().int().positive().optional(),
        per_page: z.number().int().positive().optional(),
      }),
      run: async ({ page, per_page }, call) => {
        const t = await token();
        return sget(
          fetchImpl,
          t,
          '/v1/maintenance-windows',
          pageParams(page, per_page),
          call?.signal,
        );
      },
    }),
    stool({
      name: 'list_contact_groups',
      description: 'List contact groups — who gets alerted. Paginated: optional page/per_page.',
      inputSchema: z.object({
        page: z.number().int().positive().optional(),
        per_page: z.number().int().positive().optional(),
      }),
      run: async ({ page, per_page }, call) => {
        const t = await token();
        return sget(fetchImpl, t, '/v1/contact-groups', pageParams(page, per_page), call?.signal);
      },
    }),
    stool({
      name: 'api_get',
      description:
        'GET any StatusCake API endpoint by path (e.g. "v1/maintenance-windows/{id}", ' +
        '"v1/contact-groups/{id}", "v1/ssl/{id}"). Read-only. Use for anything the named tools do not cover.',
      inputSchema: z.object({
        path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
      run: async ({ path, query }, call) => {
        const t = await token();
        return sget(fetchImpl, t, path, query, call?.signal);
      },
    }),
  ];
}

/**
 * Creates a StatusCake adapter with bounded uptime, page-speed, and SSL reads.
 *
 * @remarks Requests are bearer-authenticated, on-demand, and pinned to the StatusCake API origin.
 * @param config - Tenant-scoped StatusCake settings and credential accessor.
 * @param fetchImpl - HTTP transport used for StatusCake API requests.
 */
export function makeStatusCakeConnector(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
): IDataSourceConnector {
  return createDataSourceConnector(config, STATUSCAKE_CONNECTOR, {
    alertLifecycle: statusCakeLifecycle(async (path, query) =>
      sget(fetchImpl, await connect(config), path, query),
    ),
    topology: statuscakeTopology(config, () => {
      const transport = topologyFetch(fetchImpl);
      return async (path, query) => sget(transport, await connect(config), path, query);
    }),
    entityCoverage: dataSourceEntityCoverage(
      config.id,
      ['availability'],
      ['service', 'endpoint', 'host'],
    ),
    async fetchTriageContext(query): Promise<TriageContext> {
      // Down-first: pull uptime tests, keep the down ones, best-effort scope to the service, and fall
      // back to all-down when nothing matches (StatusCake has no universal service key, so "what is
      // down right now" is a real opener even unfiltered — the Prometheus firing-alerts precedent).
      // windowMinutes is inert (StatusCake status is current, not windowed) but echoed for transparency.
      try {
        const token = await connect(config);
        const data = await sget(fetchImpl, token, '/v1/uptime', { limit: TRIAGE_SAMPLE });
        const items = obj(data).data;
        const down = (Array.isArray(items) ? items : []).map(summarizeTest).filter(isDown);
        const scoped = down.filter((t) => referencesService(t, query.service));
        const downTests = (scoped.length > 0 ? scoped : down).slice(0, TRIAGE_DOWN_CAP);
        return {
          source: 'statuscake',
          data: { service: query.service, windowMinutes: query.windowMinutes, downTests },
        };
      } catch {
        return {
          source: 'statuscake',
          data: {
            service: query.service,
            windowMinutes: query.windowMinutes,
            note: 'statuscake first-pass unavailable (credential or reachability)',
          },
        };
      }
    },
    tools: () => makeStatusCakeTools(config, fetchImpl),
    async probe(): Promise<ProbeResult> {
      let token: string;
      try {
        token = await connect(config);
      } catch (e) {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: [e instanceof Error ? e.message : 'statuscake connector: configuration error'],
        };
      }
      // A trivial uptime list proves reachability + the credential; StatusCake has no userinfo endpoint.
      let statusCode: number | null;
      try {
        const res = await fetchImpl(buildGetUrl('/v1/uptime', { limit: 1 }), sInit(token));
        statusCode = res.status;
      } catch {
        statusCode = null;
      }
      if (statusCode === null) {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: ['statuscake did not respond'],
        };
      }
      if (statusCode === 200) {
        return { status: 'healthy', reachable: true, authorized: true, warnings: [] };
      }
      if (statusCode === 401 || statusCode === 403) {
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings: ['statuscake reachable but the credential was rejected'],
        };
      }
      return {
        status: 'unhealthy',
        reachable: true,
        authorized: false,
        warnings: [`statuscake returned ${statusCode}`],
      };
    },
  });
}

export const statusCakeConnectorDefinition = defineConnector({
  ...STATUSCAKE_CONNECTOR,
  create: makeStatusCakeConnector,
});
