import { describe, expect, test } from 'vitest';
import { apiConn, cfg, conn, fakeFetch, lookup, makeArgoCdConnector } from './test-helpers';

describe('snapshot', () => {
  test('returns no rows and records successful evidence for an empty scoped list', async () => {
    const connector = conn(fakeFetch(() => ({ json: { items: [] } })).impl);
    await expect(connector.snapshot()).resolves.toEqual([]);
    expect(connector.pollEvidence?.()?.failureCategory).toBeUndefined();
  });

  test('filters to configured scope and forwards the label selector', async () => {
    const { impl, calls } = fakeFetch(() => ({
      json: {
        items: [
          {
            metadata: { name: 'checkout', namespace: 'argocd', uid: 'uid-checkout' },
            spec: { project: 'payments', destination: { namespace: 'payments' } },
            status: { sync: {}, health: {}, history: [] },
          },
          {
            metadata: { name: 'orders', namespace: 'argocd', uid: 'uid-orders' },
            spec: { project: 'payments', destination: { namespace: 'orders' } },
            status: { sync: {}, health: {}, history: [] },
          },
        ],
      },
    }));
    const connector = conn(impl, {
      settings: {
        baseUrl: 'https://argocd.example.com',
        applicationsInAnyNamespace: false,
        applications: [{ project: 'payments', name: 'checkout' }],
        labelSelector: 'sre=true',
      },
    });
    const snapshots = await connector.snapshot();
    expect(snapshots.map((snapshot) => snapshot.entityId)).toEqual([
      'application:payments/argocd/checkout',
    ]);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.getAll('projects')).toEqual(['payments']);
    expect(url.searchParams.get('selector')).toBe('sre=true');
  });

  test('normalizes an omitted Application project to default without a server project filter', async () => {
    const { impl, calls } = fakeFetch(() => ({
      json: {
        items: [
          {
            metadata: { name: 'api', namespace: 'argocd', uid: 'uid-api' },
            spec: {},
            status: { sync: {}, health: {}, history: [] },
          },
        ],
      },
    }));
    const snapshots = await apiConn(impl).snapshot();
    expect(snapshots[0]).toMatchObject({
      entityId: 'application:default/argocd/api',
      metadata: { project: 'default' },
    });
    expect(new URL(calls[0]!.url).searchParams.has('projects')).toBe(false);
  });

  test('removes credentials and sensitive query data from snapshots and links', async () => {
    const connector = apiConn(
      fakeFetch(() => ({
        json: {
          items: [
            {
              metadata: {
                name: 'api',
                namespace: 'argocd',
                uid: 'uid-api',
                annotations: {
                  'link.argocd.argoproj.io/external-link':
                    'https://user:link-secret@argocd.example/app?token=short#fragment',
                },
              },
              spec: {
                project: 'default',
                sources: [
                  { repoURL: 'https://user:repo-secret@git.example/repo?password=short' },
                  { repoURL: 'credential:user:opaque-secret@host' },
                ],
              },
              status: {
                sync: {},
                health: { message: 'see https://user:health-secret@example/failure' },
                operationState: { message: 'failed?token=operation-secret' },
                conditions: [
                  { type: 'ComparisonError', message: 'https://user:condition-secret@example' },
                  { type: 'RenderError', message: 'credential:user:message-secret@host' },
                  {
                    type: 'AuthError',
                    message: 'https://callback.example/#access_token=fragment-secret&state=ok',
                  },
                ],
                history: [],
              },
            },
          ],
        },
      })).impl,
    );
    const serialized = JSON.stringify(await connector.snapshot());
    for (const secret of [
      'link-secret',
      'repo-secret',
      'health-secret',
      'operation-secret',
      'condition-secret',
      'opaque-secret',
      'message-secret',
      'fragment-secret',
      'password=short',
      'token=short',
    ])
      expect(serialized).not.toContain(secret);
  });

  test('keeps equal revisions from two Applications as distinct history events', async () => {
    const app = (name: string) => ({
      metadata: { name, namespace: 'argocd', uid: `uid-${name}` },
      spec: { project: 'payments', destination: { namespace: name } },
      status: {
        sync: {},
        health: {},
        history: [
          {
            id: 7,
            revision: 'same-revision',
            source: { targetRevision: 'main' },
            deployStartedAt: '2026-08-22T01:00:00Z',
            deployedAt: '2026-08-22T01:01:00Z',
            initiatedBy: { automated: true },
          },
        ],
      },
    });
    const connector = conn(
      fakeFetch(() => ({ json: { items: [app('checkout'), app('orders')] } })).impl,
      { settings: { applications: [{ project: 'payments', name: '*' }] } },
    );
    const histories = (await connector.snapshot()).filter(
      (snapshot) => snapshot.metadata.kind === 'deployment',
    );
    expect(histories.map((snapshot) => snapshot.metadata.providerId)).toEqual([
      'uid-checkout:7',
      'uid-orders:7',
    ]);
    expect(histories[0]?.metadata).toMatchObject({
      ref: 'main',
      actor: 'automated sync',
    });
    expect(histories[0]?.metadata).not.toHaveProperty('destinationServer');
    expect(histories[0]?.metadata).not.toHaveProperty('destinationNamespace');
  });

  test('keys history by immutable Application UID instead of mutable project and destination', async () => {
    const application = (project: string, destination: string) => ({
      metadata: { name: 'checkout', namespace: 'argocd', uid: 'uid-stable' },
      spec: { project, destination: { namespace: destination } },
      status: {
        sync: {},
        health: {},
        history: [
          {
            id: 7,
            revision: 'release',
            deployedAt: '2026-08-22T01:01:00Z',
          },
        ],
      },
    });
    const first = conn(
      fakeFetch(() => ({ json: { items: [application('payments', 'old-destination')] } })).impl,
    );
    const second = conn(
      fakeFetch(() => ({ json: { items: [application('renamed', 'new-destination')] } })).impl,
      { settings: { applications: [{ project: 'renamed', name: 'checkout' }] } },
    );
    const firstHistory = (await first.snapshot()).find(
      (snapshot) => snapshot.metadata.kind === 'deployment',
    );
    const secondHistory = (await second.snapshot()).find(
      (snapshot) => snapshot.metadata.kind === 'deployment',
    );
    expect(firstHistory?.metadata.providerId).toBe('uid-stable:7');
    expect(secondHistory?.metadata.providerId).toBe('uid-stable:7');
    expect(firstHistory?.metadata).not.toHaveProperty('destinationNamespace');
    expect(secondHistory?.metadata).not.toHaveProperty('destinationNamespace');
  });

  test('fails closed when provider history has no immutable Application UID', async () => {
    const connector = conn(
      fakeFetch(() => ({
        json: {
          items: [
            {
              metadata: { name: 'checkout', namespace: 'argocd' },
              spec: { project: 'payments' },
              status: { sync: {}, health: {}, history: [{ id: 7, revision: 'release' }] },
            },
          ],
        },
      })).impl,
    );
    await expect(connector.snapshot()).rejects.toThrow(/metadata.uid/);
  });

  test('fails with secret-free backlog evidence when application or history work exceeds bounds', async () => {
    const tooManyApps = conn(
      fakeFetch(() => ({
        json: {
          items: Array.from({ length: 201 }, (_, index) => ({
            metadata: { name: `app-${index}`, namespace: 'argocd', uid: `uid-${index}` },
            spec: { project: 'default' },
            status: {},
          })),
        },
      })).impl,
    );
    await expect(tooManyApps.snapshot()).rejects.toThrow(/application count/);
    expect(tooManyApps.pollEvidence?.()).toMatchObject({ failureCategory: 'backlog' });

    const tooMuchHistory = conn(
      fakeFetch(() => ({
        json: {
          items: [
            {
              metadata: { name: 'checkout', namespace: 'argocd', uid: 'uid-checkout' },
              spec: { project: 'payments' },
              status: { history: Array.from({ length: 21 }, (_, id) => ({ id })) },
            },
          ],
        },
      })).impl,
    );
    await expect(tooMuchHistory.snapshot()).rejects.toThrow(/history count/);
    expect(JSON.stringify(tooMuchHistory.pollEvidence?.())).not.toContain('checkout');
  });

  test('cancels an unknown-length Applications response after the byte bound', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1100 * 1024).fill(32);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const connector = makeArgoCdConnector(cfg(), fetchImpl, lookup);
    await expect(connector.snapshot()).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true);
    expect(connector.pollEvidence?.()).toMatchObject({ failureCategory: 'backlog' });
  });
});
