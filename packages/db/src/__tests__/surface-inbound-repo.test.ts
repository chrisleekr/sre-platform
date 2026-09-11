import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  surfaceConfigs,
  surfaceInboundEvents,
  jobs,
  acceptSurfaceInboundEventTx,
  linkSurfaceInboundJobTx,
  updateSurfaceInboundState,
  recordSurfaceInboundClassificationOutcome,
  getSurfaceInboundHealth,
  hasPendingSurfaceMessageClassification,
  isSurfaceInboundSuperseded,
  setSurfaceMessageTerminalDispositionTx,
  withSurfaceInboundMessageLock,
  withSurfaceInboundRoutingFence,
  type DbHandle,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;

let admin: DbHandle;
let app: DbHandle;
let coordination: DbHandle;
const tenantId = randomUUID();
let configId: string;

async function setTerminal(
  input: Parameters<typeof setSurfaceMessageTerminalDispositionTx>[1],
): Promise<number> {
  return withSurfaceInboundMessageLock(admin.db, input, async (tx) => {
    const result = await setSurfaceMessageTerminalDispositionTx(tx, input);
    return result.updatedCount;
  });
}

async function terminalDisposition(intakeId: string): Promise<string | null> {
  const rows = await admin.db
    .select({ disposition: surfaceInboundEvents.terminalDisposition })
    .from(surfaceInboundEvents)
    .where(and(eq(surfaceInboundEvents.id, intakeId), eq(surfaceInboundEvents.tenantId, tenantId)))
    .limit(1);
  return rows[0]?.disposition ?? null;
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  coordination = makeDb(ADMIN_URL);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'inbound-ledger-test' });
  const rows = await admin.db
    .insert(surfaceConfigs)
    .values({ tenantId, surface: 'slack' })
    .returning({ id: surfaceConfigs.id });
  configId = rows[0]!.id;
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(surfaceInboundEvents).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(surfaceConfigs).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(jobs).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.close();
  }
  if (app) await app.close();
  if (coordination) await coordination.close();
});

describe('surface inbound ledger', () => {
  test('finds a pending durable predecessor by stable message without crossing tenants', async () => {
    const externalMessageId = `pending-message-${randomUUID()}`;
    const identity = {
      tenantId,
      configId,
      surface: 'slack',
      envelopeType: 'events_api',
      eventType: 'message',
      channel: 'C-pending',
      externalMessageId,
    };
    const root = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        ...identity,
        deliveryKey: `event:pending-root-${randomUUID()}`,
      }),
    );
    const edit = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        ...identity,
        deliveryKey: `event:pending-edit-${randomUUID()}`,
      }),
    );
    const inserted = await admin.db
      .insert(jobs)
      .values({
        tenantId,
        type: 'classify',
        payload: {
          intakeId: root.row.id,
          channel: identity.channel,
          externalId: externalMessageId,
        },
        idempotencyKey: root.row.id,
        eventKey: `slack:${identity.channel}:${externalMessageId}`,
        status: 'queued',
        stream: 'test:surface-pending',
      })
      .returning({ id: jobs.id });
    const query = {
      tenantId,
      surface: 'slack',
      channel: identity.channel,
      externalMessageId,
      excludeIntakeId: edit.row.id,
    };

    await expect(hasPendingSurfaceMessageClassification(admin.db, query)).resolves.toBe(true);
    await admin.db
      .update(surfaceInboundEvents)
      .set({ channel: null, externalMessageId: null })
      .where(eq(surfaceInboundEvents.id, root.row.id));
    await admin.db
      .update(jobs)
      .set({ idempotencyKey: null, eventKey: null })
      .where(eq(jobs.id, inserted[0]!.id));
    await expect(hasPendingSurfaceMessageClassification(admin.db, query)).resolves.toBe(true);
    await expect(
      hasPendingSurfaceMessageClassification(admin.db, {
        ...query,
        tenantId: randomUUID(),
      }),
    ).resolves.toBe(false);
    await admin.db
      .update(jobs)
      .set({ status: 'done' })
      .where(sql`id = ${inserted[0]!.id}`);
    await expect(hasPendingSurfaceMessageClassification(admin.db, query)).resolves.toBe(false);
    await admin.db.delete(surfaceInboundEvents).where(sql`id in (${root.row.id}, ${edit.row.id})`);
    await admin.db.delete(jobs).where(eq(jobs.id, inserted[0]!.id));
  });

  test('supersedes every receipt for one stable surface message without crossing tenants', async () => {
    const externalMessageId = `message-${randomUUID()}`;
    const receipts = [];
    for (const deliveryKey of [`event:root-${randomUUID()}`, `event:edit-${randomUUID()}`]) {
      const accepted = await admin.db.transaction((tx) =>
        acceptSurfaceInboundEventTx(tx, {
          tenantId,
          configId,
          surface: 'slack',
          deliveryKey,
          envelopeType: 'events_api',
          eventType: 'message',
          channel: 'C-superseded',
          externalMessageId,
        }),
      );
      receipts.push(accepted.row);
    }

    await expect(
      setTerminal({
        tenantId: randomUUID(),
        surface: 'slack',
        channel: 'C-superseded',
        externalMessageId,
        disposition: 'foreign',
        eventAt: new Date('2026-08-29T00:00:01.000Z'),
      }),
    ).resolves.toBe(0);
    await expect(
      setTerminal({
        tenantId,
        surface: 'slack',
        channel: 'C-superseded',
        externalMessageId,
        disposition: 'suppressed_provider_control_notification',
        eventAt: new Date('2026-08-29T00:00:01.000Z'),
      }),
    ).resolves.toBe(2);
    for (const receipt of receipts) {
      await expect(terminalDisposition(receipt.id)).resolves.toBe(
        'suppressed_provider_control_notification',
      );
    }
    await expect(getSurfaceInboundHealth(admin.db, tenantId, 'slack', configId)).resolves.toEqual(
      expect.objectContaining({ pendingCount: 0 }),
    );
  });

  test('orders message decisions by provider event time and fences routing atomically', async () => {
    const externalMessageId = `message-order-${randomUUID()}`;
    const receipt = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId,
        configId,
        surface: 'slack',
        deliveryKey: `event:order-${randomUUID()}`,
        envelopeType: 'events_api',
        eventType: 'message',
        channel: 'C-order',
        externalMessageId,
      }),
    );
    const actionableAt = new Date('2026-08-29T00:00:10.000Z');
    const identity = {
      tenantId,
      surface: 'slack',
      channel: 'C-order',
      externalMessageId,
    };
    await expect(
      withSurfaceInboundRoutingFence(
        admin.db,
        { ...identity, intakeId: receipt.row.id, eventAt: actionableAt },
        async () => 'routed',
      ),
    ).resolves.toEqual({ status: 'executed', value: 'routed' });

    await expect(
      setTerminal({
        ...identity,
        disposition: 'suppressed_provider_control_notification',
        eventAt: new Date('2026-08-29T00:00:09.000Z'),
      }),
    ).resolves.toBe(0);
    await expect(
      isSurfaceInboundSuperseded(admin.db, tenantId, receipt.row.id, actionableAt),
    ).resolves.toBe(true);

    const repeatedRoute = vi.fn(async () => 'must-not-run');
    await expect(
      withSurfaceInboundRoutingFence(
        admin.db,
        { ...identity, intakeId: receipt.row.id, eventAt: actionableAt },
        repeatedRoute,
      ),
    ).resolves.toEqual({ status: 'superseded' });
    expect(repeatedRoute).not.toHaveBeenCalled();

    await expect(
      setTerminal({
        ...identity,
        disposition: 'suppressed_provider_control_notification',
        eventAt: new Date('2026-08-29T00:00:11.000Z'),
      }),
    ).resolves.toBe(1);
    await expect(
      withSurfaceInboundRoutingFence(
        admin.db,
        { ...identity, intakeId: receipt.row.id, eventAt: actionableAt },
        async () => 'must-not-run',
      ),
    ).resolves.toEqual({ status: 'superseded' });
  });

  test('uses a coordination pool while five fenced callbacks write classify outcomes', async () => {
    const cases = [];
    for (let index = 0; index < 5; index += 1) {
      const receipt = await admin.db.transaction((tx) =>
        acceptSurfaceInboundEventTx(tx, {
          tenantId,
          configId,
          surface: 'slack',
          deliveryKey: `event:legacy-routing-${randomUUID()}`,
          envelopeType: 'events_api',
          eventType: 'message',
        }),
      );
      cases.push({
        receipt,
        identity: {
          tenantId,
          surface: 'slack',
          channel: `C-legacy-routing-${index}`,
          externalMessageId: `legacy-routing-${randomUUID()}`,
        },
      });
    }

    await expect(
      Promise.all(
        cases.map(({ identity, receipt }) =>
          withSurfaceInboundRoutingFence(
            coordination.db,
            {
              ...identity,
              intakeId: receipt.row.id,
              eventAt: new Date('2026-08-29T00:00:20.000Z'),
            },
            async () => {
              await recordSurfaceInboundClassificationOutcome(
                admin.db,
                tenantId,
                receipt.row.id,
                'new_incident',
              );
              return 'routed';
            },
          ),
        ),
      ),
    ).resolves.toEqual(cases.map(() => ({ status: 'executed', value: 'routed' })));

    for (const { identity, receipt } of cases) {
      await expect(
        admin.db
          .select({
            channel: surfaceInboundEvents.channel,
            externalMessageId: surfaceInboundEvents.externalMessageId,
            classificationOutcome: surfaceInboundEvents.classificationOutcome,
          })
          .from(surfaceInboundEvents)
          .where(eq(surfaceInboundEvents.id, receipt.row.id)),
      ).resolves.toEqual([
        {
          channel: identity.channel,
          externalMessageId: identity.externalMessageId,
          classificationOutcome: 'new_incident',
        },
      ]);
      await admin.db
        .delete(surfaceInboundEvents)
        .where(eq(surfaceInboundEvents.id, receipt.row.id));
    }
  });

  test('orders opposite decisions exactly within one JavaScript millisecond', async () => {
    const externalMessageId = `message-microseconds-${randomUUID()}`;
    const receipt = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId,
        configId,
        surface: 'slack',
        deliveryKey: `event:microseconds-${randomUUID()}`,
        envelopeType: 'events_api',
        eventType: 'message',
        channel: 'C-microseconds',
        externalMessageId,
      }),
    );
    const eventAt = new Date('2026-08-29T00:00:10.000Z');
    const identity = {
      tenantId,
      surface: 'slack',
      channel: 'C-microseconds',
      externalMessageId,
    };

    await expect(
      setTerminal({
        ...identity,
        disposition: 'suppressed_provider_control_notification',
        eventAt,
        eventVersion: '1787952010000001',
      }),
    ).resolves.toBe(1);
    await expect(
      withSurfaceInboundRoutingFence(
        admin.db,
        {
          ...identity,
          intakeId: receipt.row.id,
          eventAt,
          eventVersion: '1787952010000999',
        },
        async () => 'routed',
      ),
    ).resolves.toEqual({ status: 'executed', value: 'routed' });
    await expect(
      isSurfaceInboundSuperseded(admin.db, tenantId, receipt.row.id, eventAt, '1787952010000999'),
    ).resolves.toBe(true);
    await expect(
      setTerminal({
        ...identity,
        disposition: 'suppressed_provider_control_notification',
        eventAt,
        eventVersion: '1787952010000999',
      }),
    ).resolves.toBe(1);
    await expect(terminalDisposition(receipt.row.id)).resolves.toBe(
      'suppressed_provider_control_notification',
    );
    await recordSurfaceInboundClassificationOutcome(
      admin.db,
      tenantId,
      receipt.row.id,
      'new_incident',
    );
    await updateSurfaceInboundState(admin.db, receipt.row.id, {
      state: 'processed',
      outcome: 'classify_enqueued',
      attemptCount: 1,
      completed: true,
    });
  });

  test('reserves one receipt per delivery and projects processing health', async () => {
    const first = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId,
        configId,
        surface: 'slack',
        deliveryKey: 'event:one',
        envelopeType: 'events_api',
        eventType: 'message',
        channel: 'C1',
      }),
    );
    const duplicate = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId,
        configId,
        surface: 'slack',
        deliveryKey: 'event:one',
        envelopeType: 'events_api',
      }),
    );
    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({ inserted: false, row: { id: first.row.id } });

    const jobRows = await admin.db
      .insert(jobs)
      .values({ tenantId, type: 'slack.inbound', payload: {}, stream: 'sre:slack-inbound' })
      .returning({ id: jobs.id });
    await admin.db.transaction((tx) => linkSurfaceInboundJobTx(tx, first.row.id, jobRows[0]!.id));
    await updateSurfaceInboundState(admin.db, first.row.id, {
      state: 'processed',
      outcome: 'classify_enqueued',
      attemptCount: 1,
      completed: true,
    });

    await expect(getSurfaceInboundHealth(admin.db, tenantId, 'slack', configId)).resolves.toEqual({
      latest: expect.objectContaining({
        state: 'processed',
        outcome: 'classify_enqueued',
        classificationOutcome: null,
        jobStatus: 'queued',
        attemptCount: 1,
      }),
      pendingCount: 1,
      failedLast24Hours: 0,
    });

    const beforeForeignWrite = await admin.db
      .select({
        classificationOutcome: surfaceInboundEvents.classificationOutcome,
        classificationUpdatedAt: surfaceInboundEvents.classificationUpdatedAt,
        updatedAt: surfaceInboundEvents.updatedAt,
      })
      .from(surfaceInboundEvents)
      .where(sql`id = ${first.row.id}`);
    await recordSurfaceInboundClassificationOutcome(
      admin.db,
      randomUUID(),
      first.row.id,
      'not_worthy',
    );
    const afterForeignWrite = await admin.db
      .select({
        classificationOutcome: surfaceInboundEvents.classificationOutcome,
        classificationUpdatedAt: surfaceInboundEvents.classificationUpdatedAt,
        updatedAt: surfaceInboundEvents.updatedAt,
      })
      .from(surfaceInboundEvents)
      .where(sql`id = ${first.row.id}`);
    expect(afterForeignWrite).toEqual(beforeForeignWrite);

    await recordSurfaceInboundClassificationOutcome(
      admin.db,
      tenantId,
      first.row.id,
      'retry',
      'provider_unavailable',
    );
    await expect(getSurfaceInboundHealth(admin.db, tenantId, 'slack', configId)).resolves.toEqual({
      latest: expect.objectContaining({
        classificationOutcome: 'retry',
        errorCode: 'provider_unavailable',
      }),
      pendingCount: 1,
      failedLast24Hours: 0,
    });

    await recordSurfaceInboundClassificationOutcome(
      admin.db,
      tenantId,
      first.row.id,
      'new_incident',
    );
    await expect(getSurfaceInboundHealth(admin.db, tenantId, 'slack', configId)).resolves.toEqual({
      latest: expect.objectContaining({
        classificationOutcome: 'new_incident',
        classificationUpdatedAt: expect.any(Date),
        errorCode: null,
      }),
      pendingCount: 0,
      failedLast24Hours: 0,
    });

    const downstreamRows = await admin.db
      .insert(surfaceInboundEvents)
      .values([
        {
          tenantId,
          configId,
          surface: 'slack',
          deliveryKey: 'event:mention',
          envelopeType: 'events_api',
          state: 'processed',
          outcome: 'mention_enqueued',
          acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          tenantId,
          configId,
          surface: 'slack',
          deliveryKey: 'event:edit',
          envelopeType: 'events_api',
          state: 'processed',
          outcome: 'edit_enqueued',
          acceptedAt: new Date('2026-01-01T00:00:01.000Z'),
        },
      ])
      .returning({ id: surfaceInboundEvents.id });
    await expect(getSurfaceInboundHealth(admin.db, tenantId, 'slack', configId)).resolves.toEqual(
      expect.objectContaining({ pendingCount: 2 }),
    );
    for (const row of downstreamRows) {
      await recordSurfaceInboundClassificationOutcome(admin.db, tenantId, row.id, 'new_incident');
    }
    await expect(getSurfaceInboundHealth(admin.db, tenantId, 'slack', configId)).resolves.toEqual(
      expect.objectContaining({ pendingCount: 0 }),
    );

    await updateSurfaceInboundState(admin.db, first.row.id, {
      state: 'retrying',
      outcome: 'processing_failed',
      attemptCount: 2,
    });
    await admin.db
      .update(jobs)
      .set({ status: 'dead' })
      .where(sql`id = ${jobRows[0]!.id}`);
    await expect(getSurfaceInboundHealth(admin.db, tenantId, 'slack', configId)).resolves.toEqual({
      latest: expect.objectContaining({ state: 'retrying', jobStatus: 'dead', attemptCount: 2 }),
      pendingCount: 0,
      failedLast24Hours: 1,
    });
  });

  test('is system-only because unknown-team receipts cannot be tenant-RLS scoped', async () => {
    const privileges = (await app.db.execute(sql`
      select privilege,
             pg_catalog.has_table_privilege(current_user, 'public.surface_inbound_events', privilege) as allowed
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege
      order by privilege
    `)) as unknown as { privilege: string; allowed: boolean }[];
    expect(privileges.every((row) => !row.allowed)).toBe(true);
  });
});
