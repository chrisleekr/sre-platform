import * as z from 'zod';
import type { ConnectorConfig } from '../../registry';
import type { HostLookup } from '../../ssrf';
import type { ConnectorTool } from '../../types';
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
import { readApplications, readScopedApplication } from './verification';

export function atool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>) => Promise<unknown>;
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
  const client = () => connect(config, lookup);

  return [
    atool({
      name: 'list_applications',
      description:
        'List ArgoCD applications with their sync and health status (the "what is OutOfSync/Degraded" ' +
        'inventory) within the connector scope. Returns a summary per app: name, project, sync ' +
        'status, health status, revision.',
      inputSchema: z.object({}),
      run: async () => {
        const c = await client();
        const applications = await readApplications(config, fetchImpl, c);
        return { applications: applications.map(summarizeApp) };
      },
    }),
    atool({
      name: 'get_application',
      description:
        'Get one application by name: projected investigation state including sync, health, ' +
        'operationState (last sync result), conditions, and revision history. appNamespace is ' +
        'required when Applications-in-any-namespace is enabled.',
      inputSchema: z.object({ name: z.string(), appNamespace: z.string().optional() }),
      run: async ({ name, appNamespace }) => {
        const c = await client();
        const app = validateName('name', name);
        const namespace = appNamespace ? validateName('appNamespace', appNamespace) : undefined;
        const data = await readScopedApplication(config, fetchImpl, c, app, namespace);
        return projectApplicationForInvestigation(data);
      },
    }),
    atool({
      name: 'get_resource_tree',
      description:
        'Get the live resource tree for an application: every managed Kubernetes resource with its ' +
        'health and sync status (find the Degraded Deployment/Pod). No manifest bodies are returned. ' +
        'appNamespace is required when Applications-in-any-namespace is enabled.',
      inputSchema: z.object({ name: z.string(), appNamespace: z.string().optional() }),
      run: async ({ name, appNamespace }) => {
        const c = await client();
        const app = validateName('name', name);
        const namespace = appNamespace ? validateName('appNamespace', appNamespace) : undefined;
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
        'appNamespace is required when Applications-in-any-namespace is enabled.',
      inputSchema: z.object({ name: z.string(), appNamespace: z.string().optional() }),
      run: async ({ name, appNamespace }) => {
        const c = await client();
        const app = validateName('name', name);
        const namespace = appNamespace ? validateName('appNamespace', appNamespace) : undefined;
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
        'appNamespace is required when Applications-in-any-namespace is enabled.',
      inputSchema: z.object({ name: z.string(), appNamespace: z.string().optional() }),
      run: async ({ name, appNamespace }) => {
        const c = await client();
        const app = validateName('name', name);
        const namespace = appNamespace ? validateName('appNamespace', appNamespace) : undefined;
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
        'resource namespace), and sinceSeconds. appNamespace is required when ' +
        'Applications-in-any-namespace is enabled.',
      inputSchema: z.object({
        name: z.string(),
        podName: z.string().optional(),
        container: z.string().optional(),
        namespace: z.string().optional(),
        tailLines: z.number().int().positive().optional(),
        sinceSeconds: z.number().int().positive().optional(),
        appNamespace: z.string().optional(),
      }),
      run: async ({
        name,
        podName,
        container,
        namespace,
        tailLines,
        sinceSeconds,
        appNamespace,
      }) => {
        const c = await client();
        const app = validateName('name', name);
        const applicationNamespace = appNamespace
          ? validateName('appNamespace', appNamespace)
          : undefined;
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
      run: async ({ path, query }) => {
        const c = await client();
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
