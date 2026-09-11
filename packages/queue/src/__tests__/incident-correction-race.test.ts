import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  applySignalObservationTx,
  createIncident,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  jobs,
  lockIncidentWorkTx,
  makeDb,
  mergeIncidents,
  recordSurfaceBinding,
  splitMergedIncident,
  surfaceBindings,
  tenants,
  withTenant,
  type DbHandle,
} from '@sre/db';
import { IncidentMovedError, Queue } from '../queue';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let queue: Queue;
let tenantId: string;
const stream = `test:incident-correction:${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
  queue = new Queue(admin.db, redis, { stream, deadStream: `${stream}:dead` });
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Incident correction race tenant' });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(incidentRelations).where(eq(incidentRelations.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(surfaceBindings).where(eq(surfaceBindings.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
  if (redis) {
    await redis.del(stream, `${stream}:dead`);
    await redis.quit();
  }
});

async function correctionPair(suffix: string) {
  const source = await createIncident(app.db, tenantId, {
    fingerprint: `race-source-${suffix}`,
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev2',
    investigationStatus: 'assessed',
  });
  const target = await createIncident(app.db, tenantId, {
    fingerprint: `race-target-${suffix}`,
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev2',
    investigationStatus: 'assessed',
  });
  await recordSurfaceBinding(app.db, tenantId, {
    incidentId: source.id,
    surface: 'slack',
    channel: 'C-CORRECTION-RACE',
    threadId: `${suffix}.1`,
  });
  await recordSurfaceBinding(app.db, tenantId, {
    incidentId: target.id,
    surface: 'slack',
    channel: 'C-CORRECTION-RACE',
    threadId: `${suffix}.2`,
  });
  const signal = await withTenant(app.db, tenantId, (tx) =>
    applySignalObservationTx(tx, tenantId, {
      incidentId: source.id,
      surface: 'alertmanager',
      channel: `connector-${suffix}`,
      externalMessageId: `episode-${suffix}`,
      state: 'firing',
      summary: `Episode ${suffix}`,
      contentHash: `content-${suffix}`,
      eventKey: `event-${suffix}`,
      eventAt: new Date('2026-08-26T00:00:00Z'),
    }),
  );
  return { sourceId: source.id, targetId: target.id, signalId: signal.signal.id };
}

async function holdProducerLock(
  pair: Awaited<ReturnType<typeof correctionPair>>,
  ready: () => void,
  release: Promise<void>,
  incidentId = pair.sourceId,
) {
  return withTenant(app.db, tenantId, async (tx) => {
    await lockIncidentWorkTx(tx, tenantId, [incidentId]);
    ready();
    await release;
    return queue.insertReassessmentTx(tx, tenantId, incidentId, pair.signalId, 1);
  });
}

test('enqueue, merge, and split races preserve one consistent owner for every job', async () => {
  const producerWins = await correctionPair(randomUUID());
  let releaseProducer!: () => void;
  let producerLocked!: () => void;
  const producerHasLock = new Promise<void>((resolve) => {
    producerLocked = resolve;
  });
  const producer = holdProducerLock(
    producerWins,
    producerLocked,
    new Promise<void>((resolve) => {
      releaseProducer = resolve;
    }),
  );
  await producerHasLock;
  const losingMerge = mergeIncidents(app.db, tenantId, {
    sourceIncidentId: producerWins.sourceId,
    targetIncidentId: producerWins.targetId,
    rationale: 'Queued work wins before ownership can move.',
    evidence: ['race:producer-first'],
    decidedByUserId: randomUUID(),
  });
  releaseProducer();
  const queued = await producer;
  expect(queued.jobId).toBeTruthy();
  await expect(losingMerge).rejects.toThrow(/independent investigations to finish/i);
  await admin.db.delete(jobs).where(eq(jobs.id, queued.jobId!));

  const mergeWins = await correctionPair(randomUUID());
  let releaseMerge!: () => void;
  let mergeLocked!: () => void;
  const mergeHasLock = new Promise<void>((resolve) => {
    mergeLocked = resolve;
  });
  const winningMerge = mergeIncidents(app.db, tenantId, {
    sourceIncidentId: mergeWins.sourceId,
    targetIncidentId: mergeWins.targetId,
    rationale: 'Ownership moves before new work can queue.',
    evidence: ['race:merge-first'],
    decidedByUserId: randomUUID(),
    onCorrectedTx: async () => {
      mergeLocked();
      await new Promise<void>((resolve) => {
        releaseMerge = resolve;
      });
    },
  });
  await mergeHasLock;
  const losingEnqueue = queue.enqueue({
    tenantId,
    type: 'signal.reassess',
    payload: {
      incidentId: mergeWins.sourceId,
      signalId: mergeWins.signalId,
      signalVersion: 1,
    },
  });
  releaseMerge();
  await winningMerge;
  await expect(losingEnqueue).rejects.toBeInstanceOf(IncidentMovedError);

  const splitProducerWins = mergeWins;
  let releaseSplitProducer!: () => void;
  let splitProducerLocked!: () => void;
  const splitProducerReady = new Promise<void>((resolve) => {
    splitProducerLocked = resolve;
  });
  const splitProducer = holdProducerLock(
    splitProducerWins,
    splitProducerLocked,
    new Promise<void>((resolve) => {
      releaseSplitProducer = resolve;
    }),
    splitProducerWins.targetId,
  );
  await splitProducerReady;
  const losingSplit = splitMergedIncident(app.db, tenantId, {
    sourceIncidentId: splitProducerWins.sourceId,
    targetIncidentId: splitProducerWins.targetId,
    rationale: 'Queued work prevents ownership from splitting underneath it.',
    evidence: ['race:producer-before-split'],
    decidedByUserId: randomUUID(),
  });
  releaseSplitProducer();
  const splitQueued = await splitProducer;
  await expect(losingSplit).rejects.toThrow(/independent investigations to finish/i);
  await admin.db.delete(jobs).where(eq(jobs.id, splitQueued.jobId!));

  let releaseSplit!: () => void;
  let splitLocked!: () => void;
  const splitHasLock = new Promise<void>((resolve) => {
    splitLocked = resolve;
  });
  const winningSplit = splitMergedIncident(app.db, tenantId, {
    sourceIncidentId: splitProducerWins.sourceId,
    targetIncidentId: splitProducerWins.targetId,
    rationale: 'Split restores ownership before new source work can queue.',
    evidence: ['race:split-first'],
    decidedByUserId: randomUUID(),
    onCorrectedTx: async () => {
      splitLocked();
      await new Promise<void>((resolve) => {
        releaseSplit = resolve;
      });
    },
  });
  await splitHasLock;
  const validAfterSplit = queue.enqueue({
    tenantId,
    type: 'signal.reassess',
    payload: {
      incidentId: splitProducerWins.sourceId,
      signalId: splitProducerWins.signalId,
      signalVersion: 1,
    },
  });
  releaseSplit();
  await winningSplit;
  const validJobId = await validAfterSplit;
  expect(
    (await admin.db.select().from(jobs).where(eq(jobs.id, validJobId)))[0]?.payload,
  ).toMatchObject({ incidentId: splitProducerWins.sourceId });
}, 20_000);
