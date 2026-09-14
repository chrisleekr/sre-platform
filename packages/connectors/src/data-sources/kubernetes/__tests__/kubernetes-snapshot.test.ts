import { describe, expect, test } from 'vitest';
import { entityCandidateKey, type AffectedEntityCandidate } from '@sre/contracts';
import { cfg, fakeFetch, makeKubernetesConnector } from './test-helpers';

describe('makeKubernetesConnector snapshot', () => {
  test('includes pods from later pages and records complete collection', async () => {
    const urls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      const value = String(url);
      urls.push(value);
      const later = value.includes('continue=next%2Fpage');
      return Response.json(
        value.includes('/pods')
          ? {
              metadata: later ? {} : { continue: 'next/page' },
              items: [
                {
                  metadata: { name: later ? 'failed' : 'ready', namespace: 'checkout' },
                  status: { phase: later ? 'Failed' : 'Running' },
                },
              ],
            }
          : { items: [] },
      );
    }) as typeof fetch;
    const snapshots = await makeKubernetesConnector(cfg(), impl).snapshot();
    expect(snapshots.filter((item) => item.metadata.kind === 'pod')).toHaveLength(2);
    expect(snapshots.find((item) => item.entityId === 'checkout/failed')?.metadata.phase).toBe(
      'Failed',
    );
    expect(urls.some((url) => url.includes('continue=next%2Fpage'))).toBe(true);
    expect(
      snapshots.find((item) => item.entityId === 'collection/pods')?.metadata.completeness,
    ).toBe('complete');
  });

  test('marks the bounded page cap as partial instead of claiming complete inventory', async () => {
    const { impl, calls } = fakeFetch({ pods: { metadata: { continue: 'more' }, items: [] } });
    const snapshots = await makeKubernetesConnector(cfg(), impl).snapshot();
    expect(calls.filter((call) => call.url.includes('/pods'))).toHaveLength(5);
    expect(
      snapshots.find((item) => item.entityId === 'collection/pods')?.metadata.completeness,
    ).toBe('partial');
  });

  test('records a successful empty collection explicitly', async () => {
    const { impl } = fakeFetch({ pods: { items: [] }, nodes: { items: [] } });
    const snapshots = await makeKubernetesConnector(cfg(), impl).snapshot();
    expect(snapshots).toEqual([
      expect.objectContaining({
        entityId: 'collection/pods',
        metadata: expect.objectContaining({ completeness: 'complete' }),
      }),
    ]);
  });

  test('declares the saved cluster and namespace as its entity coverage boundary', () => {
    const { impl } = fakeFetch();
    const connector = makeKubernetesConnector(
      cfg({
        settings: {
          apiUrl: 'https://k8s.example.com:6443',
          name: 'production',
          namespace: 'checkout',
        },
      }),
      impl,
    );
    const candidate: AffectedEntityCandidate = {
      key: entityCandidateKey('workload', 'checkout-7d9f', {
        cluster: 'staging',
        namespace: 'checkout',
      }),
      kind: 'workload',
      stableId: 'checkout-7d9f',
      displayName: 'checkout-7d9f',
      scope: { cluster: 'staging', namespace: 'checkout' },
      provenance: { kind: 'provider_label', source: 'pod' },
      confidence: 90,
      observedAt: '2026-08-31T00:00:00.000Z',
      completeness: 'complete',
      requiredCapabilities: ['runtime'],
    };

    expect(connector.entityCoverage?.assess(candidate)).toBe('out_of_scope');
    expect(
      connector.entityCoverage?.assess({
        ...candidate,
        key: entityCandidateKey('workload', 'checkout-7d9f', {
          cluster: 'production',
          namespace: 'checkout',
        }),
        scope: { cluster: 'production', namespace: 'checkout' },
      }),
    ).toBe('covered');
  });

  test('emits one snapshot per pod with numeric health metrics and reasons in metadata', async () => {
    const { impl } = fakeFetch();
    const c = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', namespace: 'checkout' } }),
      impl,
    );

    const snaps = await c.snapshot();
    const pod = snaps.find((s) => s.entityId === 'checkout/checkout-abc');
    expect(pod).toBeDefined();
    expect(pod!.source).toBe('kubernetes');
    expect(pod!.tenantId).toBe('t1');
    // The prior OOM remains diagnostic history, not a current health metric.
    expect(pod!.metrics.restartCount).toBe(7);
    expect(pod!.metrics.oomKilled).toBe(0);
    expect(pod!.metrics.ready).toBe(0);
    expect(pod!.metadata.kind).toBe('pod');
    expect(pod!.metadata.namespace).toBe('checkout');
    expect(pod!.metadata.containers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'app',
          lastTerminatedReason: 'OOMKilled',
          lastTerminatedAt: '2026-08-17T05:43:23Z',
        }),
      ]),
    );
    expect(pod!.observedAt).toBeInstanceOf(Date);
  });

  test('reports a current OOM termination as unhealthy', async () => {
    const { impl } = fakeFetch({
      pods: {
        items: [
          {
            metadata: { name: 'checkout-failed', namespace: 'checkout' },
            status: {
              phase: 'Failed',
              containerStatuses: [
                {
                  name: 'app',
                  ready: false,
                  restartCount: 0,
                  state: {
                    terminated: {
                      reason: 'OOMKilled',
                      exitCode: 137,
                      finishedAt: '2026-08-28T01:00:00Z',
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const connector = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', namespace: 'checkout' } }),
      impl,
    );

    const pod = (await connector.snapshot()).find(
      (snapshot) => snapshot.entityId === 'checkout/checkout-failed',
    );

    expect(pod).toMatchObject({
      metrics: { ready: 0, restartCount: 0, oomKilled: 1 },
      metadata: {
        phase: 'Failed',
        containers: [expect.objectContaining({ terminatedReason: 'OOMKilled' })],
      },
    });
  });

  test('includes best-effort node health as node snapshots', async () => {
    const { impl } = fakeFetch();
    const c = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', namespace: 'checkout' } }),
      impl,
    );

    const snaps = await c.snapshot();
    const node = snaps.find((s) => s.entityId === 'ip-10-0-0-5');
    expect(node).toBeDefined();
    expect(node!.metrics.ready).toBe(0);
    expect(node!.metrics.pressures).toBe(1);
    expect(node!.metadata.kind).toBe('node');
    expect(node!.metadata.pressures).toContain('MemoryPressure');
  });

  test('a denied node read keeps pod health and emits a sanitized connector error', async () => {
    const { impl } = fakeFetch({ status: { nodes: 403 } });
    const c = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', namespace: 'checkout' } }),
      impl,
    );

    const snaps = await c.snapshot();

    expect(snaps.some((snapshot) => snapshot.entityId === 'checkout/checkout-abc')).toBe(true);
    expect(snaps).toContainEqual(
      expect.objectContaining({
        entityId: 'cluster/nodes',
        metrics: {},
        metadata: { kind: 'node', error: 'node read denied' },
      }),
    );
  });

  test('with no namespace configured, polls pods across all namespaces', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeKubernetesConnector(cfg(), impl); // apiUrl only, no namespace

    const snaps = await c.snapshot();
    expect(calls.some((k) => k.url.includes('/api/v1/pods?limit=200'))).toBe(true);
    expect(calls.some((k) => k.url.includes('/namespaces/'))).toBe(false);
    expect(snaps.some((s) => s.entityId === 'checkout/checkout-abc')).toBe(true);
  });

  test('enforces the same SSRF guard as fetchTriageContext (private apiUrl needs a CA)', async () => {
    const { impl } = fakeFetch();
    const c = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://10.0.0.1:6443', namespace: 'checkout' } }),
      impl,
    );
    await expect(c.snapshot()).rejects.toThrow(/private apiUrl requires caCert/);
  });
});
