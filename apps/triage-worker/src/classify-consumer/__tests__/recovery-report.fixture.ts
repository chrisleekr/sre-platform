import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  alertCohortMembers,
  alertCohorts,
  applySignalObservation,
  createIncident,
  incidentMessages,
  incidentSignals,
  inboundSideEffects,
  incidents,
  jobs,
  makeDb,
  signalDispositions,
  surfaceBindings,
  surfaceInboundEvents,
  tenantSignalPolicies,
  tenants,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import type { InboundCandidate } from '@sre/connectors';
import { makeClassifyHandler } from '../../classify-consumer';
import { makeFakeClassifier } from '../../engine/classify';
import { makeSlackIntakeStateDeps } from '../intake-state';

export const PRODUCER = 'bot:B_ALERTS';
export const CHANNEL = 'C-RECOVERY';

export let admin: DbHandle;
export let app: DbHandle;
export let redis: Redis;
export let queue: Queue;
export let hub: ConversationHub;
export const tenantId = randomUUID();
// Same channel, producer and monitor identities as the home tenant, so only RLS separates them.
export const foreignTenantId = randomUUID();

/** Registers the shared database, queue and hub lifecycle for one test file. */
export function useRecoveryFixture(): void {
  beforeAll(async () => {
    expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
    admin = makeDb(process.env.DATABASE_URL!);
    app = makeDb(process.env.APP_DATABASE_URL!);
    redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(admin.db, redis, { stream: 'sre:jobs:recovery-report', group: 'recovery' });
    hub = new ConversationHub(app.db, redis);
    await admin.db.insert(tenants).values([
      { id: tenantId, name: 'recovery-report' },
      { id: foreignTenantId, name: 'recovery-report-foreign' },
    ]);
  });

  afterAll(async () => {
    if (admin) {
      const scoped = sql`tenant_id in (${tenantId}, ${foreignTenantId})`;
      await admin.db.delete(signalDispositions).where(scoped);
      await admin.db.delete(jobs).where(scoped);
      await admin.db.delete(surfaceInboundEvents).where(scoped);
      await admin.db.delete(inboundSideEffects).where(scoped);
      await admin.db.delete(incidentMessages).where(scoped);
      await admin.db.delete(surfaceBindings).where(scoped);
      await admin.db.delete(alertCohortMembers).where(scoped);
      await admin.db.delete(alertCohorts).where(scoped);
      await admin.db.delete(incidentSignals).where(scoped);
      await admin.db.delete(incidents).where(scoped);
      await admin.db.delete(tenantSignalPolicies).where(scoped);
      await admin.db.delete(tenants).where(sql`id in (${tenantId}, ${foreignTenantId})`);
      await admin.close();
    }
    if (app) await app.close();
    if (redis) await redis.quit();
  });
}

/** Opens one incident with one advisory Slack signal, as the classify path stores it. */
export async function trackedIncident(
  monitorKey: string,
  root = `root-${randomUUID()}`,
  owner = tenantId,
) {
  const incident = await createIncident(app.db, owner, {
    fingerprint: `recovery-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
  });
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
    eventAt: new Date('2026-09-20T00:00:00.000Z'),
  });
  return { incidentId: incident.id, signalId: observed.signal.id, root };
}

export function resolvedCandidate(
  monitorKey: string,
  over: Partial<InboundCandidate> = {},
): InboundCandidate {
  const externalId = over.externalId ?? `resolved-${randomUUID()}`;
  const eventKey = over.eventKey ?? `slack:${CHANNEL}:${externalId}:producer:${PRODUCER}`;
  const text = '[RESOLVED] Checkout error rate is high.';
  return {
    externalId,
    channel: CHANNEL,
    author: 'bot',
    producerId: PRODUCER,
    text,
    raw: null,
    signalState: 'resolved',
    eventKey,
    eventAt: '2026-09-20T00:05:00.000Z',
    contentHash: createHash('sha256').update(text).digest('hex'),
    isEdit: false,
    observations: [
      {
        externalMessageId: externalId,
        state: 'resolved',
        summary: text,
        contentHash: 'resolved',
        eventKey,
        eventAt: '2026-09-20T00:05:00.000Z',
        monitorKey,
      },
    ],
    ...over,
  };
}

/**
 * Builds the classify handler. `fenced` wires the production stable-message fence, which only
 * applies to candidates that carry an `intakeId` (see `intakeReceipt`).
 */
export function handler(semanticDispositionEnabled = true, fenced = false) {
  const onOutcome = vi.fn();
  const route = vi.fn(async () => {
    throw new Error('a recovery notice must never open an incident');
  });
  return {
    onOutcome,
    route,
    handle: makeClassifyHandler({
      classify: makeFakeClassifier(() => {
        throw new Error('a recovery notice must not spend a classifier decision');
      }),
      route,
      hub,
      embedder: { dim: 1, embed: async () => [[0]] },
      appDb: app.db,
      redis,
      reservationRedis: redis,
      queue,
      semanticDispositionEnabled,
      ...(fenced ? makeSlackIntakeStateDeps(admin.db, admin.db) : {}),
      onOutcome,
    }),
  };
}

export const job = (payload: InboundCandidate) => ({
  id: randomUUID(),
  tenantId,
  type: 'classify' as const,
  attempts: 1,
  payload,
});

export const reportMessages = (incidentId: string) =>
  admin.db
    .select({ content: incidentMessages.content, author: incidentMessages.author })
    .from(incidentMessages)
    .where(
      and(
        eq(incidentMessages.incidentId, incidentId),
        sql`${incidentMessages.originMessageId} like 'slack-recovery:%'`,
      ),
    );

export const recoveryJobs = (incidentId: string) =>
  admin.db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.type, 'recovery.verify'),
        sql`${jobs.payload} ->> 'incidentId' = ${incidentId}`,
      ),
    );

export const signalStates = (incidentId: string) =>
  admin.db
    .select({ state: incidentSignals.state, clearProvenance: incidentSignals.clearProvenance })
    .from(incidentSignals)
    .where(eq(incidentSignals.incidentId, incidentId));

export const VERIFYING =
  'Provider reported recovery in Slack at 2026-09-20T00:05:00.000Z. Verifying recovery before resolving.';

export const disposition = (eventKey: string) =>
  admin.db
    .select()
    .from(signalDispositions)
    .where(
      and(
        eq(signalDispositions.tenantId, tenantId),
        eq(signalDispositions.sourceEventKey, eventKey),
      ),
    );

/** Records the durable Slack receipt a production candidate carries, and returns its id. */
export async function intakeReceipt(candidate: InboundCandidate): Promise<string> {
  const [row] = await admin.db
    .insert(surfaceInboundEvents)
    .values({
      tenantId,
      surface: 'slack',
      deliveryKey: `event:${randomUUID()}`,
      envelopeType: 'events_api',
      eventType: 'message',
      eventSubtype: candidate.isEdit ? 'message_changed' : 'bot_message',
      channel: candidate.channel,
      externalMessageId: candidate.externalId,
      state: 'processed',
      outcome: candidate.isEdit ? 'edit_enqueued' : 'classify_enqueued',
    })
    .returning({ id: surfaceInboundEvents.id });
  return row!.id;
}
