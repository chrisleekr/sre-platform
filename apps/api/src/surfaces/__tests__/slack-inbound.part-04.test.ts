import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  applySignalObservation,
  createIncident,
  incidentSignals,
  incidents,
  lockIncidentWorkTx,
  recordSurfaceBinding,
  withTenant,
} from '@sre/db';

import { handleSlackEvent } from '../slack-inbound';

import { createFixture } from './slack-inbound.fixture';

const __fixture = createFixture();

describe('Slack inbound processors', () => {
  test('a control edit resolves a signal admitted before the provider semantics were recognized', async () => {
    const rootTs = '1788001000.000100';
    const incident = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `control-edit-${randomUUID()}`,
      alertSource: 'slack',
      service: 'monitoring',
      severity: 'sev3',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
      incidentId: incident.id,
      surface: 'slack',
      channel: __fixture.CLS_SUB,
      externalMessageId: rootTs,
      state: 'firing',
      summary: 'Initially admitted provider notification',
      contentHash: 'initial-control-content',
      eventKey: `slack:${__fixture.CLS_SUB}:${rootTs}:initial`,
      eventAt: new Date('2026-08-29T00:00:00.000Z'),
    });

    const outcome = await __fixture.processClassifyEvent(
      __fixture.rootEvent({
        channel: __fixture.CLS_SUB,
        subtype: 'message_changed',
        event_ts: '1788001010.000100',
        message: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B_ALERT',
          text: '*Alert:* InfoInhibitor',
          ts: rootTs,
          edited: { ts: '1788001010.000100' },
          attachments: [
            {
              fallback: 'Provider control notification',
              fields: [
                { title: 'Severity', value: 'none' },
                { title: 'Receiver', value: 'null' },
              ],
            },
          ],
        },
      }),
    );

    expect(outcome).toBe('suppressed_provider_control_notification');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
    expect(
      await __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, incident.id)),
    ).toEqual([expect.objectContaining({ state: 'resolved', version: 2 })]);
    expect(__fixture.enqueued).toEqual([
      expect.objectContaining({
        tenantId: __fixture.tenantB,
        type: 'recovery.verify',
        payload: expect.objectContaining({ incidentId: incident.id }),
      }),
    ]);
  });

  test('a control edit reassesses the incident when another distinct signal remains firing', async () => {
    const rootTs = '1788001100.000100';
    const incident = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `control-edit-partial-${randomUUID()}`,
      alertSource: 'slack',
      service: 'monitoring',
      severity: 'sev3',
    });
    const target = await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
      incidentId: incident.id,
      surface: 'slack',
      channel: __fixture.CLS_SUB,
      externalMessageId: rootTs,
      state: 'firing',
      summary: 'Provider control notification admitted before adapter correction',
      contentHash: 'partial-control-content',
      eventKey: `slack:${__fixture.CLS_SUB}:${rootTs}:initial`,
      eventAt: new Date('2026-08-29T00:00:00.000Z'),
    });
    const distinct = await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
      incidentId: incident.id,
      surface: 'slack',
      channel: __fixture.CLS_SUB,
      externalMessageId: `${rootTs}-distinct`,
      state: 'firing',
      summary: 'Checkout latency remains high',
      contentHash: 'distinct-firing-content',
      eventKey: `slack:${__fixture.CLS_SUB}:${rootTs}:distinct`,
      eventAt: new Date('2026-08-29T00:00:01.000Z'),
    });

    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'message_changed',
          event_ts: '1788001110.000100',
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            text: '*Alert:* InfoInhibitor',
            ts: rootTs,
            edited: { ts: '1788001110.000100' },
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
      ),
    ).resolves.toBe('suppressed_provider_control_notification');

    const rows = await __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incident.id));
    expect(rows.find((row) => row.id === target.signal.id)).toMatchObject({
      state: 'resolved',
      version: 2,
    });
    expect(rows.find((row) => row.id === distinct.signal.id)).toMatchObject({
      state: 'firing',
      version: 1,
    });
    expect(__fixture.enqueued).toEqual([
      expect.objectContaining({
        tenantId: __fixture.tenantB,
        type: 'signal.reassess',
        payload: expect.objectContaining({
          incidentId: incident.id,
          signalId: target.signal.id,
          signalVersion: 2,
        }),
      }),
    ]);
  });

  test('a control edit follows a signal moved while suppression waits for its incident lock', async () => {
    const rootTs = '1788001200.000100';
    const source = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `control-move-source-${randomUUID()}`,
      alertSource: 'slack',
      service: 'monitoring-source',
      severity: 'sev3',
    });
    const target = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `control-move-target-${randomUUID()}`,
      alertSource: 'slack',
      service: 'monitoring-target',
      severity: 'sev3',
    });
    const observed = await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
      incidentId: source.id,
      surface: 'slack',
      channel: __fixture.CLS_SUB,
      externalMessageId: rootTs,
      state: 'firing',
      summary: 'Provider control notification awaiting correction',
      contentHash: 'moving-control-content',
      eventKey: `slack:${__fixture.CLS_SUB}:${rootTs}:initial`,
      eventAt: new Date('2026-08-29T00:00:00.000Z'),
    });

    let releaseMove!: () => void;
    const moveGate = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    let markMoved!: () => void;
    let blockerPid: number | null = null;
    const moved = new Promise<void>((resolve) => {
      markMoved = resolve;
    });
    const move = withTenant(__fixture.app.db, __fixture.tenantB, async (tx) => {
      await lockIncidentWorkTx(tx, __fixture.tenantB, [source.id, target.id]);
      await tx
        .update(incidentSignals)
        .set({ incidentId: target.id })
        .where(eq(incidentSignals.id, observed.signal.id));
      const [backend] = await tx
        .select({ pid: sql<number>`pg_backend_pid()` })
        .from(incidents)
        .where(eq(incidents.id, source.id))
        .limit(1);
      blockerPid = backend!.pid;
      markMoved();
      await moveGate;
    });
    await moved;

    let suppressionSettled = false;
    const suppression = __fixture
      .processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'message_changed',
          event_ts: '1788001210.000100',
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            text: '*Alert:* InfoInhibitor',
            ts: rootTs,
            edited: { ts: '1788001210.000100' },
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
      )
      .finally(() => {
        suppressionSettled = true;
      });
    try {
      await vi.waitFor(
        async () => {
          const [row] = await __fixture.admin.sql<Array<{ waiting: number }>>`
            SELECT count(*)::int AS waiting
            FROM pg_stat_activity
            WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
          `;
          expect(row?.waiting).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
    } finally {
      releaseMove();
    }
    expect(suppressionSettled).toBe(false);
    await move;
    await expect(suppression).resolves.toBe('suppressed_provider_control_notification');

    await expect(
      __fixture.admin.db
        .select({ incidentId: incidentSignals.incidentId, state: incidentSignals.state })
        .from(incidentSignals)
        .where(eq(incidentSignals.id, observed.signal.id)),
    ).resolves.toEqual([{ incidentId: target.id, state: 'resolved' }]);
    expect(__fixture.enqueued).toEqual([
      expect.objectContaining({
        tenantId: __fixture.tenantB,
        type: 'recovery.verify',
        payload: expect.objectContaining({ incidentId: target.id }),
      }),
    ]);
  });

  test('a grouped resolved edit is classified from durable members after the reservation expires', async () => {
    const ts = __fixture.nextTs();
    const groupedIncidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantB, {
        fingerprint: `grouped-edit-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    for (const [member, alertName] of [
      ['latency', 'Checkout latency is high.'],
      ['errors', 'Checkout errors are high.'],
    ] as const) {
      await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
        incidentId: groupedIncidentId,
        surface: 'slack',
        channel: __fixture.CLS_SUB,
        externalMessageId: `${ts}#${member}`,
        state: 'firing',
        summary: alertName,
        contentHash: `${member}-firing`,
        eventKey: `slack:${__fixture.CLS_SUB}:${ts}:observation:${member}:producer:bot:B_ALERT`,
        eventAt: new Date('2026-08-21T00:00:00.000Z'),
        provider: 'prometheus-alertmanager',
        providerGroupKey: 'alertmanager:https://alerts.example|checkout',
        alertName,
      });
    }
    expect(
      await __fixture.redis.get(__fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, ts)),
    ).toBeNull();
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          bot_id: 'B_ALERT',
          user: undefined,
          subtype: 'message_changed',
          ts,
          text: [
            '[RESOLVED:2] checkout | <https://alerts.example>',
            '*Alert:* Checkout latency is high.',
            '*Description:* latency recovered.',
            '*Severity:* `warning`',
            '*Source:* Prometheus Alertmanager',
            '*Alert:* Checkout errors are high.',
            '*Description:* errors recovered.',
            '*Severity:* `critical`',
            '*Source:* Prometheus Alertmanager',
          ].join(' '),
        }),
      ),
    ).resolves.toBe('edit_enqueued');

    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]!.payload).toMatchObject({
      isEdit: true,
      signalState: 'resolved',
      observations: [
        expect.objectContaining({ alertName: 'Checkout latency is high.' }),
        expect.objectContaining({ alertName: 'Checkout errors are high.' }),
      ],
    });
  });

  test('C9 classify: an edit for a root the platform never observed is dropped', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          user: 'U_HUMAN',
          text: 'old edited text',
          subtype: 'message_changed',
          ts: __fixture.nextTs(),
        }),
      ),
    ).resolves.toBe('dropped_untracked_edit');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });

  test('C9 classify: an edit for a terminal not-worthy root is dropped without retry work', async () => {
    const ts = __fixture.nextTs();
    await __fixture.redis.set(
      __fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, ts),
      'terminal',
      'EX',
      86_400,
    );
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          user: 'U_HUMAN',
          text: 'edited chatter',
          subtype: 'message_changed',
          ts,
        }),
      ),
    ).resolves.toBe('dropped_untracked_edit');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });

  // --- Mention pull path: app_mention creates/resumes bypassing the worthy classifier -----

  test('mention C1: a top-level app_mention in an allowlisted channel enqueues one classify job tagged kind:mention with rootTs === ev.ts', async () => {
    const ts = __fixture.nextTs();
    await expect(
      __fixture.processClassifyEvent(
        __fixture.mentionEvent({
          ts,
          channel: __fixture.CLS_SUB,
          user: 'U_HUMAN',
          text: `<@${__fixture.SELF_BOT}> checkout is down`,
        }),
      ),
    ).resolves.toBe('mention_enqueued');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]).toMatchObject({
      tenantId: __fixture.tenantB,
      type: 'classify',
    });
    const p = __fixture.classifyEnqueued[0]!.payload as {
      kind: string;
      channel: string;
      rootTs: string;
      ts: string;
      user: string;
      text: string;
    };
    expect(p.kind).toBe('mention');
    expect(p.channel).toBe(__fixture.CLS_SUB);
    expect(p.rootTs).toBe(ts); // a top-level mention roots at its own ts
    expect(p.ts).toBe(ts);
    expect(p.user).toBe('U_HUMAN');
    expect(p.text).toContain('checkout is down');
  });

  test('mention C2: an app_mention reply in an untracked thread enqueues a mention job with rootTs === thread_ts (root, not the reply ts)', async () => {
    const ts = __fixture.nextTs();
    const threadTs = '1701.9999'; // no binding exists for CLS_SUB:1701.9999
    await expect(
      __fixture.processClassifyEvent(
        __fixture.mentionEvent({ ts, thread_ts: threadTs, channel: __fixture.CLS_SUB }),
      ),
    ).resolves.toBe('mention_enqueued');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
    const p = __fixture.classifyEnqueued[0]!.payload as {
      kind: string;
      rootTs: string;
      ts: string;
    };
    expect(p.kind).toBe('mention');
    expect(p.rootTs).toBe(threadTs);
    expect(p.ts).toBe(ts);
  });

  test('mention C3: an app_mention in a thread WITH a binding resumes the incident (no classify job)', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.mentionEvent({
          ts: __fixture.nextTs(),
          thread_ts: __fixture.ROOT_C3,
          channel: __fixture.CLS_SUB,
          text: `<@${__fixture.SELF_BOT}> please roll back`,
        }),
      ),
    ).resolves.toBe('resume_enqueued');
    expect(__fixture.classifyEnqueued).toHaveLength(0); // resume, not create

    const resumeJobs = __fixture.enqueued.filter((j) => j.type === 'resume');
    expect(resumeJobs).toHaveLength(1);
    expect((resumeJobs[0]!.payload as { incidentId: string }).incidentId).toBe(
      __fixture.mentionIncidentId,
    );

    const history = await __fixture.hub.history(__fixture.tenantB, __fixture.mentionIncidentId);
    expect(
      history.some(
        (m) =>
          m.author === 'human' && m.originSurface === 'slack' && m.content.includes('roll back'),
      ),
    ).toBe(true);
  });

  test('mention C3: an app_mention in an archived tracked thread is acknowledged without a resume', async () => {
    const threadTs = '1701.7001';
    const { id: archivedIncidentId } = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ status: 'resolved', archivedAt: new Date() })
      .where(sql`${incidents.id} = ${archivedIncidentId}`);
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantB, {
      incidentId: archivedIncidentId,
      surface: 'slack',
      channel: __fixture.CLS_SUB,
      threadId: threadTs,
    });

    await expect(
      __fixture.processClassifyEvent(
        __fixture.mentionEvent({
          ts: __fixture.nextTs(),
          thread_ts: threadTs,
          channel: __fixture.CLS_SUB,
          text: `<@${__fixture.SELF_BOT}> wake the old incident`,
        }),
      ),
    ).resolves.toBe('dropped_archived');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
    expect(__fixture.enqueued).toHaveLength(0);
    expect(
      (await __fixture.hub.history(__fixture.tenantB, archivedIncidentId)).some(
        (m) => m.author === 'human',
      ),
    ).toBe(false);
  });

  test('mention resume: a secret pasted in an app_mention on a bound thread is scrubbed before it reaches the hub', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.mentionEvent({
          ts: __fixture.nextTs(),
          thread_ts: __fixture.ROOT_C3,
          channel: __fixture.CLS_SUB,
          text: `<@${__fixture.SELF_BOT}> retry with AKIAIOSFODNN7EXAMPLE`,
        }),
      ),
    ).resolves.toBe('resume_enqueued');

    const history = await __fixture.hub.history(__fixture.tenantB, __fixture.mentionIncidentId);
    const human = history.find((m) => m.author === 'human' && m.content.includes('retry with'));
    expect(human).toBeDefined();
    expect(human!.content).toContain('[REDACTED]');
    expect(human!.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  test('mention C4-suppress: a plain message whose text mentions the bot does NOT enqueue a classify job (app_mention owns it)', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          user: 'U_HUMAN',
          text: `<@${__fixture.SELF_BOT}> checkout down`,
          ts: __fixture.nextTs(),
        }),
      ),
    ).resolves.toBe('dropped_mention_twin');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });

  test('mention C4-suppress: a plain message thread-reply mentioning the bot in a tracked thread does NOT enqueue a resume', async () => {
    await expect(
      __fixture.processClassifyEvent({
        type: 'event_callback',
        event_id: `Ev-${randomUUID().slice(0, 8)}`,
        event: {
          type: 'message',
          channel: __fixture.CLS_TARGET,
          user: 'U_HUMAN',
          text: `<@${__fixture.SELF_BOT}> please look`,
          thread_ts: __fixture.ROOT_C4B,
          ts: __fixture.nextTs(),
        },
      }),
    ).resolves.toBe('dropped_mention_twin');
    expect(__fixture.enqueued.filter((j) => j.type === 'resume')).toHaveLength(0);
  });

  test('mention C6-idempotent: the same app_mention delivered twice enqueues at most one classify job (mention ts reservation)', async () => {
    const event = __fixture.mentionEvent({ ts: __fixture.nextTs(), channel: __fixture.CLS_SUB });
    await expect(__fixture.processClassifyEvent(event)).resolves.toBe('mention_enqueued');
    await expect(__fixture.processClassifyEvent(event)).resolves.toBe('dropped_duplicate');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
  });

  test('mention gating: an app_mention in a non-allowlisted channel does nothing', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.mentionEvent({ channel: __fixture.CLS_NONE, ts: __fixture.nextTs() }),
      ),
    ).resolves.toBe('dropped_unsubscribed');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });

  test('mention gating: an app_mention with an EMPTY botUserId skips the mention branch (no double-incident)', async () => {
    // With botUserId unset the message-twin suppression cannot fire, so firing the mention branch would
    // open a SECOND incident from the same mention. The branch must ack + skip, deferring to the
    // classify path.
    await expect(
      handleSlackEvent(
        __fixture.classifyDeps,
        __fixture.classifyConfigId,
        { ...__fixture.tenantBConfig(), botUserId: '' },
        __fixture.mentionEvent({ channel: __fixture.CLS_SUB, ts: __fixture.nextTs() }),
      ),
    ).resolves.toBe('dropped_no_candidate');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });
});
