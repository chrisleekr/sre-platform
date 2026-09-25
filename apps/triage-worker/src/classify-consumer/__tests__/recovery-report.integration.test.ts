import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  applySignalObservation,
  createIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  listProviderRecoveryReports,
  makeDb,
  signalDispositions,
  surfaceBindings,
  tenantSignalPolicies,
  tenants,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import type { InboundCandidate } from '@sre/connectors';
import { makeClassifyHandler } from '../../classify-consumer';
import { makeFakeClassifier } from '../../engine/classify';

const PRODUCER = 'bot:B_ALERTS';
const CHANNEL = 'C-RECOVERY';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let queue: Queue;
let hub: ConversationHub;
const tenantId = randomUUID();
// Same channel, producer and monitor identities as the home tenant, so only RLS separates them.
const foreignTenantId = randomUUID();

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
    await admin.db.delete(incidentMessages).where(scoped);
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

/** Opens one incident with one advisory Slack signal, as the classify path stores it. */
async function trackedIncident(
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

function resolvedCandidate(
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

function handler(semanticDispositionEnabled = true) {
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

const reportMessages = (incidentId: string) =>
  admin.db
    .select({ content: incidentMessages.content, author: incidentMessages.author })
    .from(incidentMessages)
    .where(
      and(
        eq(incidentMessages.incidentId, incidentId),
        sql`${incidentMessages.originMessageId} like 'slack-recovery:%'`,
      ),
    );

const disposition = (eventKey: string) =>
  admin.db
    .select()
    .from(signalDispositions)
    .where(
      and(
        eq(signalDispositions.tenantId, tenantId),
        eq(signalDispositions.sourceEventKey, eventKey),
      ),
    );

describe('Slack recovery notices', () => {
  test('a matched notice is linked, posted once on redelivery, and never changes lifecycle', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle, onOutcome, route } = handler();
    const candidate = resolvedCandidate(monitorKey);

    await handle(job(candidate));
    await handle(job(candidate));

    expect(route).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledTimes(2);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_reported' }),
    );
    expect(await reportMessages(tracked.incidentId)).toEqual([
      {
        author: 'system',
        content:
          'Provider reported recovery in Slack at 2026-09-20T00:05:00.000Z. Slack text is advisory; confirm to resolve.',
      },
    ]);
    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({
        disposition: 'log',
        correlationDecision: 'recovery_reported',
        correlatedIncidentId: tracked.incidentId,
        correlatedSignalId: tracked.signalId,
      }),
    ]);
    const [signal] = await admin.db
      .select({ state: incidentSignals.state })
      .from(incidentSignals)
      .where(eq(incidentSignals.id, tracked.signalId));
    expect(signal!.state).toBe('unknown');
    const [incident] = await admin.db
      .select({ status: incidents.status })
      .from(incidents)
      .where(eq(incidents.id, tracked.incidentId));
    expect(incident!.status).toBe('open');
  });

  test('an Alertmanager edit links by its exact Slack root and records root scope', async () => {
    const tracked = await trackedIncident(`slack:monitor-${randomUUID()}`);
    const { handle, onOutcome } = handler();
    const candidate = resolvedCandidate('unused', {
      externalId: tracked.root,
      eventKey: `slack:${CHANNEL}:${tracked.root}:edit:2:producer:${PRODUCER}`,
      isEdit: true,
      observations: undefined,
    });

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_reported' }),
    );
    expect(await reportMessages(tracked.incidentId)).toHaveLength(1);
    // Root scope lets the workspace cover every alert the edited message carried.
    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({
        correlationDecision: 'recovery_reported_root',
        correlatedSignalId: tracked.signalId,
      }),
    ]);
  });

  test('an edit that opens firing and lists a resolved alert records signal scope', async () => {
    const tracked = await trackedIncident(`slack:monitor-${randomUUID()}`);
    const { handle } = handler();
    const text = '[FIRING:1] Checkout latency is high.\nResolved: Checkout error rate is high.';
    const candidate = resolvedCandidate('unused', {
      externalId: tracked.root,
      eventKey: `slack:${CHANNEL}:${tracked.root}:edit:2:producer:${PRODUCER}`,
      isEdit: true,
      text,
      contentHash: createHash('sha256').update(text).digest('hex'),
      observations: undefined,
    });

    await handle(job(candidate));

    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({
        correlationDecision: 'recovery_reported',
        correlatedSignalId: tracked.signalId,
      }),
    ]);
  });

  test('an Alertmanager message edited to resolved and back to firing no longer reads as recovered', async () => {
    const root = `grouped-${randomUUID()}`;
    const incident = await createIncident(app.db, tenantId, {
      fingerprint: `recovery-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const monitors = [`slack:monitor-a-${randomUUID()}`, `slack:monitor-b-${randomUUID()}`];
    for (const [index, monitorKey] of monitors.entries())
      await applySignalObservation(app.db, tenantId, {
        incidentId: incident.id,
        surface: 'slack',
        channel: CHANNEL,
        externalMessageId: `${root}#alert-${index}`,
        state: 'unknown',
        summary: 'Checkout error rate is high.',
        contentHash: `firing-${index}`,
        monitorKey,
        eventKey: `slack:${CHANNEL}:${root}:producer:${PRODUCER}`,
        eventAt: new Date('2026-09-20T00:00:00.000Z'),
      });
    // Slack update_message edits the same message; the first alert's monitor keys supersession.
    const edit = (text: string, eventAt: string, monitorKey: string): InboundCandidate => {
      const version = String(Date.parse(eventAt) * 1000);
      const eventKey = `slack:${CHANNEL}:${root}:edit:${version}:producer:${PRODUCER}`;
      return resolvedCandidate(monitorKey, {
        externalId: root,
        eventKey,
        eventAt,
        eventVersion: version,
        isEdit: true,
        text,
        signalState: text.startsWith('[RESOLVED') ? 'resolved' : 'firing',
        contentHash: createHash('sha256').update(text).digest('hex'),
        observations: [
          {
            externalMessageId: root,
            state: 'unknown',
            summary: text,
            contentHash: 'edit',
            eventKey,
            eventAt,
            monitorKey,
          },
        ],
      });
    };
    const { handle } = handler();
    const covered = async () =>
      (await listProviderRecoveryReports(app.db, tenantId, incident.id)).length;

    await handle(
      job(
        edit('[RESOLVED] Checkout error rate is high.', '2026-09-20T00:05:00.000Z', monitors[0]!),
      ),
    );
    expect(await covered()).toBe(2);

    await handle(
      job(edit('[FIRING:1] Checkout latency is high.', '2026-09-20T00:08:00.000Z', monitors[1]!)),
    );
    expect(await covered()).toBe(0);
  });

  test('the link and message do not depend on disposition recording', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle, onOutcome } = handler(false);
    const candidate = resolvedCandidate(monitorKey);

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_reported' }),
    );
    expect(await reportMessages(tracked.incidentId)).toHaveLength(1);
    expect(await disposition(candidate.eventKey)).toEqual([]);
  });

  test.each([
    { name: 'no open signal carries the monitor', incidents: 0 },
    { name: 'two open incidents carry the monitor', incidents: 2 },
  ])('an ambiguous notice stays unmatched when $name', async ({ incidents: count }) => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await Promise.all(
      Array.from({ length: count }, () => trackedIncident(monitorKey)),
    );
    const { handle, onOutcome } = handler();
    const candidate = resolvedCandidate(monitorKey);

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
    for (const item of tracked) expect(await reportMessages(item.incidentId)).toEqual([]);
    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({ disposition: 'log', correlatedIncidentId: null }),
    ]);
  });

  test('a notice for an already resolved incident is not linked', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    await admin.db
      .update(incidents)
      .set({ status: 'resolved' })
      .where(eq(incidents.id, tracked.incidentId));
    const { handle, onOutcome } = handler();

    await handle(job(resolvedCandidate(monitorKey)));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
    expect(await reportMessages(tracked.incidentId)).toEqual([]);
  });

  test.each([
    { name: 'new message', edit: false },
    { name: 'root edit', edit: true },
  ])('a $name from another producer is not linked', async ({ edit }) => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle, onOutcome } = handler();
    const other = 'bot:B_OTHER';
    const candidate = resolvedCandidate(monitorKey, {
      producerId: other,
      eventKey: `slack:${CHANNEL}:${randomUUID()}:producer:${other}`,
      ...(edit ? { externalId: tracked.root, isEdit: true } : {}),
    });

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
    expect(await reportMessages(tracked.incidentId)).toEqual([]);
  });

  test.each([
    { name: 'new message', edit: false },
    { name: 'root edit', edit: true },
  ])("a $name never links to another tenant's incident", async ({ edit }) => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const foreign = await trackedIncident(monitorKey, undefined, foreignTenantId);
    const foreignSignals = () =>
      admin.db
        .select({ id: incidentSignals.id, state: incidentSignals.state })
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, foreign.incidentId));
    const signalsBefore = await foreignSignals();
    const { handle, onOutcome } = handler();
    const candidate = resolvedCandidate(
      monitorKey,
      edit
        ? {
            externalId: foreign.root,
            eventKey: `slack:${CHANNEL}:${foreign.root}:edit:2:producer:${PRODUCER}`,
            isEdit: true,
            observations: undefined,
          }
        : {},
    );

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
    expect(await reportMessages(foreign.incidentId)).toEqual([]);
    await expect(foreignSignals()).resolves.toEqual(signalsBefore);
    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({ correlatedIncidentId: null, correlatedSignalId: null }),
    ]);
  });
});
