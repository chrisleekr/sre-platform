import { describe, expect, test } from 'vitest';
import { cfg, fakeFetch, makeKubernetesConnector } from './test-helpers';

// Scope namespaces come from alert labels, so they are untrusted. `..` would normalize
// `/api/v1/namespaces/../pods` to the cluster-wide `/api/v1/pods`.
describe('fetchTriageContext namespace validation', () => {
  const paths = (calls: { url: string }[]) => calls.map((k) => new URL(k.url).pathname);

  test('skips an invalid scope namespace and reads the first valid one', async () => {
    const { impl, calls } = fakeFetch();
    const ctx = await makeKubernetesConnector(cfg(), impl).fetchTriageContext({
      service: 'slack:C07EWAS8132',
      windowMinutes: 30,
      scope: { namespaces: ['..', 'gitlab'], nodes: [] },
    });
    expect(paths(calls)).toEqual(
      expect.arrayContaining([
        '/api/v1/namespaces/gitlab/pods',
        '/api/v1/namespaces/gitlab/events',
      ]),
    );
    expect(paths(calls)).not.toContain('/api/v1/pods');
    expect(paths(calls)).not.toContain('/api/v1/events');
    expect(ctx.data).toMatchObject({ namespace: 'gitlab' });
  });

  test('with no valid namespace, reads nodes only', async () => {
    const { impl, calls } = fakeFetch();
    const ctx = await makeKubernetesConnector(cfg(), impl).fetchTriageContext({
      service: 'slack:C07EWAS8132',
      windowMinutes: 30,
      scope: { namespaces: ['..'], nodes: [] },
    });
    expect(paths(calls)).toEqual(['/api/v1/nodes']);
    expect(ctx.data).toMatchObject({ namespace: null, pods: [], warnings: [] });
  });

  test('an invalid service name falls back to no namespace instead of throwing', async () => {
    const { impl, calls } = fakeFetch();
    await makeKubernetesConnector(cfg(), impl).fetchTriageContext({
      service: '..',
      windowMinutes: 30,
    });
    expect(paths(calls)).toEqual(['/api/v1/nodes']);
  });

  test('an invalid configured namespace rejects before any pods or events read', async () => {
    const { impl, calls } = fakeFetch();
    const config = cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', namespace: '..' } });
    await expect(
      makeKubernetesConnector(config, impl).fetchTriageContext({
        service: 'checkout',
        windowMinutes: 30,
      }),
    ).rejects.toThrow('kubernetes connector: invalid namespace segment');
    expect(paths(calls).filter((p) => /\/(pods|events)$/.test(p))).toEqual([]);
  });
});
