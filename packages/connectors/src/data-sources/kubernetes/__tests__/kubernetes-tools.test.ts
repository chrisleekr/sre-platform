import { describe, expect, test } from 'vitest';
import { cfg, eventsResp, makeKubernetesConnector, type ConnectorConfig } from './test-helpers';

const REDACTED = '[REDACTED]';

/** A general fake fetch for the tool tests: routes by URL, records calls, serves json or text. */
function toolFetch(handler: (url: string) => { status?: number; json?: unknown; text?: string }) {
  const calls: { url: string; auth?: string }[] = [];
  const impl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    calls.push({ url: u, auth: init?.headers?.Authorization });
    const r = handler(u);
    const status = r.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function k8sTool(name: string, config: ConnectorConfig, fetchImpl: typeof fetch) {
  const t = makeKubernetesConnector(config, fetchImpl)
    .tools()
    .find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe('makeKubernetesConnector tools()', () => {
  test('exposes the seven read tools', () => {
    const names = makeKubernetesConnector(cfg())
      .tools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        'get_pod_logs',
        'get_resource',
        'list_api_resources',
        'list_events',
        'list_resources',
        'top_nodes',
        'top_pods',
      ].sort(),
    );
  });

  test('get_resource builds a namespaced URL and sanitizes a Secret get', async () => {
    const { impl, calls } = toolFetch(() => ({
      json: { kind: 'Secret', data: { password: 'x' } },
    }));
    const out = (await k8sTool('get_resource', cfg(), impl).run({
      apiVersion: 'v1',
      resource: 'secrets',
      name: 'db',
      namespace: 'checkout',
    })) as { data: Record<string, string> };
    expect(calls[0]!.url).toContain('/api/v1/namespaces/checkout/secrets/db');
    expect(out.data.password).toBe(REDACTED);
  });

  test('get_resource with no namespace builds the cluster-scoped path (nodes)', async () => {
    const { impl, calls } = toolFetch(() => ({ json: { kind: 'Node' } }));
    await k8sTool('get_resource', cfg(), impl).run({
      apiVersion: 'v1',
      resource: 'nodes',
      name: 'ip-10-0-0-5',
    });
    // Cluster-scoped kind: no /namespaces/ segment even though it is omitted, not defaulted.
    expect(calls[0]!.url).toContain('/api/v1/nodes/ip-10-0-0-5');
    expect(calls[0]!.url).not.toContain('/namespaces/');
  });

  test('get_resource redacts a Secret whose response omits .kind (input-driven via resourceKind)', async () => {
    // The apiserver echo may omit `.kind`; redaction must key off the queried resource, not the echo.
    const { impl } = toolFetch(() => ({
      json: { metadata: { name: 'db' }, data: { password: 'x' } },
    }));
    const out = (await k8sTool('get_resource', cfg(), impl).run({
      apiVersion: 'v1',
      resource: 'secrets',
      name: 'db',
      namespace: 'checkout',
    })) as { data: Record<string, string> };
    expect(out.data.password).toBe(REDACTED);
  });

  test('list_resources with no namespace lists across all namespaces (cluster path)', async () => {
    const { impl, calls } = toolFetch(() => ({ json: { items: [] } }));
    await k8sTool('list_resources', cfg(), impl).run({ apiVersion: 'v1', resource: 'nodes' });
    expect(calls[0]!.url).toContain('/api/v1/nodes?limit=200');
    expect(calls[0]!.url).not.toContain('/namespaces/');
  });

  test('get_resource rejects a path-injecting name/resource before any fetch', async () => {
    const { impl, calls } = toolFetch(() => ({ json: {} }));
    await expect(
      k8sTool('get_resource', cfg(), impl).run({
        apiVersion: 'v1',
        resource: 'pods',
        name: '../secrets/x',
      }),
    ).rejects.toThrow();
    await expect(
      k8sTool('get_resource', cfg(), impl).run({
        apiVersion: 'v1',
        resource: 'pods/../..',
        name: 'p',
      }),
    ).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  test('list_resources builds an apps/v1 URL with a default limit and redacts item env', async () => {
    const { impl, calls } = toolFetch(() => ({
      json: {
        items: [
          {
            kind: 'Deployment',
            spec: {
              template: {
                spec: { containers: [{ name: 'a', env: [{ name: 'PW', value: 's' }] }] },
              },
            },
          },
        ],
      },
    }));
    const out = (await k8sTool('list_resources', cfg(), impl).run({
      apiVersion: 'apps/v1',
      resource: 'deployments',
      namespace: 'checkout',
    })) as { items: any[] };
    expect(calls[0]!.url).toContain('/apis/apps/v1/namespaces/checkout/deployments?limit=200');
    expect(out.items[0].spec.template.spec.containers[0].env[0].value).toBe(REDACTED);
  });

  test('list_resources of secrets redacts each item data via resourceKind', async () => {
    const { impl } = toolFetch(() => ({
      json: { items: [{ metadata: { name: 'db' }, data: { password: 'x' } }] },
    }));
    const out = (await k8sTool('list_resources', cfg(), impl).run({
      apiVersion: 'v1',
      resource: 'secrets',
    })) as { items: any[] };
    expect(out.items[0].data.password).toBe(REDACTED);
  });

  test('get_pod_logs reads raw text and bounds tailLines and limitBytes', async () => {
    const { impl, calls } = toolFetch(() => ({ text: 'line1\nline2' }));
    const out = (await k8sTool('get_pod_logs', cfg(), impl).run({
      namespace: 'checkout',
      name: 'checkout-abc',
    })) as { log: string };
    expect(calls[0]!.url).toContain('/api/v1/namespaces/checkout/pods/checkout-abc/log?');
    expect(calls[0]!.url).toContain('tailLines=200');
    expect(calls[0]!.url).toContain('limitBytes=65536');
    expect(out.log).toBe('line1\nline2');
  });

  test('list_events defaults to Warning and maps events', async () => {
    const { impl, calls } = toolFetch(() => ({ json: eventsResp }));
    const out = (await k8sTool('list_events', cfg(), impl).run({ namespace: 'checkout' })) as {
      events: Array<{ object: string }>;
    };
    expect(calls[0]!.url).toContain('fieldSelector=type%3DWarning');
    expect(out.events[0]!.object).toBe('Pod/checkout-abc');
  });

  test('top_nodes returns metrics and degrades a 404 to unavailable', async () => {
    const ok = toolFetch(() => ({ json: { items: [{ metadata: { name: 'n1' } }] } }));
    const okOut = (await k8sTool('top_nodes', cfg(), ok.impl).run({})) as { items: any[] };
    expect(okOut.items[0].metadata.name).toBe('n1');
    const nf = toolFetch(() => ({ status: 404 }));
    const nfOut = (await k8sTool('top_nodes', cfg(), nf.impl).run({})) as {
      unavailable?: string;
    };
    expect(nfOut.unavailable).toMatch(/metrics-server/);
  });

  test('top_pods builds the metrics URL', async () => {
    const { impl, calls } = toolFetch(() => ({ json: { items: [] } }));
    await k8sTool('top_pods', cfg(), impl).run({ namespace: 'checkout' });
    expect(calls[0]!.url).toContain('/apis/metrics.k8s.io/v1beta1/namespaces/checkout/pods');
  });

  test('top_pods with no namespace builds the all-namespace metrics URL', async () => {
    const { impl, calls } = toolFetch(() => ({ json: { items: [] } }));
    await k8sTool('top_pods', cfg(), impl).run({});
    expect(calls[0]!.url).toContain('/apis/metrics.k8s.io/v1beta1/pods');
    expect(calls[0]!.url).not.toContain('/namespaces/');
  });

  test('get_pod_logs threads container, previous, and sinceSeconds into the query', async () => {
    const { impl, calls } = toolFetch(() => ({ text: 'log' }));
    await k8sTool('get_pod_logs', cfg(), impl).run({
      namespace: 'checkout',
      name: 'checkout-abc',
      container: 'app',
      previous: true,
      sinceSeconds: 300,
    });
    const url = calls[0]!.url;
    expect(url).toContain('container=app');
    expect(url).toContain('previous=true');
    expect(url).toContain('sinceSeconds=300');
    // The bounding defaults are still applied alongside the optional flags.
    expect(url).toContain('tailLines=200');
    expect(url).toContain('limitBytes=65536');
  });

  test('a 403 on get_resource throws (dispatch maps it to a graceful error)', async () => {
    const { impl } = toolFetch(() => ({ status: 403 }));
    await expect(
      k8sTool('get_resource', cfg(), impl).run({
        apiVersion: 'v1',
        resource: 'secrets',
        name: 'db',
        namespace: 'x',
      }),
    ).rejects.toThrow(/k8s api 403/);
  });

  test('list_api_resources flattens core and grouped discovery, dropping subresources', async () => {
    const { impl } = toolFetch((u) => {
      if (u.endsWith('/api/v1'))
        return {
          json: {
            resources: [
              { name: 'pods', kind: 'Pod', namespaced: true },
              { name: 'pods/log', kind: 'Pod', namespaced: true },
            ],
          },
        };
      if (u.endsWith('/apis'))
        return { json: { groups: [{ name: 'apps', preferredVersion: { version: 'v1' } }] } };
      if (u.endsWith('/apis/apps/v1'))
        return {
          json: { resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true }] },
        };
      return { json: {} };
    });
    const out = (await k8sTool('list_api_resources', cfg(), impl).run({})) as {
      resources: Array<{ resource: string }>;
    };
    const names = out.resources.map((r) => r.resource);
    expect(names).toContain('pods');
    expect(names).not.toContain('pods/log');
    expect(names).toContain('deployments');
  });

  test('tools honor the SSRF guard (a private apiUrl needs a pinned CA)', async () => {
    const { impl } = toolFetch(() => ({ json: {} }));
    const t = k8sTool('get_resource', cfg({ settings: { apiUrl: 'https://10.0.0.1:6443' } }), impl);
    await expect(
      t.run({ apiVersion: 'v1', resource: 'pods', name: 'p', namespace: 'x' }),
    ).rejects.toThrow(/private apiUrl requires caCert/);
  });
});
