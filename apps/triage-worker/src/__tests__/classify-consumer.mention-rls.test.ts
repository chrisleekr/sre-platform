// criterion 5 — live-Postgres RLS isolation for the mention pull path. Mirrors the two-tenant
// live-PG shape of runbook-seeder.test.ts / worker.test.ts: tenants inserted as admin, the incident
// funnel + hub run under app_user (RLS), and a mention-created incident for tenant A must be invisible
// to tenant B. The thread reader + characterize generator are hermetic fakes; the funnel (route) and
// hub are REAL so the incident row and its transcript are written under the tenant context.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  makeDb,
  withTenant,
  tenants,
  incidents,
  incidentMessages,
  surfaceBindings,
  jobs,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import { routeToIncident, type IncidentSignal, type RouteResult } from '@sre/alerts';
import { makeClassifyHandler } from '../classify-consumer';
import { makeFakeClassifier } from '../engine/classify';
import type { StructuredGenerator } from '../engine/types';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

const CHANNEL = 'C-rls';
const ROOT_TS = '1700500000.0001';
const FINGERPRINT = `slack:${CHANNEL}:${ROOT_TS}`;

// the resolved-thread follow-up scenario. Module-level so afterAll can drop the live 24h dedup key
// the funnel arms — the whole point of the test is that the key outlives the incident it was armed for.
const RESOLVED_CHANNEL = 'C-resolved';
const RESOLVED_ROOT_TS = '1700700000.0001';
const RESOLVED_FINGERPRINT = `slack:${RESOLVED_CHANNEL}:${RESOLVED_ROOT_TS}`;

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let queue: Queue;
let hub: ConversationHub;

const resolveIncident = (targetTenantId: string, incidentId: string) =>
  hub.transitionIncident(targetTenantId, incidentId, {
    to: 'resolved',
    reason: 'Test fixture lifecycle.',
    transitionKey: `test:${incidentId}:resolved`,
    author: 'system',
  });
let tenantA: string;
let tenantB: string;

const routeSignal = (signal: IncidentSignal): Promise<RouteResult> =>
  routeToIncident(
    {
      appDb: app.db,
      redis,
      queue,
      appendOpenerTx: (tx, tenantId, incidentId, opener) =>
        hub.appendTxOnce(tx, tenantId, incidentId, opener).then((result) => result.message),
    },
    signal,
  );

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  queue = new Queue(admin.db, redis, { stream: 'sre:jobs:mention-rls-test', group: 'mention-rls' });
  hub = new ConversationHub(app.db, redis);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'MRA' },
    { id: tenantB, name: 'MRB' },
  ]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    const both = sql`tenant_id in (${tenantA}, ${tenantB})`;
    await admin.db.delete(jobs).where(both);
    await admin.db.delete(incidentMessages).where(both);
    // routeToIncident now binds the incident to its thread in the same tx, so the FK must go first.
    await admin.db.delete(surfaceBindings).where(both);
    await admin.db.delete(incidents).where(both);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
  if (redis) {
    await redis.del(
      `dedup:${tenantA}:${FINGERPRINT}`,
      `dedup:${tenantB}:${FINGERPRINT}`,
      `dedup:${tenantA}:${RESOLVED_FINGERPRINT}`,
    );
    await redis.quit();
  }
});

describe('mention pull path — live RLS isolation', () => {
  test('a mention-created incident for tenant A is invisible to tenant B', async () => {
    const readThread = vi.fn(async () => [
      { user: 'U_HUMAN', text: 'checkout is on fire', ts: ROOT_TS },
    ]);
    const generate = vi.fn(async () => ({
      decision: 'new_incident',
      service: 'checkout',
      severity: 'sev2',
      title: 't',
    }));
    const generator = { generate } as unknown as StructuredGenerator;
    // Deterministic embedder for the correlation-shortlist seed; vector contents irrelevant
    // to this RLS test, only that embed() is callable without a server.
    const embedder = {
      dim: 1024,
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.1)),
    };

    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => ({ decision: 'not_worthy' })),
      route: routeSignal,
      recordBinding: async () => undefined,
      hub,
      threadReader: { readThread },
      generator,
      embedder,
      appDb: app.db,
      redis,
      queue,
    } as unknown as Parameters<typeof makeClassifyHandler>[0]);

    await handler({
      id: 'job-mrls',
      tenantId: tenantA,
      type: 'classify',
      attempts: 1,
      payload: {
        kind: 'mention',
        channel: CHANNEL,
        rootTs: ROOT_TS,
        ts: '1700500000.0009',
        user: 'U_HUMAN',
        text: '<@U_BOT> checkout is on fire',
        raw: { type: 'app_mention', ts: '1700500000.0009' },
      },
    });

    // The incident opened under tenant A, keyed on the mention fingerprint channel:root_ts.
    const seenByA = await withTenant(app.db, tenantA, (tx) =>
      tx.select({ id: incidents.id }).from(incidents).where(eq(incidents.fingerprint, FINGERPRINT)),
    );
    expect(seenByA).toHaveLength(1);

    // RLS hides it from tenant B (cross-tenant exclusion).
    const seenByB = await withTenant(app.db, tenantB, (tx) =>
      tx.select({ id: incidents.id }).from(incidents).where(eq(incidents.fingerprint, FINGERPRINT)),
    );
    expect(seenByB).toHaveLength(0);

    // The transcript hub message is visible only to tenant A.
    const incidentId = seenByA[0]!.id;
    const msgsA = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ content: incidentMessages.content })
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, incidentId)),
    );
    expect(msgsA.some((m) => m.content.includes('checkout is on fire'))).toBe(true);
    const msgsB = await withTenant(app.db, tenantB, (tx) =>
      tx
        .select({ content: incidentMessages.content })
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, incidentId)),
    );
    expect(msgsB).toHaveLength(0);
  });

  // The mention races its own alert's classify job: the alert lands as root ts1, a classify
  // job is in flight, and seconds later a human @-mentions the bot in that thread. The webhook's binding
  // lookup misses (the classify job has not committed the binding yet) so a MENTION classify job is
  // enqueued; the push job then commits I1 bound to (channel, ts1). The mention now carries a DIFFERENT
  // fingerprint, so it mints I2 and collides on the thread's unique. That collision used to throw, retry
  // 50 times against an identical collision, and DEAD-LETTER the human's question. A taken thread is the
  // answer to "which incident owns this conversation": the question joins the owner.
  test('a mention that races its own alert lands on the OWNER incident and never dead-letters', async () => {
    const channel = 'C-race';
    const rootTs = '1700600000.0001';
    const mentionFp = `slack:${channel}:${rootTs}`;
    const embedder = {
      dim: 1024,
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.1)),
    };

    // 1-4. The push classify job wins the race: incident I1 is committed, bound to (channel, rootTs).
    const pushed = await routeToIncident(
      { appDb: app.db, redis, queue },
      {
        tenantId: tenantA,
        source: 'slack',
        fingerprint: `slack:push-${randomUUID()}`,
        service: 'checkout',
        severity: 'sev2',
        origin: { surface: 'slack', channel, threadId: rootTs },
      },
    );
    const owner = pushed.incidentId!;

    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => ({ decision: 'not_worthy' })),
      route: routeSignal,
      hub,
      // The real reader returns the WHOLE thread, the human's mention included — that transcript is what
      // the mention path attaches.
      threadReader: {
        readThread: async () => [
          { user: 'U_H', text: 'alert body', ts: rootTs },
          { user: 'U_HUMAN', text: '<@U_BOT> what is happening?', ts: '1700600000.0009' },
        ],
      },
      // A new_incident verdict, i.e. the mention does NOT correlate onto the owner by itself. The BINDING
      // is what resolves it, so the fix cannot be an artefact of a lucky belongs_to.
      generator: {
        generate: async () => ({
          decision: 'new_incident',
          service: 'checkout',
          severity: 'sev2',
          title: 't',
        }),
      } as unknown as StructuredGenerator,
      embedder,
      appDb: app.db,
      redis,
      queue,
    } as unknown as Parameters<typeof makeClassifyHandler>[0]);

    // 5. The mention job runs. It must NOT throw — a throw is a retry, and every retry collides identically
    //    until the queue dead-letters the human's message.
    await expect(
      handler({
        id: 'job-race',
        tenantId: tenantA,
        type: 'classify',
        attempts: 1,
        payload: {
          kind: 'mention',
          channel,
          rootTs,
          ts: '1700600000.0009',
          user: 'U_HUMAN',
          text: '<@U_BOT> what is happening?',
          raw: { type: 'app_mention', ts: '1700600000.0009' },
        },
      }),
    ).resolves.toBeUndefined();

    // No second incident: the mention's own fingerprint minted nothing that survived.
    const minted = await withTenant(app.db, tenantA, (tx) =>
      tx.select({ id: incidents.id }).from(incidents).where(eq(incidents.fingerprint, mentionFp)),
    );
    expect(minted).toHaveLength(0);

    // The thread still has exactly one binding, still owned by I1.
    const bound = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ incidentId: surfaceBindings.incidentId })
        .from(surfaceBindings)
        .where(eq(surfaceBindings.externalId, `${channel}:${rootTs}`)),
    );
    expect(bound).toEqual([{ incidentId: owner }]);

    // The human's question landed on the OWNER incident...
    const msgs = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ content: incidentMessages.content })
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, owner)),
    );
    expect(msgs.some((m) => m.content.includes('what is happening?'))).toBe(true);

    // ...and the engine was woken for it (a resume job, not a dead letter).
    const resumes = await admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(sql`tenant_id = ${tenantA} and type = 'resume' and payload->>'incidentId' = ${owner}`);
    expect(resumes).toHaveLength(1);

    await redis.del(`dedup:${tenantA}:${mentionFp}`);
  });

  // fixed by this commit; this test locks it. The funnel USED TO derive its dedup key from the
  // fingerprint, and the mention path's fingerprint is THREAD-derived (`slack:<channel>:<rootTs>`),
  // identical for every message in the thread, armed for INBOUND_DEDUP_TTL_SEC = 86_400. So one key
  // suppressed every DISTINCT human message in that thread for 24h. It bit deterministically once the
  // thread's incident left the active set AND no other active incident drew a belongs_to: correlation is
  // tenant-wide, so the owner resolving does not by itself decide the verdict, but against a candidate set
  // with nothing to match, every route converges on new_incident (an out-of-range belongs_to and a
  // characterize throw both take the fallback). It bit intermittently otherwise, whenever the verdict was
  // new_incident anyway. Either way the funnel deduped, `created.incidentId` was undefined, and the
  // handler returned early: the human's question was dropped with no hub line, no resume and no reply. The
  // thread's binding still names the owner, so the question has an obvious home; the dedup key was what
  // stopped it getting there. This test locks the resolved case because it is the reproducible one.
  // The funnel now keys on the signal's dedupKey, falling back to the fingerprint (routeToIncident in
  // @sre/alerts), and the mention path passes messageKey(channel, ts).
  test('a human follow-up in a RESOLVED thread reaches the owner and is not eaten by the 24h dedup key', async () => {
    const followupTs = '1700700000.0009';
    const followupText = '<@U_BOT> it is back — what changed?';
    const followupKey = `slack:${RESOLVED_CHANNEL}:${followupTs}`;
    const embedder = {
      dim: 1024,
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.1)),
    };

    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => ({ decision: 'not_worthy' })),
      route: routeSignal,
      hub,
      threadReader: {
        readThread: async () => [
          { user: 'U_HUMAN', text: 'checkout latency spiked', ts: RESOLVED_ROOT_TS },
          { user: 'U_HUMAN', text: followupText, ts: followupTs },
        ],
      },
      // new_incident for BOTH deliveries — which is what production does. The opener has nothing to
      // correlate onto; by the follow-up the owner is RESOLVED and therefore absent from the active set,
      // so belongs_to is not reachable for it.
      generator: {
        generate: async () => ({
          decision: 'new_incident',
          service: 'checkout',
          severity: 'sev2',
          title: 't',
        }),
      } as unknown as StructuredGenerator,
      embedder,
      appDb: app.db,
      redis,
      queue,
    } as unknown as Parameters<typeof makeClassifyHandler>[0]);

    // 1. The opener runs through the REAL mention path, so the incident, its thread binding and the live
    //    24h dedup key are all armed exactly the way production arms them — not hand-written into Valkey.
    await handler({
      id: 'job-resolved-open',
      tenantId: tenantA,
      type: 'classify',
      attempts: 1,
      payload: {
        kind: 'mention',
        channel: RESOLVED_CHANNEL,
        rootTs: RESOLVED_ROOT_TS,
        ts: RESOLVED_ROOT_TS,
        user: 'U_HUMAN',
        text: '<@U_BOT> checkout latency spiked',
        raw: { type: 'app_mention', ts: RESOLVED_ROOT_TS },
      },
    });

    const owned = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.fingerprint, RESOLVED_FINGERPRINT)),
    );
    expect(owned).toHaveLength(1);
    const owner = owned[0]!.id;

    // Guards step 1: without a live key this test would pass vacuously. The opener's dedupKey is
    // messageKey(channel, ts), which for the OPENER alone coincides with the thread fingerprint because
    // ts === rootTs, so the key is per-message and covers only the opener's own redelivery. Pre-fix this
    // same key was armed off the thread fingerprint and swallowed every later message in the thread. That
    // is the bug the follow-up below proves is gone.
    const ttl = await redis.ttl(`dedup:${tenantA}:${RESOLVED_FINGERPRINT}`);
    expect(ttl).toBeGreaterThan(86_000);

    // 2. The incident is resolved — it drops out of listActiveIncidents.
    await resolveIncident(tenantA, owner);

    // 3-4. A DISTINCT human message arrives in the SAME thread (ts !== rootTs). It must not throw.
    await expect(
      handler({
        id: 'job-resolved-followup',
        tenantId: tenantA,
        type: 'classify',
        attempts: 1,
        payload: {
          kind: 'mention',
          channel: RESOLVED_CHANNEL,
          rootTs: RESOLVED_ROOT_TS,
          ts: followupTs,
          user: 'U_HUMAN',
          text: followupText,
          raw: { type: 'app_mention', ts: followupTs },
        },
      }),
    ).resolves.toBeUndefined();

    // 5. The human's question landed on the incident that OWNS the thread, carrying its own surface
    // message id — not the root's, so this cannot pass on the opener's line.
    const line = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ incidentId: incidentMessages.incidentId, content: incidentMessages.content })
        .from(incidentMessages)
        .where(eq(incidentMessages.originMessageId, followupKey)),
    );
    expect(line).toHaveLength(1);
    expect(line[0]!.incidentId).toBe(owner);
    expect(line[0]!.content).toContain('what changed?');

    // ...and exactly one resume is ENQUEUED for it. The enqueue is all this test asserts, deliberately:
    // is the message reaching the owner durably (hub line + dashboard) instead of vanishing, which
    // holds whatever the engine then does. The resume is also ANSWERED, because handleResume does not
    // return early on a 'resolved' incident, so the engine runs and answers per terminal (a
    // `stay_silent` turn posts nothing at all); only the RCA write is frozen. What that answer looks like
    // is worker.test.ts's to pin.
    const resumes = await admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(sql`tenant_id = ${tenantA} and type = 'resume' and payload->>'incidentId' = ${owner}`);
    expect(resumes).toHaveLength(1);
  });

  // The same job redelivered. The classify stream is at-least-once. The funnel ALREADY rolled back and
  // released the key on ThreadAlreadyBoundError (route-to-incident.ts's rollback + catch, which did
  // not touch; what changed in that file is only the key it arms). What the fix changed here is that
  // a follow-up now REACHES that path instead of deduping on the thread key first. So a
  // redelivery genuinely re-runs the whole mention path rather than being suppressed, and idempotency has
  // to come from appendOnce's (tenant_id, origin_message_id) unique plus enqueueResume's coalesce index
  //not from the key.
  test('a redelivered follow-up in a RESOLVED thread still yields exactly one hub line and one resume', async () => {
    const channel = 'C-resolved-redeliver';
    const rootTs = '1700800000.0001';
    const followupTs = '1700800000.0009';
    const embedder = {
      dim: 1024,
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.1)),
    };
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => ({ decision: 'not_worthy' })),
      route: routeSignal,
      hub,
      threadReader: {
        readThread: async () => [{ user: 'U_HUMAN', text: 'db connections maxed', ts: rootTs }],
      },
      generator: {
        generate: async () => ({
          decision: 'new_incident',
          service: 'checkout',
          severity: 'sev2',
          title: 't',
        }),
      } as unknown as StructuredGenerator,
      embedder,
      appDb: app.db,
      redis,
      queue,
    } as unknown as Parameters<typeof makeClassifyHandler>[0]);

    const mention = (id: string, ts: string) => ({
      id,
      tenantId: tenantA,
      type: 'classify' as const,
      attempts: 1,
      payload: {
        kind: 'mention',
        channel,
        rootTs,
        ts,
        user: 'U_HUMAN',
        text: ts === rootTs ? '<@U_BOT> db connections maxed' : '<@U_BOT> any update?',
        raw: { type: 'app_mention', ts },
      },
    });

    await handler(mention('job-rd-open', rootTs));
    const owned = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.fingerprint, `slack:${channel}:${rootTs}`)),
    );
    const owner = owned[0]!.id;
    await resolveIncident(tenantA, owner);

    // Same job id, same surface `ts`, twice.
    await handler(mention('job-rd-followup', followupTs));
    await handler(mention('job-rd-followup', followupTs));

    const lines = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ id: incidentMessages.id })
        .from(incidentMessages)
        .where(eq(incidentMessages.originMessageId, `slack:${channel}:${followupTs}`)),
    );
    expect(lines).toHaveLength(1);
    const resumes = await admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(sql`tenant_id = ${tenantA} and type = 'resume' and payload->>'incidentId' = ${owner}`);
    expect(resumes).toHaveLength(1);

    await redis.del(
      `dedup:${tenantA}:slack:${channel}:${rootTs}`,
      `dedup:${tenantA}:slack:${channel}:${followupTs}`,
    );
  });

  // The property the fix must NOT break. On an UNBOUND thread the mention path opens the incident,
  // and a redelivery of that SAME message (same channel + same ts) must still be suppressed by the key —
  // otherwise the funnel would mint a second incident or re-seed the hub.
  test('a redelivered mention on an unbound thread opens exactly one incident and seeds once', async () => {
    const channel = 'C-redeliver';
    const rootTs = '1700900000.0001';
    const embedder = {
      dim: 1024,
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.1)),
    };
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => ({ decision: 'not_worthy' })),
      route: routeSignal,
      hub,
      threadReader: {
        readThread: async () => [{ user: 'U_HUMAN', text: 'cache evictions spiking', ts: rootTs }],
      },
      generator: {
        generate: async () => ({
          decision: 'new_incident',
          service: 'checkout',
          severity: 'sev2',
          title: 't',
        }),
      } as unknown as StructuredGenerator,
      embedder,
      appDb: app.db,
      redis,
      queue,
    } as unknown as Parameters<typeof makeClassifyHandler>[0]);

    const job = {
      id: 'job-redeliver',
      tenantId: tenantA,
      type: 'classify' as const,
      attempts: 1,
      payload: {
        kind: 'mention',
        channel,
        rootTs,
        ts: rootTs,
        user: 'U_HUMAN',
        text: '<@U_BOT> cache evictions spiking',
        raw: { type: 'app_mention', ts: rootTs },
      },
    };
    await handler(job);
    await handler(job);

    const opened = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.fingerprint, `slack:${channel}:${rootTs}`)),
    );
    expect(opened).toHaveLength(1);

    // The seed is hub.append (not appendOnce), so a second pass through openNewIncident would duplicate
    // it. Exactly one proves the redelivery was suppressed at the funnel.
    const seeds = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select({ id: incidentMessages.id })
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, opened[0]!.id)),
    );
    expect(seeds).toHaveLength(1);

    await redis.del(`dedup:${tenantA}:slack:${channel}:${rootTs}`);
  });
});
