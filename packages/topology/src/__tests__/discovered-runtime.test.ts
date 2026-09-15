import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  connectorConfigs,
  makeDb,
  persistTopologyDiscovery,
  tenants,
  type DbHandle,
} from '@sre/db';
import { topologyRefKey, type TopologyEntity } from '@sre/contracts';
import { normalizeDiscoveredRuntimeObservation, type NormalizedSnapshot } from '@sre/connectors';
import { readTopologyRuntime } from '../discovered-runtime';

const tenantId = randomUUID(),
  sourceId = randomUUID(),
  apmId = randomUUID();
let admin: DbHandle, app: DbHandle;
const pod: TopologyEntity = {
  ref: { authority: `connector:${sourceId}`, kind: 'Pod', id: 'pod-uid' },
  aliases: [
    { authority: 'kubernetes-object', kind: 'Pod', id: JSON.stringify(['apps', 'pod-uid']) },
  ],
  kind: 'workload',
  name: 'checkout-1',
  scope: { namespace: 'apps' },
  attributes: {},
};
const service = (environment: string): TopologyEntity => ({
  ref: { authority: `connector:${apmId}`, kind: 'service', id: environment },
  kind: 'service',
  name: 'checkout',
  scope: { environment },
  attributes: {},
});
const production = service('production'),
  development = service('development');
const selection = { key: topologyRefKey(production.ref), kind: 'service' as const };
const snapshot = (overrides: Partial<NormalizedSnapshot> = {}): NormalizedSnapshot => ({
  tenantId,
  source: 'kubernetes',
  entityId: 'apps/checkout-1',
  metrics: {},
  metadata: {},
  topology: { ref: pod.aliases![0]!, state: 'attention' },
  observedAt: new Date(),
  ...overrides,
});
beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Automatic runtime' });
  await admin.db.insert(connectorConfigs).values([
    { id: sourceId, tenantId, type: 'kubernetes', name: 'Cluster', lifecycleVersion: 4 },
    { id: apmId, tenantId, type: 'datadog', name: 'APM' },
  ]);
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: sourceId, lifecycleVersion: 4 },
    {
      observedAt: new Date().toISOString(),
      collections: [{ key: 'pods', completeness: 'complete', entities: [pod], relations: [] }],
    },
  );
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: apmId, lifecycleVersion: 0 },
    {
      observedAt: new Date().toISOString(),
      collections: [
        {
          key: 'spans',
          completeness: 'partial',
          issue: 'sampling',
          entities: [production, development],
          relations: [
            {
              from: production.ref,
              to: pod.aliases![0]!,
              kind: 'runs_on',
              evidence: 'observed',
              description: 'Span pod UID',
            },
          ],
        },
      ],
    },
  );
});
afterAll(async () => {
  await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await Promise.all([admin.close(), app.close()]);
});

test('joins APM service to exact Kubernetes runtime without a manual catalog entry', async () => {
  const requests: unknown[] = [];
  const evidence = await readTopologyRuntime(
    app.db,
    tenantId,
    selection,
    async (tenant, source) => {
      requests.push({ tenant, ...source });
      return [snapshot()];
    },
  );
  expect(requests).toEqual([
    { tenant: tenantId, id: sourceId, type: 'kubernetes', lifecycleVersion: 4 },
  ]);
  expect(evidence).toMatchObject({
    status: 'partial',
    subject: { key: selection.key, scope: { environment: 'production' } },
    observations: [{ name: 'checkout-1', state: 'attention', stale: false }],
  });
  expect(normalizeDiscoveredRuntimeObservation(evidence, new Date()).state).toBe('firing');
});

test('does not match by pod name, another tenant, source type, or replaced UID', async () => {
  for (const invalid of [
    snapshot({ topology: undefined }),
    snapshot({ tenantId: randomUUID() }),
    snapshot({ source: 'datadog' }),
    snapshot({
      topology: {
        ref: { ...pod.aliases![0]!, id: JSON.stringify(['apps', 'replacement-uid']) },
        state: 'attention',
      },
    }),
  ]) {
    const evidence = await readTopologyRuntime(app.db, tenantId, selection, async () => [invalid]);
    expect(evidence.status).toBe('unavailable');
    expect(evidence.observations).toEqual([]);
  }
  expect(
    (
      await readTopologyRuntime(app.db, randomUUID(), selection, async () => {
        throw new Error('Foreign read');
      })
    ).subject,
  ).toBeNull();
});

test('keeps environment ambiguity and missing runtime separate', async () => {
  expect(
    (
      await readTopologyRuntime(
        app.db,
        tenantId,
        { name: 'checkout', kind: 'service' },
        async () => [],
      )
    ).status,
  ).toBe('ambiguous');
  const evidence = await readTopologyRuntime(
    app.db,
    tenantId,
    { key: topologyRefKey(development.ref) },
    async () => {
      throw new Error('Must not inherit production pod');
    },
  );
  expect(evidence.subject?.scope.environment).toBe('development');
  expect(evidence.status).toBe('unavailable');
});

test('partial healthy observations never establish service recovery', async () => {
  const evidence = await readTopologyRuntime(app.db, tenantId, selection, async () => [
    snapshot({ topology: { ref: pod.aliases![0]!, state: 'healthy' } }),
  ]);
  expect(evidence.status).toBe('partial');
  expect(evidence.observations[0]?.state).toBe('healthy');
  expect(normalizeDiscoveredRuntimeObservation(evidence, new Date()).state).toBe('unknown');
});

test('stale and future observations cannot make an unhealthy service actionable', async () => {
  const stale = await readTopologyRuntime(app.db, tenantId, selection, async () => [
    snapshot({ observedAt: new Date(Date.now() - 120_000) }),
  ]);
  expect(stale.observations[0]).toMatchObject({ stale: true, state: 'unknown' });
  expect(normalizeDiscoveredRuntimeObservation(stale, new Date()).state).toBe('unknown');
  for (const observedAt of [new Date(Date.now() + 120_000), new Date(NaN)]) {
    expect(
      (
        await readTopologyRuntime(app.db, tenantId, selection, async () => [
          snapshot({ observedAt }),
        ])
      ).observations,
    ).toEqual([]);
  }
});

test('outages preserve uncertainty and generation changes invalidate old discovery', async () => {
  const failed = await readTopologyRuntime(app.db, tenantId, selection, async () => {
    throw new Error('Unavailable');
  });
  expect(failed.status).toBe('unavailable');
  expect(failed.note).toContain('1 source reads failed');
  try {
    await admin.db
      .update(connectorConfigs)
      .set({ pollFailureCategory: 'forbidden' })
      .where(eq(connectorConfigs.id, sourceId));
    expect(
      (await readTopologyRuntime(app.db, tenantId, selection, async () => [snapshot()]))
        .observations[0]?.state,
    ).toBe('unknown');
    await admin.db
      .update(connectorConfigs)
      .set({ lifecycleVersion: 5, pollFailureCategory: null })
      .where(eq(connectorConfigs.id, sourceId));
    const result = await readTopologyRuntime(app.db, tenantId, selection, async () => {
      throw new Error('Must not read old generation');
    });
    expect(result.status).toBe('unavailable');
    expect(result.note).not.toContain('source reads failed');
  } finally {
    await admin.db
      .update(connectorConfigs)
      .set({ lifecycleVersion: 4, pollFailureCategory: null })
      .where(eq(connectorConfigs.id, sourceId));
  }
});

test('deduplicates resource observations and refuses contradictory equal-time states', async () => {
  const unhealthy = snapshot(),
    healthy = snapshot({
      observedAt: unhealthy.observedAt,
      topology: { ref: pod.aliases![0]!, state: 'healthy' },
    });
  const evidence = await readTopologyRuntime(app.db, tenantId, selection, async () => [
    unhealthy,
    healthy,
  ]);
  expect(evidence.observations).toHaveLength(1);
  expect(evidence.observations[0]?.state).toBe('unknown');
  expect(evidence.note).toContain('conflicting resource state');
});

test('material runtime hashes ignore observation order before truncating summaries', async () => {
  const base = await readTopologyRuntime(app.db, tenantId, selection, async () => [snapshot()]);
  expect(base.observations).toHaveLength(1);
  const observations = Array.from({ length: 25 }, (_, index) => ({
    ...base.observations[0]!,
    resourceKey: `resource-${index}`,
    name: `resource-${String(index).padStart(2, '0')}`,
    state: 'attention' as const,
    stale: false,
  }));
  const now = new Date();
  const first = normalizeDiscoveredRuntimeObservation({ ...base, observations }, now);
  const reversed = normalizeDiscoveredRuntimeObservation(
    { ...base, observations: [...observations].reverse() },
    now,
  );
  expect(first.contentHash).toBe(reversed.contentHash);
  expect(first.snapshot.summaries).toEqual(observations.slice(0, 20).map((item) => item.name));
});
