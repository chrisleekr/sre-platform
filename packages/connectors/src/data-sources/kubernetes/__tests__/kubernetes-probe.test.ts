import { describe, expect, test } from 'vitest';
import { PEM, cfg, makeKubernetesConnector, probeFetch, probeKubernetes } from './test-helpers';

describe('probeKubernetes', () => {
  test('reachable, pods readable, secrets denied → healthy with no warnings', async () => {
    const r = await probeKubernetes(cfg(), probeFetch({ api: 200, pods: 200, secrets: 403 }));
    expect(r).toEqual({ reachable: true, canListPods: true, secretsDenied: true, warnings: [] });
  });

  test('with no namespace configured, probes the same all-namespace paths used by polling', async () => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      const value = String(url);
      calls.push(value);
      const status = value.includes('/secrets') ? 403 : 200;
      return { ok: status < 400, status, json: async () => ({}), text: async () => '' };
    }) as unknown as typeof fetch;

    const result = await probeKubernetes(cfg(), impl);

    expect(result.canListPods).toBe(true);
    expect(calls.some((url) => url.endsWith('/api/v1/pods?limit=1'))).toBe(true);
    expect(calls.some((url) => url.endsWith('/api/v1/secrets?limit=1'))).toBe(true);
    expect(calls.some((url) => url.includes('/namespaces/default/'))).toBe(false);
  });

  test('warns when pod access works but node access is denied', async () => {
    const impl = (async (url: string) => {
      const value = String(url);
      const status = value.includes('/secrets') || value.includes('/nodes') ? 403 : 200;
      return { ok: status < 400, status, json: async () => ({}), text: async () => '' };
    }) as unknown as typeof fetch;

    const result = await probeKubernetes(cfg(), impl);

    expect(result.canListPods).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/node read.*RBAC manifest/i);
  });

  test('an optional node-probe failure warns without disabling pod monitoring', async () => {
    const impl = (async (url: string) => {
      const value = String(url);
      if (value.includes('/nodes')) throw new Error('network detail must not escape');
      const status = value.includes('/secrets') ? 403 : 200;
      return { ok: status < 400, status, json: async () => ({}), text: async () => '' };
    }) as unknown as typeof fetch;

    const result = await probeKubernetes(cfg(), impl);

    expect(result.reachable).toBe(true);
    expect(result.canListPods).toBe(true);
    expect(result.warnings).toContain('node health probe failed');
    expect(result.warnings.join(' ')).not.toContain('network detail');
  });

  test('pods 403 → canListPods false with a warning', async () => {
    const r = await probeKubernetes(cfg(), probeFetch({ pods: 403, secrets: 403 }));
    expect(r.reachable).toBe(true);
    expect(r.canListPods).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/pod read/);
  });

  test('secrets 200 → secretsDenied false with a least-privilege warning', async () => {
    const r = await probeKubernetes(cfg(), probeFetch({ pods: 200, secrets: 200 }));
    expect(r.secretsDenied).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/secret reads/);
  });

  test('api 401 → still reachable but warned', async () => {
    const r = await probeKubernetes(cfg(), probeFetch({ api: 401, pods: 403, secrets: 403 }));
    expect(r.reachable).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('a network error on /api → not reachable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await probeKubernetes(cfg(), impl);
    expect(r.reachable).toBe(false);
    expect(r.canListPods).toBe(false);
  });
});

describe('makeKubernetesConnector probe()', () => {
  test('reports healthy when reachable and pods are listable', async () => {
    const impl = probeFetch({ api: 200, pods: 200, secrets: 403 });
    const c = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443' } }),
      impl,
    );
    const r = await c.probe();
    expect(r.status).toBe('healthy');
    expect(r.reachable).toBe(true);
    expect(r.checks?.canListPods).toBe(true);
    expect(r.checks?.secretsDenied).toBe(true);
  });

  test('reports unhealthy when pods are forbidden', async () => {
    const impl = probeFetch({ api: 200, pods: 403, secrets: 403 });
    const c = makeKubernetesConnector(cfg(), impl);
    const r = await c.probe();
    expect(r.status).toBe('unhealthy');
  });
});

describe('probeKubernetes diagnostics', () => {
  // An egress rule between the platform and the control plane surfaces here as a timeout. Reporting
  // it as a bare unreachable leaves an operator with nothing to act on, which is the whole point of
  // these two warnings.
  test('a timeout at /api names egress as the thing to check', async () => {
    const impl = (async () => {
      throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const r = await probeKubernetes(cfg(), impl);
    expect(r.reachable).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/did not answer before the timeout.*egress/i);
  });

  test('a non-timeout network failure at /api names both the apiUrl and egress', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await probeKubernetes(cfg(), impl);
    expect(r.reachable).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/could not be contacted.*apiUrl.*egress/i);
  });

  // The literal-host check cannot see a name that resolves into dangerous space, so without
  // resolve-and-validate the bearer token would be sent to whatever the name points at.
  test('an apiUrl resolving to the metadata endpoint is refused before any request', async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const r = await probeKubernetes(
      cfg({ settings: { apiUrl: 'https://metadata.example.com' } }),
      impl,
      async () => ['169.254.169.254'],
    );
    expect(called).toBe(false);
    expect(r.reachable).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/not allowed/i);
  });

  test('an apiUrl resolving into private space is still allowed, which is the in-cluster case', async () => {
    const impl = probeFetch({ api: 200, pods: 200, secrets: 403 });
    const r = await probeKubernetes(
      cfg({ settings: { apiUrl: 'https://10.96.0.1', caCert: PEM } }),
      impl,
      async () => ['10.96.0.1'],
    );
    expect(r).toEqual({ reachable: true, canListPods: true, secretsDenied: true, warnings: [] });
  });
});
