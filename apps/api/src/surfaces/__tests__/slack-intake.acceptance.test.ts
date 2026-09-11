import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  incidentMessages,
  incidentSignals,
  inboundSideEffects,
  inboundChannels,
  incidents,
  jobs,
  makeDb,
  subscribeChannel,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  surfaceInboundEvents,
  tenants,
  upsertSurfaceConfig,
  EMBED_DIM,
  type DbHandle,
  type Embedder,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue, type JobHandler } from '@sre/queue';
import { SLACK_CLASSIFY_TERMINAL, slackClassifyReservationKey } from '@sre/connectors';
import { makeClassifyHandler } from '../../../../triage-worker/src/classify-consumer';
import { makeSlackIntakeStateDeps } from '../../../../triage-worker/src/classify-consumer/intake-state';
import { makeFakeClassifier } from '../../../../triage-worker/src/engine/classify';
import { handleSlackEvent, type SlackInboundDeps } from '../slack-inbound';
import { makeSlackInboundPipeline } from '../slack-intake';
import { makeSlackSocketManager } from '../slack-socket';
import { createEventsApiEnvelope, FakeSocketClient } from './slack-intake.acceptance.fixture';

const suffix = randomUUID().slice(0, 8);
const inboundStream = `test:slack-intake:${suffix}`;
const inboundDeadStream = `${inboundStream}:dead`;
const workspaceStream = `test:slack-workspace:${suffix}`;
const workspaceDeadStream = `${workspaceStream}:dead`;
const classifyStream = `test:slack-classify:${suffix}`;
const classifyDeadStream = `${classifyStream}:dead`;
const channel = 'C_ALERTS';
const eventsApiEnvelope = createEventsApiEnvelope(suffix);

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let inboundQueue: Queue;
let workspaceQueue: Queue;
let classifyQueue: Queue;
let tenantId: string;
let configId: string;
let client: FakeSocketClient;
let manager: ReturnType<typeof makeSlackSocketManager>;
let intakeHandler: JobHandler;
let classifyHandler: JobHandler;
let classifyInvocations = 0;
let slackDeps: SlackInboundDeps;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
  inboundQueue = new Queue(admin.db, redis, {
    stream: inboundStream,
    deadStream: inboundDeadStream,
    group: `slack-intake-${suffix}`,
  });
  workspaceQueue = new Queue(admin.db, redis, {
    stream: workspaceStream,
    deadStream: workspaceDeadStream,
    group: `slack-workspace-${suffix}`,
  });
  classifyQueue = new Queue(admin.db, redis, {
    stream: classifyStream,
    deadStream: classifyDeadStream,
    group: `slack-classify-${suffix}`,
  });
  await Promise.all([inboundQueue.ensureGroup(), classifyQueue.ensureGroup()]);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: `Slack intake ${suffix}` });
  const config = await upsertSurfaceConfig(app.db, tenantId, {
    surface: 'slack',
    botUserId: 'U_PLATFORM',
    botId: 'B_PLATFORM',
    teamId: `T_${suffix}`,
    appId: `A_${suffix}`,
  });
  configId = config.id;
  await subscribeChannel(app.db, {
    tenantId,
    surface: 'slack',
    channel,
    enabled: true,
  });

  const hub = new ConversationHub(app.db, redis);
  slackDeps = {
    adminDb: admin.db,
    appDb: app.db,
    hub,
    queue: workspaceQueue,
    classifyQueue,
    redis,
    reservationRedis: redis,
  };

  const pipeline = makeSlackInboundPipeline({
    db: admin.db,
    queue: inboundQueue,
    processInteraction: async () => 'dropped_no_candidate',
    processEvent: (route, body, context) =>
      handleSlackEvent(
        slackDeps,
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
  intakeHandler = pipeline.handler;
  const embedder: Embedder = {
    dim: EMBED_DIM,
    embed: async (texts) => texts.map(() => Array.from({ length: EMBED_DIM }, () => 0)),
  };
  classifyHandler = makeClassifyHandler({
    classify: makeFakeClassifier((_candidate, candidates) => {
      classifyInvocations++;
      return candidates.length > 0
        ? { decision: 'belongs_to', index: 1 }
        : {
            decision: 'new_incident',
            service: 'checkout',
            severity: 'sev2',
            title: 'Checkout errors are high',
          };
    }),
    appDb: app.db,
    redis,
    reservationRedis: redis,
    queue: workspaceQueue,
    hub,
    embedder,
    ...makeSlackIntakeStateDeps(admin.db, admin.db),
  });
  client = new FakeSocketClient();
  manager = makeSlackSocketManager({
    listConnections: async () => [],
    resolveTeam: async (teamId, appId) =>
      teamId === `T_${suffix}` && appId === `A_${suffix}`
        ? {
            tenantId,
            configId,
            appId,
            botUserId: 'U_PLATFORM',
            botId: 'B_PLATFORM',
          }
        : undefined,
    processEvent: pipeline.acceptEvent,
    processInteraction: pipeline.acceptInteraction,
    recordDrop: pipeline.recordDrop,
    createClient: () => client,
  });
  await manager.replace(configId, 'xapp-test', `A_${suffix}`);
}, 30_000);

afterAll(async () => {
  await manager?.stopAll();
  await redis?.del(
    inboundStream,
    inboundDeadStream,
    workspaceStream,
    workspaceDeadStream,
    classifyStream,
    classifyDeadStream,
  );
  if (admin) {
    await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await admin.db.delete(surfaceInboundEvents).where(eq(surfaceInboundEvents.tenantId, tenantId));
    await admin.db.delete(surfaceDeliveries).where(eq(surfaceDeliveries.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(inboundSideEffects).where(eq(inboundSideEffects.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(surfaceBindings).where(eq(surfaceBindings.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(inboundChannels).where(eq(inboundChannels.tenantId, tenantId));
    await admin.db.delete(surfaceConfigs).where(eq(surfaceConfigs.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  await app?.close();
  await redis?.quit();
});

describe('Slack Socket intake acceptance', () => {
  test('runs subscribed Slack alerts through durable intake, classification, incident binding, and correlation', async () => {
    const eventId = `Ev_${randomUUID()}`;
    const threadTs = `1788000000.${String(Date.now()).slice(-6)}`;
    const ack = vi.fn(async () => undefined);
    await client.receive(
      eventsApiEnvelope(
        eventId,
        {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B_ALERTMANAGER',
          channel,
          ts: threadTs,
          text: '[FIRING:1] Checkout errors are high',
        },
        ack,
      ),
    );

    expect(ack).toHaveBeenCalledTimes(1);
    const accepted = await admin.db
      .select()
      .from(surfaceInboundEvents)
      .where(sql`tenant_id = ${tenantId} and delivery_key = ${`event:${eventId}`}`);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ state: 'queued', configId, jobId: expect.any(String) });
    expect(
      await admin.db.select().from(incidents).where(eq(incidents.tenantId, tenantId)),
    ).toHaveLength(0);

    await vi.waitFor(async () => expect(await redis.xlen(inboundStream)).toBeGreaterThan(0));
    await expect(inboundQueue.process(`acceptance-${suffix}`, intakeHandler)).resolves.toBe(1);
    const terminal = await admin.db
      .select()
      .from(surfaceInboundEvents)
      .where(eq(surfaceInboundEvents.id, accepted[0]!.id));
    expect(terminal[0]).toMatchObject({
      state: 'processed',
      outcome: 'classify_enqueued',
      completedAt: expect.any(Date),
    });
    expect(
      await admin.db.select().from(incidents).where(eq(incidents.tenantId, tenantId)),
    ).toHaveLength(0);
    await vi.waitFor(async () => expect(await redis.xlen(classifyStream)).toBeGreaterThan(0));
    await expect(classifyQueue.process(`classify-${suffix}`, classifyHandler)).resolves.toBe(1);

    const classified = await admin.db
      .select()
      .from(surfaceInboundEvents)
      .where(eq(surfaceInboundEvents.id, accepted[0]!.id));
    expect(classified[0]).toMatchObject({
      classificationOutcome: 'new_incident',
      classificationUpdatedAt: expect.any(Date),
    });

    const opened = await admin.db.select().from(incidents).where(eq(incidents.tenantId, tenantId));
    expect(opened).toHaveLength(1);
    const bindings = await admin.db
      .select()
      .from(surfaceBindings)
      .where(
        sql`tenant_id = ${tenantId} and incident_id = ${opened[0]!.id} and channel = ${channel} and thread_id = ${threadTs}`,
      );
    expect(bindings).toEqual([expect.objectContaining({ role: 'primary' })]);
    const inboundJob = await admin.db.select().from(jobs).where(eq(jobs.id, accepted[0]!.jobId!));
    expect(inboundJob[0]?.status).toBe('done');

    const inboundLengthBefore = await redis.xlen(inboundStream);
    const classifyLengthBefore = await redis.xlen(classifyStream);
    const correlatedEventId = `Ev_${randomUUID()}`;
    const correlatedThreadTs = `1788000001.${String(Date.now()).slice(-6)}`;
    await client.receive(
      eventsApiEnvelope(correlatedEventId, {
        type: 'message',
        subtype: 'bot_message',
        bot_id: 'B_ALERTMANAGER',
        channel,
        ts: correlatedThreadTs,
        text: '[FIRING:1] Checkout latency is high and related',
      }),
    );
    await vi.waitFor(async () => {
      const row = await admin.db
        .select()
        .from(surfaceInboundEvents)
        .where(sql`tenant_id = ${tenantId} and delivery_key = ${`event:${correlatedEventId}`}`);
      expect(row[0]?.state).toBe('queued');
    });
    await vi.waitFor(async () =>
      expect(await redis.xlen(inboundStream)).toBeGreaterThan(inboundLengthBefore),
    );
    await expect(inboundQueue.process(`acceptance-${suffix}`, intakeHandler)).resolves.toBe(1);
    await vi.waitFor(async () =>
      expect(await redis.xlen(classifyStream)).toBeGreaterThan(classifyLengthBefore),
    );
    await expect(classifyQueue.process(`classify-${suffix}`, classifyHandler)).resolves.toBe(1);

    const correlatedReceipt = await admin.db
      .select()
      .from(surfaceInboundEvents)
      .where(sql`tenant_id = ${tenantId} and delivery_key = ${`event:${correlatedEventId}`}`);
    expect(correlatedReceipt[0]).toMatchObject({
      classificationOutcome: 'belongs_to',
      classificationUpdatedAt: expect.any(Date),
    });

    expect(
      await admin.db.select().from(incidents).where(eq(incidents.tenantId, tenantId)),
    ).toHaveLength(1);
    const sourceBindings = await admin.db
      .select()
      .from(surfaceBindings)
      .where(
        sql`tenant_id = ${tenantId} and incident_id = ${opened[0]!.id} and channel = ${channel} and thread_id = ${correlatedThreadTs}`,
      );
    expect(sourceBindings).toEqual([
      expect.objectContaining({ role: 'primary', projectionMode: 'full' }),
    ]);
    const previousBindings = await admin.db
      .select()
      .from(surfaceBindings)
      .where(
        sql`tenant_id = ${tenantId} and incident_id = ${opened[0]!.id} and channel = ${channel} and thread_id = ${threadTs}`,
      );
    expect(previousBindings).toEqual([
      expect.objectContaining({ role: 'source', projectionMode: 'status' }),
    ]);
    const relationships = await admin.db
      .select()
      .from(incidentMessages)
      .where(
        sql`tenant_id = ${tenantId} and incident_id = ${opened[0]!.id} and kind = 'relationship'`,
      );
    expect(relationships).toEqual([]);
  });

  test('records a typed control suppression without classification, incident, or LLM work', async () => {
    const eventId = `Ev_${randomUUID()}`;
    const messageId = `1788000002.${String(Date.now()).slice(-6)}`;
    const incidentCountBefore = (
      await admin.db.select().from(incidents).where(eq(incidents.tenantId, tenantId))
    ).length;
    const classifyLengthBefore = await redis.xlen(classifyStream);
    const workspaceLengthBefore = await redis.xlen(workspaceStream);
    const inboundLengthBefore = await redis.xlen(inboundStream);
    const jobsBefore = await admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.tenantId, tenantId));
    const originalReservationRedis = slackDeps.reservationRedis;
    const originalOnError = slackDeps.onError;
    const cacheError = new Error('reservation cache unavailable');
    const errors: unknown[] = [];
    slackDeps.reservationRedis = {
      eval: vi.fn(async () => {
        throw cacheError;
      }),
    } as unknown as Redis;
    slackDeps.onError = (error) => errors.push(error);
    try {
      await client.receive(
        eventsApiEnvelope(eventId, {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B_ALERTMANAGER',
          channel,
          ts: messageId,
          text: '',
          attachments: [
            {
              fallback:
                '[FIRING:1] InfoInhibitor monitoring | <https://alerts.example/#/alerts?receiver=default>',
              text: [
                '*Alert:* Informational alert inhibition.',
                '*Description:* Provider-maintained inhibition state.',
                '*Severity:* `none`',
                '*Source:* Prometheus Alertmanager',
              ].join(' '),
            },
          ],
        }),
      );
      await vi.waitFor(async () => {
        const rows = await admin.db
          .select()
          .from(surfaceInboundEvents)
          .where(sql`tenant_id = ${tenantId} and delivery_key = ${`event:${eventId}`}`);
        expect(rows[0]?.state).toBe('queued');
      });
      await vi.waitFor(async () =>
        expect(await redis.xlen(inboundStream)).toBeGreaterThan(inboundLengthBefore),
      );
      await expect(inboundQueue.process(`control-${suffix}`, intakeHandler)).resolves.toBe(1);
    } finally {
      slackDeps.reservationRedis = originalReservationRedis;
      slackDeps.onError = originalOnError;
    }

    const receipts = await admin.db
      .select()
      .from(surfaceInboundEvents)
      .where(sql`tenant_id = ${tenantId} and delivery_key = ${`event:${eventId}`}`);
    expect(receipts).toEqual([
      expect.objectContaining({
        state: 'processed',
        outcome: 'suppressed_provider_control_notification',
        classificationOutcome: 'superseded',
        terminalDisposition: 'suppressed_provider_control_notification',
        terminalDispositionAt: expect.any(Date),
        terminalDispositionEventAt: expect.any(Date),
        completedAt: expect.any(Date),
      }),
    ]);
    expect(await redis.xlen(classifyStream)).toBe(classifyLengthBefore);
    expect(await redis.xlen(workspaceStream)).toBe(workspaceLengthBefore);
    const priorJobIds = new Set(jobsBefore.map((row) => row.id));
    const newJobs = (
      await admin.db
        .select({ id: jobs.id, type: jobs.type })
        .from(jobs)
        .where(eq(jobs.tenantId, tenantId))
    ).filter((row) => !priorJobIds.has(row.id));
    expect(newJobs).toEqual([{ id: expect.any(String), type: 'slack.inbound' }]);
    expect(errors).toEqual([cacheError]);
    expect(
      await admin.db.select().from(incidents).where(eq(incidents.tenantId, tenantId)),
    ).toHaveLength(incidentCountBefore);

    const reservationKey = slackClassifyReservationKey(tenantId, channel, messageId);
    await redis.del(reservationKey);
    const actionableEventId = `Ev_${randomUUID()}`;
    const actionableAt = '1788000020.000100';
    const callsBeforeActionable = classifyInvocations;
    const actionableInboundLengthBefore = await redis.xlen(inboundStream);
    await client.receive(
      eventsApiEnvelope(actionableEventId, {
        type: 'message',
        subtype: 'message_changed',
        channel,
        event_ts: actionableAt,
        message: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B_ALERTMANAGER',
          ts: messageId,
          edited: { ts: actionableAt },
          text: '[FIRING:1] checkout errors | *Alert:* Checkout errors are high. *Severity:* critical',
        },
      }),
    );
    await vi.waitFor(async () =>
      expect(
        await admin.db
          .select()
          .from(surfaceInboundEvents)
          .where(sql`delivery_key = ${`event:${actionableEventId}`}`),
      ).toHaveLength(1),
    );
    await vi.waitFor(async () =>
      expect(await redis.xlen(inboundStream)).toBeGreaterThan(actionableInboundLengthBefore),
    );
    await expect(inboundQueue.process(`reactivate-${suffix}`, intakeHandler)).resolves.toBe(1);
    await expect(classifyQueue.process(`reactivate-${suffix}`, classifyHandler)).resolves.toBe(1);

    const corrected = await admin.db
      .select()
      .from(surfaceInboundEvents)
      .where(
        sql`tenant_id = ${tenantId} and channel = ${channel} and external_message_id = ${messageId}`,
      );
    expect(corrected).toHaveLength(2);
    expect(corrected.every((row) => row.terminalDisposition === null)).toBe(true);
    expect(corrected.find((row) => row.deliveryKey === `event:${actionableEventId}`)).toMatchObject(
      {
        classificationOutcome: expect.stringMatching(/^(?:new_incident|belongs_to)$/),
        terminalDispositionEventAt: new Date(Number(actionableAt) * 1000),
      },
    );
    expect(await redis.get(reservationKey)).toBe(SLACK_CLASSIFY_TERMINAL);
    expect(classifyInvocations).toBe(callsBeforeActionable + 1);
  });

  test('a control edit durably supersedes an already queued root before classification', async () => {
    const messageId = `1788000003.${String(Date.now()).slice(-6)}`;
    const rootEventId = `Ev_${randomUUID()}`;
    const inboundLengthBefore = await redis.xlen(inboundStream);
    const incidentCountBefore = (
      await admin.db.select().from(incidents).where(eq(incidents.tenantId, tenantId))
    ).length;
    await client.receive(
      eventsApiEnvelope(rootEventId, {
        type: 'message',
        subtype: 'bot_message',
        bot_id: 'B_ALERTMANAGER',
        channel,
        ts: messageId,
        text: '[FIRING:1] checkout errors | *Alert:* Checkout errors are high. *Severity:* critical',
      }),
    );
    await vi.waitFor(async () => {
      expect(
        await admin.db
          .select()
          .from(surfaceInboundEvents)
          .where(sql`delivery_key = ${`event:${rootEventId}`}`),
      ).toHaveLength(1);
    });
    await vi.waitFor(async () =>
      expect(await redis.xlen(inboundStream)).toBeGreaterThan(inboundLengthBefore),
    );
    await expect(inboundQueue.process(`root-${suffix}`, intakeHandler)).resolves.toBe(1);

    const editEventId = `Ev_${randomUUID()}`;
    const editInboundLengthBefore = await redis.xlen(inboundStream);
    await client.receive(
      eventsApiEnvelope(editEventId, {
        type: 'message',
        subtype: 'message_changed',
        channel,
        event_ts: '1788000010.000100',
        message: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B_ALERTMANAGER',
          ts: messageId,
          text: '*Alert:* InfoInhibitor',
          edited: { ts: '1788000010.000100' },
          attachments: [
            {
              fields: [
                { title: 'Severity', value: 'none' },
                { title: 'Receiver', value: 'null' },
              ],
            },
          ],
        },
      }),
    );
    await vi.waitFor(async () => {
      expect(
        await admin.db
          .select()
          .from(surfaceInboundEvents)
          .where(sql`delivery_key = ${`event:${editEventId}`}`),
      ).toHaveLength(1);
    });
    await vi.waitFor(async () =>
      expect(await redis.xlen(inboundStream)).toBeGreaterThan(editInboundLengthBefore),
    );
    await expect(inboundQueue.process(`edit-${suffix}`, intakeHandler)).resolves.toBe(1);

    const callsBefore = classifyInvocations;
    await expect(
      classifyQueue.process(`classify-suppressed-${suffix}`, classifyHandler),
    ).resolves.toBe(1);
    const receipts = await admin.db
      .select()
      .from(surfaceInboundEvents)
      .where(
        sql`tenant_id = ${tenantId} and channel = ${channel} and external_message_id = ${messageId}`,
      );
    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.terminalDisposition !== null)).toBe(true);
    expect(
      receipts.find((receipt) => receipt.deliveryKey === `event:${rootEventId}`),
    ).toMatchObject({
      classificationOutcome: 'superseded',
    });
    expect(classifyInvocations).toBe(callsBefore);
    expect(
      await admin.db.select().from(incidents).where(eq(incidents.tenantId, tenantId)),
    ).toHaveLength(incidentCountBefore);
  });
});
