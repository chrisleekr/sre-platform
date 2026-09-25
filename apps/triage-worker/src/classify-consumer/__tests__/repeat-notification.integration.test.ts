import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  applySignalObservation,
  createIncident,
  inboundSideEffects,
  incidentMessages,
  incidentSignals,
  incidents,
  makeDb,
  signalDispositions,
  surfaceBindings,
  tenantSignalPolicies,
  tenants,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import type { Queue } from '@sre/queue';
import type { InboundCandidate } from '@sre/connectors';
import { makeClassifyHandler } from '../../classify-consumer';
import { makeFakeClassifier } from '../../engine/classify';
import { RepeatNotifications } from '../repeats';

const PRODUCER = 'bot:B_ALERTS';
const CHANNEL = 'C-REPEAT';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let hub: ConversationHub;
const tenantId = randomUUID();
// Same channel, producer and monitor identities as the home tenant, so only RLS separates them.
const foreignTenantId = randomUUID();

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
  hub = new ConversationHub(app.db, redis);
  await admin.db.insert(tenants).values([
    { id: tenantId, name: 'repeat-notification' },
    { id: foreignTenantId, name: 'repeat-notification-foreign' },
  ]);
});

afterAll(async () => {
  if (admin) {
    const scoped = sql`tenant_id in (${tenantId}, ${foreignTenantId})`;
    await admin.db.delete(signalDispositions).where(scoped);
    await admin.db.delete(incidentMessages).where(scoped);
    await admin.db.delete(inboundSideEffects).where(scoped);
    await admin.db.delete(surfaceBindings).where(scoped);
    await admin.db.delete(incidentSignals).where(scoped);
    await admin.db.delete(incidents).where(scoped);
    await admin.db.delete(tenantSignalPolicies).where(scoped);
    await admin.db.delete(tenants).where(sql`id in (${tenantId}, ${foreignTenantId})`);
    await admin.close();
  }
  if (app) await app.close();
  if (redis) await redis.quit();
});

/** Opens one incident tracking one advisory Slack signal for the monitor. */
async function trackedIncident(monitorKey: string, lastSeenAt = new Date(), owner = tenantId) {
  const incident = await createIncident(app.db, owner, {
    fingerprint: `repeat-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
  });
  const root = `root-${randomUUID()}`;
  const observed = await applySignalObservation(app.db, owner, {
    incidentId: incident.id,
    surface: 'slack',
    channel: CHANNEL,
    externalMessageId: root,
    state: 'unknown',
    summary: 'Checkout error rate is high.',
    contentHash: 'firing',
    monitorKey,
    eventKey: `slack:${CHANNEL}:${root}:producer:${PRODUCER}`,
    eventAt: lastSeenAt,
  });
  return { incidentId: incident.id, signalId: observed.signal.id };
}

function firingCandidate(...monitorKeys: string[]): InboundCandidate {
  const externalId = `repeat-${randomUUID()}`;
  const eventKey = `slack:${CHANNEL}:${externalId}:producer:${PRODUCER}`;
  const text = `[FIRING:${monitorKeys.length}] Checkout error rate is high.`;
  const eventAt = new Date().toISOString();
  const grouped = monitorKeys.length > 1;
  return {
    externalId,
    channel: CHANNEL,
    author: 'bot',
    producerId: PRODUCER,
    text,
    raw: { ts: externalId, text },
    signalState: 'firing',
    eventKey,
    eventAt,
    contentHash: createHash('sha256').update(text).digest('hex'),
    isEdit: false,
    // A grouped message stores one signal per alert under `<message>#<alert>`.
    observations: monitorKeys.map((monitorKey, index) => ({
      externalMessageId: grouped ? `${externalId}#alert-${index}` : externalId,
      state: 'firing' as const,
      summary: text,
      contentHash: `repeat-${index}`,
      eventKey: grouped
        ? `slack:${CHANNEL}:${externalId}:observation:alert-${index}:producer:${PRODUCER}`
        : eventKey,
      eventAt,
      monitorKey,
    })),
  };
}

/** Signals stored for one inbound Slack message, grouped members included. */
function signalsOf(owner: string, externalId: string) {
  return admin.db
    .select({ incidentId: incidentSignals.incidentId })
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.tenantId, owner),
        sql`split_part(${incidentSignals.externalMessageId}, '#', 1) = ${externalId}`,
      ),
    );
}

// Disposition recording off selects the legacy classifier, so a fall-through is observable as one call.
function handler(semanticDispositionEnabled = true) {
  const onOutcome = vi.fn();
  const classifyFn = vi.fn(() => ({ decision: 'not_worthy' as const }));
  const route = vi.fn(async () => ({ deduped: false, incidentId: randomUUID() }));
  const insertReassessmentTx = vi.fn(async () => ({ jobId: 'unexpected' }));
  const publishJob = vi.fn();
  return {
    onOutcome,
    classifyFn,
    route,
    insertReassessmentTx,
    handle: makeClassifyHandler({
      classify: makeFakeClassifier(classifyFn),
      route,
      hub,
      embedder: { dim: 1, embed: async () => [[0]] },
      appDb: app.db,
      redis,
      reservationRedis: redis,
      queue: { insertReassessmentTx, publishJob } as unknown as Queue,
      semanticDispositionEnabled,
      onOutcome,
    }),
  };
}

const job = (payload: InboundCandidate) => ({
  id: randomUUID(),
  tenantId,
  type: 'classify' as const,
  attempts: 1,
  payload,
});

describe('repeat provider notifications', () => {
  test('a repeat attaches to the tracking incident without a new incident or engine run', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle, onOutcome, classifyFn, route, insertReassessmentTx } = handler();
    const candidate = firingCandidate(monitorKey);

    await handle(job(candidate));

    expect(classifyFn).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(insertReassessmentTx).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'belongs_to' }));
    const attached = await admin.db
      .select({ incidentId: incidentSignals.incidentId })
      .from(incidentSignals)
      .where(
        and(
          eq(incidentSignals.tenantId, tenantId),
          eq(incidentSignals.externalMessageId, candidate.externalId),
        ),
      );
    expect(attached).toEqual([{ incidentId: tracked.incidentId }]);
    const [row] = await admin.db
      .select()
      .from(signalDispositions)
      .where(
        and(
          eq(signalDispositions.tenantId, tenantId),
          eq(signalDispositions.sourceEventKey, candidate.eventKey),
        ),
      );
    expect(row).toMatchObject({
      disposition: 'log',
      effectiveDisposition: 'log',
      correlationDecision: 'belongs_to',
      correlatedIncidentId: tracked.incidentId,
      correlatedSignalId: tracked.signalId,
    });
  });

  test.each([
    { name: 'two open incidents track the monitor', incidents: 2, ageHours: 0 },
    { name: 'the tracking signal is older than the active window', incidents: 1, ageHours: 25 },
  ])('falls through to classification when $name', async ({ incidents: count, ageHours }) => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    await Promise.all(
      Array.from({ length: count }, () =>
        trackedIncident(monitorKey, new Date(Date.now() - ageHours * 3_600_000)),
      ),
    );
    const { handle, onOutcome, classifyFn } = handler(false);

    await handle(job(firingCandidate(monitorKey)));

    expect(classifyFn).toHaveBeenCalledTimes(1);
    expect(onOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'belongs_to' }));
  });

  test('a repeat for a resolved incident falls through to classification', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    await admin.db
      .update(incidents)
      .set({ status: 'resolved' })
      .where(eq(incidents.id, tracked.incidentId));
    const { handle, classifyFn } = handler(false);

    await handle(job(firingCandidate(monitorKey)));

    expect(classifyFn).toHaveBeenCalledTimes(1);
  });

  test('a grouped message with one untracked alert falls through to classification', async () => {
    const trackedKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(trackedKey);
    const { handle, onOutcome, classifyFn } = handler(false);
    const candidate = firingCandidate(trackedKey, `slack:monitor-${randomUUID()}`);

    await handle(job(candidate));

    expect(classifyFn).toHaveBeenCalledTimes(1);
    expect(onOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'belongs_to' }));
    const attached = await signalsOf(tenantId, candidate.externalId);
    expect(attached.filter((row) => row.incidentId === tracked.incidentId)).toEqual([]);
  });

  test.each([
    { name: 'resolved', closed: { status: 'resolved' as const } },
    { name: 'archived', closed: { archivedAt: new Date() } },
  ])(
    'a repeat whose incident was $name after the match falls through to classification',
    async ({ closed }) => {
      const monitorKey = `slack:monitor-${randomUUID()}`;
      const tracked = await trackedIncident(monitorKey);
      await admin.db.update(incidents).set(closed).where(eq(incidents.id, tracked.incidentId));
      // Simulates the incident closing between the match read and the attach transaction.
      const match = vi.spyOn(RepeatNotifications.prototype, 'match').mockResolvedValueOnce(tracked);
      const { handle, onOutcome, classifyFn } = handler(false);
      const candidate = firingCandidate(monitorKey);

      try {
        await handle(job(candidate));
      } finally {
        match.mockRestore();
      }

      expect(classifyFn).toHaveBeenCalledTimes(1);
      expect(onOutcome).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'belongs_to' }),
      );
      await expect(signalsOf(tenantId, candidate.externalId)).resolves.toEqual([]);
    },
  );

  test('a monitor tracked only by another tenant is not a repeat', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const foreign = await trackedIncident(monitorKey, new Date(), foreignTenantId);
    const foreignLines = () =>
      admin.db
        .select({ id: incidentMessages.id })
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, foreign.incidentId));
    const foreignSignals = () =>
      admin.db
        .select({ id: incidentSignals.id })
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, foreign.incidentId));
    const [linesBefore, signalsBefore] = await Promise.all([foreignLines(), foreignSignals()]);
    const { handle, onOutcome, classifyFn } = handler(false);

    await handle(job(firingCandidate(monitorKey)));

    expect(classifyFn).toHaveBeenCalledTimes(1);
    expect(onOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'belongs_to' }));
    await expect(foreignLines()).resolves.toEqual(linesBefore);
    await expect(foreignSignals()).resolves.toEqual(signalsBefore);
  });
});
