import * as z from 'zod';
import type { ConnectorConfig } from '../../registry';
import type { HostLookup } from '../../ssrf';
import type { ConnectorTool } from '../../types';
import {
  DEFAULT_RANGE_FROM,
  DEFAULT_TO,
  MAX_POINTS,
  connect,
  optSeconds,
  pget,
  ppost,
  resolveSeconds,
  resolveStepSeconds,
  type FetchLike,
  type PrometheusConnectorOptions,
} from './client';

function ptool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>) => Promise<unknown>;
}): ConnectorTool {
  return def as ConnectorTool;
}

/**
 * Prometheus granular triage tools. Full read breadth over the tenant's Prometheus:
 * `query`/`query_range` run PromQL (POST form-encoded to a fixed read path — long queries can't blow a
 * GET URL limit, and a fixed read path can't mutate); `series`/`labels`/`label_values`/`metadata`
 * discover the metric+label space; `targets`/`rules`/`alerts` read operational state (the hot triage
 * signals); `api_get` is a GET-only passthrough over the rest (`status/*`, `alertmanagers`, future
 * endpoints). No tool takes a `method` and the admin/TSDB deletes are POST/PUT, so nothing can mutate.
 * Output redaction is the dispatch layer's single choke point, so there is no bespoke sanitizer:
 * Prometheus itself masks structured credentials as `<secret>`; the only residual is a credential
 * embedded in a URL string (a documented Prometheus behavior), the same accepted best-effort limit as
 * k8s pod logs and GitLab job traces.
 */
export function makePrometheusTools(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
  options: PrometheusConnectorOptions,
): ConnectorTool[] {
  const client = () => connect(config, lookup, options);

  return [
    ptool({
      name: 'query',
      description:
        'Evaluate an instant PromQL query at a single time (current value / snapshot). query is ' +
        'PromQL (e.g. "up", "rate(http_requests_total[5m])"). Optional time (ISO 8601 or relative ' +
        'like now-5m; defaults to now). Anchor time to the incident onset, not the current time.',
      inputSchema: z.object({ query: z.string(), time: z.string().optional() }),
      run: async ({ query, time }) => {
        const c = await client();
        const form: Record<string, string> = { query };
        const t = optSeconds(time, Date.now());
        if (t !== undefined) form.time = t;
        return ppost(fetchImpl, c, '/api/v1/query', form);
      },
    }),
    ptool({
      name: 'query_range',
      description:
        'Evaluate a PromQL query over a time range (a series). query is PromQL; start/end are ISO 8601 ' +
        'or relative (now-1h); step is a resolution like "15s"/"1m" (defaults to ~250 points across the ' +
        'window). Anchor start/end to the incident onset. Returns a matrix of series.',
      inputSchema: z.object({
        query: z.string(),
        start: z.string().optional(),
        end: z.string().optional(),
        step: z.union([z.string(), z.number()]).optional(),
      }),
      run: async ({ query, start, end, step }) => {
        const c = await client();
        const nowMs = Date.now();
        const startS = resolveSeconds(start ?? DEFAULT_RANGE_FROM, nowMs);
        const endS = resolveSeconds(end ?? DEFAULT_TO, nowMs);
        const rangeSeconds = Math.max(1, endS - startS);
        const stepS = resolveStepSeconds(step, rangeSeconds);
        const points = rangeSeconds / stepS;
        if (points > MAX_POINTS)
          throw new Error(
            `prometheus query_range: range too wide for step (${Math.ceil(points)} points > ${MAX_POINTS}); increase step or narrow the window`,
          );
        return ppost(fetchImpl, c, '/api/v1/query_range', {
          query,
          start: String(startS),
          end: String(endS),
          step: String(stepS),
        });
      },
    }),
    ptool({
      name: 'series',
      description:
        'Find series matching label matchers. match is one or more selectors (e.g. ["up", ' +
        '"{job=\\"api\\"}"]). Optional start/end (ISO 8601 or relative). Use to discover what series exist.',
      inputSchema: z.object({
        match: z.array(z.string()).min(1),
        start: z.string().optional(),
        end: z.string().optional(),
      }),
      run: async ({ match, start, end }) => {
        const c = await client();
        const nowMs = Date.now();
        return pget(fetchImpl, c, '/api/v1/series', {
          'match[]': match,
          start: optSeconds(start, nowMs),
          end: optSeconds(end, nowMs),
        });
      },
    }),
    ptool({
      name: 'labels',
      description:
        'List label names, optionally constrained by match selectors and a time range. Use to discover ' +
        'the label schema (e.g. what dimensions exist).',
      inputSchema: z.object({
        match: z.array(z.string()).optional(),
        start: z.string().optional(),
        end: z.string().optional(),
      }),
      run: async ({ match, start, end }) => {
        const c = await client();
        const nowMs = Date.now();
        return pget(fetchImpl, c, '/api/v1/labels', {
          'match[]': match,
          start: optSeconds(start, nowMs),
          end: optSeconds(end, nowMs),
        });
      },
    }),
    ptool({
      name: 'label_values',
      description:
        'List the values of one label name (e.g. name="job" → all job values). Optionally constrained ' +
        'by match selectors.',
      inputSchema: z.object({ name: z.string().min(1), match: z.array(z.string()).optional() }),
      run: async ({ name, match }) => {
        const c = await client();
        // name is a model-controlled path segment: encode it so a crafted value cannot traverse.
        return pget(fetchImpl, c, `/api/v1/label/${encodeURIComponent(name)}/values`, {
          'match[]': match,
        });
      },
    }),
    ptool({
      name: 'metadata',
      description:
        'Read metric metadata (type, help text, unit). Optional metric to filter to one name; optional ' +
        'limit. Use to understand what a metric measures.',
      inputSchema: z.object({ metric: z.string().optional(), limit: z.number().optional() }),
      run: async ({ metric, limit }) => {
        const c = await client();
        return pget(fetchImpl, c, '/api/v1/metadata', { metric, limit });
      },
    }),
    ptool({
      name: 'targets',
      description:
        'List scrape targets and their health (up/down, last scrape, errors) — the "what is not being ' +
        'scraped" signal. Optional state: "active", "dropped", or "any" (default active).',
      inputSchema: z.object({ state: z.enum(['active', 'dropped', 'any']).optional() }),
      run: async ({ state }) => {
        const c = await client();
        return pget(fetchImpl, c, '/api/v1/targets', { state });
      },
    }),
    ptool({
      name: 'rules',
      description:
        'List alerting and recording rules and their current state. Optional type: "alert" or "record".',
      inputSchema: z.object({ type: z.enum(['alert', 'record']).optional() }),
      run: async ({ type }) => {
        const c = await client();
        return pget(fetchImpl, c, '/api/v1/rules', { type });
      },
    }),
    ptool({
      name: 'alerts',
      description:
        'List the alerts currently firing (and pending) — the "what is on fire right now" signal.',
      inputSchema: z.object({}),
      run: async () => {
        const c = await client();
        return pget(fetchImpl, c, '/api/v1/alerts');
      },
    }),
    ptool({
      name: 'api_get',
      description:
        'GET any Prometheus HTTP API endpoint by path (e.g. "api/v1/status/config", ' +
        '"api/v1/status/runtimeinfo", "api/v1/alertmanagers", "api/v1/targets/metadata"). Read-only. ' +
        'Use for anything the named tools do not cover.',
      inputSchema: z.object({
        path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
      run: async ({ path, query }) => {
        const c = await client();
        return pget(fetchImpl, c, path, query);
      },
    }),
  ];
}
