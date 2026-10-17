import * as z from 'zod';
import type { ConnectorConfig } from '../../registry';
import type { HostLookup } from '../../ssrf';
import type { ConnectorTool, ToolRunOptions } from '../../types';
import {
  DEFAULT_TAIL_LINES,
  MAX_LOG_CHARS,
  MAX_TAIL_LINES,
  aget,
  atext,
  buildGetUrl,
  connect,
  validateName,
  type FetchLike,
} from './client';
import {
  apiGetPathIsDenied,
  parseLogStream,
  projectApplicationForInvestigation,
  scrubManagedResources,
  summarizeApp,
} from './projection';
import {
  readApplications,
  readScopedApplication,
  resolveApplicationNamespace,
} from './verification';

function httpsBase(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Browser URL for one application, built from operator-entered settings rather than the app's
 * external-link annotation, which the application's own manifest controls. The optional `webUrl`
 * wins, because the server URL is often an in-cluster address. An http server URL is confined to
 * private networks, so it is not offered as a link.
 * @param settings - Connector settings holding the operator-entered `webUrl` and `baseUrl`.
 * @param name - Application name.
 * @param namespace - Application namespace.
 */
export function applicationWebUrl(
  settings: Record<string, unknown>,
  name: string,
  namespace: string,
): string | undefined {
  const base = httpsBase(settings.webUrl) ?? httpsBase(settings.baseUrl);
  if (!base) return undefined;
  const prefix = base.pathname.replace(/\/+$/, '');
  return `${base.origin}${prefix}/applications/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

export function atool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>, options?: ToolRunOptions) => Promise<unknown>;
}): ConnectorTool {
  return def as ConnectorTool;
}

/**
 * ArgoCD granular triage tools. Read breadth over the tenant's ArgoCD API server
 * with a single bearer token and SSRF confinement. HTTP is restricted to internal networks.
 * Every per-app tool validates the name (and appNamespace) it interpolates before any fetch, so a
 * crafted value cannot traverse the path. `get_managed_resources` returns the live-vs-desired drift
 * diff scrubbed of Secret values (the one manifest-bearing surface); `api_get` is a GET-only
 * passthrough over the rest but refuses raw Applications, global inventory, and manifest-bearing
 * endpoints. Log output is bounded and relies on the dispatch layer's single
 * redaction choke point, the same accepted limit as k8s pod logs.
 */
export function makeArgoCdTools(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
): ConnectorTool[] {
  // The tool caller's cancellation rides the client, so every read the tool makes stops with it.
  const client = async (call?: ToolRunOptions) => ({
    ...(await connect(config, lookup)),
    signal: call?.signal,
  });
  const namespaceFor = async (
    c: Awaited<ReturnType<typeof client>>,
    app: string,
    appNamespace: string | undefined,
  ) =>
    resolveApplicationNamespace(
      config,
      fetchImpl,
      c,
      app,
      appNamespace ? validateName('appNamespace', appNamespace) : undefined,
    );

  return [
    atool({
      name: 'list_applications',
      description:
        'List ArgoCD applications with their sync and health status (the "what is OutOfSync/Degraded" ' +
        'inventory) within the connector scope. Returns a summary per app: name, project, sync ' +
        'status, health status, revision.',
      inputSchema: z.object({}),
      run: async (_input, call) => {
        const c = await client(call);
        const applications = await readApplications(config, fetchImpl, c);
        return { applications: applications.map(summarizeApp) };
      },
    }),
    atool({
      name: 'get_application',
      description:
        'Get one application by name: projected investigation state including sync, health, ' +
        'operationState (last sync result), conditions, and revision history. appNamespace is ' +
        'needed only when the name is in several namespaces.',
      inputSchema: z.object({ name: z.string(), appNamespace: z.string().optional() }),
      run: async ({ name, appNamespace }, call) => {
        const c = await client(call);
        const app = validateName('name', name);
        const namespace = await namespaceFor(c, app, appNamespace);
        const data = await readScopedApplication(config, fetchImpl, c, app, namespace);
        const projected = projectApplicationForInvestigation(data);
        const metadata = projected.metadata as { name?: string; namespace?: string };
        const webUrl =
          metadata.name && metadata.namespace
            ? applicationWebUrl(config.settings, metadata.name, metadata.namespace)
            : undefined;
        return webUrl ? { ...projected, webUrl } : projected;
      },
    }),
    atool({
      name: 'get_resource_tree',
      description:
        'Get the live resource tree for an application: every managed Kubernetes resource with its ' +
        'health and sync status (find the Degraded Deployment/Pod). No manifest bodies are returned. ' +
        'appNamespace is needed only when the name is in several namespaces.',
      inputSchema: z.object({ name: z.string(), appNamespace: z.string().optional() }),
      run: async ({ name, appNamespace }, call) => {
        const c = await client(call);
        const app = validateName('name', name);
        const namespace = await namespaceFor(c, app, appNamespace);
        await readScopedApplication(config, fetchImpl, c, app, namespace);
        return aget(fetchImpl, c, `/api/v1/applications/${encodeURIComponent(app)}/resource-tree`, {
          appNamespace: namespace,
        });
      },
    }),
    atool({
      name: 'get_managed_resources',
      description:
        'Get the live-vs-desired drift diff for an application (what has drifted from Git, the "why is ' +
        'it OutOfSync" detail). Secret and ConfigMap values and container env values are redacted. ' +
        'appNamespace is needed only when the name is in several namespaces.',
      inputSchema: z.object({ name: z.string(), appNamespace: z.string().optional() }),
      run: async ({ name, appNamespace }, call) => {
        const c = await client(call);
        const app = validateName('name', name);
        const namespace = await namespaceFor(c, app, appNamespace);
        await readScopedApplication(config, fetchImpl, c, app, namespace);
        const data = await aget(
          fetchImpl,
          c,
          `/api/v1/applications/${encodeURIComponent(app)}/managed-resources`,
          { appNamespace: namespace },
        );
        return scrubManagedResources(data);
      },
    }),
    atool({
      name: 'get_application_events',
      description:
        'List Kubernetes events for an application (why a sync failed, image pull errors, etc.). ' +
        'appNamespace is needed only when the name is in several namespaces.',
      inputSchema: z.object({ name: z.string(), appNamespace: z.string().optional() }),
      run: async ({ name, appNamespace }, call) => {
        const c = await client(call);
        const app = validateName('name', name);
        const namespace = await namespaceFor(c, app, appNamespace);
        await readScopedApplication(config, fetchImpl, c, app, namespace);
        return aget(fetchImpl, c, `/api/v1/applications/${encodeURIComponent(app)}/events`, {
          appNamespace: namespace,
        });
      },
    }),
    atool({
      name: 'get_application_logs',
      description:
        'Read pod logs for an application (bounded to the last 64K characters, default last 100 ' +
        'lines). Omit podName to aggregate across the app pods; optional container, namespace (the ' +
        'resource namespace), and sinceSeconds. appNamespace is needed only when the name is ' +
        'in several namespaces.',
      inputSchema: z.object({
        name: z.string(),
        podName: z.string().optional(),
        container: z.string().optional(),
        namespace: z.string().optional(),
        tailLines: z.number().int().positive().optional(),
        sinceSeconds: z.number().int().positive().optional(),
        appNamespace: z.string().optional(),
      }),
      run: async (
        { name, podName, container, namespace, tailLines, sinceSeconds, appNamespace },
        call,
      ) => {
        const c = await client(call);
        const app = validateName('name', name);
        const applicationNamespace = await namespaceFor(c, app, appNamespace);
        await readScopedApplication(config, fetchImpl, c, app, applicationNamespace);
        // follow is forced off: a streaming follow never terminates for a request/response tool.
        const body = await atext(
          fetchImpl,
          c,
          `/api/v1/applications/${encodeURIComponent(app)}/logs`,
          {
            follow: 'false',
            tailLines: String(Math.min(tailLines ?? DEFAULT_TAIL_LINES, MAX_TAIL_LINES)),
            podName,
            container,
            namespace,
            sinceSeconds: sinceSeconds != null ? String(sinceSeconds) : undefined,
            appNamespace: applicationNamespace,
          },
        );
        return { log: parseLogStream(body, MAX_LOG_CHARS) };
      },
    }),
    atool({
      name: 'api_get',
      description:
        'GET a non-Application ArgoCD API endpoint by path, such as "api/v1/settings" or ' +
        '"api/v1/version". Read-only. Raw Applications, global inventory, and ' +
        'manifest endpoints are refused; use the projected named tools.',
      inputSchema: z.object({
        path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
      run: async ({ path, query }, call) => {
        const c = await client(call);
        if (apiGetPathIsDenied(c.base, buildGetUrl(c.base, path, query)))
          throw new Error(
            'argocd connector: raw Applications, global inventory, and manifest endpoints are ' +
              'not available through api_get; use the projected named tools',
          );
        return aget(fetchImpl, c, path, query);
      },
    }),
  ];
}
