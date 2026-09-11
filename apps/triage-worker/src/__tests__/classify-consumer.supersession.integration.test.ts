import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  createIncident,
  inboundSideEffects,
  incidentMessages,
  incidentSignals,
  incidents,
  isSurfaceInboundSuperseded,
  makeDb,
  jobs,
  recordSurfaceInboundClassificationOutcome,
  setSurfaceMessageTerminalDispositionTx,
  surfaceInboundEvents,
  surfaceBindings,
  tenants,
  withSurfaceInboundMessageLock,
  withSurfaceInboundRoutingFence,
  type DbHandle,
  type Embedder,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import { makeClassifyHandler } from '../classify-consumer';
import { makeFakeClassifier } from '../engine/classify';

let admin: DbHandle;
let app: DbHandle;
const tenantId = randomUUID();

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'classification fence test' });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await admin.db.delete(surfaceInboundEvents).where(eq(surfaceInboundEvents.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(surfaceBindings).where(eq(surfaceBindings.tenantId, tenantId));
    await admin.db.delete(inboundSideEffects).where(eq(inboundSideEffects.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

test('the durable fence blocks routing when suppression commits after two stale reads', async () => {
  const channel = 'C-fence';
  const messageId = '1788000004.000100';
  const eventAt = new Date('2026-08-29T00:00:20.000Z');
  const rows = await admin.db
    .insert(surfaceInboundEvents)
    .values({
      tenantId,
      surface: 'slack',
      deliveryKey: `event:${randomUUID()}`,
      envelopeType: 'events_api',
      eventType: 'message',
      channel,
      externalMessageId: messageId,
      state: 'processed',
      outcome: 'classify_enqueued',
    })
    .returning({ id: surfaceInboundEvents.id });
  const route = vi.fn(async () => ({ deduped: false }));
  let reads = 0;
  const redis = {
    set: vi.fn(),
    get: vi.fn(async () => null),
    eval: vi.fn(async () => 1),
  } as unknown as Redis;
  const classify = vi.fn(() => ({
    decision: 'new_incident' as const,
    service: 'checkout',
    severity: 'sev2' as const,
    title: 'Checkout errors are high',
  }));
  const handler = makeClassifyHandler({
    classify: makeFakeClassifier(classify),
    route,
    appDb: app.db,
    redis,
    reservationRedis: redis,
    queue: {} as Queue,
    embedder: {
      dim: 1,
      embed: async (texts) => texts.map(() => [0]),
    } as Embedder,
    isIntakeSuperseded: async (
      currentTenantId,
      intakeId,
      candidateEventAt,
      candidateEventVersion,
    ) => {
      const superseded = await isSurfaceInboundSuperseded(
        admin.db,
        currentTenantId,
        intakeId,
        candidateEventAt,
        candidateEventVersion,
      );
      reads += 1;
      if (reads === 2)
        await withSurfaceInboundMessageLock(
          admin.db,
          { tenantId, surface: 'slack', channel, externalMessageId: messageId },
          (tx) =>
            setSurfaceMessageTerminalDispositionTx(tx, {
              tenantId,
              surface: 'slack',
              channel,
              externalMessageId: messageId,
              disposition: 'suppressed_provider_control_notification',
              eventAt,
            }),
        );
      return superseded;
    },
    withIntakeRoutingFence: (
      currentTenantId,
      intakeId,
      candidateEventAt,
      candidateEventVersion,
      identity,
      fn,
    ) =>
      withSurfaceInboundRoutingFence(
        admin.db,
        {
          tenantId: currentTenantId,
          intakeId,
          eventAt: candidateEventAt,
          eventVersion: candidateEventVersion,
          ...identity,
        },
        fn,
      ),
    onOutcome: async (outcome) => {
      if (outcome.intakeId)
        await recordSurfaceInboundClassificationOutcome(
          admin.db,
          outcome.tenantId,
          outcome.intakeId,
          outcome.outcome,
        );
    },
  });

  await expect(
    handler({
      id: randomUUID(),
      tenantId,
      type: 'classify',
      attempts: 1,
      payload: {
        intakeId: rows[0]!.id,
        externalId: messageId,
        channel,
        author: 'bot',
        text: 'Checkout errors are high',
        raw: null,
        signalState: 'firing',
        alertKind: 'firing',
        eventKey: `slack:${channel}:${messageId}`,
        eventAt: eventAt.toISOString(),
        contentHash: 'checkout-errors',
        isEdit: false,
      },
    }),
  ).resolves.toBeUndefined();
  expect(reads).toBe(2);
  expect(route).not.toHaveBeenCalled();
  await expect(
    admin.db
      .select({ outcome: surfaceInboundEvents.classificationOutcome })
      .from(surfaceInboundEvents)
      .where(eq(surfaceInboundEvents.id, rows[0]!.id)),
  ).resolves.toEqual([{ outcome: 'superseded' }]);
});

test('a queued pre-migration receipt repairs its missing identity and routes once', async () => {
  const channel = 'C-legacy-fence';
  const messageId = '1788000005.000100';
  const eventAt = new Date('2026-08-29T00:00:30.000Z');
  const rows = await admin.db
    .insert(surfaceInboundEvents)
    .values({
      tenantId,
      surface: 'slack',
      deliveryKey: `event:${randomUUID()}`,
      envelopeType: 'events_api',
      eventType: 'message',
      channel,
      externalMessageId: null,
      state: 'processed',
      outcome: 'classify_enqueued',
    })
    .returning({ id: surfaceInboundEvents.id });
  const route = vi.fn(async () => ({ deduped: false }));
  const redis = {
    set: vi.fn(),
    get: vi.fn(async () => null),
    eval: vi.fn(async () => 1),
  } as unknown as Redis;
  const classify = vi.fn(() => ({
    decision: 'new_incident' as const,
    service: 'checkout',
    severity: 'sev2' as const,
    title: 'Checkout errors are high',
  }));
  const handler = makeClassifyHandler({
    classify: makeFakeClassifier(classify),
    route,
    appDb: app.db,
    redis,
    reservationRedis: redis,
    queue: {} as Queue,
    embedder: { dim: 1, embed: async (texts) => texts.map(() => [0]) } as Embedder,
    isIntakeSuperseded: (currentTenantId, intakeId, candidateEventAt, candidateEventVersion) =>
      isSurfaceInboundSuperseded(
        admin.db,
        currentTenantId,
        intakeId,
        candidateEventAt,
        candidateEventVersion,
      ),
    withIntakeRoutingFence: (
      currentTenantId,
      intakeId,
      candidateEventAt,
      candidateEventVersion,
      identity,
      fn,
    ) =>
      withSurfaceInboundRoutingFence(
        admin.db,
        {
          tenantId: currentTenantId,
          intakeId,
          eventAt: candidateEventAt,
          eventVersion: candidateEventVersion,
          ...identity,
        },
        fn,
      ),
    onOutcome: async (outcome) => {
      if (outcome.intakeId)
        await recordSurfaceInboundClassificationOutcome(
          admin.db,
          outcome.tenantId,
          outcome.intakeId,
          outcome.outcome,
        );
    },
  });

  const job = {
    id: randomUUID(),
    tenantId,
    type: 'classify',
    attempts: 1,
    payload: {
      intakeId: rows[0]!.id,
      externalId: messageId,
      channel,
      author: 'bot',
      text: 'Checkout errors are high',
      raw: null,
      signalState: 'firing',
      alertKind: 'firing',
      eventKey: `slack:${channel}:${messageId}`,
      eventAt: eventAt.toISOString(),
      contentHash: 'checkout-errors-legacy',
      isEdit: false,
    },
  } as const;
  await handler(job);
  await handler({ ...job, attempts: 2 });

  expect(route).toHaveBeenCalledTimes(1);
  expect(classify).toHaveBeenCalledTimes(1);
  await expect(
    admin.db
      .select({
        externalMessageId: surfaceInboundEvents.externalMessageId,
        outcome: surfaceInboundEvents.classificationOutcome,
      })
      .from(surfaceInboundEvents)
      .where(eq(surfaceInboundEvents.id, rows[0]!.id)),
  ).resolves.toEqual([{ externalMessageId: messageId, outcome: 'new_incident' }]);
});

test('post-commit delivery loss still commits the routing marker and prevents model replay', async () => {
  const channel = 'C-post-commit-fence';
  const messageId = '1788000006.000100';
  const eventAt = new Date('2026-08-29T00:00:40.000Z');
  await createIncident(app.db, tenantId, {
    fingerprint: `post-commit-fence-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev2',
    title: 'Checkout incident',
  });
  const rows = await admin.db
    .insert(surfaceInboundEvents)
    .values({
      tenantId,
      surface: 'slack',
      deliveryKey: `event:${randomUUID()}`,
      envelopeType: 'events_api',
      eventType: 'message',
      channel,
      externalMessageId: messageId,
      state: 'processed',
      outcome: 'classify_enqueued',
    })
    .returning({ id: surfaceInboundEvents.id });
  const publishError = new Error('Valkey unavailable');
  const publishRedis = {
    publish: vi.fn(async () => {
      throw publishError;
    }),
  } as unknown as Redis;
  const hub = new ConversationHub(app.db, {} as Redis, publishRedis);
  const publishJob = vi.fn(async () => {
    throw publishError;
  });
  const queue = {
    insertReassessmentTx: vi.fn(async () => ({ jobId: randomUUID() })),
    publishJob,
  } as unknown as Queue;
  const reservationRedis = {
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    eval: vi.fn(async () => {
      throw publishError;
    }),
  } as unknown as Redis;
  const classify = vi.fn(() => ({ decision: 'belongs_to' as const, index: 1 }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const handler = makeClassifyHandler({
    classify: makeFakeClassifier(classify),
    appDb: app.db,
    redis: reservationRedis,
    reservationRedis,
    queue,
    hub,
    embedder: { dim: 1, embed: async (texts) => texts.map(() => [0]) } as Embedder,
    isIntakeSuperseded: (currentTenantId, intakeId, candidateEventAt, candidateEventVersion) =>
      isSurfaceInboundSuperseded(
        admin.db,
        currentTenantId,
        intakeId,
        candidateEventAt,
        candidateEventVersion,
      ),
    withIntakeRoutingFence: (
      currentTenantId,
      intakeId,
      candidateEventAt,
      candidateEventVersion,
      identity,
      fn,
    ) =>
      withSurfaceInboundRoutingFence(
        admin.db,
        {
          tenantId: currentTenantId,
          intakeId,
          eventAt: candidateEventAt,
          eventVersion: candidateEventVersion,
          ...identity,
        },
        fn,
      ),
    onOutcome: async (outcome) => {
      if (outcome.intakeId)
        await recordSurfaceInboundClassificationOutcome(
          admin.db,
          outcome.tenantId,
          outcome.intakeId,
          outcome.outcome,
        );
    },
  });
  const job = {
    id: randomUUID(),
    tenantId,
    type: 'classify',
    attempts: 1,
    payload: {
      intakeId: rows[0]!.id,
      externalId: messageId,
      channel,
      author: 'bot',
      text: 'Checkout errors are high',
      raw: null,
      signalState: 'firing',
      alertKind: 'firing',
      eventKey: `slack:${channel}:${messageId}:producer:bot:B_ALERT`,
      eventAt: eventAt.toISOString(),
      contentHash: 'checkout-errors-post-commit',
      isEdit: false,
    },
  } as const;

  let warningLines: string[] = [];
  try {
    await expect(handler(job)).resolves.toBeUndefined();
    await expect(handler({ ...job, attempts: 2 })).resolves.toBeUndefined();
  } finally {
    warningLines = warn.mock.calls.flat().map(String);
    warn.mockRestore();
  }

  expect(classify).toHaveBeenCalledTimes(1);
  expect(publishRedis.publish).toHaveBeenCalled();
  expect(publishJob).toHaveBeenCalled();
  expect(reservationRedis.eval).toHaveBeenCalledTimes(2);
  expect(warningLines.join('\n')).toContain('classify.reservation_update_failed');
  await expect(isSurfaceInboundSuperseded(admin.db, tenantId, rows[0]!.id, eventAt)).resolves.toBe(
    true,
  );
});

test('dedup cache loss routes durably and does not replay the model', async () => {
  const channel = 'C-dedup-fence';
  const messageId = '1788000007.000100';
  const eventAt = new Date('2026-08-29T00:00:50.000Z');
  const rows = await admin.db
    .insert(surfaceInboundEvents)
    .values({
      tenantId,
      surface: 'slack',
      deliveryKey: `event:${randomUUID()}`,
      envelopeType: 'events_api',
      eventType: 'message',
      channel,
      externalMessageId: messageId,
      state: 'processed',
      outcome: 'classify_enqueued',
    })
    .returning({ id: surfaceInboundEvents.id });
  const unavailable = new Error('Valkey unavailable');
  const reservationRedis = {
    set: vi.fn(async () => {
      throw unavailable;
    }),
    del: vi.fn(async () => 0),
    eval: vi.fn(async () => 1),
  } as unknown as Redis;
  const dispatchRedis = {
    xadd: vi.fn(async () => {
      throw unavailable;
    }),
  } as unknown as Redis;
  const publishRedis = {
    publish: vi.fn(async () => {
      throw unavailable;
    }),
  } as unknown as Redis;
  const queue = new Queue(admin.db, {} as Redis, {
    stream: `test:classify-dedup-fence:${randomUUID()}`,
    dispatchRedis,
  });
  const hub = new ConversationHub(app.db, {} as Redis, publishRedis);
  const classify = vi.fn(() => ({
    decision: 'new_incident' as const,
    service: 'checkout',
    severity: 'sev2' as const,
    title: 'Checkout errors are high',
  }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const handler = makeClassifyHandler({
    classify: makeFakeClassifier(classify),
    appDb: app.db,
    redis: reservationRedis,
    reservationRedis,
    queue,
    hub,
    embedder: { dim: 1, embed: async (texts) => texts.map(() => [0]) } as Embedder,
    isIntakeSuperseded: (currentTenantId, intakeId, candidateEventAt, candidateEventVersion) =>
      isSurfaceInboundSuperseded(
        admin.db,
        currentTenantId,
        intakeId,
        candidateEventAt,
        candidateEventVersion,
      ),
    withIntakeRoutingFence: (
      currentTenantId,
      intakeId,
      candidateEventAt,
      candidateEventVersion,
      identity,
      fn,
    ) =>
      withSurfaceInboundRoutingFence(
        admin.db,
        {
          tenantId: currentTenantId,
          intakeId,
          eventAt: candidateEventAt,
          eventVersion: candidateEventVersion,
          ...identity,
        },
        fn,
      ),
    onOutcome: async (outcome) => {
      if (outcome.intakeId)
        await recordSurfaceInboundClassificationOutcome(
          admin.db,
          outcome.tenantId,
          outcome.intakeId,
          outcome.outcome,
        );
    },
  });
  const job = {
    id: randomUUID(),
    tenantId,
    type: 'classify',
    attempts: 1,
    payload: {
      intakeId: rows[0]!.id,
      externalId: messageId,
      channel,
      author: 'bot',
      text: 'Checkout errors are high',
      raw: null,
      signalState: 'firing',
      alertKind: 'firing',
      eventKey: `slack:${channel}:${messageId}:producer:bot:B_ALERT`,
      eventAt: eventAt.toISOString(),
      contentHash: 'checkout-errors-dedup-down',
      isEdit: false,
    },
  } as const;

  try {
    await expect(handler(job)).resolves.toBeUndefined();
    await expect(handler({ ...job, attempts: 2 })).resolves.toBeUndefined();
  } finally {
    warn.mockRestore();
  }

  expect(classify).toHaveBeenCalledTimes(1);
  expect(reservationRedis.set).toHaveBeenCalledTimes(1);
  expect(reservationRedis.del).not.toHaveBeenCalled();
  await expect(isSurfaceInboundSuperseded(admin.db, tenantId, rows[0]!.id, eventAt)).resolves.toBe(
    true,
  );
});
