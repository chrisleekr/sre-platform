import { describe, expect, test } from 'vitest';
import {
  apiConn,
  conn,
  fakeFetch,
  scopedApplication,
  scopedFetch,
  toolNamed,
} from './test-helpers';

describe('list_applications', () => {
  const appsResp = {
    items: [
      {
        metadata: { name: 'api', namespace: 'argocd' },
        spec: {
          project: 'default',
          source: { repoURL: 'git@x', targetRevision: 'HEAD', path: 'apps/api' },
        },
        status: {
          sync: { status: 'OutOfSync', revision: 'abc123' },
          health: { status: 'Degraded' },
          operationState: { phase: 'Failed', message: 'boom' },
        },
      },
    ],
  };

  test('locally scopes the default project, forwards the selector, and projects a summary', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: appsResp }));
    const out = (await toolNamed(apiConn(impl, false, 'app=web'), 'list_applications').run({})) as {
      applications: Array<Record<string, unknown>>;
    };
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/v1/applications');
    expect(u.searchParams.has('projects')).toBe(false);
    expect(u.searchParams.get('selector')).toBe('app=web');
    expect(out.applications[0]).toMatchObject({
      name: 'api',
      project: 'default',
      syncStatus: 'OutOfSync',
      healthStatus: 'Degraded',
      revisions: ['abc123'],
      sources: [
        {
          path: 'apps/api',
          targetRevision: 'HEAD',
        },
      ],
      operationPhase: 'Failed',
    });
  });

  test('rejects a missing items array as malformed provider data', async () => {
    const { impl } = fakeFetch(() => ({ json: {} }));
    await expect(toolNamed(apiConn(impl), 'list_applications').run({})).rejects.toThrow(
      /response is malformed/,
    );
  });

  test('preserves ordered multi-source and OCI coordinates in summaries', async () => {
    const { impl } = fakeFetch(() => ({
      json: {
        items: [
          {
            metadata: { name: 'api', namespace: 'argocd' },
            spec: {
              project: 'default',
              sources: [
                { repoURL: 'oci://registry.example/team/app', targetRevision: '1.2.3' },
                { repoURL: 'https://git.example/config', targetRevision: 'main' },
              ],
            },
            status: { sync: { revisions: ['digest-a', 'commit-b'] } },
          },
        ],
      },
    }));
    const out = (await toolNamed(apiConn(impl), 'list_applications').run({})) as {
      applications: Array<Record<string, unknown>>;
    };
    expect(out.applications[0]).toMatchObject({
      revisions: ['digest-a', 'commit-b'],
      sources: [
        { repoURL: 'oci://registry.example/team/app', targetRevision: '1.2.3' },
        { repoURL: 'https://git.example/config', targetRevision: 'main' },
      ],
    });
  });
});

describe('get_application', () => {
  test('returns a strict Application projection and omits inline source configuration', async () => {
    const appResp = {
      metadata: {
        name: 'api',
        namespace: 'argocd',
        uid: 'uid-api',
        managedFields: [{ manager: 'argocd' }],
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"secret":"x"}' },
      },
      spec: {
        project: 'default',
        source: {
          repoURL: 'https://user:odd-pass@git.example.com/app.git?token=abc#fragment',
          targetRevision: 'main',
          path: 'apps/api',
          helm: {
            values: 'password: short-secret',
            valuesObject: { password: 'short-secret' },
            parameters: [{ name: 'password', value: 'short-secret' }],
            fileParameters: [{ name: 'secret', path: 'secrets.yaml' }],
          },
          plugin: { env: [{ name: 'PASSWORD', value: 'short-secret' }] },
        },
      },
      status: { sync: { status: 'Synced' }, history: [] },
    };
    const { impl, calls } = fakeFetch(() => ({ json: appResp }));
    appResp.metadata.namespace = 'team-a';
    const out = (await toolNamed(apiConn(impl, true), 'get_application').run({
      name: 'api',
      appNamespace: 'team-a',
    })) as { metadata: Record<string, unknown>; status: Record<string, unknown> };
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/applications/api');
    expect(new URL(calls[0]!.url).searchParams.get('appNamespace')).toBe('team-a');
    expect(out.metadata.managedFields).toBeUndefined();
    expect(out.metadata.annotations).toBeUndefined();
    expect(out.status.sync).toMatchObject({ status: 'Synced' });
    expect(JSON.stringify(out)).not.toContain('short-secret');
    expect(JSON.stringify(out)).not.toContain('odd-pass');
    expect(JSON.stringify(out)).not.toContain('token=abc');
    expect(JSON.stringify(out)).not.toContain('valuesObject');
  });

  test('rejects an invalid application name before any fetch', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'get_application').run({ name: '../../etc' }),
    ).rejects.toThrow(/invalid name/);
    expect(calls).toHaveLength(0);
  });

  test('rejects an invalid appNamespace', async () => {
    const c = conn(fakeFetch().impl);
    await expect(
      toolNamed(c, 'get_application').run({ name: 'api', appNamespace: 'Bad NS' }),
    ).rejects.toThrow(/invalid appNamespace/);
  });

  test('requires appNamespace for named tools in Applications-in-any-namespace mode', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(apiConn(impl, true), 'get_application').run({ name: 'api' }),
    ).rejects.toThrow(/namespace is required/);
    expect(calls).toHaveLength(0);
  });
});

describe('get_resource_tree + get_application_events', () => {
  test('resource_tree hits the right path', async () => {
    const { impl, calls } = scopedFetch({ json: { nodes: [] } });
    await toolNamed(apiConn(impl), 'get_resource_tree').run({ name: 'api' });
    expect(new URL(calls[1]!.url).pathname).toBe('/api/v1/applications/api/resource-tree');
  });
  test('events hits the right path', async () => {
    const { impl, calls } = scopedFetch({ json: { items: [] } });
    await toolNamed(apiConn(impl), 'get_application_events').run({ name: 'api' });
    expect(new URL(calls[1]!.url).pathname).toBe('/api/v1/applications/api/events');
  });

  test('rejects an out-of-scope Application before reading its subresource', async () => {
    const { impl, calls } = fakeFetch(() => ({
      json: {
        metadata: { name: 'api', namespace: 'argocd', uid: 'uid-api' },
        spec: { project: 'outside' },
      },
    }));
    await expect(
      toolNamed(apiConn(impl), 'get_resource_tree').run({ name: 'api' }),
    ).rejects.toThrow(/outside the configured scope/);
    expect(calls).toHaveLength(1);
  });

  test('rejects appNamespace when Applications-in-any-namespace is disabled', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(apiConn(impl), 'get_application_events').run({
        name: 'api',
        appNamespace: 'team-a',
      }),
    ).rejects.toThrow(/namespace is outside/);
    expect(calls).toHaveLength(0);
  });
});

describe('get_managed_resources (drift diff scrubbing)', () => {
  const managedResp = {
    items: [
      {
        kind: 'Secret',
        name: 'db',
        namespace: 'prod',
        targetState: JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'db', managedFields: [{ manager: 'x' }] },
          data: { password: 'aGk=' },
        }),
        liveState: JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'db' },
          data: { password: 'c2VjcmV0' },
        }),
      },
      { kind: 'ConfigMap', name: 'cfg', normalizedLiveState: 'not-json{' },
    ],
  };

  test('redacts Secret data in every state, keeps keys/metadata, marks unparseable', async () => {
    const { impl, calls } = scopedFetch({ json: managedResp }, 'team-a');
    const out = (await toolNamed(apiConn(impl, true), 'get_managed_resources').run({
      name: 'api',
      appNamespace: 'team-a',
    })) as { items: Array<Record<string, unknown>> };
    expect(new URL(calls[1]!.url).pathname).toBe('/api/v1/applications/api/managed-resources');
    expect(new URL(calls[1]!.url).searchParams.get('appNamespace')).toBe('team-a');

    const secret = out.items[0]!;
    const target = secret.targetState as {
      data: Record<string, string>;
      metadata: Record<string, unknown>;
    };
    const live = secret.liveState as { data: Record<string, string> };
    expect(target.data.password).toBe('[REDACTED]'); // value gone, key kept
    expect(live.data.password).toBe('[REDACTED]');
    expect(target.metadata.managedFields).toBeUndefined();
    expect(secret.kind).toBe('Secret'); // envelope metadata preserved
    expect(secret.name).toBe('db');

    const cm = out.items[1]!;
    expect(cm.normalizedLiveState).toBe('[unparseable manifest omitted]');
  });

  test('scrubs a manifest-bearing field outside the known state list', async () => {
    // A future/unknown field that carries a manifest must not slip through the fixed state list.
    const resp = {
      items: [
        {
          kind: 'Secret',
          name: 'db',
          extraState: JSON.stringify({ kind: 'Secret', data: { token: 'c2VjcmV0' } }),
        },
      ],
    };
    const { impl } = scopedFetch({ json: resp });
    const out = (await toolNamed(apiConn(impl), 'get_managed_resources').run({ name: 'api' })) as {
      items: Array<Record<string, unknown>>;
    };
    const item = out.items[0]!;
    expect((item.extraState as { data: Record<string, string> }).data.token).toBe('[REDACTED]');
    expect(item.name).toBe('db'); // a plain scalar field is untouched
  });
});

describe('get_application_logs', () => {
  test('parses the NDJSON stream, forces follow=false, defaults tailLines', async () => {
    const stream = '{"result":{"content":"line1"}}\n{"result":{"content":"line2"}}\n';
    const { impl, calls } = scopedFetch({ text: stream });
    const out = (await toolNamed(apiConn(impl), 'get_application_logs').run({ name: 'api' })) as {
      log: string;
    };
    const u = new URL(calls[1]!.url);
    expect(u.pathname).toBe('/api/v1/applications/api/logs');
    expect(u.searchParams.get('follow')).toBe('false');
    expect(u.searchParams.get('tailLines')).toBe('100');
    expect(out.log).toBe('line1\nline2');
  });

  test('caps tailLines at 1000 and passes optional params', async () => {
    const { impl, calls } = scopedFetch({ text: '' });
    await toolNamed(apiConn(impl), 'get_application_logs').run({
      name: 'api',
      podName: 'api-abc',
      container: 'app',
      namespace: 'prod',
      tailLines: 5000,
      sinceSeconds: 600,
    });
    const u = new URL(calls[1]!.url);
    expect(u.searchParams.get('tailLines')).toBe('1000');
    expect(u.searchParams.get('podName')).toBe('api-abc');
    expect(u.searchParams.get('container')).toBe('app');
    expect(u.searchParams.get('namespace')).toBe('prod');
    expect(u.searchParams.get('sinceSeconds')).toBe('600');
  });

  test('falls back to raw body when no line is JSON', async () => {
    const { impl } = scopedFetch({ text: 'plain log line\nanother' });
    const out = (await toolNamed(apiConn(impl), 'get_application_logs').run({ name: 'api' })) as {
      log: string;
    };
    expect(out.log).toBe('plain log line\nanother');
  });

  test('tails to the 64KiB ceiling', async () => {
    const big = 'x'.repeat(70_000);
    const { impl } = scopedFetch({ text: `{"result":{"content":"${big}"}}` });
    const out = (await toolNamed(apiConn(impl), 'get_application_logs').run({ name: 'api' })) as {
      log: string;
    };
    expect(out.log.length).toBe(64 * 1024);
  });

  test('cancels an oversized unknown-length log stream before materializing it', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1100 * 1024).fill(120);
    const fetchImpl = (async (url: string | URL | Request) =>
      new URL(String(url)).pathname === '/api/v1/applications/api'
        ? new Response(JSON.stringify(scopedApplication()), { status: 200 })
        : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(chunk);
                controller.enqueue(chunk);
              },
              cancel() {
                cancelled = true;
              },
            }),
          )) as unknown as typeof fetch;
    await expect(
      toolNamed(apiConn(fetchImpl), 'get_application_logs').run({ name: 'api' }),
    ).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true);
  });
});
