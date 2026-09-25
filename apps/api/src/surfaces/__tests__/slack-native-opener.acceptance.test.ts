import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  alertEpisodeIntakes,
  connectorConfigs,
  getAlertEpisodeIntake,
  inboundChannels,
  incidents,
  investigationRuns,
  jobs,
  makeDb,
  subscribeChannel,
  surfaceConfigs,
  surfaceInboundEvents,
  tenants,
  upsertSurfaceConfig,
  type DbHandle,
} from '@sre/db';
import { Queue, type JobHandler } from '@sre/queue';
import { ConversationHub } from '@sre/hub';
import { handleSlackEvent } from '../slack-inbound';
import { makeSlackInboundPipeline } from '../slack-intake';
import { makeSlackSocketManager } from '../slack-socket';
import { createEventsApiEnvelope, FakeSocketClient } from './slack-intake.acceptance.fixture';
import { nativeBlocks, seedNativeOpener } from './slack-native-opener.fixture';

const suffix = randomUUID();
const channel = 'C_NATIVE';
const tenantId = randomUUID();
const envelope = createEventsApiEnvelope(suffix);
const client = new FakeSocketClient();
const streams = ['inbound', 'classify', 'workspace'].map(
  (kind) => `test:native-echo:${suffix}:${kind}`,
);
let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let inbound: Queue;
let handler: JobHandler;
let manager: ReturnType<typeof makeSlackSocketManager>;
beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Native echo acceptance' });
  const config = await upsertSurfaceConfig(app.db, tenantId, {
    surface: 'slack',
    botUserId: 'U_PLATFORM',
    botId: 'B_PLATFORM',
    teamId: `T_${suffix}`,
    appId: `A_${suffix}`,
  });
  await subscribeChannel(app.db, { tenantId, surface: 'slack', channel, enabled: true });
  const [inboundQueue, classifyQueue, workspaceQueue] = streams.map(
    (stream) => new Queue(admin.db, redis, { stream, deadStream: `${stream}:dead`, group: suffix }),
  );
  inbound = inboundQueue!;
  await inbound.ensureGroup();
  const pipeline = makeSlackInboundPipeline({
    db: admin.db,
    queue: inbound,
    processInteraction: async () => 'dropped_no_candidate',
    processEvent: (route, body, context) =>
      handleSlackEvent(
        {
          adminDb: admin.db,
          appDb: app.db,
          hub: new ConversationHub(app.db, redis),
          redis,
          reservationRedis: redis,
          queue: workspaceQueue!,
          classifyQueue: classifyQueue!,
        },
        route.configId,
        {
          tenantId: route.tenantId,
          surface: 'slack',
          botUserId: route.botUserId ?? '',
          botId: route.botId,
        },
        body,
        context,
      ),
  });
  handler = pipeline.handler;
  manager = makeSlackSocketManager({
    listConnections: async () => [],
    resolveTeam: async (teamId, appId) =>
      teamId === `T_${suffix}` && appId === `A_${suffix}`
        ? { tenantId, configId: config.id, appId, botUserId: 'U_PLATFORM', botId: 'B_PLATFORM' }
        : undefined,
    processEvent: pipeline.acceptEvent,
    processInteraction: pipeline.acceptInteraction,
    recordDrop: pipeline.recordDrop,
    createClient: () => client,
  });
  await manager.replace(config.id, 'xapp-test', `A_${suffix}`);
});
afterAll(async () => {
  await manager?.stopAll();
  await redis?.del(...streams.flatMap((stream) => [stream, `${stream}:dead`]));
  if (admin) {
    await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await admin.db.delete(surfaceInboundEvents).where(eq(surfaceInboundEvents.tenantId, tenantId));
    await admin.db.delete(alertEpisodeIntakes).where(eq(alertEpisodeIntakes.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(inboundChannels).where(eq(inboundChannels.tenantId, tenantId));
    await admin.db.delete(surfaceConfigs).where(eq(surfaceConfigs.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  await app?.close();
  await redis?.quit();
});

test.each(['posting', 'uncertain'] as const)(
  'round-trips an owned %s echo through durable Socket intake without duplicate work',
  async (state) => {
    const ts = '1900.000001';
    const intake = await seedNativeOpener(app.db, tenantId, state, channel, ts);
    const snapshot = async () => ({
      jobs: await admin.db
        .select({ id: jobs.id, type: jobs.type })
        .from(jobs)
        .where(eq(jobs.tenantId, tenantId)),
      incidents: await admin.db
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.tenantId, tenantId)),
      runs: await admin.db
        .select({ id: investigationRuns.id })
        .from(investigationRuns)
        .where(eq(investigationRuns.tenantId, tenantId)),
    });
    const before = await snapshot();
    const message = {
      type: 'message',
      subtype: 'bot_message',
      bot_id: 'B_PLATFORM',
      ts,
      text: '[FIRING:1] Checkout errors are high',
      blocks: nativeBlocks(intake.id),
    };
    const event =
      state === 'uncertain'
        ? {
            type: 'message',
            subtype: 'message_changed',
            channel,
            event_ts: '1900.000003',
            message: { ...message, edited: { ts: '1900.000002' } },
          }
        : { ...message, channel };
    const eventId = `Ev_${randomUUID()}`;
    const ack = vi.fn(async () => undefined);
    // The earlier case's acknowledged entry stays in the stream, and publish is not awaited.
    const baseline = await redis.xlen(streams[0]!);
    await Promise.all([
      client.receive(envelope(eventId, event, ack)),
      client.receive(envelope(eventId, event, ack)),
    ]);
    expect(ack).toHaveBeenCalledTimes(2);
    const receipts = await admin.db
      .select()
      .from(surfaceInboundEvents)
      .where(sql`tenant_id = ${tenantId} and delivery_key = ${`event:${eventId}`}`);
    expect(receipts).toHaveLength(1);
    const [job] = await admin.db.select().from(jobs).where(eq(jobs.id, receipts[0]!.jobId!));
    expect(job?.payload).toMatchObject({ body: { event } });
    await vi.waitFor(async () => expect(await redis.xlen(streams[0]!)).toBeGreaterThan(baseline));
    await expect(inbound.process(`native-${suffix}`, handler)).resolves.toBe(1);
    const [receipt] = await admin.db
      .select()
      .from(surfaceInboundEvents)
      .where(eq(surfaceInboundEvents.id, receipts[0]!.id));
    expect(receipt).toMatchObject({
      state: 'processed',
      outcome: 'suppressed_native_alert_opener',
      completedAt: expect.any(Date),
    });
    const after = await snapshot();
    expect(after.incidents).toEqual(before.incidents);
    expect(after.runs).toEqual(before.runs);
    const prior = new Set(before.jobs.map((row) => row.id));
    expect(after.jobs.filter((row) => !prior.has(row.id))).toEqual([
      { id: receipts[0]!.jobId, type: 'slack.inbound' },
    ]);
    expect(await redis.xlen(streams[1]!)).toBe(0);
    expect(await redis.xlen(streams[2]!)).toBe(0);
    expect(await getAlertEpisodeIntake(app.db, tenantId, intake.id)).toEqual(intake);
  },
);
