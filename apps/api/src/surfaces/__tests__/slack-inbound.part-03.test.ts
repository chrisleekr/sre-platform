import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  createApproval,
  createIncident,
  getIncident,
  memberships,
  persistSurfaceIdentity,
  users,
} from '@sre/db';

import { createFixture } from './slack-inbound.fixture';

const __fixture = createFixture();

describe('Slack inbound processors', () => {
  test('a lifecycle button from an unprovisioned Slack user fails closed', async () => {
    __fixture.usersInfoImpl = async () => 'workspace-guest@example.com';
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `slack-lifecycle-unauthorized-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });

    await expect(
      __fixture.processInteraction(
        __fixture.lifecycleBlockActions(
          id,
          'mitigated',
          0,
          '1787550000.000005',
          'U_LIFECYCLE_GUEST',
        ),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('dropped_unauthorized');
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      lifecycleVersion: 0,
    });
  });

  test("a tap referencing another tenant's approval is ignored (cross-tenant guard)", async () => {
    const before = (await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId)).length;
    await expect(
      __fixture.processInteraction(__fixture.blockActions(`${__fixture.approvalIdB}:yes`)),
    ).resolves.toBe('interaction_processed');
    expect((await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId)).length).toBe(
      before,
    );
  });

  // (C6): the Slack decide path must ALSO enqueue a resume when a tap WINS the CAS, so
  // both surfaces resume the engine (today it appends 'decided' but never resumes — the bug to fix). A
  // losing/duplicate tap must NOT enqueue a second resume. Fresh approval so the CAS is unconsumed.
  test('C6 resume parity: a winning approval tap enqueues a resume; a losing/duplicate tap does not', async () => {
    const { row: approval } = await createApproval(__fixture.app.db, __fixture.tenantId, {
      incidentId: __fixture.incidentId,
      actionId: `act-decide-${randomUUID().slice(0, 8)}`,
      prompt: 'Roll back?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    });

    // Winning tap: records the decision AND enqueues exactly one resume for this incident.
    await expect(
      __fixture.processInteraction(__fixture.blockActions(`${approval.id}:yes`)),
    ).resolves.toBe('interaction_processed');
    const resumes = __fixture.enqueued.filter((e) => e.type === 'resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ tenantId: __fixture.tenantId });
    expect((resumes[0]!.payload as { incidentId: string }).incidentId).toBe(__fixture.incidentId);

    // Duplicate tap loses the CAS: acks 200, no second resume enqueued.
    await expect(
      __fixture.processInteraction(__fixture.blockActions(`${approval.id}:no`)),
    ).resolves.toBe('interaction_processed');
    expect(__fixture.enqueued.filter((e) => e.type === 'resume')).toHaveLength(1);
  });

  // --- Auto-attribution of an approval decider --------------------------------------------
  // A tap's 'decided:' reply carries the approver, resolved through the same seam as a human reply:
  // surface_identities cache → users.info → exactly-one tenant member. Resolution runs BEFORE the decide tx
  // and is non-fatal (null on any miss), and a decision is NEVER credited to the wrong person.

  test('C1 attribution: a block_actions tap stamps the approver as author_user_id', async () => {
    __fixture.usersInfoImpl = async () => __fixture.ATTR_EMAIL;
    const appr = await __fixture.freshApproval();
    await expect(
      __fixture.processInteraction(
        __fixture.blockActions(`${appr.id}:yes`, { username: 'sre-jane', id: __fixture.U_APPR_C1 }),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('interaction_processed');
    const decided = await __fixture.decidedReply(appr.id);
    expect(decided).toBeDefined();
    expect(decided!.content).toBe('decided: Yes');
    expect(decided!.authorUserId).toBe(__fixture.attrMemberUserId);
  });

  test('C2 attribution: an approver email matching no tenant member records the decision with author_user_id null (never-wrong-person)', async () => {
    __fixture.usersInfoImpl = async () => 'stranger@x.io';
    const appr = await __fixture.freshApproval();
    await expect(
      __fixture.processInteraction(
        __fixture.blockActions(`${appr.id}:yes`, {
          username: 'sre-nobody',
          id: __fixture.U_APPR_C2_NONE,
        }),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('interaction_processed');
    const decided = await __fixture.decidedReply(appr.id);
    expect(decided).toBeDefined(); // the decision is still recorded, just unattributed
    expect(decided!.content).toBe('decided: Yes');
    expect(decided!.authorUserId ?? null).toBeNull();
  });

  test('C2 attribution: an approver email matching TWO tenant members is ambiguous — decision recorded with author_user_id null', async () => {
    // Pin the precondition: this case only differs from the no-match case above by the fixture producing
    // TWO members. If it ever drifts to zero, the null assertion below would still pass and this would
    // silently become a duplicate of that test, losing the ambiguity guard with nothing to say so.
    const carriers = await __fixture.admin.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(memberships, sql`${memberships.userId} = ${users.id}`)
      .where(
        sql`${memberships.tenantId} = ${__fixture.tenantId} and lower(${users.email}) = ${__fixture.APPR_AMBIG_EMAIL}`,
      );
    expect(carriers).toHaveLength(2);

    __fixture.usersInfoImpl = async () => __fixture.APPR_AMBIG_EMAIL; // two members carry it → resolveUserByEmail returns null
    const appr = await __fixture.freshApproval();
    await expect(
      __fixture.processInteraction(
        __fixture.blockActions(`${appr.id}:yes`, {
          username: 'sre-twin',
          id: __fixture.U_APPR_C2_AMBIG,
        }),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('interaction_processed');
    const decided = await __fixture.decidedReply(appr.id);
    expect(decided).toBeDefined();
    expect(decided!.content).toBe('decided: Yes');
    expect(decided!.authorUserId ?? null).toBeNull(); // guessing either twin would credit the wrong person
  });

  test('C3 attribution: no retrievable approver email records the decision with author_user_id null AND still enqueues the resume (non-fatal)', async () => {
    __fixture.usersInfoImpl = async () => null; // users.info error / missing email / bot author
    const appr = await __fixture.freshApproval();
    await expect(
      __fixture.processInteraction(
        __fixture.blockActions(`${appr.id}:yes`, {
          username: 'sre-noemail',
          id: __fixture.U_APPR_C3,
        }),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('interaction_processed');
    const decided = await __fixture.decidedReply(appr.id);
    expect(decided).toBeDefined();
    expect(decided!.authorUserId ?? null).toBeNull();
    expect(__fixture.enqueued.filter((e) => e.type === 'resume')).toHaveLength(1); // the decision still resumes
  });

  test('C3 attribution: a users.info error is swallowed — the decision and its resume still land, author_user_id null (non-fatal)', async () => {
    __fixture.usersInfoImpl = async () => {
      throw new Error('users.info 500'); // a real network/DB fault, not just a missing email
    };
    const appr = await __fixture.freshApproval();
    await expect(
      __fixture.processInteraction(
        __fixture.blockActions(`${appr.id}:yes`, {
          username: 'sre-boom',
          id: __fixture.U_APPR_C3_ERR,
        }),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('interaction_processed');
    // C6: a failed resolve must not roll back the CAS + append + resume — attribution is best-effort.
    const decided = await __fixture.decidedReply(appr.id);
    expect(decided).toBeDefined();
    expect(decided!.content).toBe('decided: Yes');
    expect(decided!.authorUserId ?? null).toBeNull();
    expect(__fixture.enqueued.filter((e) => e.type === 'resume')).toHaveLength(1);
  });

  test('C4 attribution: an already-cached approver Slack id uses the cache and does NOT call users.info', async () => {
    await persistSurfaceIdentity(__fixture.app.db, __fixture.tenantId, {
      surface: 'slack',
      surfaceUserId: __fixture.U_APPR_C4,
      authorUserId: __fixture.attrMemberUserId,
      source: 'auto',
    });
    __fixture.usersInfoImpl = async () => __fixture.ATTR_EMAIL; // would resolve, but a cache hit must not consult it
    __fixture.usersInfoCalls.length = 0;
    const appr = await __fixture.freshApproval();
    await expect(
      __fixture.processInteraction(
        __fixture.blockActions(`${appr.id}:yes`, {
          username: 'sre-cached',
          id: __fixture.U_APPR_C4,
        }),
        __fixture.attrDeps,
      ),
    ).resolves.toBe('interaction_processed');
    const decided = await __fixture.decidedReply(appr.id);
    expect(decided).toBeDefined();
    expect(decided!.authorUserId).toBe(__fixture.attrMemberUserId);
    expect(__fixture.usersInfoCalls.filter((u) => u === __fixture.U_APPR_C4)).toHaveLength(0);
  });

  // --- Inbound-classify producer -------------------------------------------------

  test('C1 classify: a root message in a non-subscribed channel is acked and not enqueued', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({ channel: __fixture.CLS_NONE, ts: __fixture.nextTs() }),
      ),
    ).resolves.toBe('dropped_unsubscribed');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });

  test('C2 classify: a root human message in an allowlisted channel enqueues exactly one classify job carrying the candidate', async () => {
    const messageTs = __fixture.nextTs();
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          user: 'U_HUMAN',
          text: 'checkout latency spiking',
          ts: messageTs,
        }),
      ),
    ).resolves.toBe('classify_enqueued');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]).toMatchObject({
      tenantId: __fixture.tenantB,
      type: 'classify',
    });
    const payload = __fixture.classifyEnqueued[0]!.payload as {
      externalId: string;
      channel: string;
      author: string;
      text: string;
      raw: unknown;
    };
    expect(payload.channel).toBe(__fixture.CLS_SUB);
    expect(payload.text).toBe('checkout latency spiking');
    expect(payload.author).toBe('human');
    expect(payload.externalId).toBe(messageTs); // externalId === Slack message ts
    expect(payload.raw).toBeDefined();
  });

  test('C2 classify: another app bot_message in an allowlisted channel enqueues with author=bot', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'bot_message',
          bot_id: 'B_ALERT',
          user: undefined, // an incoming-webhook alert post carries bot_id, no user
          text: 'PagerDuty: sev2 checkout',
          ts: __fixture.nextTs(),
        }),
      ),
    ).resolves.toBe('classify_enqueued');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect((__fixture.classifyEnqueued[0]!.payload as { author: string }).author).toBe('bot');
  });

  test('classify: a provider resolution inside an alert thread is durably enqueued', async () => {
    const messageTs = __fixture.nextTs();
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'bot_message',
          bot_id: 'B_ALERT',
          user: undefined,
          thread_ts: '1787403855.537859',
          text: '',
          attachments: [
            {
              fallback:
                '[RESOLVED] monitoring (NodeSystemSaturation node-exporter 192.168.1.203:9100 warning) | <http://alertmanager.example/#/alerts?receiver=default>',
            },
          ],
          ts: messageTs,
        }),
      ),
    ).resolves.toBe('classify_enqueued');

    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]).toMatchObject({
      tenantId: __fixture.tenantB,
      type: 'classify',
      payload: {
        externalId: messageTs,
        producerId: 'bot:B_ALERT',
        signalState: 'resolved',
      },
    });
  });

  test('C13/C15 classify: an attachment-only bot_message in a subscribed channel enqueues the raw candidate and reports its terminal outcome', async () => {
    const envelope = __fixture.rootEvent({
      channel: __fixture.CLS_SUB,
      subtype: 'bot_message',
      bot_id: 'B_ALERT',
      user: undefined,
      text: '',
      attachments: [
        {
          fallback: 'Alertmanager: InstanceDown firing',
          pretext: 'Firing alert',
          title: 'InstanceDown',
          text: 'homelab target is unreachable',
          fields: [{ title: 'Severity', value: 'critical' }],
        },
      ],
      ts: __fixture.nextTs(),
    });

    const outcome = await __fixture.processClassifyEvent(envelope);

    expect(__fixture.classifyEnqueued).toHaveLength(1);
    const candidate = __fixture.classifyEnqueued[0]!.payload as {
      text: string;
      author: string;
      alertKind?: string;
      raw: unknown;
    };
    expect(candidate.text.trim()).not.toBe('');
    expect(candidate.text).toContain('Alertmanager');
    expect(candidate.alertKind).toBe('firing');
    expect(candidate.author).toBe('bot');
    expect(candidate.raw).toEqual((envelope as { event: unknown }).event);
    expect(outcome).toBe('classify_enqueued');
  });

  test('C14/C15 classify: no usable top-level or attachment text is a benign typed drop', async () => {
    const outcome = await __fixture.processClassifyEvent(
      __fixture.rootEvent({
        channel: __fixture.CLS_SUB,
        subtype: 'bot_message',
        bot_id: 'B_ALERT',
        user: undefined,
        text: ' ',
        attachments: [{ fallback: '', pretext: ' ', title: '', text: '', fields: [] }],
        ts: __fixture.nextTs(),
      }),
    );

    expect(__fixture.classifyEnqueued).toHaveLength(0);
    expect(outcome).toBe('dropped_no_candidate');
  });

  test('classify: an Alertmanager control notification is suppressed before LLM work', async () => {
    const outcome = await __fixture.processClassifyEvent(
      __fixture.rootEvent({
        channel: __fixture.CLS_SUB,
        subtype: 'bot_message',
        bot_id: 'B_ALERT',
        user: undefined,
        text: '',
        attachments: [
          {
            fallback:
              '[FIRING:1] InfoInhibitor monitoring | <https://alerts.example/#/alerts?receiver=default>',
            text: [
              '*Alert:* Info-level alert inhibition.',
              '*Description:* This provider control exists only to inhibit noisy informational alerts.',
              '*Severity:* `none`',
              '*Source:* Prometheus Alertmanager',
            ].join(' '),
          },
        ],
        ts: __fixture.nextTs(),
      }),
    );

    expect(outcome).toBe('suppressed_provider_control_notification');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });

  test('C16 classify: an attachment-only enqueue failure remains retryable', async () => {
    __fixture.classifyShouldThrow = true;
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          subtype: 'bot_message',
          bot_id: 'B_ALERT',
          user: undefined,
          text: '',
          attachments: [{ fallback: 'Alertmanager: enqueue me' }],
          ts: __fixture.nextTs(),
        }),
      ),
    ).rejects.toThrow('classify enqueue failed');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });

  test('C3 classify: a same-app root message is enqueued as an automated alert', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          user: __fixture.SELF_BOT,
          text: 'assistant reply',
          ts: __fixture.nextTs(),
        }),
      ),
    ).resolves.toBe('classify_enqueued');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]!.payload).toMatchObject({ author: 'bot' });
  });

  test('C4 classify: the same message delivered twice enqueues at most one versioned reservation', async () => {
    const event = __fixture.rootEvent({
      channel: __fixture.CLS_SUB,
      user: 'U_HUMAN',
      text: 'db pool exhausted',
      ts: __fixture.nextTs(),
    });
    await expect(__fixture.processClassifyEvent(event)).resolves.toBe('classify_enqueued');
    await expect(__fixture.processClassifyEvent(event)).resolves.toBe('dropped_duplicate');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
  });

  test('enqueues an attachment-only incoming-webhook alert from the configured app', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          subtype: 'bot_message',
          bot_id: __fixture.SELF_BOT_ID,
          user: undefined,
          text: '',
          attachments: [{ fallback: 'our own rendered triage result' }],
          ts: __fixture.nextTs(),
        }),
      ),
    ).resolves.toBe('classify_enqueued');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
    expect(__fixture.classifyEnqueued[0]!.payload).toMatchObject({
      author: 'bot',
      text: 'our own rendered triage result',
    });
  });

  test('C5 classify: a root message in a channel whose subscription is DISABLED is not enqueued', async () => {
    // Per-channel opt-in: CLS_DISABLED is subscribed on tenant B but switched off.
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_DISABLED,
          user: 'U_HUMAN',
          text: 'noise',
          ts: __fixture.nextTs(),
        }),
      ),
    ).resolves.toBe('dropped_unsubscribed');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });

  test('C6 classify: a failed durable insert leaves the ordering cache untouched', async () => {
    __fixture.classifyShouldThrow = true;
    const messageTs = __fixture.nextTs();
    const key = __fixture.clsKey(__fixture.tenantB, __fixture.CLS_SUB, messageTs);
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          user: 'U_HUMAN',
          text: 'boom',
          ts: messageTs,
        }),
      ),
    ).rejects.toThrow('classify enqueue failed');
    expect(await __fixture.redis.get(key)).toBeNull();
    expect(await __fixture.redis.get(`${key}:event-version`)).toBeNull();
  });

  test('C9 classify: a root message with empty text yields no candidate and is not enqueued', async () => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({
          channel: __fixture.CLS_SUB,
          user: 'U_HUMAN',
          text: '   ',
          ts: __fixture.nextTs(),
        }),
      ),
    ).resolves.toBe('dropped_no_candidate');
    expect(__fixture.classifyEnqueued).toHaveLength(0);
  });
});
