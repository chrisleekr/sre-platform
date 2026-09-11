import { describe, expect, test } from 'vitest';
import { apiConn, conn, fakeFetch, scopedApplication, toolNamed } from './test-helpers';

describe('api_get', () => {
  test('GETs an arbitrary /api path', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { Version: '2.11' } }));
    await toolNamed(conn(impl), 'api_get').run({ path: 'api/v1/version' });
    expect(calls[0]!.url).toBe('https://argocd.example.com/api/v1/version');
    expect(calls[0]!.method).toBe('GET');
  });

  test('refuses the managed-resources endpoint (secret-leak surface)', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'api_get').run({ path: 'api/v1/applications/api/managed-resources' }),
    ).rejects.toThrow(/projected named tools/);
    expect(calls).toHaveLength(0);
  });

  test('refuses the single-resource manifest endpoint', async () => {
    const c = conn(fakeFetch().impl);
    await expect(
      toolNamed(c, 'api_get').run({ path: 'api/v1/applications/api/resource' }),
    ).rejects.toThrow(/projected named tools/);
  });

  test('refuses GetManifests (manifests / manifests-with-files)', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'api_get').run({ path: 'api/v1/applications/api/manifests' }),
    ).rejects.toThrow(/projected named tools/);
    await expect(
      toolNamed(conn(impl), 'api_get').run({
        path: 'api/v1/applications/api/manifests-with-files',
      }),
    ).rejects.toThrow(/projected named tools/);
    expect(calls).toHaveLength(0);
  });

  test('refuses a percent-encoded manifest endpoint (denylist evasion)', async () => {
    const { impl, calls } = fakeFetch();
    // managed-resource%73 decodes to managed-resources; ArgoCD would route it there. buildGetUrl
    // rejects any '%' in the path before the fetch, and the decoded denylist is the backstop.
    await expect(
      toolNamed(conn(impl), 'api_get').run({
        path: 'api/v1/applications/api/managed-resource%73',
      }),
    ).rejects.toThrow(/percent-encoded|projected named tools/);
    await expect(
      toolNamed(conn(impl), 'api_get').run({
        path: 'api/v1/applications/api/managed%2Dresources',
      }),
    ).rejects.toThrow(/percent-encoded|projected named tools/);
    expect(calls).toHaveLength(0);
  });

  test('forwards the optional query into the URL', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'api_get').run({
      path: 'api/v1/settings',
      query: { section: 'status' },
    });
    expect(new URL(calls[0]!.url).searchParams.get('section')).toBe('status');
  });

  test.each([
    'api/v1/applications',
    'api/v1/applications/api',
    'api/v1/projects',
    'api/v1/clusters',
    'api/v1/repositories',
  ])('refuses raw or global inventory path %s', async (path) => {
    const { impl, calls } = fakeFetch();
    await expect(toolNamed(conn(impl), 'api_get').run({ path })).rejects.toThrow(
      /projected named tools/,
    );
    expect(calls).toHaveLength(0);
  });

  test('refuses raw Applications when the configured server uses an api-shaped root path', async () => {
    const { impl, calls } = fakeFetch();
    const connector = conn(impl, {
      settings: { baseUrl: 'https://argocd.example.com/tenant/api/v1' },
    });
    await expect(
      toolNamed(connector, 'api_get').run({ path: 'api/v1/applications' }),
    ).rejects.toThrow(/projected named tools/);
    expect(calls).toHaveLength(0);
  });

  test('refuses resource-tree through the generic path', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { nodes: [] } }));
    await expect(
      toolNamed(conn(impl), 'api_get').run({ path: 'api/v1/applications/api/resource-tree' }),
    ).rejects.toThrow(/projected named tools/);
    expect(calls).toHaveLength(0);
  });

  test('rejects a traversal path', async () => {
    const c = conn(fakeFetch().impl);
    await expect(toolNamed(c, 'api_get').run({ path: 'api/../secret' })).rejects.toThrow(
      /must be under \/api\//,
    );
  });

  test('throws on a non-ok status', async () => {
    const c = conn(fakeFetch(() => ({ ok: false, status: 404 })).impl);
    await expect(toolNamed(c, 'api_get').run({ path: 'api/v1/version' })).rejects.toThrow(
      /argocd api 404/,
    );
  });

  test.each([
    ['named JSON tool', 'get_resource_tree', { name: 'api' }],
    ['api_get', 'api_get', { path: 'api/v1/settings' }],
  ])('bounds an unknown-length oversized %s response', async (_label, tool, input) => {
    let cancelled = false;
    const chunk = new Uint8Array(1100 * 1024).fill(32);
    const fetchImpl = (async (url: string | URL | Request) => {
      if (
        tool === 'get_resource_tree' &&
        new URL(String(url)).pathname === '/api/v1/applications/api'
      )
        return new Response(JSON.stringify(scopedApplication()), { status: 200 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }) as unknown as typeof fetch;
    const connector = tool === 'get_resource_tree' ? apiConn(fetchImpl) : conn(fetchImpl);
    await expect(toolNamed(connector, tool).run(input)).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true);
  });
});

describe('fetchTriageContext', () => {
  const appResp = {
    items: [
      {
        metadata: { name: 'api', namespace: 'argocd' },
        spec: { project: 'default' },
        status: {
          sync: { status: 'OutOfSync' },
          health: { status: 'Degraded' },
          conditions: [
            {
              type: 'SyncError',
              message: 'failed https://user:triage-secret@git.example/repo?token=short',
            },
          ],
        },
      },
    ],
  };

  test('maps the service to an application headline', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: appResp }));
    const ctx = await apiConn(impl).fetchTriageContext({ service: 'api', windowMinutes: 30 });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/applications');
    expect(ctx.source).toBe('argocd');
    const data = ctx.data as { application: Record<string, unknown>; conditions: unknown[] };
    expect(data.application).toMatchObject({ syncStatus: 'OutOfSync', healthStatus: 'Degraded' });
    expect(data.conditions).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain('triage-secret');
    expect(JSON.stringify(data)).not.toContain('token=short');
  });

  test('degrades to a note when the app is absent (404)', async () => {
    const { impl } = fakeFetch(() => ({ ok: false, status: 404 }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'missing', windowMinutes: 30 });
    expect((ctx.data as { note?: string }).note).toMatch(/no argocd application named 'missing'/);
  });

  test('degrades to a note for a non-name service without any fetch', async () => {
    const { impl, calls } = fakeFetch();
    const ctx = await conn(impl).fetchTriageContext({ service: 'Bad Service', windowMinutes: 30 });
    expect((ctx.data as { note?: string }).note).toMatch(/no argocd application/);
    expect(calls).toHaveLength(0);
  });

  test('degrades to a note when only an out-of-scope application has the service name', async () => {
    const { impl } = fakeFetch(() => ({
      json: {
        items: [
          {
            metadata: { name: 'api', namespace: 'argocd' },
            spec: { project: 'outside' },
          },
        ],
      },
    }));
    const ctx = await apiConn(impl).fetchTriageContext({ service: 'api', windowMinutes: 30 });
    expect((ctx.data as { note?: string }).note).toMatch(/no argocd application/);
  });

  test('returns namespace-qualified candidates when a scoped any-namespace name is ambiguous', async () => {
    const { impl } = fakeFetch(() => ({
      json: {
        items: ['team-a', 'team-b'].map((namespace) => ({
          metadata: { name: 'api', namespace },
          spec: { project: 'default' },
        })),
      },
    }));
    const connector = conn(impl, {
      settings: {
        applicationsInAnyNamespace: true,
        applications: [{ project: 'default', namespace: '*', name: 'api' }],
      },
    });
    const ctx = await connector.fetchTriageContext({ service: 'api', windowMinutes: 30 });
    expect(ctx.data).toMatchObject({
      note: "multiple scoped argocd applications are named 'api'",
      applications: [
        { name: 'api', namespace: 'team-a' },
        { name: 'api', namespace: 'team-b' },
      ],
    });
  });
});
