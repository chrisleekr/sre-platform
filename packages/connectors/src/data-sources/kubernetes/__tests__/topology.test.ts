import { expect, test } from 'vitest';
import { cfg, lookup } from './test-helpers';
import { kubernetesTopology } from '../topology';

function transport(overrides: Record<string, unknown | Response> = {}) {
  const paths: string[] = [];
  const fetchImpl = (async (input: string | Request | URL) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const value =
      overrides[path] ??
      (path.endsWith('/kube-system') ? { metadata: { uid: 'cluster-uid' } } : { items: [] });
    return value instanceof Response ? value.clone() : Response.json(value);
  }) as typeof fetch;
  return { paths, fetchImpl };
}
const resource = (name: string, uid: string, namespace = 'checkout') => ({
  metadata: { name, uid, namespace },
});

test('preserves only valid network addresses and TCP ports for endpoint resolution', async () => {
  const { fetchImpl } = transport({
    '/api/v1/pods': {
      items: [
        {
          ...resource('api', 'pod'),
          status: { podIPs: [{ ip: '2001:db8:0:0::1' }, { ip: 'not-ip' }] },
          spec: {
            containers: [
              {
                ports: [{ containerPort: 8080 }, { containerPort: 53, protocol: 'UDP' }],
                env: [{ name: 'PRIVATE', value: 'do-not-store' }],
              },
            ],
          },
        },
      ],
    },
    '/api/v1/services': {
      items: [
        {
          ...resource('api', 'service'),
          spec: {
            clusterIPs: ['10.0.0.1'],
            ports: [
              { port: 80, targetPort: 8080 },
              { port: 53, protocol: 'UDP' },
            ],
          },
        },
      ],
    },
  });
  const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
  expect(result.collections.find((c) => c.key === 'pods')?.entities[0]?.network).toEqual({
    addresses: ['2001:db8::1'],
    ports: [8080],
  });
  expect(result.collections.find((c) => c.key === 'services')?.entities[0]?.network).toEqual({
    addresses: ['10.0.0.1'],
    ports: [80],
  });
  expect(JSON.stringify(result)).not.toContain('do-not-store');
});

test('does not treat a host-network Pod address as exclusive workload identity', async () => {
  const { fetchImpl } = transport({
    '/api/v1/pods': {
      items: [
        {
          ...resource('host-agent', 'host-pod'),
          spec: { hostNetwork: true },
          status: { podIP: '10.0.0.1' },
        },
      ],
    },
  });
  const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
  const pod = result.collections.find((c) => c.key === 'pods')!.entities[0]!;
  expect(pod.name).toBe('host-agent');
  expect(pod.network?.addresses).toEqual([]);
});

test('discovers Datadog pod service declarations with isolated scope and no invented call edges', async () => {
  const pod = (uid: string, namespace = 'apps', env: unknown = 'production') => ({
    metadata: {
      ...resource('api', uid, namespace).metadata,
      labels: {
        'tags.datadoghq.com/service': 'checkout',
        ...(env === null ? {} : { 'tags.datadoghq.com/env': env }),
        'tags.datadoghq.com/version': uid,
        'private.label': 'never-retain',
      },
    },
  });
  const { fetchImpl } = transport({
    '/api/v1/pods': {
      items: [
        pod('replica-one'),
        pod('replica-two'),
        pod('staging', 'apps', 'staging'),
        pod('other-namespace', 'other'),
        pod('unknown-env', 'apps', null),
        pod('invalid-env', 'apps', 123),
        pod('empty-env', 'apps', ''),
      ],
    },
  });
  const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
  const collection = result.collections.find((row) => row.key === 'pods')!;
  const services = collection.entities.filter((entity) => entity.kind === 'service');
  expect(services).toHaveLength(4);
  const links = collection.relations.filter((relation) => relation.kind === 'runs_on');
  expect(links).toHaveLength(5);
  expect(links[0]!.from).toEqual(links[1]!.from);
  expect(links[0]!.from).not.toEqual(links[2]!.from);
  expect(links[0]!.from).not.toEqual(links[3]!.from);
  expect(links.every((link) => link.evidence === 'declared')).toBe(true);
  expect(collection.relations.some((link) => link.kind === 'calls')).toBe(false);
  expect(services.every((entity) => entity.attributes?.provenance === 'datadog_pod_label')).toBe(
    true,
  );
  expect(JSON.stringify(result)).not.toContain('never-retain');
});

test('discovers explicit pod service declarations without merging environments or generic app labels', async () => {
  const declared = (uid: string, namespace: string, environment: string) => ({
    metadata: {
      ...resource('api', uid, namespace).metadata,
      annotations: {
        'resource.opentelemetry.io/service.name': 'checkout',
        'resource.opentelemetry.io/service.namespace': 'commerce',
        'resource.opentelemetry.io/deployment.environment.name': environment,
        'resource.opentelemetry.io/private.key': 'never-retain',
      },
    },
  });
  const { fetchImpl } = transport({
    '/api/v1/pods': {
      items: [
        declared('prod-one', 'apps', 'production'),
        declared('prod-two', 'apps', 'production'),
        declared('stage', 'apps', 'staging'),
        declared('other', 'other', 'production'),
        {
          metadata: {
            ...resource('unrelated', 'generic').metadata,
            labels: { 'app.kubernetes.io/name': 'checkout' },
          },
        },
      ],
    },
  });
  const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
  const pods = result.collections.find((collection) => collection.key === 'pods')!;
  expect(pods.entities.filter((entity) => entity.kind === 'service')).toHaveLength(3);
  const links = pods.relations.filter((relation) => relation.kind === 'runs_on');
  expect(links).toHaveLength(4);
  expect(links.every((relation) => relation.evidence === 'declared')).toBe(true);
  expect(links[0]!.from).toEqual(links[1]!.from);
  expect(links[0]!.from).not.toEqual(links[2]!.from);
  expect(links[0]!.from).not.toEqual(links[3]!.from);
  expect(JSON.stringify(result)).not.toContain('never-retain');
});

test('keeps Datadog declarations cluster-scoped and separate from conflicting OpenTelemetry declarations', async () => {
  const discover = async (cluster: string) => {
    const { fetchImpl } = transport({
      '/api/v1/namespaces/kube-system': { metadata: { uid: cluster } },
      '/api/v1/pods': {
        items: [
          {
            metadata: {
              ...resource('api', 'pod').metadata,
              labels: {
                'tags.datadoghq.com/service': 'billing',
                'tags.datadoghq.com/env': 'production',
              },
              annotations: { 'resource.opentelemetry.io/service.name': 'checkout' },
            },
          },
        ],
      },
    });
    return (await kubernetesTopology(cfg(), fetchImpl, lookup).discover()).collections.find(
      (row) => row.key === 'pods',
    )!;
  };
  const first = await discover('cluster-one'),
    second = await discover('cluster-two');
  const declarations = first.entities.filter((entity) => entity.kind === 'service');
  expect(declarations.map((entity) => entity.name).sort()).toEqual(['billing', 'checkout']);
  expect(declarations.every((entity) => !entity.aliases?.length)).toBe(true);
  expect(first.relations).toHaveLength(2);
  expect(first.relations.every((relation) => relation.evidence === 'declared')).toBe(true);
  expect(declarations.find((entity) => entity.name === 'billing')!.ref).not.toEqual(
    second.entities.find((entity) => entity.name === 'billing')!.ref,
  );
});

test.each(['', ' ', 'bad\nname', 'x'.repeat(254), 123, null])(
  'does not promote malformed Datadog service labels (%j)',
  async (value) => {
    const { fetchImpl } = transport({
      '/api/v1/pods': {
        items: [
          {
            metadata: {
              ...resource('api', 'pod').metadata,
              labels: {
                'tags.datadoghq.com/service': value,
                'tags.datadoghq.com/container.service': 'checkout',
              },
            },
          },
        ],
      },
    });
    const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
    expect(
      result.collections
        .flatMap((row) => row.entities)
        .filter((entity) => entity.kind === 'service'),
    ).toEqual([]);
  },
);

test('does not drop malformed scope into an unscoped service declaration', async () => {
  const { fetchImpl } = transport({
    '/api/v1/pods': {
      items: [
        {
          metadata: {
            ...resource('api', 'uid').metadata,
            annotations: {
              'resource.opentelemetry.io/service.name': 'checkout',
              'resource.opentelemetry.io/service.namespace': 'x'.repeat(254),
            },
          },
        },
      ],
    },
  });
  const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
  expect(
    result.collections
      .flatMap((collection) => collection.entities)
      .some((entity) => entity.kind === 'service'),
  ).toBe(false);
});

test('continues Kubernetes list snapshots across batches and clears an expired token without claiming absence', async () => {
  const pages: number[] = [];
  let expired = false;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/kube-system'))
      return Response.json({ metadata: { uid: 'cluster-uid' } });
    if (!url.pathname.endsWith('/pods')) return Response.json({ items: [] });
    if (expired) return new Response('', { status: 410 });
    const page = Number(url.searchParams.get('continue') ?? 1);
    pages.push(page);
    return Response.json({
      items: [resource(`pod-${page}`, `uid-${page}`)],
      metadata: { continue: page < 6 ? String(page + 1) : '' },
    });
  }) as typeof fetch;
  const source = kubernetesTopology(cfg(), fetchImpl, lookup);
  const first = (await source.discover()).collections.find((c) => c.key === 'pods')!;
  expect(first.scan).toEqual({ cursor: '6', incomplete: false });
  const last = (await source.discover({ scans: { pods: first.scan! } })).collections.find(
    (c) => c.key === 'pods',
  )!;
  expect(last.scan).toEqual({ cursor: null, incomplete: false });
  expect(last.completeness).toBe('complete');
  expect(pages).toEqual([1, 2, 3, 4, 5, 6]);
  expired = true;
  const failed = (await source.discover({ scans: { pods: first.scan! } })).collections.find(
    (c) => c.key === 'pods',
  )!;
  expect(failed).toMatchObject({
    completeness: 'partial',
    issue: 'limit',
    scan: { cursor: null, incomplete: true },
  });
});

test('oversized Kubernetes lists are unavailable limit evidence, never a complete empty collection', async () => {
  const fetchImpl = (async (input: string | Request | URL) =>
    String(input).endsWith('/kube-system')
      ? Response.json({ metadata: { uid: 'cluster-uid' } })
      : new Response('not parsed', {
          headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
        })) as typeof fetch;
  const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
  expect(result.collections.length).toBeGreaterThan(0);
  expect(
    result.collections.every((c) => c.completeness === 'unavailable' && c.issue === 'limit'),
  ).toBe(true);
});

test('discovers ownership and Service routes without inferring calls or merging shared labels', async () => {
  const pod = resource('api-pod', 'pod-uid');
  const { fetchImpl, paths } = transport({
    '/apis/apps/v1/deployments': {
      items: [resource('api', 'deploy-uid'), resource('api', 'other-uid', 'staging')],
    },
    '/api/v1/pods': {
      items: [
        {
          ...pod,
          metadata: {
            ...pod.metadata,
            ownerReferences: [{ kind: 'Deployment', uid: 'deploy-uid', controller: true }],
          },
          spec: { containers: [{ env: [{ name: 'TOKEN', value: 'never-retain-this' }] }] },
        },
      ],
    },
    '/api/v1/services': { items: [resource('api', 'service-uid')] },
    '/apis/discovery.k8s.io/v1/endpointslices': {
      items: [
        {
          ...resource('api-slice', 'slice-uid'),
          metadata: {
            ...resource('api-slice', 'slice-uid').metadata,
            labels: { 'kubernetes.io/service-name': 'api' },
          },
          endpoints: [{ targetRef: { kind: 'Pod', uid: 'pod-uid', namespace: 'checkout' } }],
        },
      ],
    },
  });
  const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
  const entities = result.collections.flatMap((c) => c.entities);
  const relations = result.collections.flatMap((c) => c.relations);
  expect(entities.filter((e) => e.ref.kind === 'Deployment')).toHaveLength(2);
  expect(entities.every((e) => e.ref.authority === 'kubernetes-cluster:cluster-uid')).toBe(true);
  expect(relations.map((r) => r.kind).sort()).toEqual(['owns', 'routes_to']);
  expect(relations.find((r) => r.kind === 'owns')).toMatchObject({
    from: { id: 'deploy-uid' },
    to: { id: 'pod-uid' },
  });
  expect(JSON.stringify(result)).not.toContain('never-retain-this');
  expect(paths.some((path) => path.includes('secrets'))).toBe(false);
});

test('keeps namespace restrictions and marks denied or malformed collections honestly', async () => {
  const { fetchImpl, paths } = transport({
    '/api/v1/namespaces/kube-system': new Response('', { status: 403 }),
    '/api/v1/namespaces/checkout/pods': { items: [resource('foreign', 'uid', 'other')] },
    '/apis/apps/v1/namespaces/checkout/deployments': new Response('', { status: 403 }),
    '/api/v1/namespaces/checkout/services': {},
  });
  const result = await kubernetesTopology(
    cfg({ settings: { apiUrl: 'https://k8s.example.com:6443', namespace: 'checkout' } }),
    fetchImpl,
    lookup,
  ).discover();
  expect(result.collections.find((c) => c.key === 'pods')).toMatchObject({
    entities: [],
    completeness: 'partial',
  });
  expect(result.collections.find((c) => c.key === 'deployments')).toMatchObject({
    completeness: 'unavailable',
    issue: 'permission_denied',
  });
  expect(result.collections.find((c) => c.key === 'services')).toMatchObject({
    completeness: 'partial',
    issue: 'invalid_response',
  });
  expect(
    paths.every((path) => path.includes('/namespaces/checkout/') || path.endsWith('/kube-system')),
  ).toBe(true);
});

test('bounded pagination retains evidence without claiming collection completeness', async () => {
  const { fetchImpl, paths } = transport({
    '/api/v1/pods': { items: [], metadata: { continue: 'next' } },
  });
  const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
  expect(paths.filter((path) => path.endsWith('/pods'))).toHaveLength(5);
  expect(result.collections.find((c) => c.key === 'pods')).toMatchObject({
    completeness: 'partial',
    issue: 'limit',
  });
});

test('keeps pod application source declarations separate from verified image provenance', async () => {
  const pod = resource('api', 'pod-uid');
  const { fetchImpl, paths } = transport({
    '/api/v1/pods': {
      items: [
        {
          ...pod,
          metadata: {
            ...pod.metadata,
            annotations: {
              'org.opencontainers.image.source': 'git@git.example:team/monorepo.git',
              'org.opencontainers.image.revision': 'a'.repeat(40),
              'secret-note': 'must-not-retain',
            },
          },
          spec: { containers: [{ env: [{ name: 'TOKEN', value: 'must-not-retain' }] }] },
        },
      ],
    },
  });
  const result = await kubernetesTopology(cfg(), fetchImpl, lookup).discover();
  const source = result.collections
    .flatMap((row) => row.relations)
    .find((row) => row.kind === 'deployed_from');
  expect(source).toMatchObject({
    from: { id: 'pod-uid' },
    to: { authority: 'repository:git.example', id: 'team/monorepo' },
    evidence: 'declared',
    attributes: {
      role: 'application_source',
      provenance: 'pod_annotation',
      revision: 'a'.repeat(40),
    },
  });
  expect(JSON.stringify(result)).not.toContain('must-not-retain');
  expect(paths.every((path) => path.startsWith('/api'))).toBe(true);
});
