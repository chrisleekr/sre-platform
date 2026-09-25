import * as z from 'zod';
import type { ConnectorConfig } from '../../registry';
import { dnsLookup, type HostLookup } from '../../ssrf';
import { sanitizeObject } from '../../shared/kubernetes/sanitize';
import type { ConnectorTool, ToolRunOptions } from '../../types';
import { obj, str } from '../../values';
import { resourcePath, validateSegment } from './path';
import { K8sApiError, itemsOf, k8sClient, mapEvent } from './runtime';

type FetchLike = typeof fetch;

/** Map a queried resource plural to the object kind the sanitizer gates data-redaction on. */
function resourceKindFor(resource: string): string | undefined {
  if (resource === 'secrets') return 'Secret';
  if (resource === 'configmaps') return 'ConfigMap';
  return undefined;
}

/**
 * Tie a Zod input schema to a typed `run` body while returning the erased `ConnectorTool` the
 * interface expects. `runTool` validates input against the same schema before dispatch, so the run
 * body always receives a value of `z.infer<S>`; the erasure is sound.
 */
function tool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>, options?: ToolRunOptions) => Promise<unknown>;
}): ConnectorTool {
  return def as ConnectorTool;
}

/** Read the metrics API, degrading a 404 (metrics-server not installed) to a soft `unavailable`. */
async function readMetrics(
  client: { kjson: (path: string) => Promise<unknown> },
  path: string,
): Promise<unknown> {
  try {
    return await client.kjson(path);
  } catch (e) {
    if (e instanceof K8sApiError && e.status === 404)
      return { unavailable: 'metrics-server not installed' };
    throw e;
  }
}

/**
 * The connector's granular triage tools. Each validates every path segment it
 * interpolates before building a client, so a crafted `name`/`resource`/`namespace` cannot traverse
 * the API path (rejected before any fetch). Get/list results are secret-excluded via
 * `sanitizeObject`; logs return raw text (the dispatch layer redacts output once). A configured
 * `settings.namespace` is the default for namespaced tools; empty means cluster/all-namespace scope.
 */
export function makeK8sTools(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup = dnsLookup,
): ConnectorTool[] {
  const defaultNs = () => str(config.settings.namespace);

  return [
    tool({
      name: 'list_api_resources',
      description:
        'Discover the API resources served by the cluster (core group plus named API groups). ' +
        'Optionally filter to a single group. Returns [{group, version, resource, kind, namespaced}].',
      inputSchema: z.object({ group: z.string().optional() }),
      run: async ({ group }, call) => {
        const client = await k8sClient(config, fetchImpl, lookup, call?.signal);
        const out: Array<{
          group: string;
          version: string;
          resource: string;
          kind: string;
          namespaced: boolean;
        }> = [];
        const addList = (grp: string, ver: string, list: unknown) => {
          for (const r of itemsOfResources(list)) {
            const ro = obj(r);
            const name = str(ro.name);
            // Skip subresources (pods/log, deployments/scale): they are not independently listable.
            if (!name || name.includes('/')) continue;
            out.push({
              group: grp,
              version: ver,
              resource: name,
              kind: str(ro.kind) ?? '',
              namespaced: ro.namespaced === true,
            });
          }
        };
        // The core group ("") lives at /api/v1; only fetch it when no group filter is set.
        if (!group) addList('', 'v1', await client.kjson('/api/v1'));
        const groups = (obj(await client.kjson('/apis')).groups ?? []) as unknown[];
        for (const g of groups) {
          const go = obj(g);
          const gname = str(go.name) ?? '';
          if (group && gname !== group) continue;
          const version = str(obj(go.preferredVersion).version);
          if (!version) continue;
          // gname/version come from the server, but validate before interpolating regardless.
          validateSegment('group', gname);
          validateSegment('version', version);
          addList(gname, version, await client.kjson(`/apis/${gname}/${version}`));
        }
        return { resources: out };
      },
    }),

    tool({
      name: 'get_resource',
      description:
        'Get a single resource by apiVersion (e.g. "v1" or "apps/v1"), plural resource, and name. ' +
        'Omit namespace for a cluster-scoped resource or to span all namespaces; provide it to scope ' +
        'to one namespace. Secret/ConfigMap values and container env values are redacted.',
      inputSchema: z.object({
        apiVersion: z.string(),
        resource: z.string(),
        name: z.string(),
        namespace: z.string().optional(),
      }),
      run: async ({ apiVersion, resource, name, namespace }, call) => {
        // Use only the caller-provided namespace: an omitted namespace must build the cluster-scoped
        // path (no /namespaces/{ns} segment), correct for cluster-scoped kinds (nodes, PVs). Falling
        // back to the configured default here would 404 a nodes get by scoping it to a namespace.
        const ns = namespace;
        // Segment validation runs here (pure) before any client/fetch: injection is rejected early.
        const path = resourcePath(apiVersion, resource, { namespace: ns, name });
        const client = await k8sClient(config, fetchImpl, lookup, call?.signal);
        return sanitizeObject(await client.kjson(path), resourceKindFor(resource));
      },
    }),

    tool({
      name: 'list_resources',
      description:
        'List resources of a kind by apiVersion and plural resource, with optional label/field ' +
        'selectors. Omit namespace for a cluster-scoped resource or to span all namespaces; provide ' +
        'it to scope to one namespace. Secret/ConfigMap values and container env values are redacted per item.',
      inputSchema: z.object({
        apiVersion: z.string(),
        resource: z.string(),
        namespace: z.string().optional(),
        labelSelector: z.string().optional(),
        fieldSelector: z.string().optional(),
        limit: z.number().int().positive().optional(),
      }),
      run: async (
        { apiVersion, resource, namespace, labelSelector, fieldSelector, limit },
        call,
      ) => {
        // Caller-provided namespace only: omitted means list across all namespaces (or a
        // cluster-scoped kind), not a silent fallback to the configured default.
        const ns = namespace;
        const path = resourcePath(apiVersion, resource, { namespace: ns });
        const qs = new URLSearchParams({ limit: String(limit ?? 200) });
        if (labelSelector) qs.set('labelSelector', labelSelector);
        if (fieldSelector) qs.set('fieldSelector', fieldSelector);
        const client = await k8sClient(config, fetchImpl, lookup, call?.signal);
        const data = await client.kjson(`${path}?${qs.toString()}`);
        const kind = resourceKindFor(resource);
        return { items: itemsOf(data).map((it) => sanitizeObject(it, kind)) };
      },
    }),

    tool({
      name: 'get_pod_logs',
      description:
        'Read a pod container log (bounded to the last 64KiB). Defaults to the last 200 lines; ' +
        'set previous:true for the prior container instance after a crash.',
      inputSchema: z.object({
        namespace: z.string(),
        name: z.string(),
        container: z.string().optional(),
        tailLines: z.number().int().positive().optional(),
        sinceSeconds: z.number().int().positive().optional(),
        previous: z.boolean().optional(),
      }),
      run: async ({ namespace, name, container, tailLines, sinceSeconds, previous }, call) => {
        validateSegment('namespace', namespace);
        validateSegment('name', name);
        const qs = new URLSearchParams({
          tailLines: String(tailLines ?? 200),
          // Cap the body so a huge log cannot exhaust the worker's memory (CWE-400).
          limitBytes: '65536',
        });
        if (container) qs.set('container', container);
        if (sinceSeconds != null) qs.set('sinceSeconds', String(sinceSeconds));
        if (previous) qs.set('previous', 'true');
        const client = await k8sClient(config, fetchImpl, lookup, call?.signal);
        return {
          log: await client.ktext(`/api/v1/namespaces/${namespace}/pods/${name}/log?${qs}`),
        };
      },
    }),

    tool({
      name: 'list_events',
      description:
        'List recent events, defaulting to Warning type. Namespace-scoped when a namespace is set, ' +
        'else cluster-wide.',
      inputSchema: z.object({
        namespace: z.string().optional(),
        type: z.string().optional(),
        limit: z.number().int().positive().optional(),
      }),
      run: async ({ namespace, type, limit }, call) => {
        const ns = namespace ?? defaultNs();
        let path = '/api/v1/events';
        if (ns) path = `/api/v1/namespaces/${validateSegment('namespace', ns)}/events`;
        // URLSearchParams encodes '=' and ',', so a crafted `type` cannot inject extra selectors.
        const qs = new URLSearchParams({
          fieldSelector: `type=${type ?? 'Warning'}`,
          limit: String(limit ?? 200),
        });
        const client = await k8sClient(config, fetchImpl, lookup, call?.signal);
        const data = await client.kjson(`${path}?${qs}`);
        return { events: itemsOf(data).map(mapEvent) };
      },
    }),

    tool({
      name: 'top_nodes',
      description:
        'Node CPU/memory usage from the metrics API. Unavailable if metrics-server is absent.',
      inputSchema: z.object({}),
      run: async (_input, call) => {
        const client = await k8sClient(config, fetchImpl, lookup, call?.signal);
        return readMetrics(client, '/apis/metrics.k8s.io/v1beta1/nodes');
      },
    }),

    tool({
      name: 'top_pods',
      description:
        'Pod CPU/memory usage from the metrics API. Omit namespace to span all namespaces; provide ' +
        'it to scope to one namespace. Unavailable if metrics-server is absent.',
      inputSchema: z.object({ namespace: z.string().optional() }),
      run: async ({ namespace }, call) => {
        // Caller-provided namespace only: omitted means all-namespace metrics, not the configured default.
        const ns = namespace;
        const path = ns
          ? `/apis/metrics.k8s.io/v1beta1/namespaces/${validateSegment('namespace', ns)}/pods`
          : '/apis/metrics.k8s.io/v1beta1/pods';
        const client = await k8sClient(config, fetchImpl, lookup, call?.signal);
        return readMetrics(client, path);
      },
    }),
  ];
}

/** The `.resources` array of an APIResourceList, or [] when the shape is unexpected. */
function itemsOfResources(v: unknown): unknown[] {
  const resources = obj(v).resources;
  return Array.isArray(resources) ? resources : [];
}
