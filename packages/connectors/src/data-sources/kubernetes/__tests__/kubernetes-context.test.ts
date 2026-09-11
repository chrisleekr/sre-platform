import { describe, expect, test } from 'vitest';
import { PEM, cfg, fakeFetch, makeKubernetesConnector } from './test-helpers';

describe('makeKubernetesConnector fetchTriageContext', () => {
  test('exposes current image digest and explicit source annotations as runtime provenance', async () => {
    const { impl } = fakeFetch({
      pods: {
        items: [
          {
            metadata: {
              name: 'checkout-abc',
              namespace: 'checkout',
              labels: { 'app.kubernetes.io/name': 'checkout' },
              annotations: {
                'org.opencontainers.image.source': 'https://github.com/acme/checkout',
                'org.opencontainers.image.revision': 'a'.repeat(40),
              },
            },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'app',
                  image: 'registry.example/acme/checkout:stable',
                  imageID: `registry.example/acme/checkout@sha256:${'b'.repeat(64)}`,
                },
              ],
            },
          },
        ],
      },
    });
    const connector = makeKubernetesConnector(cfg(), impl);
    const artifacts = await connector.runtimeArtifacts!.observe('checkout');
    expect(artifacts).toEqual({
      artifacts: [
        expect.objectContaining({
          kind: 'oci_image',
          namespace: 'checkout',
          workload: 'checkout-abc',
          container: 'app',
          digest: `sha256:${'b'.repeat(64)}`,
          sourceUrl: 'https://github.com/acme/checkout',
          revision: 'a'.repeat(40),
        }),
      ],
      incomplete: false,
    });
  });

  test('does not attribute unrelated pods in a monitored namespace to the incident service', async () => {
    const { impl } = fakeFetch({
      pods: {
        items: [
          {
            metadata: {
              name: 'billing-abc',
              namespace: 'shared',
              labels: { 'app.kubernetes.io/name': 'billing' },
            },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'app',
                  image: 'registry.example/acme/billing:stable',
                  imageID: `registry.example/acme/billing@sha256:${'b'.repeat(64)}`,
                },
              ],
            },
          },
        ],
      },
    });
    const connector = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', namespace: 'shared' } }),
      impl,
    );
    await expect(connector.runtimeArtifacts!.observe('checkout')).resolves.toEqual({
      artifacts: [],
      incomplete: false,
    });
  });

  test('does not infer service ownership from instance labels or pod-name prefixes', async () => {
    const { impl } = fakeFetch({
      pods: {
        items: [
          {
            metadata: {
              name: 'checkout-worker-abc',
              namespace: 'shared',
              labels: { 'app.kubernetes.io/instance': 'checkout' },
            },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'worker',
                  image: 'registry.example/acme/checkout-worker:stable',
                  imageID: `registry.example/acme/checkout-worker@sha256:${'b'.repeat(64)}`,
                },
              ],
            },
          },
        ],
      },
    });
    const connector = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', namespace: 'shared' } }),
      impl,
    );

    await expect(connector.runtimeArtifacts!.observe('checkout')).resolves.toEqual({
      artifacts: [],
      incomplete: false,
    });
  });

  test('follows Kubernetes continuation tokens when resolving runtime artifacts', async () => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      const secondPage = String(url).includes('continue=next-page');
      return {
        ok: true,
        status: 200,
        json: async () =>
          secondPage
            ? {
                metadata: {},
                items: [
                  {
                    metadata: {
                      name: 'checkout-abc',
                      namespace: 'checkout',
                      labels: { 'app.kubernetes.io/name': 'checkout' },
                    },
                    status: {
                      phase: 'Running',
                      containerStatuses: [
                        {
                          name: 'app',
                          image: 'registry.example/acme/checkout:stable',
                          imageID: `registry.example/acme/checkout@sha256:${'b'.repeat(64)}`,
                        },
                      ],
                    },
                  },
                ],
              }
            : { metadata: { continue: 'next-page' }, items: [] },
      };
    }) as unknown as typeof fetch;
    const connector = makeKubernetesConnector(cfg(), impl);

    const result = await connector.runtimeArtifacts!.observe('checkout');

    expect(result.incomplete).toBe(false);
    expect(result.artifacts).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('continue=next-page');
  });

  test('drops credential-bearing source metadata and non-immutable revisions', async () => {
    const secret = 'hunter2';
    const { impl } = fakeFetch({
      pods: {
        items: [
          {
            metadata: {
              name: 'checkout-abc',
              namespace: 'checkout',
              labels: { 'app.kubernetes.io/name': 'checkout' },
              annotations: {
                'org.opencontainers.image.source': `https://deploy:${secret}@git.example/acme/checkout?token=short`,
                'org.opencontainers.image.revision': 'main',
              },
            },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'app',
                  image: 'registry.example/acme/checkout:stable',
                  imageID: `registry.example/acme/checkout@sha256:${'b'.repeat(64)}`,
                },
              ],
            },
          },
        ],
      },
    });
    const connector = makeKubernetesConnector(cfg(), impl);

    const result = await connector.runtimeArtifacts!.observe('checkout');

    expect(result.artifacts[0]).toMatchObject({
      sourceUrl: null,
      revision: null,
      provenance: null,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('token=short');
  });

  test('strips query and fragment data from declared repository URLs', async () => {
    const { impl } = fakeFetch({
      pods: {
        items: [
          {
            metadata: {
              name: 'checkout-abc',
              namespace: 'checkout',
              labels: { 'app.kubernetes.io/name': 'checkout' },
              annotations: {
                'org.opencontainers.image.source':
                  'https://git.example/acme/checkout.git?token=short#fragment',
                'org.opencontainers.image.revision': 'A'.repeat(40),
              },
            },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'app',
                  image: 'registry.example/acme/checkout:stable',
                  imageID: `registry.example/acme/checkout@sha256:${'b'.repeat(64)}`,
                },
              ],
            },
          },
        ],
      },
    });
    const connector = makeKubernetesConnector(cfg(), impl);

    const result = await connector.runtimeArtifacts!.observe('checkout');

    expect(result.artifacts[0]).toMatchObject({
      sourceUrl: 'https://git.example/acme/checkout.git',
      revision: 'a'.repeat(40),
      provenance: 'declared',
    });
  });

  test.each([
    {
      source: 'ssh://git@git.example/acme/checkout.git?token=short#fragment',
      expected: 'ssh://git.example/acme/checkout.git',
    },
    {
      source: 'git://git@git.example/acme/checkout.git',
      expected: 'git://git.example/acme/checkout.git',
    },
    {
      source: 'git@git.example:acme/checkout.git',
      expected: 'ssh://git.example/acme/checkout.git',
    },
    { source: 'file:///srv/checkout', expected: null },
  ])('sanitizes declared non-web source metadata: $source', async ({ source, expected }) => {
    const { impl } = fakeFetch({
      pods: {
        items: [
          {
            metadata: {
              name: 'checkout-abc',
              namespace: 'checkout',
              labels: { 'app.kubernetes.io/name': 'checkout' },
              annotations: {
                'org.opencontainers.image.source': source,
                'org.opencontainers.image.revision': 'a'.repeat(40),
              },
            },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'app',
                  image: 'registry.example/acme/checkout:stable',
                  imageID: `registry.example/acme/checkout@sha256:${'b'.repeat(64)}`,
                },
              ],
            },
          },
        ],
      },
    });
    const connector = makeKubernetesConnector(cfg(), impl);

    const result = await connector.runtimeArtifacts!.observe('checkout');

    expect(result.artifacts[0]?.sourceUrl).toBe(expected);
    expect(JSON.stringify(result)).not.toContain('token=short');
    expect(JSON.stringify(result)).not.toContain('git@');
  });

  test('marks runtime artifact discovery incomplete at its page budget', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ metadata: { continue: `page-${calls + 1}` }, items: [] }),
      };
    }) as unknown as typeof fetch;
    const connector = makeKubernetesConnector(cfg(), impl);

    await expect(connector.runtimeArtifacts!.observe('checkout')).resolves.toEqual({
      artifacts: [],
      incomplete: true,
    });
    expect(calls).toBe(5);
  });

  test('normalizes pods, warning events, and nodes into one bundle', async () => {
    const { impl } = fakeFetch();
    const c = makeKubernetesConnector(cfg(), impl);

    const ctx = await c.fetchTriageContext({ service: 'checkout', windowMinutes: 60 });

    expect(ctx.source).toBe('kubernetes');
    const data = ctx.data as {
      namespace: string;
      pods: Array<{
        oomKilled: boolean;
        restarts: number;
        containers: Array<{
          terminatedReason?: string;
          lastTerminatedReason?: string;
          lastTerminatedAt?: string;
        }>;
      }>;
      nodes: Array<{ ready: boolean; pressures: string[] }>;
      warnings: Array<{ object: string }>;
    };
    expect(data.namespace).toBe('checkout');
    expect(data.pods[0]!.oomKilled).toBe(false);
    expect(data.pods[0]!.containers[0]).toMatchObject({
      lastTerminatedReason: 'OOMKilled',
      lastTerminatedAt: '2026-08-17T05:43:23Z',
    });
    expect(data.pods[0]!.containers[0]!.terminatedReason).toBeUndefined();
    expect(data.pods[0]!.restarts).toBe(7);
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.warnings[0]!.object).toBe('Pod/checkout-abc');
    expect(data.nodes[0]!.ready).toBe(false);
    expect(data.nodes[0]!.pressures).toContain('MemoryPressure');
  });

  test('sends a Bearer token on every call and never puts it in a URL', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeKubernetesConnector(cfg(), impl);
    await c.fetchTriageContext({ service: 'checkout', windowMinutes: 60 });
    expect(calls.length).toBe(3);
    expect(calls.every((k) => k.auth === 'Bearer k8s-sa-token')).toBe(true);
    expect(calls.every((k) => !k.url.includes('k8s-sa-token'))).toBe(true);
  });

  test('uses the service as the namespace, requests only Warning events, and bounds list size', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeKubernetesConnector(cfg(), impl);
    await c.fetchTriageContext({ service: 'payments', windowMinutes: 30 });
    expect(calls.some((k) => k.url.includes('/api/v1/namespaces/payments/pods?limit=200'))).toBe(
      true,
    );
    expect(
      calls.some((k) =>
        k.url.includes('/api/v1/namespaces/payments/events?fieldSelector=type%3DWarning&limit=200'),
      ),
    ).toBe(true);
  });

  test('settings.namespace overrides the service', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', namespace: 'billing' } }),
      impl,
    );
    await c.fetchTriageContext({ service: 'payments', windowMinutes: 30 });
    expect(calls.some((k) => k.url.includes('/api/v1/namespaces/billing/pods'))).toBe(true);
    expect(calls.some((k) => k.url.includes('/namespaces/payments/'))).toBe(false);
  });

  test('throws on a non-2xx pods response', async () => {
    const { impl } = fakeFetch({ status: { pods: 500 } });
    const c = makeKubernetesConnector(cfg(), impl);
    await expect(c.fetchTriageContext({ service: 'checkout', windowMinutes: 10 })).rejects.toThrow(
      /k8s api 500/,
    );
  });

  test('a nodes 403 does not fail the call; nodes degrade to []', async () => {
    const { impl } = fakeFetch({ status: { nodes: 403 } });
    const c = makeKubernetesConnector(cfg(), impl);
    const ctx = await c.fetchTriageContext({ service: 'checkout', windowMinutes: 60 });
    const data = ctx.data as { pods: unknown[]; nodes: unknown[] };
    expect(data.nodes).toEqual([]);
    expect(data.pods.length).toBeGreaterThan(0);
  });

  test('propagates a missing-credential rejection', async () => {
    const { impl } = fakeFetch();
    const c = makeKubernetesConnector(
      cfg({
        getCredential: async () => {
          throw new Error('no credential stored');
        },
      }),
      impl,
    );
    await expect(c.fetchTriageContext({ service: 'checkout', windowMinutes: 10 })).rejects.toThrow(
      /no credential/,
    );
  });

  test('bounds each request with a timeout and blocks redirects', async () => {
    const { impl, calls } = fakeFetch();
    await makeKubernetesConnector(cfg(), impl).fetchTriageContext({
      service: 'checkout',
      windowMinutes: 10,
    });
    expect(calls.length).toBe(3);
    expect(calls.every((k) => k.hasSignal)).toBe(true);
    expect(calls.every((k) => k.redirect === 'error')).toBe(true);
  });

  test('allows a private (RFC1918) https control plane when a CA is pinned', async () => {
    const { impl } = fakeFetch();
    const c = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://10.0.0.1:6443', caCert: PEM } }),
      impl,
    );
    await expect(
      c.fetchTriageContext({ service: 'checkout', windowMinutes: 10 }),
    ).resolves.toBeDefined();
  });

  test('rejects a private apiUrl with no pinned CA or explicit insecure opt-in', async () => {
    const { impl } = fakeFetch();
    const c = makeKubernetesConnector(cfg({ settings: { apiUrl: 'https://10.0.0.1:6443' } }), impl);
    await expect(c.fetchTriageContext({ service: 'checkout', windowMinutes: 10 })).rejects.toThrow(
      /private apiUrl requires caCert/,
    );
  });

  test('rejects a non-https apiUrl (http and file both throw)', async () => {
    const { impl } = fakeFetch();
    const http = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'http://k8s.example.com:6443' } }),
      impl,
    );
    await expect(
      http.fetchTriageContext({ service: 'checkout', windowMinutes: 10 }),
    ).rejects.toThrow(/must be https/);
    const file = makeKubernetesConnector(cfg({ settings: { apiUrl: 'file:///etc/passwd' } }), impl);
    await expect(
      file.fetchTriageContext({ service: 'checkout', windowMinutes: 10 }),
    ).rejects.toThrow(/must be https/);
  });

  test('wires a CA cert into each request TLS options', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', caCert: PEM } }),
      impl,
    );
    await c.fetchTriageContext({ service: 'checkout', windowMinutes: 10 });
    expect(calls.length).toBe(3);
    expect(calls.every((k) => k.tls?.ca === PEM)).toBe(true);
  });

  test('honors insecureSkipTLSVerify when no CA cert is set', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeKubernetesConnector(
      cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', insecureSkipTLSVerify: true } }),
      impl,
    );
    await c.fetchTriageContext({ service: 'checkout', windowMinutes: 10 });
    expect(calls.every((k) => k.tls?.rejectUnauthorized === false)).toBe(true);
  });
});
