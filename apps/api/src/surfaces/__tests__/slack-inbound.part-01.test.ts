import { seedMembership } from '@sre/db/test-support';
import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  createIncident,
  incidents,
  jobs,
  persistSurfaceIdentity,
  recordSurfaceBinding,
  setIncidentArchivedTx,
  surfaceBindings,
  withTenant,
} from '@sre/db';

import { handleSlackEvent, type SlackEnvelope, type SlackInboundDeps } from '../slack-inbound';

import { createFixture } from './slack-inbound.fixture';

const __fixture = createFixture();

describe('Slack inbound processors', () => {
  test.each([
    {
      name: 'human-authored control wording',
      event: {
        user: 'U_HUMAN',
        text: '*Severity:* none This is an internal alert routed to a null receiver.',
      },
    },
    {
      name: 'provider-authored negation',
      event: {
        subtype: 'bot_message',
        bot_id: 'B_ALERT',
        user: undefined,
        text: '*Severity:* none This is not an internal alert and is not routed to a null receiver.',
      },
    },
  ])('classify: $name is not permanently suppressed', async ({ event }) => {
    await expect(
      __fixture.processClassifyEvent(
        __fixture.rootEvent({ channel: __fixture.CLS_SUB, ts: __fixture.nextTs(), ...event }),
      ),
    ).resolves.toBe('classify_enqueued');
    expect(__fixture.classifyEnqueued).toHaveLength(1);
  });

  test('exposes the existing event and interaction processors independently of HTTP transport', async () => {
    const inbound = await import('../slack-inbound');
    const processors = inbound as unknown as {
      handleSlackEvent?: unknown;
      handleSlackInteraction?: unknown;
    };

    expect(processors.handleSlackEvent).toBeTypeOf('function');
    expect(processors.handleSlackInteraction).toBeTypeOf('function');
  });

  test('a human thread reply appends a human message and enqueues a resume', async () => {
    await expect(
      __fixture.processBaseEvent(__fixture.messageEvent({}, { text: 'restart the pods' })),
    ).resolves.toBe('resume_enqueued');

    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId);
    const human = history.find((m) => m.author === 'human' && m.content === 'restart the pods');
    expect(human).toBeDefined();
    expect(human!.originSurface).toBe('slack'); // so the fan-out does not echo it back to Slack
    expect(
      history.find(
        (m) =>
          m.author === 'agent' &&
          m.kind === 'reply' &&
          m.content === 'Message received. Investigating…',
      ),
    ).toBeDefined();

    expect(__fixture.enqueued).toHaveLength(1);
    expect(__fixture.enqueued[0]).toMatchObject({ tenantId: __fixture.tenantId, type: 'resume' });
    const payload = __fixture.enqueued[0]!.payload as {
      incidentId: string;
      humanMessageId: string;
    };
    expect(payload.incidentId).toBe(__fixture.incidentId);
    expect(payload.humanMessageId).toBe(human!.id);
  });

  test('a deleted incident permanently ignores Slack thread replies', async () => {
    const threadTs = '1699.7001';
    const { id: archivedIncidentId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ status: 'resolved', archivedAt: new Date() })
      .where(sql`${incidents.id} = ${archivedIncidentId}`);
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: archivedIncidentId,
      surface: 'slack',
      channel: __fixture.CHANNEL,
      threadId: threadTs,
    });

    await expect(
      __fixture.processBaseEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-archived-reply' },
          { thread_ts: threadTs, ts: '1699.7002', text: 'wake the old incident' },
        ),
      ),
    ).resolves.toBe('dropped_archived');
    expect(
      (await __fixture.hub.history(__fixture.tenantId, archivedIncidentId)).some(
        (m) => m.author === 'human',
      ),
    ).toBe(false);
    expect(__fixture.enqueued).toHaveLength(0);
  });

  test('Slack replies serialize with archive in either transaction order', async () => {
    const makeTerminalThread = async (threadTs: string) => {
      const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      });
      await __fixture.admin.db
        .update(incidents)
        .set({ status: 'resolved' })
        .where(sql`${incidents.id} = ${id}`);
      await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
        incidentId: id,
        surface: 'slack',
        channel: __fixture.CHANNEL,
        threadId: threadTs,
      });
      return id;
    };

    // Reply locks first: the archive waits, then observes the queued resume and refuses to hide the work.
    const replyFirstThread = '1699.7101';
    const replyFirstIncident = await makeTerminalThread(replyFirstThread);
    let releaseResume!: () => void;
    const resumeReleased = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let resumeInserted!: () => void;
    const resumeReached = new Promise<void>((resolve) => {
      resumeInserted = resolve;
    });
    const racingDeps: SlackInboundDeps = {
      ...__fixture.baseDeps,
      queue: {
        ...__fixture.queue,
        insertResumeTx: async (tx, queuedTenantId, queuedIncidentId, humanMessageId) => {
          const inserted = await tx
            .insert(jobs)
            .values({
              tenantId: queuedTenantId,
              type: 'resume',
              payload: { incidentId: queuedIncidentId, humanMessageId },
              status: 'queued',
              stream: `slack-archive-race-${randomUUID()}`,
            })
            .returning({ id: jobs.id });
          resumeInserted();
          await resumeReleased;
          return { jobId: inserted[0]!.id };
        },
      },
    };
    const reply = handleSlackEvent(
      racingDeps,
      __fixture.slackConfigId,
      __fixture.tenantAConfig(),
      __fixture.messageEvent(
        { event_id: 'Ev-reply-first-archive-race' },
        { thread_ts: replyFirstThread, ts: '1699.7102', text: 'finish this check' },
      ) as SlackEnvelope,
    );
    await resumeReached;
    let archiveSettled = false;
    const archive = __fixture.hub
      .setIncidentArchived(__fixture.tenantId, replyFirstIncident, {
        archived: true,
        reason: 'Concurrent Slack archive test.',
        archiveKey: `slack-archive-race:${randomUUID()}`,
        author: 'system',
        expectedVersion: 0,
      })
      .then((result) => {
        archiveSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(archiveSettled).toBe(false);
    releaseResume();
    await expect(reply).resolves.toBe('resume_enqueued');
    expect((await archive).archive.outcome).toBe('work_in_progress');

    // Archive locks first: the reply waits for commit, then acknowledges without a message or resume.
    const archiveFirstThread = '1699.7201';
    const archiveFirstIncident = await makeTerminalThread(archiveFirstThread);
    let releaseArchive!: () => void;
    const archiveReleased = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archiveLocked!: () => void;
    const archiveReached = new Promise<void>((resolve) => {
      archiveLocked = resolve;
    });
    const archiveTransaction = withTenant(__fixture.app.db, __fixture.tenantId, async (tx) => {
      expect(
        await setIncidentArchivedTx(tx, archiveFirstIncident, true, { expectedVersion: 0 }),
      ).toMatchObject({ outcome: 'applied' });
      archiveLocked();
      await archiveReleased;
    });
    await archiveReached;
    let replySettled = false;
    const blockedReply = __fixture
      .processBaseEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-archive-first-reply-race' },
          { thread_ts: archiveFirstThread, ts: '1699.7202', text: 'wake archived work' },
        ),
      )
      .then((outcome) => {
        replySettled = true;
        return outcome;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(replySettled).toBe(false);
    releaseArchive();
    await archiveTransaction;
    await expect(blockedReply).resolves.toBe('dropped_archived');
    expect(
      (await __fixture.hub.history(__fixture.tenantId, archiveFirstIncident)).some((message) =>
        message.content.includes('wake archived work'),
      ),
    ).toBe(false);
    expect(__fixture.enqueued).toHaveLength(0);
  });

  test('a reply in a linked source thread receives a durable primary-investigation notice', async () => {
    await __fixture.admin.db
      .update(surfaceBindings)
      .set({ role: 'source', projectionMode: 'status' })
      .where(sql`${surfaceBindings.incidentId} = ${__fixture.incidentId}`);
    try {
      await expect(
        __fixture.processBaseEvent(
          __fixture.messageEvent(
            { event_id: 'Ev-source-thread-reply' },
            { ts: '1712.0000', text: 'check whether this recurrence has the same cause' },
          ),
        ),
      ).resolves.toBe('resume_enqueued');

      const history = await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            author: 'system',
            kind: 'relationship',
            content: expect.stringContaining('answer in the primary investigation'),
          }),
        ]),
      );
      expect(__fixture.enqueued).toHaveLength(1);
    } finally {
      await __fixture.admin.db
        .update(surfaceBindings)
        .set({ role: 'primary', projectionMode: 'full' })
        .where(sql`${surfaceBindings.incidentId} = ${__fixture.incidentId}`);
    }
  });

  // --- Secret scrubbing on the human resume paths ------------------------------
  // A human who pastes a credential into a reply must not have it persisted verbatim in
  // incident_messages (and re-egressed to the LLM on resume). The durable row is the assertion
  // surface: scrubbing must happen BEFORE the hub append, not at the model boundary.

  test('text-reply resume: a secret pasted in a human thread reply is scrubbed before it reaches the hub', async () => {
    await expect(
      __fixture.processBaseEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-scrub-reply' },
          { ts: '1712.0001', text: 'try again with AKIAIOSFODNN7EXAMPLE' },
        ),
      ),
    ).resolves.toBe('resume_enqueued');

    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId);
    const human = history.find((m) => m.author === 'human' && m.content.includes('try again with'));
    expect(human).toBeDefined();
    expect(human!.content).toContain('[REDACTED]');
    expect(human!.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  // --- Auto-attribution of a human reply author ------------------------------------------

  test('C1 attribution: a reply whose author email resolves to exactly one tenant member stamps that member id as author_user_id', async () => {
    __fixture.usersInfoImpl = async () => __fixture.ATTR_EMAIL;
    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-attr-c1' },
          { user: __fixture.U_C1, thread_ts: __fixture.T_C1, ts: '1710.1001', text: 'c1 reply' },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    const human = (await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentC1)).find(
      (m) => m.author === 'human' && m.content === 'c1 reply',
    );
    expect(human).toBeDefined();
    expect(human!.authorUserId).toBe(__fixture.attrMemberUserId);
  });

  test('C2 attribution: an email matching no tenant member appends author_user_id null (never-wrong-person)', async () => {
    __fixture.usersInfoImpl = async () => 'stranger@x.io';
    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-attr-c2' },
          { user: 'U_ATTR_2', thread_ts: __fixture.T_C2, ts: '1710.1002', text: 'c2 reply' },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    const human = (await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentC2)).find(
      (m) => m.content === 'c2 reply',
    );
    expect(human).toBeDefined();
    expect(human!.authorUserId ?? null).toBeNull();
  });

  test('C3 attribution: no retrievable email appends author_user_id null AND still enqueues the resume (non-fatal)', async () => {
    __fixture.usersInfoImpl = async () => null; // users.info error / missing email / bot author
    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-attr-c3' },
          { user: 'U_ATTR_3', thread_ts: __fixture.T_C3, ts: '1710.1003', text: 'c3 reply' },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    const human = (await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentC3)).find(
      (m) => m.content === 'c3 reply',
    );
    expect(human).toBeDefined();
    expect(human!.authorUserId ?? null).toBeNull();
    expect(__fixture.enqueued).toHaveLength(1); // ingestion still proceeds: the resume is enqueued
    expect(__fixture.enqueued[0]).toMatchObject({ tenantId: __fixture.tenantId, type: 'resume' });
  });

  test('C3 attribution: a users.info error is swallowed — author_user_id null AND the resume still enqueues (non-fatal)', async () => {
    __fixture.usersInfoImpl = async () => {
      throw new Error('users.info 500'); // a real network/DB fault, not just a missing email
    };
    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-attr-c3-err' },
          { user: 'U_ATTR_3', thread_ts: __fixture.T_C3, ts: '1710.1013', text: 'c3 err reply' },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    const human = (await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentC3)).find(
      (m) => m.content === 'c3 err reply',
    );
    expect(human).toBeDefined();
    expect(human!.authorUserId ?? null).toBeNull(); // resolve threw → swallowed to null
    expect(__fixture.enqueued).toHaveLength(1); // and the human reply still lands: resume enqueued
    expect(__fixture.enqueued[0]).toMatchObject({ tenantId: __fixture.tenantId, type: 'resume' });
  });

  test('C4 attribution: an already-cached Slack author id uses the cache and does NOT call users.info', async () => {
    await persistSurfaceIdentity(__fixture.app.db, __fixture.tenantId, {
      surface: 'slack',
      surfaceUserId: __fixture.U_C4,
      authorUserId: __fixture.attrMemberUserId,
      source: 'auto',
    });
    __fixture.usersInfoImpl = async () => __fixture.ATTR_EMAIL; // would resolve, but a cache hit must not consult it
    __fixture.usersInfoCalls.length = 0;
    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-attr-c4' },
          { user: __fixture.U_C4, thread_ts: __fixture.T_C4, ts: '1710.1004', text: 'c4 reply' },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    const human = (await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentC4)).find(
      (m) => m.content === 'c4 reply',
    );
    expect(human!.authorUserId).toBe(__fixture.attrMemberUserId);
    expect(__fixture.usersInfoCalls.filter((u) => u === __fixture.U_C4)).toHaveLength(0);
  });

  test('negative cache: repeated replies from a surface user who resolves to NO member cost one users.info call, not one per message', async () => {
    await __fixture.redis.del(__fixture.negKey(__fixture.U_NEG)); // the case owns its key regardless of what ran before
    __fixture.usersInfoImpl = async () => __fixture.NEG_STRANGER_EMAIL; // a real Slack user, never provisioned as a member
    const stamps = ['1710.2001', '1710.2002', '1710.2003'];
    for (const [i, ts] of stamps.entries()) {
      await expect(
        __fixture.processAttributedEvent(
          __fixture.messageEvent(
            { event_id: `Ev-neg-${i}` },
            { user: __fixture.U_NEG, thread_ts: __fixture.T_NEG, ts, text: `neg reply ${i}` },
          ),
        ),
      ).resolves.toBe('resume_enqueued');
    }
    // Every reply must LAND, unattributed. Without this a dropped message would satisfy the call-count
    // assertion below vacuously: zero further lookups because there was nothing further to look up.
    const landed = (
      await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentNeg)
    ).filter((m) => m.content.startsWith('neg reply '));
    expect(landed).toHaveLength(stamps.length);
    for (const m of landed) expect(m.authorUserId ?? null).toBeNull();
    // The bug: replies 2..N repeat the Slack round-trip forever because only successes are cached.
    expect(__fixture.usersInfoCalls.filter((u) => u === __fixture.U_NEG)).toHaveLength(1);
  });

  test('negative cache: the miss entry is short-lived — once it expires a newly provisioned member IS attributed (rejoin self-heals)', async () => {
    await __fixture.redis.del(__fixture.negKey(__fixture.U_NEG_REJOIN));
    __fixture.usersInfoImpl = async () => __fixture.REJOIN_EMAIL;
    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-neg-rejoin-1' },
          {
            user: __fixture.U_NEG_REJOIN,
            thread_ts: __fixture.T_NEG_REJOIN,
            ts: '1710.2011',
            text: 'rejoin reply 1',
          },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    // The TTL must exist and be SHORT. Membership is a JOIN, not a deletion, so a member who is
    // provisioned after a cached miss must self-heal with no repair step; an absent TTL (-1) or a long
    // one would strand them unattributed. This bounds the unattributed window to at most 60s.
    const ttl = await __fixture.redis.ttl(__fixture.negKey(__fixture.U_NEG_REJOIN));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    // The member is provisioned (the join), then the cached miss expires. Expiry is simulated by
    // DELETING the key rather than sleeping out the real TTL: Valkey's own expiry is not under test,
    // the re-resolve after it is. The TTL assertion above is what pins that wait to at most 60s.
    const rejoinUserId = await seedMembership(
      __fixture.admin.db,
      {
        issuer: __fixture.ATTR_ISSUER,
        subject: __fixture.REJOIN_SUBJECT,
        email: __fixture.REJOIN_EMAIL,
      },
      __fixture.tenantId,
    );
    await __fixture.redis.del(__fixture.negKey(__fixture.U_NEG_REJOIN));

    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-neg-rejoin-2' },
          {
            user: __fixture.U_NEG_REJOIN,
            thread_ts: __fixture.T_NEG_REJOIN,
            ts: '1710.2012',
            text: 'rejoin reply 2',
          },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentRejoin);
    expect(history.find((m) => m.content === 'rejoin reply 1')!.authorUserId ?? null).toBeNull();
    expect(history.find((m) => m.content === 'rejoin reply 2')!.authorUserId).toBe(rejoinUserId);
  });

  test('negative cache: a real tenant member is attributed, served by surface_identities on the next reply, and never negatively cached', async () => {
    await __fixture.redis.del(__fixture.negKey(__fixture.U_NEG_MEMBER));
    __fixture.usersInfoImpl = async () => __fixture.ATTR_EMAIL;
    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-neg-member-1' },
          {
            user: __fixture.U_NEG_MEMBER,
            thread_ts: __fixture.T_NEG_MEMBER,
            ts: '1710.2021',
            text: 'member reply 1',
          },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    // A resolved member is not a miss: negatively caching them would un-attribute a real member.
    expect(await __fixture.redis.exists(__fixture.negKey(__fixture.U_NEG_MEMBER))).toBe(0);

    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-neg-member-2' },
          {
            user: __fixture.U_NEG_MEMBER,
            thread_ts: __fixture.T_NEG_MEMBER,
            ts: '1710.2022',
            text: 'member reply 2',
          },
        ),
      ),
    ).resolves.toBe('resume_enqueued');
    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentMember);
    expect(history.find((m) => m.content === 'member reply 1')!.authorUserId).toBe(
      __fixture.attrMemberUserId,
    );
    expect(history.find((m) => m.content === 'member reply 2')!.authorUserId).toBe(
      __fixture.attrMemberUserId,
    );
    // The second reply is served by the surface_identities cache, not a second Slack round-trip.
    expect(__fixture.usersInfoCalls.filter((u) => u === __fixture.U_NEG_MEMBER)).toHaveLength(1);
  });

  test('fail direction: with Valkey rejecting every command a real tenant member is STILL attributed (attribution must not become Valkey-dependent)', async () => {
    __fixture.usersInfoImpl = async () => __fixture.ATTR_EMAIL;
    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-neg-down-1' },
          {
            user: __fixture.U_NEG_DOWN,
            thread_ts: __fixture.T_NEG_DOWN,
            ts: '1710.2031',
            text: 'down member reply',
          },
        ),
        __fixture.downDeps,
      ),
    ).resolves.toBe('resume_enqueued');
    const human = (
      await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentDown)
    ).find((m) => m.content === 'down member reply');
    expect(human).toBeDefined();
    // resolveAuthorUserId swallows EVERY throw to null, so an unguarded cache read would silently
    // un-attribute every member for the length of a Valkey blip. Today attribution does not touch
    // Valkey at all; this pins that a cache added on this path degrades to the old behaviour rather
    // than below it.
    expect(human!.authorUserId).toBe(__fixture.attrMemberUserId);
    expect(__fixture.usersInfoCalls.filter((u) => u === __fixture.U_NEG_DOWN)).toHaveLength(1);
  });

  test('fail direction: with Valkey rejecting every command a non-member reply still lands and still resumes (the cache write is best-effort)', async () => {
    __fixture.usersInfoImpl = async () => __fixture.NEG_STRANGER_EMAIL;
    await expect(
      __fixture.processAttributedEvent(
        __fixture.messageEvent(
          { event_id: 'Ev-neg-down-2' },
          {
            user: __fixture.U_NEG_DOWN_MISS,
            thread_ts: __fixture.T_NEG_DOWN_MISS,
            ts: '1710.2041',
            text: 'down miss reply',
          },
        ),
        __fixture.downDeps,
      ),
    ).resolves.toBe('resume_enqueued');
    const human = (
      await __fixture.hub.history(__fixture.tenantId, __fixture.attrIncidentDownMiss)
    ).find((m) => m.content === 'down miss reply');
    expect(human).toBeDefined();
    expect(human!.authorUserId ?? null).toBeNull();
    // A failed negative-cache WRITE must cost the caching only, never the reply or its resume.
    expect(__fixture.enqueued).toHaveLength(1);
    expect(__fixture.enqueued[0]).toMatchObject({ tenantId: __fixture.tenantId, type: 'resume' });
  });

  test('a top-level (non-thread) message does not enter the resume path', async () => {
    await __fixture.processBaseEvent({
      type: 'event_callback',
      event_id: `Ev-${randomUUID().slice(0, 8)}`,
      event: {
        type: 'message',
        channel: __fixture.CHANNEL,
        user: 'U1',
        text: 'hi channel',
        ts: '1699.5',
      },
    });
    expect(__fixture.enqueued).toHaveLength(0);
  });
});
