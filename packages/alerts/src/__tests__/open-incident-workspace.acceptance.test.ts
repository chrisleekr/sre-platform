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

test('trusted exact provider enrollment selects provider-clear without changing a reused strict incident', async () => {
  const fingerprint = `provider-policy:${randomUUID()}`;
  const signal = {
    surface: 'slack',
    channel: 'C_PROVIDER',
    externalMessageId: randomUUID(),
    state: 'firing' as const,
    summary: 'Checkout monitor firing',
    contentHash: randomUUID(),
    eventKey: `provider:${randomUUID()}:producer:bot:B_MONITOR`,
    eventAt: new Date(),
    provider: 'statuscake',
    providerGroupKey: 'statuscake:uptime:https://checkout.example/health',
    monitorKey: 'checkout-availability',
    alertName: 'Website availability',
  };
  const trusted = {
    tenantId,
    source: 'slack',
    service: 'checkout',
    severity: 'sev3',
    fingerprint,
    signal,
    resolutionPolicy: 'provider_clear' as const,
  };
  const opened = await openIncidentWorkspace({ appDb: app.db, queue }, trusted);
  const [row] = await admin.db
    .select()
    .from(incidents)
    .where(sql`id = ${opened.incidentId}`);
  expect(row).toMatchObject({ resolutionPolicy: 'provider_clear', resolutionBasis: null });

  const manual = await openIncidentWorkspace(
    { appDb: app.db, queue },
    {
      tenantId,
      source: 'manual',
      service: 'checkout',
      severity: 'sev3',
      fingerprint: `${fingerprint}:strict`,
    },
  );
  const reused = await openIncidentWorkspace(
    { appDb: app.db, queue },
    { ...trusted, fingerprint: `${fingerprint}:strict` },
  );
  expect(reused.incidentId).toBe(manual.incidentId);
  const [strict] = await admin.db
    .select()
    .from(incidents)
    .where(sql`id = ${manual.incidentId}`);
  expect(strict).toMatchObject({ resolutionPolicy: 'verified_recovery', resolutionBasis: null });
});

test.each(['manual', 'degraded', 'health_check'] as const)(
  '%s creation retains verified-recovery policy',
  async (kind) => {
    const opened = await openIncidentWorkspace(
      { appDb: app.db, queue },
      {
        tenantId,
        source: kind === 'manual' ? 'manual' : 'slack',
        service: 'checkout',
        severity: 'sev3',
        fingerprint: `strict-policy:${randomUUID()}`,
        purpose: kind === 'health_check' ? 'health_check' : 'incident',
        investigationStatus: kind === 'degraded' ? 'degraded' : 'queued',
      },
    );
    const [row] = await admin.db
      .select()
      .from(incidents)
      .where(sql`id = ${opened.incidentId}`);
    expect(row).toMatchObject({ resolutionPolicy: 'verified_recovery', resolutionBasis: null });
  },
);

test.each([
  { name: 'trusted degraded alert', purpose: 'incident' as const, expected: 'provider_clear' },
  {
    name: 'health check with explicit provider policy',
    purpose: 'health_check' as const,
    expected: 'verified_recovery',
  },
])(
  '$name persists the correct policy independently of degraded investigation',
  async ({ purpose, expected }) => {
    const opened = await openIncidentWorkspace(
      { appDb: app.db, queue },
      {
        tenantId,
        source: 'slack',
        service: 'checkout',
        severity: 'sev3',
        fingerprint: `degraded-provider-policy:${randomUUID()}`,
        purpose,
        investigationStatus: 'degraded',
        resolutionPolicy: 'provider_clear',
        signal: {
          surface: 'slack',
          channel: 'C_PROVIDER',
          externalMessageId: randomUUID(),
          state: 'firing',
          summary: 'The exact provider monitor is firing.',
          contentHash: randomUUID(),
          eventKey: `provider:${randomUUID()}:producer:bot:B_MONITOR`,
          eventAt: new Date(),
          provider: 'statuscake',
          providerGroupKey: 'statuscake:uptime:https://checkout.example/health',
          monitorKey: 'checkout-availability',
          alertName: 'Website availability',
        },
      },
    );
    const [row] = await admin.db
      .select()
      .from(incidents)
      .where(sql`id = ${opened.incidentId}`);
    expect(row).toMatchObject({
      resolutionPolicy: expected,
      investigationStatus: 'degraded',
      resolutionBasis: null,
    });
  },
);
