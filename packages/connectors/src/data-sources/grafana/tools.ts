import * as z from 'zod';
import type { ConnectorConfig } from '../../registry';
import type { HostLookup } from '../../ssrf';
import type { ConnectorTool, ToolRunOptions } from '../../types';
import {
  DEFAULT_LIMIT,
  buildGetUrl,
  clampLimit,
  connect,
  gInit,
  gget,
  isDeniedProxyPath,
  optMs,
  validateUid,
  type FetchLike,
  type GrafanaConnectorOptions,
} from './client';

function gtool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>, options?: ToolRunOptions) => Promise<unknown>;
}): ConnectorTool {
  return def as ConnectorTool;
}

/**
 * Grafana granular triage tools. Read breadth over Grafana's own aggregated state:
 * `list_alert_rules`/`list_firing_alerts`/`get_alert_rule` cover unified alerting (rule state, what is
 * actively paging post-silence, and a rule's full definition); `search_dashboards`/`get_dashboard` reach
 * the human-curated view of a service; `list_annotations` reads deploy/event markers for deploy
 * correlation; `list_datasources` discovers the backends Grafana fronts; `api_get` is a GET-only
 * passthrough over the rest. No tool takes a `method` and every path is confined to `/api/`, so nothing
 * can mutate. The connector stays on Grafana's own API: `api_get` refuses the datasource proxy/resources
 * paths (`/api/ds/query` is POST, already blocked), so it never tunnels a raw downstream-datasource
 * response. No bespoke sanitizer: Grafana redacts datasource secrets in GET responses (`secureJsonData`
 * values are omitted, `secureJsonFields` is booleans-only), and the only residual — an internal
 * datasource URL — is the dispatch redaction's accepted best-effort limit, as with Prometheus
 * scrape-target URLs.
 */
export function makeGrafanaTools(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
  options: GrafanaConnectorOptions,
): ConnectorTool[] {
  const client = async (call?: ToolRunOptions) => ({
    ...(await connect(config, lookup, options)),
    signal: call?.signal,
  });

  return [
    gtool({
      name: 'list_alert_rules',
      description:
        'List alert rules and their current state (inactive/pending/firing) with active instances — the ' +
        '"what is alerting right now" signal (Prometheus-compatible shape). datasourceUid selects the ' +
        'rule source; default "grafana" (Grafana-managed rules). Pass an external datasource UID to read ' +
        'rules managed by that datasource.',
      inputSchema: z.object({ datasourceUid: z.string().optional() }),
      run: async ({ datasourceUid }, call) => {
        const c = await client(call);
        const uid = validateUid('datasourceUid', datasourceUid ?? 'grafana');
        return gget(fetchImpl, c, `/api/prometheus/${uid}/api/v1/rules`);
      },
    }),
    gtool({
      name: 'list_firing_alerts',
      description:
        'List the alert instances currently active in the Grafana Alertmanager — what is actually paging ' +
        'right now, after silences and inhibitions are applied. Optional filter is a list of label ' +
        'matchers (e.g. ["service=api", "severity=critical"]) to scope to a service. Optional ' +
        'silenced/inhibited/active booleans (defaults: active only).',
      inputSchema: z.object({
        filter: z.array(z.string()).optional(),
        silenced: z.boolean().optional(),
        inhibited: z.boolean().optional(),
        active: z.boolean().optional(),
      }),
      run: async ({ filter, silenced, inhibited, active }, call) => {
        const c = await client(call);
        // AM v2 GET /alerts defaults active/silenced/inhibited all to true, so an unset silenced/inhibited
        // would return muted alerts as if paging. Default to paging-only (active, not silenced, not
        // inhibited) to match the tool's contract; the caller can still opt back in explicitly.
        return gget(fetchImpl, c, '/api/alertmanager/grafana/api/v2/alerts', {
          filter,
          silenced: silenced ?? false,
          inhibited: inhibited ?? false,
          active: active ?? true,
        });
      },
    }),
    gtool({
      name: 'get_alert_rule',
      description:
        'Get one Grafana-managed alert rule by UID: its full definition — the query, condition, ' +
        'thresholds, and folder. Use to see the exact rule behind a firing alert.',
      inputSchema: z.object({ uid: z.string() }),
      run: async ({ uid }, call) => {
        const c = await client(call);
        return gget(fetchImpl, c, `/api/v1/provisioning/alert-rules/${validateUid('uid', uid)}`);
      },
    }),
    gtool({
      name: 'search_dashboards',
      description:
        'Search dashboards and folders (the human-curated views of a service). Optional query (title ' +
        'substring), tag (one or more), type ("dash-db" dashboards or "dash-folder" folders), and limit. ' +
        'Returns each hit with its uid — pass that uid to get_dashboard.',
      inputSchema: z.object({
        query: z.string().optional(),
        tag: z.array(z.string()).optional(),
        type: z.enum(['dash-db', 'dash-folder']).optional(),
        limit: z.number().int().positive().optional(),
      }),
      run: async ({ query, tag, type, limit }, call) => {
        const c = await client(call);
        return gget(fetchImpl, c, '/api/search', { query, tag, type, limit: clampLimit(limit) });
      },
    }),
    gtool({
      name: 'get_dashboard',
      description:
        'Get one dashboard by UID: its full model — panels, their queries, and the datasources they read. ' +
        'Use to understand how a service is visualized and which signals its owners watch.',
      inputSchema: z.object({ uid: z.string() }),
      run: async ({ uid }, call) => {
        const c = await client(call);
        return gget(fetchImpl, c, `/api/dashboards/uid/${validateUid('uid', uid)}`);
      },
    }),
    gtool({
      name: 'list_annotations',
      description:
        'List annotations — deploy and event markers on the timeline (the deploy-correlation signal). ' +
        'Optional from/to (ISO 8601 or relative like now-1h; anchor to the incident onset), tags (one or ' +
        'more), type ("alert" state changes or "annotation" user events), dashboardUID to scope to one ' +
        'dashboard, and limit.',
      inputSchema: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        tags: z.array(z.string()).optional(),
        type: z.enum(['alert', 'annotation']).optional(),
        dashboardUID: z.string().optional(),
        limit: z.number().int().positive().optional(),
      }),
      run: async ({ from, to, tags, type, dashboardUID, limit }, call) => {
        const c = await client(call);
        const nowMs = Date.now();
        return gget(fetchImpl, c, '/api/annotations', {
          from: optMs(from, nowMs),
          to: optMs(to, nowMs),
          tags,
          type,
          dashboardUID: dashboardUID ? validateUid('dashboardUID', dashboardUID) : undefined,
          limit: clampLimit(limit) ?? DEFAULT_LIMIT,
        });
      },
    }),
    gtool({
      name: 'list_datasources',
      description:
        'List the datasources this Grafana fronts (name, type, uid) — discover what backends are behind ' +
        'it. Secret credentials are redacted by Grafana (only which secret fields are set is returned).',
      inputSchema: z.object({}),
      run: async (_input, call) => {
        const c = await client(call);
        return gget(fetchImpl, c, '/api/datasources');
      },
    }),
    gtool({
      name: 'api_get',
      description:
        'GET any Grafana HTTP API endpoint by path (e.g. "api/folders", "api/dashboards/tags", ' +
        '"api/alertmanager/grafana/api/v2/alerts/groups"). Read-only. The datasource proxy/resources ' +
        "paths are refused (this connector stays on Grafana's own API). Use for anything the named " +
        'tools do not cover.',
      inputSchema: z.object({
        path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
      run: async ({ path, query }, call) => {
        const c = await client(call);
        // Validate first (origin + /api/ + no-%), then refuse the proxy/resources tunnels on the
        // normalized pathname before the fetch.
        const url = buildGetUrl(c.base, path, query);
        if (isDeniedProxyPath(new URL(url).pathname))
          throw new Error('grafana connector: datasource proxy/resources paths are not permitted');
        const res = await fetchImpl(url, gInit(c));
        if (!res.ok) throw new Error(`grafana api ${res.status}`);
        return res.json();
      },
    }),
  ];
}
