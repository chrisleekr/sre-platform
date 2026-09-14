import { expect, test } from 'vitest';
import { conn, fakeFetch, multiCfg } from './test-helpers';

const application = {
  metadata: { uid: 'app-uid', name: 'checkout', namespace: 'argocd' },
  spec: {
    project: 'payments',
    destination: { server: 'https://cluster.example', namespace: 'production' },
    sources: [
      { repoURL: 'git@git.example:team/deployments.git', path: 'api' },
      { repoURL: 'https://git.example/team/deployments.git', path: 'worker' },
    ],
  },
  status: { sync: { revisions: ['resolved-api-sha', 'resolved-worker-sha'] } },
};

test('multi-project continuation preserves the selected project cursor without rereading other projects', async () => {
  const applications = Array.from({ length: 26 }, (_, index) => ({
    ...application,
    metadata: {
      ...application.metadata,
      uid: String(index).padStart(4, '0'),
      name: `app-${index}`,
    },
  }));
  const { impl, calls } = fakeFetch((url) => ({
    json: url.includes('resource-tree') ? { nodes: [] } : { items: applications },
  }));
  const config = multiCfg();
  config.settings.projects = [
    { project: 'payments', applications: [{ name: '*' }] },
    { project: 'identity', applications: [{ name: '*' }] },
  ];
  const source = conn(impl, config).topology!;
  const selected = ['payments/applications'];
  const first = (await source.discover({ collections: selected })).collections[0]!;
  expect(first.entities.filter((item) => item.kind === 'deployment')).toHaveLength(25);
  const second = await source.discover({
    collections: selected,
    scans: { 'payments/applications': first.scan! },
  });
  expect(second.collections.map((row) => row.key)).toEqual(selected);
  expect(
    second.collections[0]!.entities.filter((item) => item.kind === 'deployment').map(
      (item) => item.name,
    ),
  ).toEqual(['app-25']);
  expect(second.collections[0]!.completeness).toBe('complete');
  expect(calls.filter((call) => call.url.includes('resource-tree'))).toHaveLength(26);
  expect(calls.every((call) => call.authorization === 'Bearer payments-token')).toBe(true);
});

test('application discovery continues beyond twenty-five managed applications without dropping earlier evidence', async () => {
  const applications = Array.from({ length: 201 }, (_, i) => ({
    ...application,
    metadata: { ...application.metadata, uid: String(i).padStart(4, '0'), name: `app-${i}` },
  }));
  const { impl, calls } = fakeFetch((url) => ({
    json: url.includes('resource-tree') ? { nodes: [] } : { items: applications },
  }));
  const source = conn(impl, {
    settings: { applications: [{ project: 'payments', name: '*' }] },
  }).topology!;
  let scan: import('@sre/contracts').TopologyScanProgress | undefined;
  const seen: string[] = [];
  for (let i = 0; i < 9; i++) {
    const result = (await source.discover({ scans: scan ? { applications: scan } : {} }))
      .collections[0]!;
    scan = result.scan;
    seen.push(...result.entities.filter((e) => e.kind === 'deployment').map((e) => e.name));
    expect(result.completeness).toBe(i === 8 ? 'complete' : 'partial');
  }
  expect(new Set(seen).size).toBe(201);
  expect(calls.filter((call) => call.url.includes('resource-tree'))).toHaveLength(201);
  expect(scan).toEqual({ cursor: null, incomplete: false });
});

test('oversized resource trees retain application evidence and report a collection limit', async () => {
  const impl = (async (input: string | Request | URL) =>
    String(input).includes('resource-tree')
      ? new Response('not parsed', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })
      : Response.json({ items: [application] })) as typeof fetch;
  const result = await conn(impl).topology!.discover();
  expect(result.collections[0]).toMatchObject({ completeness: 'partial', issue: 'limit' });
  expect(result.collections[0]?.entities.some((e) => e.kind === 'deployment')).toBe(true);
});
test('keeps deployed repository paths distinct and links exact managed resources, not service guesses', async () => {
  const { impl, calls } = fakeFetch((url) => ({
    json: url.includes('resource-tree')
      ? {
          nodes: [
            { kind: 'Deployment', name: 'api', namespace: 'production', uid: 'api-uid' },
            { kind: 'Deployment', name: 'worker', namespace: 'production', uid: 'worker-uid' },
            { kind: 'Secret', name: 'credentials', namespace: 'production', uid: 'secret-uid' },
          ],
        }
      : {
          items: [
            application,
            {
              ...application,
              metadata: { ...application.metadata, name: 'foreign' },
              spec: { ...application.spec, project: 'outside' },
            },
          ],
        },
  }));
  const result = await conn(impl).topology!.discover();
  const collection = result.collections[0]!;
  expect(collection.completeness).toBe('complete');
  expect(collection.entities.map((e) => e.kind).sort()).toEqual([
    'deployment',
    'repository',
    'workload',
    'workload',
  ]);
  expect(
    collection.relations
      .filter((r) => r.kind === 'deployed_from')
      .map((r) => [r.scope?.path, r.attributes?.revision]),
  ).toEqual([
    ['api', 'resolved-api-sha'],
    ['worker', 'resolved-worker-sha'],
  ]);
  expect(collection.relations.filter((r) => r.kind === 'manages')).toHaveLength(2);
  expect(collection.entities.find((entity) => entity.name === 'api')?.ref).toEqual({
    authority: 'kubernetes-object',
    kind: 'Deployment',
    id: JSON.stringify(['production', 'api-uid']),
  });
  expect(collection.relations.some((r) => r.kind === 'calls')).toBe(false);
  expect(
    calls.every((call) => call.method === 'GET' && call.redirect === 'error' && call.hasSignal),
  ).toBe(true);
  expect(calls.some((call) => call.url.includes('/foreign/'))).toBe(false);
  expect(JSON.stringify(result)).not.toContain('secret-uid');
});

test('missing resource-tree permission preserves application evidence as partial', async () => {
  const { impl } = fakeFetch((url) =>
    url.includes('resource-tree') ? { status: 403 } : { json: { items: [application] } },
  );
  const result = await conn(impl).topology!.discover();
  expect(result.collections[0]).toMatchObject({
    completeness: 'partial',
    issue: 'permission_denied',
  });
  expect(result.collections[0]?.entities.some((e) => e.kind === 'deployment')).toBe(true);
});

test('named destinations are not guessed to be the cluster of a similarly named connector', async () => {
  const { impl, calls } = fakeFetch(() => ({
    json: {
      items: [
        { ...application, spec: { ...application.spec, destination: { name: 'production' } } },
      ],
    },
  }));
  const result = await conn(impl).topology!.discover();
  expect(result.collections[0]?.relations.some((r) => r.kind === 'manages')).toBe(false);
  expect(calls).toHaveLength(1);
});
