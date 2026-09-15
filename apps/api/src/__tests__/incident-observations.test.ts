import { seedMembership } from '@sre/db/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  connectorConfigs,
  deployments,
  makeDb,
  services,
  serviceRuntimeBindings,
  tenants,
  users,
  upsertDeployments,
  type DbHandle,
} from '@sre/db';
import type { NormalizedSnapshot } from '@sre/connectors';
import {
  ObservationNotActionableError,
  ObservationNotFoundError,
  ObservationUnavailableError,
  resolveObservation,
} from '../incident-observations';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let ownerUserId: string;
let foreignTenantId: string;
let kubernetesId: string;
let connectorId: string;
let deploymentId: string;
const snapshots = new Map<string, NormalizedSnapshot[]>();
const cache = {
  async get(tenant: string, source: string) {
    return snapshots.get(`${tenant}:${source}`) ?? [];
  },
  async set(tenant: string, source: string, values: NormalizedSnapshot[]) {
    snapshots.set(`${tenant}:${source}`, values);
  },
};

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantId = randomUUID();
  foreignTenantId = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantId, name: 'Observation resolvers' },
    { id: foreignTenantId, name: 'Foreign observations' },
  ]);
  ownerUserId = await seedMembership(
    admin.db,
    { issuer: 'https://observation.test', subject: randomUUID() },
    tenantId,
    'owner',
  );
  const configs = await admin.db
    .insert(connectorConfigs)
    .values([
      {
        tenantId,
        type: 'kubernetes',
        name: 'Primary Kubernetes',
        settings: { token: 'must-never-persist' },
        enabled: true,
      },
      {
        tenantId,
        type: 'github',
        name: 'GitHub production glpat-ABCDEF1234567890abcd',
        settings: { privateKey: 'must-never-persist' },
        enabled: false,
        verificationAttemptedAt: new Date(),
        verificationFailureCategory: 'permission_denied',
      },
    ])
    .returning({ id: connectorConfigs.id, type: connectorConfigs.type });
  kubernetesId = configs.find((config) => config.type === 'kubernetes')!.id;
  connectorId = configs.find((config) => config.type === 'github')!.id;
  await cache.set(tenantId, 'kubernetes', [
    {
      tenantId,
      source: 'kubernetes',
      entityId: 'argocd/argocd-server',
      metrics: { ready: 1, restartCount: 1, oomKilled: 1 },
      metadata: {
        kind: 'pod',
        namespace: 'argocd',
        phase: 'Running',
        token: 'must-never-persist',
        error: 'Probe rejected Bearer abc.def.ghi123XYZ',
      },
      observedAt: new Date(),
    },
    {
      tenantId,
      source: 'kubernetes',
      entityId: 'collection/pods',
      metrics: {},
      metadata: { kind: 'collection', resource: 'pods', completeness: 'complete' },
      observedAt: new Date(),
    },
  ]);
  await upsertDeployments(app.db, tenantId, [
    {
      source: 'gitlab',
      repo: 'payments/api',
      ref: 'main',
      sha: 'deadbeef',
      service: 'payments',
      status: 'failed',
      deployedAt: new Date(),
      url: 'https://user:password@example.test/deploy?token=must-not-persist#secret',
    },
  ]);
  const [deployment] = await admin.db
    .select({ id: deployments.id })
    .from(deployments)
    .where(sql`tenant_id = ${tenantId}`);
  deploymentId = deployment!.id;
  await admin.db.insert(services).values({
    tenantId,
    name: 'argocd',
    team: 'platform',
    criticality: 'tier1',
  });
  await admin.db.insert(serviceRuntimeBindings).values({
    tenantId,
    serviceName: 'argocd',
    connectorId: kubernetesId,
    namespace: 'argocd',
    environment: 'test',
    confirmedByUserId: ownerUserId,
    rationale: 'Confirmed fixture runtime',
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(deployments).where(sql`tenant_id in (${tenantId}, ${foreignTenantId})`);
    await admin.db
      .delete(serviceRuntimeBindings)
      .where(sql`tenant_id in (${tenantId}, ${foreignTenantId})`);
    await admin.db.delete(services).where(sql`tenant_id in (${tenantId}, ${foreignTenantId})`);
    await admin.db
      .delete(connectorConfigs)
      .where(sql`tenant_id in (${tenantId}, ${foreignTenantId})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantId}, ${foreignTenantId})`);
    if (ownerUserId) await admin.db.delete(users).where(sql`id = ${ownerUserId}`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('platform observation resolvers', () => {
  test('captures exact server-owned resource identity and retains namespace as scope, not a second affected resource', async () => {
    const values = await cache.get(tenantId, 'kubernetes');
    const ref = {
      authority: 'kubernetes-object',
      kind: 'Pod',
      id: JSON.stringify(['argocd', 'pod-uid']),
    };
    const previous = values[0]!.topology;
    values[0]!.topology = { ref, state: 'attention' };
    try {
      const result = await resolveObservation({ db: app.db, cache }, tenantId, {
        kind: 'infrastructure_resource',
        dataSourceId: kubernetesId,
        entityId: 'argocd/argocd-server',
      });
      expect(result.subject.affectedEntities).toEqual([
        expect.objectContaining({
          kind: 'workload',
          topologyRef: ref,
          scope: { dataSourceId: kubernetesId, namespace: 'argocd' },
          provenance: { kind: 'platform_snapshot', source: 'kubernetes' },
        }),
      ]);
    } finally {
      if (previous) values[0]!.topology = previous;
      else delete values[0]!.topology;
    }
  });
  test('resolves all four typed subjects from tenant-owned server evidence', async () => {
    const resolved = await Promise.all([
      resolveObservation({ db: app.db, cache }, tenantId, {
        kind: 'infrastructure_resource',
        dataSourceId: kubernetesId,
        entityId: 'argocd/argocd-server',
      }),
      resolveObservation({ db: app.db, cache }, tenantId, {
        kind: 'deployment',
        deploymentId,
      }),
      resolveObservation({ db: app.db, cache }, tenantId, {
        kind: 'connector_verification',
        connectorId,
      }),
      resolveObservation({ db: app.db, cache }, tenantId, {
        kind: 'topology_service',
        service: 'argocd',
      }),
    ]);

    expect(resolved.map((item) => item.subject.kind)).toEqual([
      'infrastructure_resource',
      'deployment',
      'connector_verification',
      'topology_service',
    ]);
    expect(resolved.every((item) => item.subject.state === 'firing')).toBe(true);
    expect(resolved[0]!.subject.signalSource).toMatchObject({
      kind: 'platform_observer',
      provider: 'kubernetes',
      dataSourceId: kubernetesId,
    });
    expect(resolved[0]!.subject.affectedEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'workload', stableId: 'argocd/argocd-server' }),
        expect.objectContaining({ kind: 'namespace', stableId: 'argocd' }),
      ]),
    );
    expect(resolved[1]!.subject.signalSource).toMatchObject({
      kind: 'platform_observer',
      provider: 'gitlab',
      externalId: deploymentId,
    });
    expect(resolved[1]!.subject.affectedEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'deployment', stableId: deploymentId }),
        expect.objectContaining({ kind: 'repository', stableId: 'payments/api' }),
        expect.objectContaining({ kind: 'service', stableId: 'payments' }),
      ]),
    );
    expect(resolved[2]!.subject.signalSource).toMatchObject({
      kind: 'platform_observer',
      provider: 'github',
      dataSourceId: connectorId,
    });
    expect(resolved[2]!.subject.affectedEntities).toEqual([
      expect.objectContaining({ kind: 'connector', stableId: connectorId }),
    ]);
    expect(resolved[3]!.subject.signalSource).toMatchObject({
      kind: 'platform_observer',
      provider: 'topology',
      externalId: 'argocd',
    });
    expect(resolved[3]!.subject.affectedEntities).toEqual([
      expect.objectContaining({
        kind: 'service',
        stableId: 'argocd',
        provenance: { kind: 'catalog', source: 'service_catalog' },
      }),
    ]);
    expect(JSON.stringify(resolved)).not.toContain('must-never-persist');
    expect(JSON.stringify(resolved)).not.toContain('abc.def.ghi123XYZ');
    expect(JSON.stringify(resolved)).not.toContain('glpat-ABCDEF1234567890abcd');
    expect(resolved[1]!.subject.snapshot).not.toHaveProperty('url');
  });

  test('returns the same not-found class for missing and foreign tenant sources', async () => {
    await expect(
      resolveObservation({ db: app.db, cache }, tenantId, {
        kind: 'infrastructure_resource',
        dataSourceId: randomUUID(),
        entityId: 'missing',
      }),
    ).rejects.toBeInstanceOf(ObservationNotFoundError);
    await expect(
      resolveObservation({ db: app.db, cache }, foreignTenantId, {
        kind: 'infrastructure_resource',
        dataSourceId: kubernetesId,
        entityId: 'argocd/argocd-server',
      }),
    ).rejects.toBeInstanceOf(ObservationNotFoundError);
  });

  test('accepts the canonical failure deployment status exposed by the dashboard', async () => {
    await admin.db
      .update(deployments)
      .set({ status: 'failure' })
      .where(sql`id = ${deploymentId}`);

    const resolved = await resolveObservation({ db: app.db, cache }, tenantId, {
      kind: 'deployment',
      deploymentId,
    });

    expect(resolved.subject.state).toBe('firing');
  });

  test('rejects a server-confirmed healthy deployment', async () => {
    await admin.db
      .update(deployments)
      .set({ status: 'success' })
      .where(sql`id = ${deploymentId}`);
    await expect(
      resolveObservation({ db: app.db, cache }, tenantId, {
        kind: 'deployment',
        deploymentId,
      }),
    ).rejects.toBeInstanceOf(ObservationNotActionableError);
  });

  test('classifies stale-only topology runtime as unknown', async () => {
    const key = `${tenantId}:kubernetes`;
    const original = snapshots.get(key)!;
    snapshots.set(key, [
      {
        ...original[0]!,
        metrics: { ready: 1, restartCount: 0, oomKilled: 0 },
        metadata: { kind: 'pod', namespace: 'argocd', phase: 'Running' },
        observedAt: new Date(Date.now() - 2 * 60_000),
      },
      original[1]!,
    ]);
    try {
      const resolved = await resolveObservation({ db: app.db, cache }, tenantId, {
        kind: 'topology_service',
        service: 'argocd',
      });
      expect(resolved.subject.state).toBe('unknown');
    } finally {
      snapshots.set(key, original);
    }
  });

  test('translates a topology cache failure into an unavailable observation', async () => {
    await expect(
      resolveObservation(
        {
          db: app.db,
          cache: {
            get: async () => {
              throw new Error('cache failed with glpat-ABCDEF1234567890abcd');
            },
            set: async () => undefined,
          },
        },
        tenantId,
        { kind: 'topology_service', service: 'argocd' },
      ),
    ).rejects.toBeInstanceOf(ObservationUnavailableError);
  });
});
