import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  applySignalObservation,
  createIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  listIncidentSignals,
  makeDb,
  tenants,
  EMBED_DIM,
  type DbHandle,
  type Embedder,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import type { Queue } from '@sre/queue';
import { makeClassifyHandler } from '../classify-consumer';
import { makeFakeClassifier } from '../engine/classify';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let tenantId: string;
let incidentId: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Grouped transaction' });
  incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: `grouped-transaction-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  for (const [member, alertName] of [
    ['latency', 'Checkout latency is high.'],
    ['errors', 'Checkout errors are high.'],
  ] as const) {
    await applySignalObservation(app.db, tenantId, {
      incidentId,
      surface: 'slack',
      channel: 'C_ALERTS',
      externalMessageId: `root#${member}`,
      state: 'firing',
      summary: alertName,
      contentHash: `${member}-firing`,
      eventKey: `slack:C_ALERTS:root:${member}:producer:bot:B_ALERT`,
      eventAt: new Date('2026-08-21T00:00:00.000Z'),
      providerGroupKey: 'alertmanager:checkout-group',
      alertName,
    });
  }
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  await app?.close();
  await redis?.quit();
});

describe('grouped signal transaction', () => {
  test('preserves the legacy plain signal when a one-member structured edit claims recovery', async () => {
    const rootId = `legacy-root-${randomUUID()}`;
    const legacyIncident = await createIncident(app.db, tenantId, {
      fingerprint: `legacy-structured-edit-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await applySignalObservation(app.db, tenantId, {
      incidentId: legacyIncident.id,
      surface: 'slack',
      channel: 'C_ALERTS',
      externalMessageId: rootId,
      state: 'firing',
      summary: 'Checkout errors are high.',
      contentHash: 'legacy-plain-firing',
      eventKey: `slack:C_ALERTS:${rootId}:root`,
      eventAt: new Date('2026-08-21T00:00:00.000Z'),
    });
    const insertRecoveryTx = vi.fn(async () => ({ jobId: randomUUID() }));
    const publishJob = vi.fn(async () => undefined);
    const classifier = vi.fn(() => {
      throw new Error('legacy structured edit must not use classification');
    });
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(classifier),
      appDb: app.db,
      redis,
      reservationRedis: redis,
      queue: {
        insertRecoveryTx,
        insertReassessmentTx: vi.fn(),
        publishJob,
      } as unknown as Queue,
      hub: new ConversationHub(app.db, redis),
      embedder: {
        dim: EMBED_DIM,
        embed: async (texts) => texts.map(() => Array.from({ length: EMBED_DIM }, () => 0)),
      },
    });

    await handler({
      id: randomUUID(),
      tenantId,
      type: 'classify',
      attempts: 1,
      payload: {
        externalId: rootId,
        channel: 'C_ALERTS',
        author: 'bot',
        text: '[RESOLVED:1] Checkout errors recovered.',
        raw: null,
        signalState: 'resolved',
        eventKey: `slack:C_ALERTS:${rootId}:edit`,
        eventAt: '2026-08-21T01:00:00.000Z',
        contentHash: 'legacy-plain-resolved',
        isEdit: true,
        observations: [
          {
            externalMessageId: `${rootId}#checkout-errors`,
            state: 'resolved',
            summary: 'Checkout errors recovered.',
            contentHash: 'legacy-member-resolved',
            eventKey: `slack:C_ALERTS:${rootId}:edit:checkout-errors`,
            eventAt: '2026-08-21T01:00:00.000Z',
            alertName: 'Checkout errors are high.',
          },
        ],
      },
    });

    const [signal] = await admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, legacyIncident.id));
    expect(signal).toMatchObject({ externalMessageId: rootId, state: 'firing', version: 1 });
    expect(classifier).not.toHaveBeenCalled();
    expect(insertRecoveryTx).not.toHaveBeenCalled();
    expect(publishJob).not.toHaveBeenCalled();
  });

  test('never enters grouped lifecycle writes for an unverified recovery', async () => {
    const realHub = new ConversationHub(app.db, redis);
    let observed = 0;
    const publishAppended = vi.fn(async () => undefined);
    const hub = {
      observeSignalTx: async (...args: Parameters<typeof realHub.observeSignalTx>) => {
        const result = await realHub.observeSignalTx(...args);
        observed += 1;
        if (observed === 2) throw new Error('second grouped observation failed');
        return result;
      },
      // The advisory recovery report line is expected; lifecycle writes are not.
      appendOnce: realHub.appendOnce.bind(realHub),
      publishAppended,
    };
    const insertRecoveryTx = vi.fn();
    const insertReassessmentTx = vi.fn();
    const publishJob = vi.fn();
    const embedder: Embedder = {
      dim: EMBED_DIM,
      embed: async (texts) => texts.map(() => Array.from({ length: EMBED_DIM }, () => 0)),
    };
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => {
        throw new Error('grouped root edit must not use classification');
      }),
      appDb: app.db,
      redis,
      reservationRedis: redis,
      queue: { insertRecoveryTx, insertReassessmentTx, publishJob } as unknown as Queue,
      hub: hub as never,
      embedder,
    });

    await expect(
      handler({
        id: randomUUID(),
        tenantId,
        type: 'classify',
        attempts: 1,
        payload: {
          externalId: 'root',
          channel: 'C_ALERTS',
          author: 'bot',
          producerId: 'bot:B_ALERT',
          text: '[RESOLVED:2] checkout',
          raw: null,
          signalState: 'resolved',
          eventKey: 'slack:C_ALERTS:root:edit:2:producer:bot:B_ALERT',
          eventAt: '2026-08-21T01:00:00.000Z',
          contentHash: 'group-resolved',
          isEdit: true,
          observations: [
            {
              externalMessageId: 'root#latency',
              state: 'resolved',
              summary: 'Checkout latency recovered',
              contentHash: 'latency-resolved',
              eventKey: 'slack:C_ALERTS:root:edit:2:latency:producer:bot:B_ALERT',
              eventAt: '2026-08-21T01:00:00.000Z',
              providerGroupKey: 'alertmanager:checkout-group',
              alertName: 'Checkout latency is high.',
            },
            {
              externalMessageId: 'root#errors',
              state: 'resolved',
              summary: 'Checkout errors recovered',
              contentHash: 'errors-resolved',
              eventKey: 'slack:C_ALERTS:root:edit:2:errors:producer:bot:B_ALERT',
              eventAt: '2026-08-21T01:00:00.000Z',
              providerGroupKey: 'alertmanager:checkout-group',
              alertName: 'Checkout errors are high.',
            },
          ],
        },
      }),
    ).resolves.toBeUndefined();
    expect(observed).toBe(0);

    expect(
      (await listIncidentSignals(app.db, tenantId, incidentId)).map((signal) => signal.state),
    ).toEqual(['firing', 'firing']);
    // Only the advisory recovery report is appended; no lifecycle or signal line is written.
    expect(
      await admin.db
        .select({ author: incidentMessages.author, kind: incidentMessages.kind })
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, incidentId)),
    ).toEqual([{ author: 'system', kind: 'status' }]);
    expect(insertRecoveryTx).not.toHaveBeenCalled();
    expect(insertReassessmentTx).not.toHaveBeenCalled();
    expect(publishAppended).not.toHaveBeenCalled();
    expect(publishJob).not.toHaveBeenCalled();
  });
});
