import { seedMembership } from '@sre/db/test-support';
import { openIncidentWorkspace } from '@sre/alerts';
import {
  connectorConfigs,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  investigationSubjects,
  jobs,
  makeDb,
  services,
  serviceRuntimeBindings,
  surfaceBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue, type Job } from '@sre/queue';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import { TriageWorker } from '../worker';

export function createFixture() {
  let admin: DbHandle;

  let app: DbHandle;

  let redis: Redis;

  let queue: Queue;

  let hub: ConversationHub;

  let tenantId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
    admin = makeDb(process.env.DATABASE_URL!);
    app = makeDb(process.env.APP_DATABASE_URL!);
    redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(admin.db, redis);
    hub = new ConversationHub(app.db, redis);
    tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'Subject sync tests' });
    ownerUserId = await seedMembership(
      admin.db,
      { issuer: 'https://subject-sync.test', subject: randomUUID() },
      tenantId,
      'owner',
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(jobs).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentMessages).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentSignals).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentRelations).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(investigationSubjects).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(surfaceBindings).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(serviceRuntimeBindings).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(services).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(connectorConfigs).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
      if (ownerUserId) await admin.db.delete(users).where(sql`id = ${ownerUserId}`);
      await admin.close();
    }
    if (app) await app.close();
    if (redis) await redis.quit();
  });

  async function opened() {
    return openIncidentWorkspace(
      { appDb: app.db, queue },
      {
        tenantId,
        source: 'platform',
        service: 'checkout',
        severity: 'sev3',
        title: 'Checkout runtime needs attention',
        subject: {
          kind: 'topology_service',
          sourceId: 'topology',
          subjectId: `checkout-${randomUUID()}`,
          sourcePath: '/topology',
          state: 'firing',
          summary: '1/3 pods need attention',
          observedAt: new Date(),
          snapshot: { pods: 3, unhealthyPods: 1 },
        },
      },
    );
  }

  function worker(
    resolveInvestigationSubject: NonNullable<
      ConstructorParameters<typeof TriageWorker>[0]['resolveInvestigationSubject']
    >,
  ) {
    return new TriageWorker({
      appDb: app.db,
      hub,
      queue,
      resolveInvestigationSubject,
    } as ConstructorParameters<typeof TriageWorker>[0]);
  }

  const job = (incidentId: string): Job => ({
    id: randomUUID(),
    tenantId,
    type: 'subject.sync',
    payload: { incidentId },
    attempts: 1,
  });

  return {
    get ownerUserId() {
      return ownerUserId;
    },
    get admin() {
      return admin;
    },
    set admin(value: typeof admin) {
      admin = value;
    },
    get app() {
      return app;
    },
    set app(value: typeof app) {
      app = value;
    },
    get redis() {
      return redis;
    },
    set redis(value: typeof redis) {
      redis = value;
    },
    get queue() {
      return queue;
    },
    set queue(value: typeof queue) {
      queue = value;
    },
    get hub() {
      return hub;
    },
    set hub(value: typeof hub) {
      hub = value;
    },
    get tenantId() {
      return tenantId;
    },
    set tenantId(value: typeof tenantId) {
      tenantId = value;
    },
    opened,
    worker,
    job,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
