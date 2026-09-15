import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  services,
  connectorConfigs,
  serviceRuntimeBindings,
  users,
  type DbHandle,
} from '@sre/db';
import type { NormalizedSnapshot } from '@sre/connectors';
import { seedMembership } from '@sre/db/test-support';
import { readServiceRuntime } from '../runtime';

let admin: DbHandle;
let app: DbHandle;
const tenantId = randomUUID();
const foreignTenantId = randomUUID();
let ownerUserId: string, foreignUserId: string;
const sourceId = randomUUID();
const otherId = randomUUID();
const snapshots = (source: string, completeness = 'complete'): NormalizedSnapshot[] => [
  {
    tenantId,
    source: 'kubernetes',
    entityId: 'collection/pods',
    metrics: {},
    metadata: { kind: 'collection', resource: 'pods', completeness },
    observedAt: new Date(),
  },
  ...['checkout', 'other'].map((name): NormalizedSnapshot => ({
    tenantId,
    source: 'kubernetes',
    entityId: `${source}/${name}`,
    metrics: { ready: 1 },
    metadata: { kind: 'pod', namespace: 'shared', labels: { app: name } },
    observedAt: new Date(),
  })),
];

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Runtime identity test' });
  await admin.db.insert(tenants).values({ id: foreignTenantId, name: 'Foreign runtime owner' });
  ownerUserId = await seedMembership(
    admin.db,
    { issuer: 'https://runtime-binding.test', subject: randomUUID() },
    tenantId,
    'owner',
  );
  foreignUserId = await seedMembership(
    admin.db,
    { issuer: 'https://runtime-binding.test', subject: randomUUID() },
    foreignTenantId,
    'owner',
  );
  await admin.db.insert(services).values({ tenantId, name: 'checkout' });
  for (const id of [sourceId, otherId]) {
    await admin.db
      .insert(connectorConfigs)
      .values({ id, tenantId, name: id, type: 'kubernetes', settings: {}, enabled: true });
    await admin.db.insert(serviceRuntimeBindings).values({
      tenantId,
      serviceName: 'checkout',
      connectorId: id,
      namespace: 'shared',
      labelKey: 'app',
      labelValue: 'checkout',
      environment: id,
      confirmedByUserId: ownerUserId,
      rationale: 'Confirmed labels',
    });
  }
});
afterAll(async () => {
  await admin.db
    .delete(serviceRuntimeBindings)
    .where(eq(serviceRuntimeBindings.tenantId, tenantId));
  await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
  await admin.db.delete(services).where(eq(services.tenantId, tenantId));
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await admin.db.delete(tenants).where(eq(tenants.id, foreignTenantId));
  await admin.db.delete(users).where(sql`id in (${ownerUserId}, ${foreignUserId})`);
  await admin.close();
  await app.close();
});

test('logical service runtime includes only explicit selectors across its sources', async () => {
  const result = await readServiceRuntime(app.db, tenantId, 'checkout', async ({ id }) =>
    snapshots(id),
  );
  expect(result?.map((row) => row.entityId)).toEqual(
    expect.arrayContaining([`${sourceId}/checkout`, `${otherId}/checkout`]),
  );
  expect(result).toHaveLength(2);
  expect(
    await readServiceRuntime(app.db, randomUUID(), 'checkout', async () => {
      throw new Error('Must not read foreign sources');
    }),
  ).toBeNull();
});

test.each(['partial', 'missing', 'stale', 'invalid'])(
  'refuses recovery evidence when one source is %s',
  async (state) => {
    const result = await readServiceRuntime(app.db, tenantId, 'checkout', async ({ id }) => {
      if (id !== otherId) return snapshots(id);
      if (state === 'missing') return [];
      const rows = snapshots(id, state === 'partial' ? 'partial' : 'complete');
      if (state === 'stale') rows[0]!.observedAt = new Date(Date.now() - 120_000);
      if (state === 'invalid') rows[0]!.observedAt = new Date(NaN);
      return rows;
    });
    expect(result).toBeNull();
  },
);

test('failed or disabled sources cannot disappear behind healthy cached pods', async () => {
  try {
    await admin.db
      .update(connectorConfigs)
      .set({ pollFailureCategory: 'forbidden' })
      .where(eq(connectorConfigs.id, otherId));
    expect(
      await readServiceRuntime(app.db, tenantId, 'checkout', async ({ id }) => snapshots(id)),
    ).toBeNull();
    await admin.db
      .update(connectorConfigs)
      .set({ pollFailureCategory: null, enabled: false })
      .where(eq(connectorConfigs.id, otherId));
    expect(
      await readServiceRuntime(app.db, tenantId, 'checkout', async ({ id }) => snapshots(id)),
    ).toBeNull();
  } finally {
    await admin.db.execute(
      sql`update connector_configs set enabled = true, poll_failure_category = null where id = ${otherId}`,
    );
  }
});

test('runtime confirmation cannot name a member of another tenant', async () => {
  await expect(
    admin.db
      .update(serviceRuntimeBindings)
      .set({ confirmedByUserId: foreignUserId })
      .where(eq(serviceRuntimeBindings.connectorId, sourceId)),
  ).rejects.toMatchObject({
    cause: { code: '23503', constraint_name: 'runtime_binding_membership_fk' },
  });
});

test('complete source inventory without a matching bound pod cannot establish recovery', async () => {
  expect(
    await readServiceRuntime(app.db, tenantId, 'checkout', async ({ id }) =>
      id === otherId
        ? snapshots(id).filter(
            (row) => row.metadata.kind === 'collection' || row.entityId.endsWith('/other'),
          )
        : snapshots(id),
    ),
  ).toBeNull();
});
