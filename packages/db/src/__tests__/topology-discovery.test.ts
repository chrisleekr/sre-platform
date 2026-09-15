import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { TopologyCollection } from '@sre/contracts';
import { makeDb, type DbHandle } from '../client';
import { tenants, connectorConfigs, topologyCollections } from '../schema';
import { withTenant } from '../rls';
import {
  listTopologyDiscovery,
  persistTopologyDiscovery,
  recordTopologyDiscoveryFailure,
  readTopologyScans,
} from '../topology-discovery-repo';

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const connectorId = randomUUID();
const otherConnectorId = randomUUID();
const generation = { id: connectorId, lifecycleVersion: 0 };
let admin: DbHandle;
let app: DbHandle;
let time = Date.now() - 100_000;
const nextTime = () => new Date((time += 1000)).toISOString();
const collection = (
  ids: string[],
  completeness: TopologyCollection['completeness'] = 'complete',
): TopologyCollection => ({
  key: 'workloads',
  completeness,
  relations: [],
  entities: ids.map((id) => ({
    ref: { authority: 'cluster:one', kind: 'Deployment', id },
    kind: 'workload',
    name: id,
    scope: { namespace: 'checkout' },
    attributes: {},
  })),
});
const persist = (value: TopologyCollection, observedAt = nextTime()) =>
  persistTopologyDiscovery(app.db, tenantId, generation, { observedAt, collections: [value] });
const inventories = async () =>
  (await listTopologyDiscovery(app.db, tenantId)).filter(
    (row) => row.collection.key !== '__discovery__',
  );

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db
    .insert(tenants)
    .values([tenantId, otherTenantId].map((id) => ({ id, name: 'Topology discovery' })));
  await admin.db.insert(connectorConfigs).values([
    { id: connectorId, tenantId, type: 'kubernetes', name: 'Runtime' },
    { id: otherConnectorId, tenantId: otherTenantId, type: 'kubernetes', name: 'Runtime' },
  ]);
});
afterAll(async () => {
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await admin.db.delete(tenants).where(eq(tenants.id, otherTenantId));
  await app.close();
  await admin.close();
});

test('partial and failed reads retain last-good facts without refreshing their observation time', async () => {
  const first = nextTime();
  await persist(collection(['api', 'worker']), first);
  const second = nextTime();
  await persist(collection(['api'], 'partial'), second);
  const [row] = await inventories();
  expect(row?.collection.entities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: expect.objectContaining({ name: 'worker' }),
        observedAt: first,
      }),
      expect.objectContaining({
        value: expect.objectContaining({ name: 'api' }),
        observedAt: second,
      }),
    ]),
  );
  await recordTopologyDiscoveryFailure(app.db, tenantId, generation, new Date(nextTime()));
  const [failed] = await inventories();
  expect(failed?.collection.completeness).toBe('unavailable');
  expect(failed?.collection.entities).toEqual(row?.collection.entities);
  await persist(collection(['api']));
  expect((await inventories())[0]?.collection.entities).toHaveLength(1);
});

test('paged scans survive failures and prune only unseen facts after the final successful page', async () => {
  await persist(collection(['old', 'first']));
  const startedAt = nextTime();
  await persist(
    {
      ...collection(['first'], 'partial'),
      scan: {
        cursor: '2',
        incomplete: false,
        inventory: [{ id: 'app-uid', name: 'app', namespace: 'argocd' }],
      },
    },
    startedAt,
  );
  expect(await readTopologyScans(app.db, tenantId, generation)).toEqual({
    workloads: {
      cursor: '2',
      incomplete: false,
      inventory: [{ id: 'app-uid', name: 'app', namespace: 'argocd' }],
    },
  });
  expect(await readTopologyScans(app.db, otherTenantId, generation)).toEqual({});
  expect(
    await readTopologyScans(app.db, tenantId, { ...generation, lifecycleVersion: 99 }),
  ).toEqual({});
  await recordTopologyDiscoveryFailure(app.db, tenantId, generation, new Date(nextTime()));
  expect((await readTopologyScans(app.db, tenantId, generation)).workloads?.cursor).toBe('2');
  const last = nextTime();
  await persist({ ...collection(['second']), scan: { cursor: null, incomplete: false } }, last);
  const [row] = await inventories();
  expect(row?.collection.entities.map((f) => f.value.name).sort()).toEqual(['first', 'second']);
  expect(row?.collection.entities.find((f) => f.value.name === 'first')?.observedAt).toBe(
    startedAt,
  );
  expect(row?.collection.completeness).toBe('complete');
  expect(await readTopologyScans(app.db, tenantId, generation)).toEqual({});
  expect(
    await persist(
      { ...collection(['late'], 'partial'), scan: { cursor: '2', incomplete: false } },
      startedAt,
    ),
  ).toBe(false);
});

test('a gapped scan cannot claim completeness or delete old facts, and a fresh scan can recover', async () => {
  await persist(collection(['keep-until-proven-absent']));
  await persist({ ...collection(['first'], 'partial'), scan: { cursor: '2', incomplete: true } });
  await expect(
    persist({ ...collection(['second']), scan: { cursor: null, incomplete: false } }),
  ).rejects.toThrow('earlier gap');
  await persist({ ...collection(['second'], 'partial'), scan: { cursor: null, incomplete: true } });
  expect((await inventories())[0]?.collection.entities.map((f) => f.value.name).sort()).toEqual([
    'first',
    'keep-until-proven-absent',
    'second',
  ]);
  expect(await readTopologyScans(app.db, tenantId, generation)).toEqual({});
  await persist({ ...collection(['new']), scan: { cursor: null, incomplete: false } });
  expect((await inventories())[0]?.collection.entities.map((f) => f.value.name)).toEqual(['new']);
});

test('scan membership is independent of the age of returned entity and relationship evidence', async () => {
  const evidenceAt = new Date(time - 700_000).toISOString();
  const initial = collection(['first', 'second', 'removed']);
  initial.entities[0]!.evidenceAt = evidenceAt;
  initial.relations = [
    {
      from: initial.entities[0]!.ref,
      to: initial.entities[1]!.ref,
      kind: 'calls',
      evidence: 'observed',
      description: 'Recorded call',
      evidenceAt,
    },
  ];
  await persist(initial);
  const seenAt = nextTime();
  await persist(
    {
      ...collection(['first'], 'partial'),
      entities: [{ ...initial.entities[0]!, evidenceAt: new Date(time - 800_000).toISOString() }],
      relations: initial.relations,
      scan: { cursor: '2', incomplete: false },
    },
    seenAt,
  );
  await recordTopologyDiscoveryFailure(app.db, tenantId, generation, new Date(nextTime()));
  await persist({ ...collection(['second']), scan: { cursor: null, incomplete: false } });
  const row = (await inventories())[0]!.collection;
  expect(row.entities.map((fact) => fact.value.name).sort()).toEqual(['first', 'second']);
  expect(row.entities.find((fact) => fact.value.name === 'first')).toMatchObject({
    observedAt: evidenceAt,
    seenAt,
  });
  expect(row.relations).toHaveLength(1);
  expect(row.relations[0]).toMatchObject({ observedAt: evidenceAt, seenAt });
  expect(row.completeness).toBe('complete');
});

test('a scan exactly at the retention cap is complete when no facts were dropped', async () => {
  const ids = Array.from({ length: 10_000 }, (_, index) => `resource-${index}`);
  await persist(collection([]));
  await persist({
    ...collection(ids.slice(0, 5000), 'partial'),
    scan: { cursor: '2', incomplete: false },
  });
  await persist({ ...collection(ids.slice(5000)), scan: { cursor: null, incomplete: false } });
  const row = (await inventories())[0]!.collection;
  expect(row.entities).toHaveLength(10_000);
  expect(row.completeness).toBe('complete');
  expect(row.issue).toBeNull();
});

test('older in-flight checkpoints preserve uncertain inventory until a new complete scan', async () => {
  await persist(collection(['possibly-removed']));
  const first = collection(['first'], 'partial');
  first.entities[0]!.evidenceAt = new Date(time - 700_000).toISOString();
  await persist({ ...first, scan: { cursor: '2', incomplete: false } });
  const before = (await inventories())[0]!.collection;
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(topologyCollections)
      .set({
        entities: before.entities.map(({ value, observedAt }) => ({ value, observedAt })),
      })
      .where(
        and(
          eq(topologyCollections.connectorId, connectorId),
          eq(topologyCollections.key, 'workloads'),
        ),
      ),
  );
  await persist({ ...collection(['second']), scan: { cursor: null, incomplete: false } });
  const retained = (await inventories())[0]!.collection;
  expect(retained.completeness).toBe('partial');
  expect(retained.entities.map((fact) => fact.value.name).sort()).toEqual([
    'first',
    'possibly-removed',
    'second',
  ]);
  expect(await readTopologyScans(app.db, tenantId, generation)).toEqual({});
  await persist({ ...collection(['first', 'second']), scan: { cursor: null, incomplete: false } });
  expect((await inventories())[0]!.collection.completeness).toBe('complete');
  expect((await inventories())[0]!.collection.entities).toHaveLength(2);
});

test('retention truncation remains a scan gap through later pages', async () => {
  const ids = Array.from({ length: 10_001 }, (_, index) => `bounded-${index}`);
  await persist(collection([]));
  await persist({
    ...collection(ids.slice(0, 5000), 'partial'),
    scan: { cursor: '2', incomplete: false },
  });
  await persist({
    ...collection(ids.slice(5000), 'partial'),
    scan: { cursor: '3', incomplete: false },
  });
  expect((await inventories())[0]!.collection.entities).toHaveLength(10_000);
  expect((await readTopologyScans(app.db, tenantId, generation)).workloads).toEqual({
    cursor: '3',
    incomplete: true,
  });
  await expect(
    persist({ ...collection([]), scan: { cursor: null, incomplete: false } }),
  ).rejects.toThrow('earlier gap');
  await persist({
    ...collection([], 'partial'),
    issue: 'limit',
    scan: { cursor: null, incomplete: true },
  });
  expect((await inventories())[0]!.collection.completeness).toBe('partial');
  expect((await inventories())[0]!.collection.issue).toBe('limit');
  expect(await readTopologyScans(app.db, tenantId, generation)).toEqual({});
});

test('late results and late failures cannot replace newer successful discovery', async () => {
  const older = nextTime();
  const newer = nextTime();
  expect(await persist(collection(['new']), newer)).toBe(true);
  expect(await persist(collection(['old']), older)).toBe(false);
  await recordTopologyDiscoveryFailure(app.db, tenantId, generation, new Date(older));
  const [row] = await inventories();
  expect(row?.collection.completeness).toBe('complete');
  expect(row?.collection.entities[0]?.value.name).toBe('new');
});

test('tenant isolation and composite connector ownership protect reads and writes', async () => {
  expect(await listTopologyDiscovery(app.db, otherTenantId)).toEqual([]);
  expect(
    await persistTopologyDiscovery(app.db, otherTenantId, generation, {
      observedAt: nextTime(),
      collections: [collection(['intruder'])],
    }),
  ).toBe(false);
  await expect(
    withTenant(app.db, tenantId, (tx) =>
      tx.insert(topologyCollections).values({
        tenantId,
        connectorId: otherConnectorId,
        generation: 0,
        key: 'illegal',
        completeness: 'complete',
        observedAt: new Date(),
        attemptedAt: new Date(),
        entities: [],
        relations: [],
      }),
    ),
  ).rejects.toThrow();
});

test('reconfiguration and disablement hide prior observations and fence stale workers', async () => {
  await admin.db
    .update(connectorConfigs)
    .set({ lifecycleVersion: 1 })
    .where(eq(connectorConfigs.id, connectorId));
  expect(await listTopologyDiscovery(app.db, tenantId)).toEqual([]);
  expect(await persist(collection(['old-generation']))).toBe(false);
  expect(
    await persistTopologyDiscovery(
      app.db,
      tenantId,
      { ...generation, lifecycleVersion: 1 },
      {
        observedAt: nextTime(),
        collections: [collection(['fresh'], 'partial')],
      },
    ),
  ).toBe(true);
  expect((await inventories())[0]?.collection.entities.map((f) => f.value.name)).toEqual(['fresh']);
  await admin.db
    .update(connectorConfigs)
    .set({ enabled: false })
    .where(eq(connectorConfigs.id, connectorId));
  expect(await listTopologyDiscovery(app.db, tenantId)).toEqual([]);
  expect(
    await persistTopologyDiscovery(
      app.db,
      tenantId,
      { ...generation, lifecycleVersion: 1 },
      {
        observedAt: nextTime(),
        collections: [collection(['disabled'])],
      },
    ),
  ).toBe(false);
});

test('rejects credential-bearing identity and duplicate facts before persistence', async () => {
  const bad = collection(['duplicate', 'duplicate']);
  await expect(persist(bad)).rejects.toThrow('Invalid topology inventory');
  const secret = collection(['api']);
  secret.entities[0]!.ref.authority = 'https://user:password@internal.example';
  await expect(persist(secret)).rejects.toThrow('Invalid topology reference');
});

test('first-read failure is visible before any inventory exists, then clears after success', async () => {
  const otherGeneration = { id: otherConnectorId, lifecycleVersion: 0 };
  await recordTopologyDiscoveryFailure(
    app.db,
    otherTenantId,
    otherGeneration,
    new Date(nextTime()),
  );
  expect((await listTopologyDiscovery(app.db, otherTenantId))[0]?.collection).toMatchObject({
    completeness: 'unavailable',
    key: '__discovery__',
    entities: [],
  });
  await persistTopologyDiscovery(app.db, otherTenantId, otherGeneration, {
    observedAt: nextTime(),
    collections: [],
  });
  expect((await listTopologyDiscovery(app.db, otherTenantId))[0]?.collection.completeness).toBe(
    'complete',
  );
});

test('repeated telemetry reads preserve event time instead of making old activity look current', async () => {
  const otherGeneration = { id: otherConnectorId, lifecycleVersion: 0 };
  const old = new Date(Date.now() - 700_000).toISOString();
  const value = collection(['observed-service'], 'partial');
  value.entities[0]!.evidenceAt = old;
  for (let read = 0; read < 2; read += 1) {
    await persistTopologyDiscovery(app.db, otherTenantId, otherGeneration, {
      observedAt: nextTime(),
      collections: [value],
    });
  }
  const row = (await listTopologyDiscovery(app.db, otherTenantId)).find(
    (result) => result.collection.key === 'workloads',
  );
  expect(row?.collection.entities[0]?.observedAt).toBe(old);
  value.entities[0]!.evidenceAt = new Date(Date.now() + 100_000).toISOString();
  await expect(
    persistTopologyDiscovery(app.db, otherTenantId, otherGeneration, {
      observedAt: nextTime(),
      collections: [value],
    }),
  ).rejects.toThrow('Invalid topology evidence time');
});

test('accepts evidence observed during a read while retaining the read-start ordering fence', async () => {
  const source = { id: otherConnectorId, lifecycleVersion: 0 };
  const startedAt = nextTime();
  const evidenceAt = new Date(Date.now() - 1).toISOString();
  const value = collection(['arrived-during-read']);
  value.entities[0]!.evidenceAt = evidenceAt;
  expect(Date.parse(evidenceAt)).toBeGreaterThan(Date.parse(startedAt));
  expect(
    await persistTopologyDiscovery(app.db, otherTenantId, source, {
      observedAt: startedAt,
      collections: [value],
    }),
  ).toBe(true);
  const saved = (await listTopologyDiscovery(app.db, otherTenantId)).find(
    (row) => row.collection.key === 'workloads',
  )!.collection;
  expect(saved.attemptedAt.toISOString()).toBe(startedAt);
  expect(saved.entities[0]?.observedAt).toBe(evidenceAt);
  await persistTopologyDiscovery(app.db, otherTenantId, source, {
    observedAt: nextTime(),
    collections: [collection(['newer-read'])],
  });
  expect(
    await persistTopologyDiscovery(app.db, otherTenantId, source, {
      observedAt: startedAt,
      collections: [value],
    }),
  ).toBe(false);
});

test('incoming inventory is bounded by UTF-8 bytes, not JavaScript string length', async () => {
  const value = collection(['unicode']);
  value.entities[0]!.attributes.label = '漢'.repeat(1_400_000);
  const input = { observedAt: nextTime(), collections: [value] };
  expect(JSON.stringify(input).length).toBeLessThan(4_000_000);
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(4_000_000);
  await expect(
    persistTopologyDiscovery(
      app.db,
      otherTenantId,
      { id: otherConnectorId, lifecycleVersion: 0 },
      input,
    ),
  ).rejects.toThrow('Topology inventory too large');
});

test('repeated partial pages share a retained byte budget across entities and relationships', async () => {
  const source = { id: otherConnectorId, lifecycleVersion: 0 };
  await persistTopologyDiscovery(app.db, otherTenantId, source, {
    observedAt: nextTime(),
    collections: [collection([])],
  });
  const text = 'ordinary topology description '.repeat(30_000);
  const evidenceAt = new Date(time - 700_000).toISOString();
  for (let index = 0; index < 3; index++) {
    const value = collection([`page-${index}`], 'partial');
    value.entities[0]!.attributes.label = text;
    value.entities[0]!.evidenceAt = evidenceAt;
    value.relations = [
      {
        from: value.entities[0]!.ref,
        to: value.entities[0]!.ref,
        kind: 'calls',
        evidence: 'observed',
        description: text,
        evidenceAt,
      },
    ];
    value.scan = { cursor: String(index + 1), incomplete: false };
    await persistTopologyDiscovery(app.db, otherTenantId, source, {
      observedAt: nextTime(),
      collections: [value],
    });
  }
  const row = (await listTopologyDiscovery(app.db, otherTenantId)).find(
    (row) => row.collection.key === 'workloads',
  )!.collection;
  expect(
    Buffer.byteLength(JSON.stringify({ entities: row.entities, relations: row.relations })),
  ).toBeLessThanOrEqual(4_000_000);
  expect(row.entities.some((fact) => fact.value.name === 'page-2')).toBe(true);
  expect(row.relations.some((fact) => fact.value.from.id === 'page-2')).toBe(true);
  expect([...row.entities, ...row.relations].every((fact) => fact.observedAt === evidenceAt)).toBe(
    true,
  );
  expect(row.issue).toBe('limit');
  expect(row.completeness).toBe('partial');
  expect((await readTopologyScans(app.db, otherTenantId, source)).workloads?.incomplete).toBe(true);
});

test('bounding an older oversized inventory during an outage preserves a scan gap', async () => {
  const source = { id: otherConnectorId, lifecycleVersion: 0 };
  await persistTopologyDiscovery(app.db, otherTenantId, source, {
    observedAt: nextTime(),
    collections: [collection([])],
  });
  const at = nextTime();
  await persistTopologyDiscovery(app.db, otherTenantId, source, {
    observedAt: at,
    collections: [
      { ...collection(['first'], 'partial'), scan: { cursor: 'next', incomplete: false } },
    ],
  });
  const old = collection(['a', 'b', 'c', 'd', 'e', 'f']).entities.map((value) => ({
    value: { ...value, attributes: { label: 'ordinary topology description '.repeat(30_000) } },
    observedAt: at,
    seenAt: at,
  }));
  await withTenant(app.db, otherTenantId, (tx) =>
    tx
      .update(topologyCollections)
      .set({ entities: old })
      .where(
        and(
          eq(topologyCollections.connectorId, otherConnectorId),
          eq(topologyCollections.key, 'workloads'),
        ),
      ),
  );
  await persistTopologyDiscovery(app.db, otherTenantId, source, {
    observedAt: nextTime(),
    collections: [collection([], 'unavailable')],
  });
  const row = (await listTopologyDiscovery(app.db, otherTenantId)).find(
    (row) => row.collection.key === 'workloads',
  )!.collection;
  expect(row.completeness).toBe('unavailable');
  expect(row.entities.length).toBeLessThan(old.length);
  expect(row.entities.every((fact) => fact.observedAt === at && fact.seenAt === at)).toBe(true);
  expect((await readTopologyScans(app.db, otherTenantId, source)).workloads).toEqual({
    cursor: 'next',
    incomplete: true,
  });
});
