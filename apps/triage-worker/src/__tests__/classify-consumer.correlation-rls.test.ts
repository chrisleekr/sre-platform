// criterion 8 — live-Postgres RLS isolation for the correlation candidate set. Mirrors
// classify-consumer.mention-rls.test.ts: tenants inserted as admin; the incident funnel + hub + the
// candidate-set builder run under app_user (RLS). Tenant A has an OPEN incident; when tenant B fires a
// similar push message, the candidate set the correlation classifier sees MUST be B-scoped — A's
// incident is never offered — so B opens its OWN incident instead of belonging_to A's. The over-cap
// retrieveNearestActive cross-tenant path is covered by incident-repo-embedding.test.ts.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  makeDb,
  withTenant,
  tenants,
  incidents,
  incidentSignals,
  incidentMessages,
  inboundSideEffects,
  surfaceBindings,
  jobs,
  createIncident,
  applySignalObservation,
  getSignalByExternal,
  getIncident,
  setIncidentEmbedding,
  EMBED_DIM,
  type DbHandle,
  type Embedder,
  type IncidentSummary,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import { makeClassifyHandler } from '../classify-consumer';
import { makeFakeClassifier } from '../engine/classify';
import type { InboundCandidate } from '@sre/connectors';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

// A deterministic one-hot embedder: every text spikes the same dimension, so any incident is a valid
// nearest-neighbour candidate. The point here is RLS scoping, not ranking.
const fakeEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIM }, () => 0.5))),
};

const CHANNEL = 'C-corr';
const A_FP = `slack:${CHANNEL}:a-root`;
const B_RAW = { ts: 'b-evt', text: 'checkout is throwing 500s again' };
const bFingerprint = (): string =>
  'slack:' + createHash('sha256').update(JSON.stringify(B_RAW)).digest('hex');

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let queue: Queue;
let hub: ConversationHub;
let tenantA: string;
let tenantB: string;
let aIncidentId: string;
// The candidate set the correlation classifier was handed for tenant B's message.
let bCandidates: IncidentSummary[] | undefined;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  queue = new Queue(admin.db, redis, { stream: 'sre:jobs:corr-rls-test', group: 'corr-rls' });
  hub = new ConversationHub(app.db, redis);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'CRA' },
    { id: tenantB, name: 'CRB' },
  ]);
  // Tenant A owns an ACTIVE incident with an embedding — a candidate ONLY within A's RLS scope.
  aIncidentId = (
    await createIncident(app.db, tenantA, {
      fingerprint: A_FP,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
      title: 'Checkout 5xx spike',
    } as Parameters<typeof createIncident>[2])
  ).id;
  const [vec] = await fakeEmbedder.embed(['checkout 5xx spike']);
  await setIncidentEmbedding(app.db, tenantA, aIncidentId, vec!);
}, 30_000);

afterAll(async () => {
  if (admin) {
    const both = sql`tenant_id in (${tenantA}, ${tenantB})`;
    await admin.db.delete(jobs).where(both);
    await admin.db.delete(incidentMessages).where(both);
    await admin.db.delete(inboundSideEffects).where(both);
    // routeToIncident now binds the incident to its thread in the same tx, so the FK must go first.
    await admin.db.delete(surfaceBindings).where(both);
    await admin.db.delete(incidentSignals).where(both);
    await admin.db.delete(incidents).where(both);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
  if (redis) {
    await redis.del(`dedup:${tenantB}:${bFingerprint()}`);
    await redis.quit();
  }
});

describe('correlation candidate set — live RLS isolation', () => {
  test('tenant B is never offered tenant A’s incident as a candidate; B opens its own', async () => {
    const bCandidate: InboundCandidate = {
      externalId: 'b-evt',
      channel: CHANNEL,
      author: 'human',
      text: B_RAW.text,
      raw: B_RAW,
      signalState: 'unknown',
      eventKey: `slack:${CHANNEL}:b-evt`,
      eventAt: '2026-08-21T00:00:00.000Z',
      contentHash: createHash('sha256').update(B_RAW.text).digest('hex'),
      isEdit: false,
    };

    const handler = makeClassifyHandler({
      // The classifier CAPTURES the candidate set the consumer built (B-scoped), then asks for a new
      // incident so B opens its own thread.
      classify: makeFakeClassifier(((_c: InboundCandidate, candidates: IncidentSummary[]) => {
        bCandidates = candidates;
        return {
          decision: 'new_incident',
          service: 'checkout',
          severity: 'sev2',
          title: 'B checkout 5xx',
        };
      }) as never),
      hub,
      embedder: fakeEmbedder,
      appDb: app.db,
      redis,
      reservationRedis: redis,
      queue,
    } as unknown as Parameters<typeof makeClassifyHandler>[0]);

    await handler({
      id: 'job-corr',
      tenantId: tenantB,
      type: 'classify',
      attempts: 1,
      payload: bCandidate,
    });

    // The candidate set was B-scoped: A's incident was never offered.
    expect(bCandidates).toBeDefined();
    expect(bCandidates!.map((c) => c.id)).not.toContain(aIncidentId);

    // B opened its own incident under B; it is invisible to A (and A's is invisible to B).
    const seenByB = await withTenant(app.db, tenantB, (tx) =>
      tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.fingerprint, bFingerprint())),
    );
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]!.id).not.toBe(aIncidentId);

    const opener = await withTenant(app.db, tenantB, (tx) =>
      tx
        .select({
          incidentId: incidentMessages.incidentId,
          author: incidentMessages.author,
          content: incidentMessages.content,
          originSurface: incidentMessages.originSurface,
          originMessageId: incidentMessages.originMessageId,
        })
        .from(incidentMessages)
        .where(
          and(
            eq(incidentMessages.incidentId, seenByB[0]!.id),
            eq(incidentMessages.originMessageId, `slack:${CHANNEL}:b-evt`),
          ),
        ),
    );
    expect(opener).toEqual([
      {
        incidentId: seenByB[0]!.id,
        author: 'human',
        content: B_RAW.text,
        originSurface: 'slack',
        originMessageId: `slack:${CHANNEL}:b-evt`,
      },
    ]);
    const initialHistory = await hub.history(tenantB, seenByB[0]!.id);
    expect(initialHistory.find((message) => message.kind === 'signal')).toMatchObject({
      signalState: 'unknown',
      signalEventType: 'opened',
    });
    expect(initialHistory.filter((message) => message.kind === 'lifecycle')).toEqual([
      expect.objectContaining({
        author: 'system',
        lifecycleFrom: null,
        lifecycleTo: 'open',
        lifecycleVersion: 0,
      }),
    ]);

    const aSeenByB = await withTenant(app.db, tenantB, (tx) =>
      tx.select({ id: incidents.id }).from(incidents).where(eq(incidents.id, aIncidentId)),
    );
    expect(aSeenByB).toHaveLength(0);

    const bSeenByA = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.fingerprint, bFingerprint())),
    );
    expect(bSeenByA).toHaveLength(0);
  });
});

// --- the side effects are idempotent BY CONSTRUCTION, in Postgres ---------------------------
// The classify stream is at-least-once. The old Valkey SET-NX guard released its key on a
// THROW, but a SIGKILL is not a throw: a worker killed between the reservation and the write left the
// redelivery skipping the side effect and ACKing — the human's reply lost forever. These prove the
// durable replacement against a LIVE Postgres, under RLS.
describe('inbound side-effect idempotency — live Postgres', () => {
  const CHANNEL_X = 'C-side';

  /** A consumer wired to the LIVE hub/db whose classifier belongs_to the named incident. The target is
   *  resolved by id (never by candidate ordering), so the verdict cannot silently point elsewhere. */
  function sideEffectHandler(
    target: string,
    over?: {
      enqueueResume?: () => Promise<string>;
      hasPendingClassification?: () => Promise<boolean>;
    },
  ): { handler: ReturnType<typeof makeClassifyHandler>; enqueueResume: ReturnType<typeof vi.fn> } {
    const enqueueResume = vi.fn(over?.enqueueResume ?? (async () => 'resume-1'));
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(((_c: InboundCandidate, candidates: IncidentSummary[]) => ({
        decision: 'belongs_to',
        index: candidates.findIndex((x) => x.id === target) + 1,
      })) as never),
      route: async () => ({ deduped: false, incidentId: 'never', jobId: 'j' }),
      hub,
      embedder: fakeEmbedder,
      appDb: app.db,
      redis,
      hasPendingClassification: over?.hasPendingClassification,
      queue: {
        enqueueResume,
        insertReassessmentTx: async () => ({ jobId: `signal-job-${randomUUID()}` }),
        publishJob: async () => {},
      } as unknown as Queue,
    } as unknown as Parameters<typeof makeClassifyHandler>[0]);
    return { handler, enqueueResume };
  }

  const job = (over: Partial<InboundCandidate>, tenantId = tenantA) => ({
    id: 'job-side',
    tenantId,
    type: 'classify' as const,
    attempts: 1,
    payload: {
      externalId: '1700000009.0001',
      channel: CHANNEL_X,
      author: 'human',
      text: 'still broken?',
      raw: { ts: '1700000009.0001' },
      signalState: over.author === 'bot' ? 'firing' : 'unknown',
      eventKey: `slack:${over.channel ?? CHANNEL_X}:${over.externalId ?? '1700000009.0001'}`,
      eventAt: '2026-08-21T00:00:00.000Z',
      contentHash: createHash('sha256')
        .update(over.text ?? 'still broken?')
        .digest('hex'),
      isEdit: false,
      ...over,
    } as InboundCandidate,
  });

  const originRows = (tenantId: string, originMessageId: string) =>
    withTenant(app.db, tenantId, (tx) =>
      tx
        .select({ id: incidentMessages.id })
        .from(incidentMessages)
        .where(eq(incidentMessages.originMessageId, originMessageId)),
    );

  test('an edit racing its root retries, then applies to the durable signal without rerouting', async () => {
    const externalId = `edit-race-${randomUUID()}`;
    const hasPendingClassification = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const { handler } = sideEffectHandler(aIncidentId, { hasPendingClassification });
    const edited = job({
      externalId,
      author: 'bot',
      text: 'checkout errors increased to 20%',
      isEdit: true,
      eventKey: `slack:${CHANNEL_X}:${externalId}:edit:2`,
      eventAt: '2026-08-21T00:01:00.000Z',
    });
    try {
      await expect(handler(edited)).rejects.toThrow('edited signal is not tracked yet');
      expect(hasPendingClassification).toHaveBeenCalledWith(
        tenantA,
        { surface: 'slack', channel: CHANNEL_X, externalMessageId: externalId },
        undefined,
      );

      await applySignalObservation(app.db, tenantA, {
        incidentId: aIncidentId,
        surface: 'slack',
        channel: CHANNEL_X,
        externalMessageId: externalId,
        state: 'firing',
        summary: 'checkout errors are high',
        contentHash: 'initial',
        eventKey: `slack:${CHANNEL_X}:${externalId}`,
        eventAt: new Date('2026-08-21T00:00:00.000Z'),
      });
      await handler(edited);

      await expect(
        getSignalByExternal(app.db, tenantA, 'slack', CHANNEL_X, externalId),
      ).resolves.toMatchObject({
        version: 2,
        summary: 'checkout errors increased to 20%',
        lastEventType: 'updated',
      });
    } finally {
      hasPendingClassification.mockReset();
    }
  });

  // THE CRASH WINDOW. The first delivery COMMITS the human's hub line and then dies before the ACK (here
  // enqueueResume throws, standing in for the SIGKILL a release-on-throw guard can never see). The
  // redelivery must self-heal: still exactly ONE hub line, and the resume must NOT be lost.
  test('a crash after the hub write: the redelivery adds no second line and still enqueues the resume', async () => {
    const ts = '1700000010.0001';
    const origin = `slack:${CHANNEL_X}:${ts}`;
    let fail = true;
    const { handler, enqueueResume } = sideEffectHandler(aIncidentId, {
      enqueueResume: async () => {
        if (fail) {
          fail = false;
          throw new Error('worker died before the ACK');
        }
        return 'resume-ok';
      },
    });

    await expect(handler(job({ externalId: ts, raw: { ts } }))).rejects.toThrow(); // not acked
    expect(await originRows(tenantA, origin)).toHaveLength(1); // the line IS committed

    await handler(job({ externalId: ts, raw: { ts } })); // the queue redelivers

    // Exactly one hub line: the (tenant_id, origin_message_id) unique collapsed the re-append.
    expect(await originRows(tenantA, origin)).toHaveLength(1);
    // ...and the resume was enqueued on the retry, even though the append was a no-op. Skipping it when
    // the row already exists would lose the human's reply forever.
    expect(enqueueResume).toHaveBeenCalledTimes(2);
  });

  // The unique is (tenant_id, origin_message_id) — it says nothing about incident_id — and the belongs_to
  // verdict is re-derived by the LLM on EVERY delivery, so a redelivery can legitimately drift to a
  // different target. The line stays where it was first written, so the resume must follow the ROW, not
  // our (drifted) belief: resuming the drifted incident would be a no-op there, and if delivery 1 died
  // before its own enqueue, nobody would ever resume the incident the message actually sits on.
  test('a redelivery whose verdict DRIFTED still resumes the incident the message really lives on', async () => {
    const ts = '1700000013.0001';
    const origin = `slack:${CHANNEL_X}:${ts}`;
    const { id: driftedTarget } = await createIncident(app.db, tenantA, {
      fingerprint: `slack:${CHANNEL_X}:drift-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });

    // Delivery 1: the verdict says incident A, and it CRASHES before its own enqueueResume.
    const one = sideEffectHandler(aIncidentId, {
      enqueueResume: async () => {
        throw new Error('worker died before the ACK');
      },
    });
    await expect(one.handler(job({ externalId: ts, raw: { ts } }))).rejects.toThrow();
    expect(await originRows(tenantA, origin)).toHaveLength(1);

    // The redelivery's verdict DRIFTS to a different incident.
    const two = sideEffectHandler(driftedTarget);
    await two.handler(job({ externalId: ts, raw: { ts } }));

    // Still one line (it lives on A), and the resume went to A — never to the drifted target, where it
    // would have found nothing and left A's human message unanswered forever.
    const rows = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ id: incidentMessages.id, incidentId: incidentMessages.incidentId })
        .from(incidentMessages)
        .where(eq(incidentMessages.originMessageId, origin)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.incidentId).toBe(aIncidentId);
    expect(two.enqueueResume).toHaveBeenCalledTimes(1);
    expect(two.enqueueResume).toHaveBeenCalledWith(tenantA, aIncidentId, rows[0]!.id);
  });

  test('a redelivered BOT belongs_to bumps occurrence_count exactly once (durable ledger)', async () => {
    const ts = '1700000011.0001';
    const before = (await getIncident(app.db, tenantA, aIncidentId))!.occurrenceCount;
    const { handler } = sideEffectHandler(aIncidentId);
    const botJob = job({ externalId: ts, author: 'bot', raw: { ts } });

    await handler(botJob);
    await handler(botJob); // redelivery

    const after = (await getIncident(app.db, tenantA, aIncidentId))!.occurrenceCount;
    expect(after).toBe(before + 1);

    // One ledger row, tenant-scoped, keyed on `slack:<channel>:<ts>`.
    const ledger = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select()
        .from(inboundSideEffects)
        .where(eq(inboundSideEffects.messageKey, `slack:${CHANNEL_X}:${ts}`)),
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.incidentId).toBe(aIncidentId);
  });

  // Tenant isolation is absolute: the ledger is a tenant-scoped table under RLS, so the SAME
  // surface message key in another tenant must land its own side effect and be invisible across tenants.
  test('the same messageKey in two tenants: both land, and neither tenant can see the other’s ledger row', async () => {
    const ts = '1700000012.0001';
    const messageKey = `slack:${CHANNEL_X}:${ts}`;
    const { id: bIncidentId } = await createIncident(app.db, tenantB, {
      fingerprint: `slack:${CHANNEL_X}:b-side-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });

    // Tenant A's consumer bumps A's incident; tenant B's bumps B's — same key, different tenants.
    const aBefore = (await getIncident(app.db, tenantA, aIncidentId))!.occurrenceCount;
    const bBefore = (await getIncident(app.db, tenantB, bIncidentId))!.occurrenceCount;
    const botJob = { externalId: ts, author: 'bot' as const, raw: { ts } };
    await sideEffectHandler(aIncidentId).handler(job(botJob, tenantA));

    await sideEffectHandler(bIncidentId).handler(job(botJob, tenantB));

    expect((await getIncident(app.db, tenantA, aIncidentId))!.occurrenceCount).toBe(aBefore + 1);
    expect((await getIncident(app.db, tenantB, bIncidentId))!.occurrenceCount).toBe(bBefore + 1);

    // RLS: each tenant sees exactly its OWN ledger row for that key, never the other's.
    const rowsFor = (tenantId: string) =>
      withTenant(app.db, tenantId, (tx) =>
        tx
          .select({
            tenantId: inboundSideEffects.tenantId,
            incidentId: inboundSideEffects.incidentId,
          })
          .from(inboundSideEffects)
          .where(eq(inboundSideEffects.messageKey, messageKey)),
      );
    const seenByA = await rowsFor(tenantA);
    const seenByB = await rowsFor(tenantB);
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]!.incidentId).toBe(aIncidentId);
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]!.incidentId).toBe(bIncidentId);
  });
});
