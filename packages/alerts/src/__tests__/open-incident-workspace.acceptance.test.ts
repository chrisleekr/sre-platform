import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  investigationSubjects,
  jobs,
  makeDb,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  tenants,
  transitionIncidentTx,
  upsertSurfaceConfig,
  withTenant,
  type DbHandle,
} from '@sre/db';
import { Queue } from '@sre/queue';
import { openIncidentWorkspace } from '../open-incident-workspace';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let queue: Queue;
let tenantId: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
  queue = new Queue(admin.db, redis);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Workspace acceptance' });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(surfaceDeliveries).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentMessages).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentSignals).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentRelations).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(investigationSubjects).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(surfaceBindings).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(surfaceConfigs).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.close();
  }
  if (app) await app.close();
  if (redis) await redis.quit();
});

function declaration(subjectId: string) {
  return {
    tenantId,
    source: 'platform',
    service: 'checkout',
    severity: 'sev3',
    title: 'Checkout needs attention',
    subject: {
      kind: 'topology_service' as const,
      sourceId: 'topology',
      subjectId,
      sourcePath: '/topology',
      state: 'firing' as const,
      summary: 'One runtime pod needs attention',
      observedAt: new Date(),
      snapshot: { pods: 3, unhealthyPods: 1 },
    },
  };
}

describe('workspace opening acceptance', () => {
  test('concurrent declarations converge on one active incident and initial triage job', async () => {
    const input = declaration(`platform:concurrent:${randomUUID()}`);
    const results = await Promise.all([
      openIncidentWorkspace({ appDb: app.db, queue }, input),
      openIncidentWorkspace({ appDb: app.db, queue }, input),
    ]);
    expect(new Set(results.map((result) => result.incidentId)).size).toBe(1);
    expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'existing']);
    const triage = await admin.db
      .select()
      .from(jobs)
      .where(
        sql`tenant_id = ${tenantId} and type = 'triage' and payload->>'incidentId' = ${results[0]!.incidentId}`,
      );
    expect(triage).toHaveLength(1);
  });

  test('a terminal episode stays immutable and the fresh episode references it', async () => {
    const input = declaration(`platform:recurrence:${randomUUID()}`);
    const first = await openIncidentWorkspace({ appDb: app.db, queue }, input);
    await withTenant(app.db, tenantId, (tx) =>
      transitionIncidentTx(tx, first.incidentId, 'closed'),
    );
    const second = await openIncidentWorkspace({ appDb: app.db, queue }, input);
    expect(second.incidentId).not.toBe(first.incidentId);
    const relations = await admin.db
      .select()
      .from(incidentRelations)
      .where(
        sql`tenant_id = ${tenantId} and source_incident_id = ${second.incidentId} and target_incident_id = ${first.incidentId}`,
      );
    expect(relations).toHaveLength(1);
    expect(relations[0]!.type).toBe('recurrence_of');
  });

  test('an optional surface binding uses the existing delivery ledger without becoming required', async () => {
    await upsertSurfaceConfig(app.db, tenantId, { surface: 'slack' });
    const opened = await openIncidentWorkspace(
      { appDb: app.db, queue },
      {
        ...declaration(`platform:binding:${randomUUID()}`),
        binding: { surface: 'slack', channel: 'C_PLATFORM', threadId: '1787880000.0001' },
      },
    );
    expect(opened.bindingId).toEqual(expect.any(String));
    const deliveries = await admin.db
      .select()
      .from(surfaceDeliveries)
      .where(sql`tenant_id = ${tenantId} and incident_id = ${opened.incidentId}`);
    expect(deliveries.length).toBeGreaterThan(0);
  });
});
