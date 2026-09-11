import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  applySignalObservation,
  createIncident,
  getIncident,
  jobs,
  recordSurfaceBinding,
  subscribeChannel,
} from '@sre/db';

import { handleSlackEvent, type SlackEnvelope, type SlackInboundDeps } from '../slack-inbound';

import { createFixture } from './slack-inbound.fixture';

const __fixture = createFixture();

describe('Slack inbound processors', () => {
  test("a bot's own message is ignored", async () => {
    await expect(
      __fixture.processBaseEvent(__fixture.messageEvent({}, { bot_id: 'B1' })),
    ).resolves.toBe('dropped_no_candidate');
    expect(__fixture.enqueued).toHaveLength(0);
  });

  test('a subtyped message (edit/join/etc.) is ignored', async () => {
    await expect(
      __fixture.processBaseEvent(__fixture.messageEvent({}, { subtype: 'message_changed' })),
    ).resolves.toBe('dropped_no_candidate');
    expect(__fixture.enqueued).toHaveLength(0);
  });

  test('a tracked message_changed edit is scrubbed and queued for fenced classification', async () => {
    const externalMessageId = '1787280000.000300';
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: __fixture.incidentId,
      surface: 'slack',
      channel: __fixture.CHANNEL,
      externalMessageId,
      state: 'firing',
      summary: 'Checkout error rate is high',
      contentHash: 'initial-hash',
      eventKey: `slack:${__fixture.CHANNEL}:${externalMessageId}`,
      eventAt: new Date('2026-08-21T02:00:00.000Z'),
    });

    await expect(
      __fixture.processBaseEvent({
        type: 'event_callback',
        event_id: `Ev-${randomUUID().slice(0, 8)}`,
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: __fixture.CHANNEL,
          event_ts: '1787280180.000200',
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            ts: externalMessageId,
            edited: { ts: '1787280180.000200' },
            text: 'Checkout error rate is now 20% key sk-abcdefghijklmnopqrstuvwx1234',
          },
        },
      }),
    ).resolves.toBe('edit_enqueued');

    expect(__fixture.enqueued).toHaveLength(0);
    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]).toMatchObject({
      tenantId: __fixture.tenantId,
      type: 'classify',
      payload: {
        externalId: externalMessageId,
        isEdit: true,
        text: expect.not.stringContaining('sk-abcdefghijklmnopqrstuvwx1234'),
      },
    });
  });

  test('a tracked resolved edit is queued for fenced recovery handling', async () => {
    const { id: recoveryIncidentId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `resolved-edit-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const externalMessageId = '1787280000.000301';
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: recoveryIncidentId,
      surface: 'slack',
      channel: __fixture.CHANNEL,
      externalMessageId,
      state: 'firing',
      summary:
        '<https://prometheus.example/graph?g0.expr=checkout_errors|[FIRING:1] CheckoutHighErrorRate>',
      contentHash: 'resolved-edit-initial',
      eventKey: `slack:${__fixture.CHANNEL}:${externalMessageId}:producer:bot:B_ALERT`,
      eventAt: new Date('2026-08-21T02:00:00.000Z'),
    });

    await expect(
      __fixture.processBaseEvent({
        type: 'event_callback',
        event_id: `Ev-${randomUUID().slice(0, 8)}`,
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: __fixture.CHANNEL,
          event_ts: '1787280181.000200',
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            ts: externalMessageId,
            edited: { ts: '1787280181.000200' },
            text: '',
            attachments: [
              {
                title: '[RESOLVED] CheckoutHighErrorRate',
                title_link: 'https://prometheus.example/graph?g0.expr=checkout_errors',
              },
            ],
          },
        },
      }),
    ).resolves.toBe('edit_enqueued');

    expect(__fixture.enqueued).toHaveLength(0);
    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]).toMatchObject({
      tenantId: __fixture.tenantId,
      type: 'classify',
      payload: {
        externalId: externalMessageId,
        isEdit: true,
        signalState: 'resolved',
      },
    });
  });

  test('a reply in a different channel is ignored', async () => {
    await expect(
      __fixture.processBaseEvent(__fixture.messageEvent({}, { channel: 'C-OTHER' })),
    ).resolves.toBe('dropped_unsubscribed');
    expect(__fixture.enqueued).toHaveLength(0);
  });

  // the incident's thread is wherever the alert landed, which is NOT necessarily the channel
  // The resume gate keys off the BINDING, so a human reply in a bound thread must be ingested no
  // matter which channel that thread lives in. The gate used to compare against a configured channel,
  // which dropped the reply, and the human's instruction was silently lost.
  test('a human reply in a bound thread outside the configured channel is accepted', async () => {
    const originChannel = __fixture.ORIGIN_CHANNEL; // != CHANNEL: the alert landed here, so the thread lives here
    const threadTs = '1799.0001';
    const { id: otherChannelIncident } = await createIncident(
      __fixture.app.db,
      __fixture.tenantId,
      {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      },
    );
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: otherChannelIncident,
      surface: 'slack',
      channel: originChannel,
      threadId: threadTs,
    });

    await expect(
      __fixture.processBaseEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-other-channel' },
          {
            channel: originChannel,
            thread_ts: threadTs,
            ts: '1799.0002',
            text: 'roll it back',
          },
        ),
      ),
    ).resolves.toBe('resume_enqueued');

    const history = await __fixture.hub.history(__fixture.tenantId, otherChannelIncident);
    const human = history.find((m) => m.author === 'human' && m.content === 'roll it back');
    expect(human).toBeDefined(); // ingested into the hub, not dropped by the channel gate
    expect(human!.originSurface).toBe('slack');

    // ...and the engine is resumed for THAT incident.
    const resumes = __fixture.enqueued.filter((e) => e.type === 'resume');
    expect(resumes).toHaveLength(1);
    expect((resumes[0]!.payload as { incidentId: string }).incidentId).toBe(otherChannelIncident);
  });

  test('a reply in an untracked thread is acked and ignored', async () => {
    await expect(
      __fixture.processBaseEvent(__fixture.messageEvent({}, { thread_ts: '9999.9999' })),
    ).resolves.toBe('dropped_untracked_thread');
    expect(__fixture.enqueued).toHaveLength(0);
  });

  // the channel subscription is the platform's ONLY per-channel inbound control, so disabling a
  // channel must revoke the threads it already created — not just stop new ones. Gating the resume path
  // on the binding alone let anyone in a disabled channel keep driving the engine (tools, connector reads,
  // LLM egress) under an old incident, forever.
  test('disabling a channel stops replies in the threads it already created', async () => {
    const threadTs = '1801.0001';
    const { id: revokedIncident } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: revokedIncident,
      surface: 'slack',
      channel: __fixture.REVOKED_CHANNEL,
      threadId: threadTs,
    });
    await subscribeChannel(__fixture.app.db, {
      tenantId: __fixture.tenantId,
      surface: 'slack',
      channel: __fixture.REVOKED_CHANNEL,
      enabled: true,
    });

    // While the channel is subscribed the reply is ingested and resumes the incident.
    await expect(
      __fixture.processBaseEvent(
        __fixture.messageEvent(
          {},
          { channel: __fixture.REVOKED_CHANNEL, thread_ts: threadTs, ts: '1801.0002' },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    expect(__fixture.enqueued.filter((e) => e.type === 'resume')).toHaveLength(1);

    // The operator turns the channel off.
    await subscribeChannel(__fixture.app.db, {
      tenantId: __fixture.tenantId,
      surface: 'slack',
      channel: __fixture.REVOKED_CHANNEL,
      enabled: false,
    });

    await expect(
      __fixture.processBaseEvent(
        __fixture.messageEvent(
          {},
          {
            channel: __fixture.REVOKED_CHANNEL,
            thread_ts: threadTs,
            ts: '1801.0003',
            text: 'still here?',
          },
        ),
      ),
    ).resolves.toBe('dropped_unsubscribed');
    expect(__fixture.enqueued.filter((e) => e.type === 'resume')).toHaveLength(1); // ...but NOT ingested
    const history = await __fixture.hub.history(__fixture.tenantId, revokedIncident);
    expect(history.some((m) => m.content === 'still here?')).toBe(false);
  });

  test('a redelivered Slack message is durably deduped: one hub append, one resume', async () => {
    const event = __fixture.messageEvent({ event_id: 'Ev-dup-1' }, { text: 'dedup slack' });
    await expect(__fixture.processBaseEvent(event)).resolves.toBe('resume_enqueued');
    await expect(__fixture.processBaseEvent(event)).resolves.toBe('dropped_duplicate');

    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId);
    expect(history.filter((m) => m.content === 'dedup slack')).toHaveLength(1);
    expect(__fixture.enqueued).toHaveLength(1);
  });

  test('dedupes the same Slack message even when Slack assigns a different event_id', async () => {
    const message = { ts: '1802.0001', text: 'same message, new envelope' };
    await expect(
      __fixture.processBaseEvent(__fixture.messageEvent({ event_id: 'Ev-redelivery-a' }, message)),
    ).resolves.toBe('resume_enqueued');
    await expect(
      __fixture.processBaseEvent(__fixture.messageEvent({ event_id: 'Ev-redelivery-b' }, message)),
    ).resolves.toBe('dropped_duplicate');

    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId);
    expect(history.filter((m) => m.content === message.text)).toHaveLength(1);
    expect(__fixture.enqueued).toHaveLength(1);
  });

  test('retries a reply cleanly when the atomic resume transaction rolls back', async () => {
    let failInsert = true;
    const insertedMessageIds: string[] = [];
    const retryDeps: SlackInboundDeps = {
      ...__fixture.baseDeps,
      queue: {
        ...__fixture.queue,
        insertResumeTx: async (_tx, _tenantId, _incidentId, humanMessageId) => {
          if (failInsert) {
            failInsert = false;
            throw new Error('resume insert failed');
          }
          insertedMessageIds.push(humanMessageId);
          return { jobId: 'retry-job' };
        },
      },
    };
    const message = { ts: '1802.0002', text: 'must survive transaction rollback' };

    await expect(
      handleSlackEvent(
        retryDeps,
        __fixture.slackConfigId,
        __fixture.tenantAConfig(),
        __fixture.messageEvent({ event_id: 'Ev-tx-fail' }, message) as SlackEnvelope,
      ),
    ).rejects.toThrow('resume insert failed');
    expect(
      (await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId)).filter(
        (m) => m.content === message.text,
      ),
    ).toHaveLength(0);

    await expect(
      handleSlackEvent(
        retryDeps,
        __fixture.slackConfigId,
        __fixture.tenantAConfig(),
        __fixture.messageEvent({ event_id: 'Ev-tx-retry' }, message) as SlackEnvelope,
      ),
    ).resolves.toBe('resume_enqueued');
    const persisted = (
      await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId)
    ).filter((m) => m.content === message.text);
    expect(persisted).toHaveLength(1);
    expect(insertedMessageIds).toEqual([persisted[0]!.id]);
  });

  test('a thread_broadcast reply ("also send to channel") is processed, not dropped', async () => {
    await expect(
      __fixture.processBaseEvent(
        __fixture.messageEvent({}, { subtype: 'thread_broadcast', text: 'broadcast: roll back' }),
      ),
    ).resolves.toBe('resume_enqueued');

    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId);
    expect(history.some((m) => m.author === 'human' && m.content === 'broadcast: roll back')).toBe(
      true,
    );
    expect(__fixture.enqueued).toHaveLength(1);
  });

  // two thread replies that land while a resume is still queued must coalesce cleanly via the
  // durable partial-unique index — one queued job, no throw swallowed by onError. Uses the LIVE Queue.
  test('coalescing: a second thread reply while a resume is queued coalesces to one job, no drop/throw', async () => {
    __fixture.coalesceOnErrors.length = 0;
    const threadTs = `1699.co-${randomUUID().slice(0, 6)}`;
    const { id: coIncidentId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: coIncidentId,
      surface: 'slack',
      channel: __fixture.CHANNEL,
      threadId: threadTs,
    });

    await expect(
      handleSlackEvent(
        __fixture.coalesceDeps,
        __fixture.slackConfigId,
        __fixture.tenantAConfig(),
        __fixture.messageEvent(
          { event_id: `Ev-co-${randomUUID().slice(0, 6)}` },
          {
            text: 'first reply',
            thread_ts: threadTs,
            ts: '1699.co01',
          },
        ) as SlackEnvelope,
      ),
    ).resolves.toBe('resume_enqueued');
    await expect(
      handleSlackEvent(
        __fixture.coalesceDeps,
        __fixture.slackConfigId,
        __fixture.tenantAConfig(),
        __fixture.messageEvent(
          { event_id: `Ev-co-${randomUUID().slice(0, 6)}` },
          {
            text: 'second reply lands mid-run',
            thread_ts: threadTs,
            ts: '1699.co02',
          },
        ) as SlackEnvelope,
      ),
    ).resolves.toBe('resume_enqueued');
    // No swallowed error: the second insert coalesced via ON CONFLICT DO NOTHING, it did not unique-
    // violate (the pre-fix queue.enqueue would have thrown and landed in onError).
    expect(__fixture.coalesceOnErrors).toHaveLength(0);
    // Exactly one queued resume job for this incident, and both human replies are durably appended.
    const queued = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(
        sql`tenant_id = ${__fixture.tenantId} and type = 'resume' and status = 'queued' and payload->>'incidentId' = ${coIncidentId}`,
      );
    expect(queued).toHaveLength(1);
    const history = await __fixture.hub.history(__fixture.tenantId, coIncidentId);
    expect(history.filter((m) => m.author === 'human')).toHaveLength(2);
  });

  test('a block_actions tap records the decision (first-wins)', async () => {
    await expect(
      __fixture.processInteraction(__fixture.blockActions(`${__fixture.approvalId}:yes`)),
    ).resolves.toBe('interaction_processed');

    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId);
    expect(
      history.some(
        (m) => m.author === 'human' && m.originSurface === 'slack' && m.content.includes('Yes'),
      ),
    ).toBe(true);

    // A second tap loses the CAS: acks 200, no new decision message.
    const before = (await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId)).length;
    await expect(
      __fixture.processInteraction(__fixture.blockActions(`${__fixture.approvalId}:no`)),
    ).resolves.toBe('interaction_processed');
    expect((await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId)).length).toBe(
      before,
    );
  });

  test('lifecycle buttons apply one audited transition and reject a stale rendered version', async () => {
    __fixture.usersInfoImpl = async () => __fixture.ATTR_EMAIL;
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `slack-lifecycle-button-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const mitigate = __fixture.lifecycleBlockActions(id, 'mitigated', 0, '1787550000.000001');

    await expect(__fixture.processInteraction(mitigate, __fixture.attrDeps)).resolves.toBe(
      'interaction_processed',
    );
    await expect(__fixture.processInteraction(mitigate, __fixture.attrDeps)).resolves.toBe(
      'interaction_processed',
    );
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'mitigated',
      lifecycleVersion: 1,
    });

    await expect(
      __fixture.processInteraction(
        __fixture.lifecycleBlockActions(id, 'resolved', 0, '1787550000.000002'),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('interaction_processed');
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'mitigated',
      lifecycleVersion: 1,
    });

    await expect(
      __fixture.processInteraction(
        __fixture.lifecycleBlockActions(id, 'resolved', 1, '1787550000.000003'),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('interaction_processed');
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 2,
    });
    const lifecycle = (await __fixture.hub.history(__fixture.tenantId, id)).filter(
      (message) => message.kind === 'lifecycle',
    );
    expect(lifecycle.map((message) => message.lifecycleTo)).toEqual(['mitigated', 'resolved']);
    expect(lifecycle[0]).toMatchObject({
      author: 'human',
      originSurface: 'slack',
      content: expect.stringContaining('from Slack'),
    });
  });

  test('a legacy acknowledgement button cannot mutate the incident', async () => {
    __fixture.usersInfoImpl = async () => __fixture.ATTR_EMAIL;
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `slack-removed-ack-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const value = JSON.stringify({ incidentId: id, to: 'acknowledged', expectedVersion: 0 });
    await expect(
      __fixture.processInteraction(
        {
          type: 'block_actions',
          user: { id: 'U_LIFECYCLE', username: 'sre-jane' },
          actions: [
            {
              action_id: 'incident_lifecycle:acknowledged',
              action_ts: '1787550000.0000035',
              value,
            },
          ],
        },
        __fixture.attrDeps,
      ),
    ).resolves.toBe('dropped_no_candidate');
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      lifecycleVersion: 0,
    });
  });

  test("a lifecycle button cannot mutate another tenant's incident", async () => {
    __fixture.usersInfoImpl = async () => __fixture.ATTR_EMAIL;
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `slack-lifecycle-cross-tenant-${randomUUID()}`,
      alertSource: 'slack',
      service: 'billing',
      severity: 'sev2',
    });

    await expect(
      __fixture.processInteraction(
        __fixture.lifecycleBlockActions(id, 'mitigated', 0, '1787550000.000004'),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('interaction_processed');
    expect(await getIncident(__fixture.app.db, __fixture.tenantB, id)).toMatchObject({
      status: 'open',
      lifecycleVersion: 0,
    });
  });
});
