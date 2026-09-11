import {
  agentToolCalls,
  inboundChannels,
  inboundSideEffects,
  incidentMessages,
  incidentSignals,
  incidents,
  investigationRuns,
  jobs,
  makeDb,
  subscribeChannel,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  surfaceWorkingPosts,
  tenants,
  upsertSurfaceConfig,
  persistSurfaceIdentity,
  surfaceIdentities,
  memberships,
  users,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue, type Job } from '@sre/queue';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import { type SlackEnvelope } from '../../../api/src/surfaces/slack-inbound';
import { seedMembership } from '../../../../packages/db/src/test-support';
import { responderGenerator } from './responder-generator.fixture';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL!;

  const APP_URL = process.env.APP_DATABASE_URL!;

  const VALKEY_URL = process.env.VALKEY_URL!;

  let admin: DbHandle;

  let app: DbHandle;

  let redis: Redis;

  let triageQueue: Queue;

  let classifyQueue: Queue;

  let hub: ConversationHub;

  let tenantId: string;
  let actorUserId: string;

  let surfaceConfigId: string;

  const channel = 'C_LIFECYCLE_ACCEPTANCE';

  const rootTs = '1787400000.000001';

  const botId = 'B_ALERTMANAGER';

  const generatorUrl = 'https://alerts.example.test/graph?g0.expr=checkout_errors';

  const alertName = 'CheckoutHighErrorRate';

  const classifyStream = `sre:classify:lifecycle:${randomUUID()}`;

  const triageStream = `sre:jobs:lifecycle:${randomUUID()}`;

  const rootText = (state: 'FIRING' | 'RESOLVED', detail: string): string =>
    `<${generatorUrl}|[${state}:1] ${alertName}>\n${detail}`;

  function messageEnvelope(over: Partial<NonNullable<SlackEnvelope['event']>>): SlackEnvelope {
    return {
      type: 'event_callback',
      event_id: `Ev-${randomUUID()}`,
      event: {
        type: 'message',
        channel,
        ts: rootTs,
        event_ts: rootTs,
        ...over,
      },
    };
  }

  async function newestQueued(type: string): Promise<Job> {
    const rows = await admin.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.type, type), eq(jobs.status, 'queued')))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`queued ${type} job not found`);
    return {
      id: row.id,
      tenantId: row.tenantId,
      type: row.type,
      payload: row.payload,
      attempts: row.attempts + 1,
    };
  }

  async function finishDirectJob(job: Job, handler: (job: Job) => Promise<void>): Promise<void> {
    await admin.db
      .update(jobs)
      .set({ status: 'processing', attempts: job.attempts })
      .where(and(eq(jobs.id, job.id), eq(jobs.tenantId, tenantId)));
    await handler(job);
    await admin.db
      .update(jobs)
      .set({ status: 'done' })
      .where(and(eq(jobs.id, job.id), eq(jobs.tenantId, tenantId)));
  }

  beforeAll(async () => {
    expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
    triageQueue = new Queue(admin.db, redis, { stream: triageStream });
    classifyQueue = new Queue(admin.db, redis, { stream: classifyStream });
    hub = new ConversationHub(app.db, redis);
    tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'Lifecycle acceptance' });
    actorUserId = await seedMembership(
      admin.db,
      { issuer: 'test', subject: `lifecycle:${tenantId}`, email: `${tenantId}@example.test` },
      tenantId,
    );
    await persistSurfaceIdentity(app.db, tenantId, {
      surface: 'slack',
      surfaceUserId: 'U_RESPONDER',
      authorUserId: actorUserId,
    });
    const config = await upsertSurfaceConfig(app.db, tenantId, {
      surface: 'slack',
      botUserId: 'U_PLATFORM',
      botId: 'B_PLATFORM',
      teamId: 'T_ACCEPTANCE',
      appId: 'A_ACCEPTANCE',
    });
    surfaceConfigId = config.id;
    await subscribeChannel(app.db, {
      tenantId,
      surface: 'slack',
      channel,
      channelName: 'incidents',
    });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      const tenant = sql`tenant_id = ${tenantId}`;
      await admin.db.delete(surfaceDeliveries).where(tenant);
      await admin.db.delete(surfaceWorkingPosts).where(tenant);
      await admin.db.delete(jobs).where(tenant);
      await admin.db.delete(agentToolCalls).where(tenant);
      await admin.db.delete(incidentMessages).where(tenant);
      await admin.db.delete(incidentSignals).where(tenant);
      await admin.db.delete(inboundSideEffects).where(tenant);
      await admin.db.delete(surfaceBindings).where(tenant);
      await admin.db.delete(inboundChannels).where(tenant);
      await admin.db.delete(surfaceConfigs).where(tenant);
      await admin.db.update(incidents).set({ trustedAssessmentRunId: null }).where(tenant);
      await admin.db.delete(investigationRuns).where(tenant);
      await admin.db.delete(incidents).where(tenant);
      await admin.db.delete(surfaceIdentities).where(tenant);
      await admin.db.delete(memberships).where(tenant);
      await admin.db.delete(users).where(eq(users.id, actorUserId));
      await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
      await admin.close();
    }
    if (app) await app.close();
    if (redis) await redis.quit();
  });

  return {
    responderGenerator,
    get actorUserId() {
      return actorUserId;
    },
    ADMIN_URL,
    APP_URL,
    VALKEY_URL,
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
    get triageQueue() {
      return triageQueue;
    },
    set triageQueue(value: typeof triageQueue) {
      triageQueue = value;
    },
    get classifyQueue() {
      return classifyQueue;
    },
    set classifyQueue(value: typeof classifyQueue) {
      classifyQueue = value;
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
    get surfaceConfigId() {
      return surfaceConfigId;
    },
    set surfaceConfigId(value: typeof surfaceConfigId) {
      surfaceConfigId = value;
    },
    channel,
    rootTs,
    botId,
    generatorUrl,
    alertName,
    classifyStream,
    triageStream,
    rootText,
    messageEnvelope,
    newestQueued,
    finishDirectJob,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
