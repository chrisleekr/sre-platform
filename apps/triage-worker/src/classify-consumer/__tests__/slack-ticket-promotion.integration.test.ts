import { seedMembership } from '@sre/db/test-support';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { routeToIncident, type IncidentSignal, type RouteResult } from '@sre/alerts';
import {
  incidents,
  jobs,
  makeDb,
  memberships,
  persistSurfaceIdentity,
  recordSignalDisposition,
  signalDispositions,
  surfaceBindings,
  surfaceIdentities,
  tenantSignalPolicies,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { Queue } from '@sre/queue';
import { makeClassifyHandler } from '../../classify-consumer';
import { makeFakeClassifier } from '../../engine/classify';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const VALKEY_URL = process.env.VALKEY_URL!;
const CHANNEL = 'C-SLACK-PROMOTION';
const THREAD = '1791000000.000100';
const SLACK_USER = 'U012SRE';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let queue: Queue;
const tenantId = randomUUID();
let userId: string;
let ticketId: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  queue = new Queue(admin.db, redis, {
    stream: 'sre:jobs:slack-ticket-promotion',
    group: 'slack-ticket-promotion',
  });
  await admin.db.insert(tenants).values({ id: tenantId, name: 'slack-ticket-promotion' });
  userId = await seedMembership(
    admin.db,
    { issuer: 'https://slack-promotion.test/', subject: `sre-${randomUUID()}` },
    tenantId,
  );
  await persistSurfaceIdentity(app.db, tenantId, {
    surface: 'slack',
    surfaceUserId: SLACK_USER,
    authorUserId: userId,
  });
  ticketId = (
    await recordSignalDisposition(app.db, tenantId, {
      source: 'slack-human',
      sourceEventKey: `slack:${CHANNEL}:${THREAD}`,
      sourceEventAt: new Date(),
      signalKey: `slack:${CHANNEL}:${THREAD}`,
      surface: 'slack',
      channel: CHANNEL,
      threadId: THREAD,
      summary: 'Checkout degradation needs review.',
      reason: 'Impact is not confirmed yet.',
      service: 'checkout',
      severity: 'sev3',
      disposition: 'ticket',
      classificationMode: 'enforce',
      effectiveDisposition: 'ticket',
      ticket: {
        action: 'Review checkout failures.',
        safeDeferralReason: 'No confirmed user impact.',
        riskIfIgnored: 'The degradation may become customer-visible.',
        reviewHorizonMinutes: 60,
      },
    })
  ).id;
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(surfaceBindings).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(signalDispositions).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(surfaceIdentities).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenantSignalPolicies).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(memberships).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(users).where(eq(users.id, userId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
  if (redis) {
    await redis.del(`dedup:${tenantId}:signal-ticket:${ticketId}:promote`);
    await redis.quit();
  }
});

const routeSignal = (signal: IncidentSignal): Promise<RouteResult> =>
  routeToIncident({ appDb: app.db, redis, queue }, signal);

describe('Slack ticket promotion', () => {
  test('accepts an explicit mention once and preserves Slack attribution under concurrency', async () => {
    const onOutcome = vi.fn();
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => ({ decision: 'not_worthy' })),
      route: routeSignal,
      hub: {} as never,
      threadReader: { readThread: vi.fn(async () => []) },
      generator: { generate: vi.fn() } as never,
      embedder: { dim: 1, embed: async () => [[0]] },
      appDb: app.db,
      redis,
      reservationRedis: redis,
      queue,
      onOutcome,
    });
    const payload = {
      kind: 'mention' as const,
      channel: CHANNEL,
      rootTs: THREAD,
      ts: '1791000000.000200',
      user: SLACK_USER,
      text: '<@U012BOT> investigate',
      raw: { type: 'app_mention', text: '<@U012BOT> investigate' },
    };

    await Promise.all([
      handler({ id: randomUUID(), tenantId, type: 'classify', attempts: 1, payload }),
      handler({ id: randomUUID(), tenantId, type: 'classify', attempts: 1, payload }),
    ]);

    const [ticket] = await admin.db
      .select()
      .from(signalDispositions)
      .where(eq(signalDispositions.id, ticketId));
    expect(ticket).toMatchObject({
      promotedByUserId: userId,
      promotedBySurface: 'slack',
      promotedByActor: `slack:${SLACK_USER}`,
      promotionCriterion: 'other',
      promotionReason: 'A mapped Slack responder promoted this ticket for investigation.',
    });
    expect(ticket!.incidentId).toEqual(expect.any(String));
    const incidentRows = await admin.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.id, ticket!.incidentId!));
    expect(incidentRows).toHaveLength(1);
    const triageJobs = await admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(sql`type = 'triage' and payload->>'incidentId' = ${ticket!.incidentId}`);
    expect(triageJobs).toHaveLength(1);
    expect(onOutcome).toHaveBeenCalledTimes(2);
  });

  test('does not intercept a shadow ticket proposal as an operational promotion', async () => {
    const thread = '1791000000.000300';
    const shadow = await recordSignalDisposition(app.db, tenantId, {
      source: 'slack-human',
      sourceEventKey: `slack:${CHANNEL}:${thread}`,
      sourceEventAt: new Date(),
      signalKey: `slack:${CHANNEL}:${thread}`,
      surface: 'slack',
      channel: CHANNEL,
      threadId: thread,
      summary: 'Shadow ticket proposal.',
      reason: 'Evaluation proposal only.',
      service: 'checkout',
      severity: 'sev3',
      disposition: 'ticket',
      classificationMode: 'shadow',
      effectiveDisposition: 'investigate',
      ticket: {
        action: 'Review checkout failures.',
        safeDeferralReason: 'No confirmed impact.',
        riskIfIgnored: 'Impact may emerge.',
        reviewHorizonMinutes: 60,
      },
    });
    const route = vi.fn(async () => ({
      deduped: false,
      reused: false,
      incidentId: randomUUID(),
    }));
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => ({ decision: 'not_worthy' })),
      route,
      hub: {} as never,
      threadReader: { readThread: vi.fn(async () => []) },
      generator: {
        generate: vi.fn(async () => ({
          decision: 'new_incident',
          service: 'checkout',
          severity: 'sev3',
          title: 'Responder requested investigation',
        })),
      } as never,
      embedder: { dim: 1, embed: async () => [[0]] },
      appDb: app.db,
      redis,
      reservationRedis: redis,
      queue,
    });

    await expect(
      handler({
        id: randomUUID(),
        tenantId,
        type: 'classify',
        attempts: 1,
        payload: {
          kind: 'mention',
          channel: CHANNEL,
          rootTs: thread,
          ts: '1791000000.000301',
          user: SLACK_USER,
          text: '<@U012BOT> investigate',
          raw: { type: 'app_mention', text: '<@U012BOT> investigate' },
        },
      }),
    ).resolves.toBeUndefined();
    const rows = await admin.db
      .select()
      .from(signalDispositions)
      .where(eq(signalDispositions.id, shadow.id));
    expect(rows[0]!.incidentId).toBeNull();
    expect(route).toHaveBeenCalledOnce();
  });
});
