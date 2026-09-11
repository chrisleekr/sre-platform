import { afterEach, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  SLACK_CLASSIFY_PENDING,
  SLACK_CLASSIFY_SUPPRESSED,
  SLACK_CLASSIFY_TERMINAL,
  writeSlackClassifyReservation,
  type InboundCandidate,
} from '@sre/connectors';
import {
  acceptSurfaceInboundEventTx,
  applySignalObservation,
  createIncident,
  jobs,
  surfaceInboundEvents,
} from '@sre/db';
import { handleSlackEvent, type SlackInboundDeps } from '../slack-inbound';
import { createFixture } from './slack-inbound.fixture';

const __fixture = createFixture();

afterEach(async () => {
  await __fixture.admin.db
    .delete(surfaceInboundEvents)
    .where(eq(surfaceInboundEvents.tenantId, __fixture.tenantB));
  await __fixture.admin.db.delete(jobs).where(eq(jobs.stream, 'test:slack-admission-concurrency'));
});

describe('Slack inbound provider decision supersession', () => {
  test('reservation state follows provider event time rather than completion order', async () => {
    const key = __fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, 'reservation-order');
    const eventAt = '2026-08-31T00:00:00.000Z';
    const older = '1788134400000001';
    const newer = '1788134400000999';

    await expect(
      writeSlackClassifyReservation(__fixture.redis, key, SLACK_CLASSIFY_PENDING, eventAt, newer),
    ).resolves.toMatchObject({ applied: true });
    await expect(
      writeSlackClassifyReservation(__fixture.redis, key, SLACK_CLASSIFY_TERMINAL, eventAt, newer),
    ).resolves.toMatchObject({ applied: true });
    await expect(
      writeSlackClassifyReservation(
        __fixture.redis,
        key,
        SLACK_CLASSIFY_SUPPRESSED,
        eventAt,
        older,
      ),
    ).resolves.toMatchObject({ applied: false });
    expect(await __fixture.redis.get(key)).toBe(SLACK_CLASSIFY_TERMINAL);

    await expect(
      writeSlackClassifyReservation(
        __fixture.redis,
        key,
        SLACK_CLASSIFY_SUPPRESSED,
        eventAt,
        newer,
      ),
    ).resolves.toMatchObject({ applied: true });
    await expect(
      writeSlackClassifyReservation(__fixture.redis, key, SLACK_CLASSIFY_TERMINAL, eventAt, newer),
    ).resolves.toMatchObject({ applied: false });
    expect(await __fixture.redis.get(key)).toBe(SLACK_CLASSIFY_SUPPRESSED);
  });

  test('an imprecise reservation blocks a delayed exact event in the same millisecond', async () => {
    const key = __fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, 'reservation-imprecise');
    const eventAt = '2026-08-31T00:00:00.000Z';

    await expect(
      writeSlackClassifyReservation(__fixture.redis, key, SLACK_CLASSIFY_PENDING, eventAt),
    ).resolves.toMatchObject({ applied: true });
    await expect(
      writeSlackClassifyReservation(
        __fixture.redis,
        key,
        SLACK_CLASSIFY_SUPPRESSED,
        eventAt,
        '1788134400000500',
      ),
    ).resolves.toMatchObject({ applied: false });
    expect(await __fixture.redis.get(key)).toBe(SLACK_CLASSIFY_PENDING);
    await __fixture.redis.del(key, `${key}:event-version`);
  });

  test('a failed durable actionable-edit insert leaves the suppression cache untouched', async () => {
    const rootTs = '1788001400.000100';
    const editTs = '1788001410.000100';
    const key = __fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, rootTs);
    await __fixture.processClassifyEvent(
      __fixture.rootEvent({
        channel: __fixture.CLS_SUB,
        subtype: 'bot_message',
        bot_id: 'B_ALERT',
        user: undefined,
        ts: rootTs,
        event_ts: rootTs,
        text: '*Alert:* InfoInhibitor',
        attachments: [
          {
            fields: [
              { title: 'Severity', value: 'none' },
              { title: 'Receiver', value: 'null' },
            ],
          },
        ],
      }),
    );
    __fixture.classifyShouldThrow = true;

    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'message_changed',
          event_ts: editTs,
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            ts: rootTs,
            edited: { ts: editTs },
            text: '*Alert:* Checkout errors are high. *Severity:* `critical`',
          },
        }),
      ),
    ).rejects.toThrow('classify enqueue failed');

    expect(await __fixture.redis.get(key)).toBe(SLACK_CLASSIFY_SUPPRESSED);
    expect(await __fixture.redis.get(`${key}:event-version`)).toBe(rootTs.replace('.', ''));
  });

  test('an actionable provider edit enters root classification before prior state is visible', async () => {
    const rootTs = '1788001200.000100';
    const key = __fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, rootTs);

    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'message_changed',
          event_ts: '1788001210.000100',
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            ts: rootTs,
            edited: { ts: '1788001210.000100' },
            text: '*Alert:* Checkout errors are high. *Severity:* `critical`',
          },
        }),
      ),
    ).resolves.toBe('edit_enqueued');

    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]).toMatchObject({
      payload: { externalId: rootTs, isEdit: false, alertKind: 'firing' },
    });
    expect(await __fixture.redis.get(key)).toBe(SLACK_CLASSIFY_PENDING);
  });

  test('the same actionable edit cannot enqueue classification twice', async () => {
    const rootTs = '1788001250.000100';
    const editTs = '1788001250.000999';
    const event = __fixture.rootEvent({
      channel: __fixture.CLS_SUB,
      subtype: 'message_changed',
      event_ts: editTs,
      message: {
        type: 'message',
        subtype: 'bot_message',
        bot_id: 'B_ALERT',
        ts: rootTs,
        edited: { ts: editTs },
        text: '*Alert:* Checkout errors are high. *Severity:* `critical`',
      },
    });

    await expect(__fixture.processClassifyEvent(event)).resolves.toBe('edit_enqueued');
    await expect(__fixture.processClassifyEvent(event)).resolves.toBe('dropped_duplicate');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
  });

  test('a newer actionable edit replaces an untracked control suppression with root classification', async () => {
    const rootTs = '1788001300.000100';
    const key = __fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, rootTs);
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'bot_message',
          bot_id: 'B_ALERT',
          user: undefined,
          ts: rootTs,
          event_ts: '1788001300.000100',
          text: '*Alert:* InfoInhibitor',
          attachments: [
            {
              fields: [
                { title: 'Severity', value: 'none' },
                { title: 'Receiver', value: 'null' },
              ],
            },
          ],
        }),
      ),
    ).resolves.toBe('suppressed_provider_control_notification');
    expect(await __fixture.redis.get(key)).toBe(SLACK_CLASSIFY_SUPPRESSED);
    expect(__fixture.classifyEnqueued).toHaveLength(0);

    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'message_changed',
          event_ts: '1788001310.000100',
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            ts: rootTs,
            edited: { ts: '1788001310.000100' },
            text: '*Alert:* Checkout errors are high. *Severity:* `critical`',
          },
        }),
      ),
    ).resolves.toBe('edit_enqueued');

    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]).toMatchObject({
      tenantId: __fixture.tenantB,
      type: 'classify',
      payload: {
        externalId: rootTs,
        isEdit: false,
        signalState: 'firing',
        alertKind: 'firing',
      },
    });
    expect(await __fixture.redis.get(key)).toBe(SLACK_CLASSIFY_PENDING);
  });

  test('a structured edit preserves legacy plain-signal routing during rolling upgrades', async () => {
    const rootTs = '1788001450.000100';
    const incident = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `legacy-plain-edit-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
      incidentId: incident.id,
      surface: 'slack',
      channel: __fixture.CLS_SUB,
      externalMessageId: rootTs,
      state: 'firing',
      summary: 'Checkout errors are high.',
      contentHash: 'legacy-plain-firing',
      eventKey: `slack:${__fixture.CLS_SUB}:${rootTs}:root`,
      eventAt: new Date('2026-08-31T00:00:00.000Z'),
    });

    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'message_changed',
          event_ts: '1788001460.000100',
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            ts: rootTs,
            edited: { ts: '1788001460.000100' },
            text: [
              '[RESOLVED:1] checkout',
              '*Alert:* Checkout errors are high.',
              '*Description:* errors recovered.',
              '*Severity:* `critical`',
              '*Source:* Prometheus Alertmanager',
            ].join(' '),
          },
        }),
      ),
    ).resolves.toBe('edit_enqueued');

    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]!.payload).toMatchObject({
      externalId: rootTs,
      isEdit: true,
      signalState: 'resolved',
      observations: [expect.objectContaining({ alertName: 'Checkout errors are high.' })],
    });
  });

  test('suppression repairs a legacy receipt before recording its terminal decision', async () => {
    const rootTs = '1788001500.000100';
    const accepted = await __fixture.admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId: __fixture.tenantB,
        configId: __fixture.classifyConfigId,
        surface: 'slack',
        deliveryKey: `event:legacy-suppression-${rootTs}`,
        envelopeType: 'events_api',
        eventType: 'message',
        eventSubtype: 'message_changed',
      }),
    );

    await expect(
      handleSlackEvent(
        __fixture.classifyDeps,
        __fixture.classifyConfigId,
        __fixture.tenantBConfig(),
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'message_changed',
          event_ts: '1788001510.000100',
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            ts: rootTs,
            edited: { ts: '1788001510.000100' },
            text: '*Alert:* InfoInhibitor',
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
        { intakeId: accepted.row.id },
      ),
    ).resolves.toBe('suppressed_provider_control_notification');

    await expect(
      __fixture.admin.db
        .select({
          channel: surfaceInboundEvents.channel,
          externalMessageId: surfaceInboundEvents.externalMessageId,
          terminalDisposition: surfaceInboundEvents.terminalDisposition,
        })
        .from(surfaceInboundEvents)
        .where(eq(surfaceInboundEvents.id, accepted.row.id)),
    ).resolves.toEqual([
      {
        channel: __fixture.CLS_SUB,
        externalMessageId: rootTs,
        terminalDisposition: 'suppressed_provider_control_notification',
      },
    ]);
  });

  test('an edit waits for a concurrent root admission before deciding it is untracked', async () => {
    const rootTs = '1788001600.000100';
    const rootReceipt = await __fixture.admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId: __fixture.tenantB,
        configId: __fixture.classifyConfigId,
        surface: 'slack',
        deliveryKey: `event:concurrent-root-${rootTs}`,
        envelopeType: 'events_api',
        eventType: 'message',
        eventSubtype: 'bot_message',
        channel: __fixture.CLS_SUB,
        externalMessageId: rootTs,
      }),
    );
    const editReceipt = await __fixture.admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId: __fixture.tenantB,
        configId: __fixture.classifyConfigId,
        surface: 'slack',
        deliveryKey: `event:concurrent-edit-${rootTs}`,
        envelopeType: 'events_api',
        eventType: 'message',
        eventSubtype: 'message_changed',
        channel: __fixture.CLS_SUB,
        externalMessageId: rootTs,
      }),
    );
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    let markRootEntered!: () => void;
    const rootEntered = new Promise<void>((resolve) => {
      markRootEntered = resolve;
    });
    let rootBackendPid: number | undefined;
    const insertedPayloads: InboundCandidate[] = [];
    const publishJob = vi.fn(async () => undefined);
    const classifyQueue: SlackInboundDeps['classifyQueue'] = {
      insertClassify: async () => {
        throw new Error('admission must insert on the stable-message transaction');
      },
      insertClassifyTx: async (tx, input) => {
        const payload = input.payload as InboundCandidate;
        if (payload.intakeId === rootReceipt.row.id) {
          const result = await tx.execute(sql`select pg_backend_pid()::int as pid`);
          rootBackendPid = Number((result as unknown as Array<{ pid: number }>)[0]!.pid);
          markRootEntered();
          await rootGate;
        }
        const rows = await tx
          .insert(jobs)
          .values({
            tenantId: input.tenantId,
            type: input.type,
            payload,
            idempotencyKey: payload.intakeId,
            eventKey: payload.eventKey,
            stream: 'test:slack-admission-concurrency',
          })
          .returning({ id: jobs.id });
        insertedPayloads.push(payload);
        return { jobId: rows[0]!.id, inserted: true, matchedBy: null } as const;
      },
      publishJob,
    };
    const deps = { ...__fixture.classifyDeps, classifyQueue };
    const root = handleSlackEvent(
      deps,
      __fixture.classifyConfigId,
      __fixture.tenantBConfig(),
      __fixture.rootEvent({
        channel: __fixture.CLS_SUB,
        subtype: 'bot_message',
        bot_id: 'B_ALERT',
        user: undefined,
        ts: rootTs,
        event_ts: rootTs,
        text: '[FIRING:1] Checkout errors are high',
      }),
      { intakeId: rootReceipt.row.id },
    );
    await rootEntered;
    expect(
      await __fixture.redis.get(__fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, rootTs)),
    ).toBeNull();
    expect(publishJob).not.toHaveBeenCalled();
    const edit = handleSlackEvent(
      deps,
      __fixture.classifyConfigId,
      __fixture.tenantBConfig(),
      __fixture.rootEvent({
        channel: __fixture.CLS_SUB,
        subtype: 'message_changed',
        event_ts: '1788001610.000100',
        message: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B_ALERT',
          ts: rootTs,
          edited: { ts: '1788001610.000100' },
          text: '[RESOLVED] Checkout errors recovered',
        },
      }),
      { intakeId: editReceipt.row.id },
    );

    let waitFailure: unknown;
    try {
      await vi.waitFor(async () => {
        const waiters = await __fixture.admin.sql<Array<{ pid: number; blockers: number[] }>>`
          SELECT pid, pg_blocking_pids(pid) AS blockers
          FROM pg_stat_activity
          WHERE wait_event = 'advisory'
        `;
        expect(rootBackendPid).toBeDefined();
        expect(waiters.some((row) => row.blockers.includes(rootBackendPid!))).toBe(true);
      });
    } catch (error) {
      waitFailure = error;
    } finally {
      releaseRoot();
    }

    await expect(root).resolves.toBe('classify_enqueued');
    await expect(edit).resolves.toBe('edit_enqueued');
    if (waitFailure) throw waitFailure;
    expect(insertedPayloads.map((payload) => payload.intakeId)).toEqual([
      rootReceipt.row.id,
      editReceipt.row.id,
    ]);
    expect(publishJob).toHaveBeenCalledTimes(2);
    expect(
      await __fixture.redis.get(__fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, rootTs)),
    ).toBe(SLACK_CLASSIFY_PENDING);
  });

  test('five simultaneous root admissions persist classify jobs on their held transactions', async () => {
    const receipts: Array<{ row: { id: string } }> = [];
    const rootTimestamps = [];
    for (let index = 0; index < 5; index += 1) {
      const rootTs = `178800170${index}.000100`;
      rootTimestamps.push(rootTs);
      receipts.push(
        await __fixture.admin.db.transaction((tx) =>
          acceptSurfaceInboundEventTx(tx, {
            tenantId: __fixture.tenantB,
            configId: __fixture.classifyConfigId,
            surface: 'slack',
            deliveryKey: `event:pool-root-${rootTs}`,
            envelopeType: 'events_api',
            eventType: 'message',
            eventSubtype: 'bot_message',
            channel: __fixture.CLS_SUB,
            externalMessageId: rootTs,
          }),
        ),
      );
    }
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const classifyQueue: SlackInboundDeps['classifyQueue'] = {
      insertClassify: async () => {
        throw new Error('pool-saturated admission must reuse the held transaction');
      },
      insertClassifyTx: async (tx, input) => {
        const payload = input.payload as InboundCandidate;
        const rows = await tx
          .insert(jobs)
          .values({
            tenantId: input.tenantId,
            type: input.type,
            payload,
            idempotencyKey: payload.intakeId,
            eventKey: payload.eventKey,
            stream: 'test:slack-admission-concurrency',
          })
          .returning({ id: jobs.id });
        entered += 1;
        await gate;
        return { jobId: rows[0]!.id, inserted: true, matchedBy: null } as const;
      },
      publishJob: async () => undefined,
    };
    const deps = { ...__fixture.classifyDeps, classifyQueue };
    const admissions = rootTimestamps.map((rootTs, index) =>
      handleSlackEvent(
        deps,
        __fixture.classifyConfigId,
        __fixture.tenantBConfig(),
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'bot_message',
          bot_id: 'B_ALERT',
          user: undefined,
          ts: rootTs,
          event_ts: rootTs,
          text: `[FIRING:1] Checkout errors are high on shard ${index}`,
        }),
        { intakeId: receipts[index]!.row.id },
      ),
    );

    try {
      await vi.waitFor(() => expect(entered).toBe(5), { timeout: 5_000 });
    } finally {
      release();
    }
    await expect(Promise.all(admissions)).resolves.toEqual(
      rootTimestamps.map(() => 'classify_enqueued'),
    );
  }, 10_000);
});
