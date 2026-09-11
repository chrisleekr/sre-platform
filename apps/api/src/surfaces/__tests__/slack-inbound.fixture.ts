import { createApproval } from '@sre/db';
import { randomUUID } from 'node:crypto';
import { beforeEach } from 'vitest';
import {
  handleSlackEvent,
  handleSlackInteraction,
  type ClassifyProducer,
  type ResumeProducer,
  type SlackConfig,
  type SlackEnvelope,
  type SlackInteraction,
} from '../slack-inbound';
import { registerSlackInboundFixtureHooks } from './slack-inbound-fixture-hooks';
import { createSlackInboundFixtureState } from './slack-inbound-fixture-state';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

  const CHANNEL = 'C123';

  const THREAD_TS = '1699.0001';

  /** A second tenant-A channel: an incident's thread lives wherever its alert landed. */
  const ORIGIN_CHANNEL = 'C_NEW_ORIGIN';

  /** Tenant-A channel for the revocation case: subscribed, bound, then DISABLED mid-incident. */
  const REVOKED_CHANNEL = 'C_REVOKED';
  const state = createSlackInboundFixtureState();

  // Coalescing fixtures: a LIVE Queue + processor dependencies so a second reply that lands while a
  // resume is still queued exercises the real partial-unique coalescing index (not the recording mock).
  const COALESCE_STREAM = 'sre:jobs:slack-coalesce-test';

  const coalesceOnErrors: unknown[] = [];

  // The coalescing resume producer. The mock records each insert as a resume "enqueue" so the
  // existing assertions on `enqueued` hold; it ignores the tx and never coalesces (real coalescing is
  // covered separately with a live Queue below).
  const enqueued: { tenantId: string; type: string; payload: unknown }[] = [];

  const queue: ResumeProducer = {
    insertResumeTx: async (_tx, tenantId, incidentId, humanMessageId) => {
      enqueued.push({ tenantId, type: 'resume', payload: { incidentId, humanMessageId } });
      return { jobId: `job-${enqueued.length}` };
    },
    insertRecoveryTx: async (_tx, tenantId, incidentId, lifecycleVersion, signalFence) => {
      enqueued.push({
        tenantId,
        type: 'recovery.verify',
        payload: { incidentId, lifecycleVersion, signalFence },
      });
      return { jobId: `job-${enqueued.length}` };
    },
    insertReassessmentTx: async (_tx, tenantId, incidentId, signalId, signalVersion) => {
      enqueued.push({
        tenantId,
        type: 'signal.reassess',
        payload: { incidentId, signalId, signalVersion },
      });
      return { jobId: `job-${enqueued.length}` };
    },
    publishJob: async () => {},
    publishResume: async () => {},
  };

  // --- Inbound-classify producer fixtures ---------------------------------------------------
  // The classify branch converts a root (no thread_ts) message in an allowlisted channel into an
  // InboundCandidate and enqueues it as a classify job. These fixtures are additive; they do not touch
  // the resume-path harness above.
  const CLS_SUB = 'C-cls-sub';

  // subscribed channel on tenant B (inbound enabled config)
  const CLS_NONE = 'C-cls-none';

  // NOT subscribed (tenant B)
  const CLS_DISABLED = 'C-cls-dis';

  // subscribed on tenant B but DISABLED (the per-channel opt-in)
  const SELF_BOT = 'U_SELFBOT';

  // tenant B's connected bot user
  const SELF_BOT_ID = 'B_SELFBOT';

  const classifyEnqueued: { tenantId: string; type: string; payload: unknown }[] = [];

  const classifyQueue: ClassifyProducer = {
    insertClassify: async (input) => {
      if (state.classifyShouldThrow) throw new Error('classify enqueue failed');
      const payload = input.payload as { intakeId?: string; eventKey?: string };
      const existingIndex = classifyEnqueued.findIndex((queued) => {
        const existing = queued.payload as { intakeId?: string; eventKey?: string };
        return (
          (payload.intakeId !== undefined && existing.intakeId === payload.intakeId) ||
          (payload.eventKey !== undefined && existing.eventKey === payload.eventKey)
        );
      });
      if (existingIndex >= 0) {
        const existing = classifyEnqueued[existingIndex]!.payload as {
          intakeId?: string;
          eventKey?: string;
        };
        return {
          jobId: `cls-job-${existingIndex + 1}`,
          inserted: false,
          matchedBy:
            payload.intakeId !== undefined && existing.intakeId === payload.intakeId
              ? ('intake' as const)
              : ('event' as const),
        };
      }
      classifyEnqueued.push(input);
      return {
        jobId: `cls-job-${classifyEnqueued.length}`,
        inserted: true,
        matchedBy: null,
      };
    },
    insertClassifyTx: async (_tx, input) => classifyQueue.insertClassify(input),
    publishJob: async () => {},
  };

  const nextTs = (): string => `1700.${String(++state.tsSeq).padStart(4, '0')}`;

  // The versioned ordering-cache key updated after the durable classify insert.
  const clsKey = (tid: string, channel: string, ts: string): string =>
    `classify:msg:${tid}:${channel}:${ts}`;

  /** A Slack Events API root (non-thread) message envelope; `eventOver` overrides the inner event. */
  function rootEvent(eventOver: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'event_callback',
      event_id: `Ev-${randomUUID().slice(0, 8)}`,
      event: {
        type: 'message',
        channel: CLS_SUB,
        user: 'U_HUMAN',
        text: 'checkout is down',
        ts: nextTs(),
        ...eventOver,
      },
    };
  }

  // --- Mention pull-path fixtures ------------------------------------------------------------
  // A human @-mention of the bot creates an incident BYPASSING the worthy classifier. A new app_mention
  // branch enqueues a classify job tagged { kind:'mention' } keyed on channel:root_ts; a mention in a
  // thread that already has a binding resumes that incident instead. These threads live on tenant B's
  // inbound-enabled config so they clear the same gate the classify branch uses.
  const ROOT_C3 = '1701.0003';

  // an app_mention reply in THIS thread (CLS_SUB) resumes mentionIncidentId
  const ROOT_C4B = '1701.0004';

  // a plain message reply mentioning the bot in THIS thread
  // A second tenant-B channel that hosts a bound thread, so the resume/mention branches are exercised
  // somewhere other than CLS_SUB. (There is no configured "target" channel any more — the AI answers in
  // the alert's own thread,.)
  const CLS_TARGET = 'C-cls-target';

  // tenant B, bound to CLS_TARGET:ROOT_C4B

  /** A Slack Events API app_mention envelope; `eventOver` overrides the inner event. */
  function mentionEvent(eventOver: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'event_callback',
      event_id: `Ev-${randomUUID().slice(0, 8)}`,
      event: {
        type: 'app_mention',
        channel: CLS_SUB,
        user: 'U_HUMAN',
        text: `<@${SELF_BOT}> checkout is down`,
        ts: nextTs(),
        ...eventOver,
      },
    };
  }

  const tenantAConfig = (): SlackConfig => ({
    tenantId: state.tenantId,
    surface: 'slack',
    botUserId: '',
  });

  const tenantBConfig = (): SlackConfig => ({
    tenantId: state.tenantB,
    surface: 'slack',
    botUserId: SELF_BOT,
    botId: SELF_BOT_ID,
  });

  const processBaseEvent = (envelope: unknown) =>
    handleSlackEvent(
      state.baseDeps,
      state.slackConfigId,
      tenantAConfig(),
      envelope as SlackEnvelope,
    );

  const processClassifyEvent = (envelope: unknown) =>
    handleSlackEvent(
      state.classifyDeps,
      state.classifyConfigId,
      tenantBConfig(),
      envelope as SlackEnvelope,
    );

  // --- Auto-attribution fixtures -------------------------------------------------------------
  // A human thread reply's author email is resolved to a tenant member and stamped as author_user_id on
  // the appended hub message. Resolution runs BEFORE the append tx and is non-fatal (null on any miss).
  // usersInfoEmail is the injected Slack users.info seam; its mock records call ids so a test can assert a
  // cache hit skips the call entirely. These fixtures live on tenant A's Slack config;
  // each case has its own tracked thread → incident so the resume path lands cleanly.
  const ATTR_ISSUER = `https://test.idp.local/${randomUUID()}/`;

  const ATTR_SUBJECT = 'sub|attr';

  const ATTR_EMAIL = 'attr-member@x.io';

  const T_C1 = '1710.0001';

  const T_C2 = '1710.0002';

  const T_C3 = '1710.0003';

  const T_C4 = '1710.0004';

  const U_C1 = 'U_ATTR_1';

  const U_C4 = 'U_ATTR_4';

  // Injected users.info email resolver seam: returns the email for a Slack user id, or null when
  // there is none (users.info error / missing email / bot author). The mock records each lookup so a test can
  // assert a cache hit does not consult it (call-count 0).
  const usersInfoCalls: string[] = [];

  const usersInfoEmail = async (tid: string, uid: string): Promise<string | null> => {
    usersInfoCalls.push(uid);
    return state.usersInfoImpl(tid, uid);
  };

  // --- Approval-tap attribution fixtures -----------------------------------------------------
  // A block_actions approval tap must stamp its approver exactly like a thread reply does: the tap's
  // Slack user id resolves through the same seam (surface_identities cache → usersInfoEmail → exactly-one
  // tenant member) and lands on the 'decided:' reply's author_user_id. Reuses the processor dependencies,
  // usersInfoImpl/usersInfoCalls, attrMemberUserId); adds only a distinct Slack id per case (so one case's
  // cache write cannot attribute another's) plus an AMBIGUOUS pair of members sharing one email.
  const APPR_AMBIG_EMAIL = 'ambig-approver@x.io';

  const AMBIG_SUBJECT_A = 'sub|attr-ambig-a';

  const AMBIG_SUBJECT_B = 'sub|attr-ambig-b';

  const U_APPR_C1 = 'U_APPR_1';

  const U_APPR_C2_NONE = 'U_APPR_2';

  const U_APPR_C2_AMBIG = 'U_APPR_2B';

  const U_APPR_C3 = 'U_APPR_3';

  const U_APPR_C3_ERR = 'U_APPR_3E';

  const U_APPR_C4 = 'U_APPR_4';

  // --- Negative-identity cache fixtures ------------------------------------------------------
  // resolveAuthorUserId caches only successful resolutions (surface_identities), so a surface user who
  // resolves to no tenant member repeats the users.info round-trip on every message. Slack ingestion does
  // not create memberships; a provider-bound sign-in or administrator assignment does. These fixtures
  // give each case its own Slack id and thread so one case's cache entry cannot serve another's.
  const NEG_STRANGER_EMAIL = 'neg-stranger@x.io';

  // a real Slack user, never provisioned as a member
  const REJOIN_EMAIL = 'neg-rejoin@x.io';

  // provisioned MID-TEST, to prove the miss self-heals
  const REJOIN_SUBJECT = 'sub|attr-rejoin';

  const U_NEG = 'U_NEG_1';

  // never a member: the repeated-lookup case
  const U_NEG_REJOIN = 'U_NEG_2';

  // not a member, then provisioned
  const U_NEG_MEMBER = 'U_NEG_3';

  // a real member, NOT pre-seeded into surface_identities
  const U_NEG_DOWN = 'U_NEG_4';

  // a real member, resolved while Valkey is down
  const U_NEG_DOWN_MISS = 'U_NEG_5';

  // not a member, resolved while Valkey is down
  const T_NEG = '1710.0005';

  const T_NEG_REJOIN = '1710.0006';

  const T_NEG_MEMBER = '1710.0007';

  const T_NEG_DOWN = '1710.0008';

  const T_NEG_DOWN_MISS = '1710.0009';

  /** The negative-cache key under test. Tenant-first, mirroring the funnel's `dedup:` key. */
  const negKey = (surfaceUserId: string): string =>
    `noident:${state.tenantId}:slack:${surfaceUserId}`;

  const processAttributedEvent = (envelope: unknown, deps = state.attrDeps) =>
    handleSlackEvent(deps, state.slackConfigId, tenantAConfig(), envelope as SlackEnvelope);

  const processInteraction = (payload: unknown, deps = state.baseDeps) =>
    handleSlackInteraction(deps, state.slackConfigId, tenantAConfig(), payload as SlackInteraction);

  /** A fresh pending approval on tenant A's incident, so each tap races an unconsumed CAS (a decided
   *  approval loses and appends nothing, which would make the attribution assertion vacuous). */
  async function freshApproval(): Promise<{ id: string }> {
    const { row } = await createApproval(state.app.db, state.tenantId, {
      incidentId: state.incidentId,
      actionId: `act-attr-${randomUUID().slice(0, 8)}`,
      prompt: 'Roll back?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    });
    return { id: row.id };
  }

  /** The 'decided:' reply the tap appended, found by its durable approval link rather than by option
   *  label — tenant A's incident carries many decided replies across this suite. */
  async function decidedReply(approvalId: string) {
    return (await state.hub.history(state.tenantId, state.incidentId)).find(
      (m) => m.kind === 'reply' && m.approvalId === approvalId,
    );
  }

  /** A Slack block_actions payload for an approval-button tap (value = "<approvalId>:<optionId>"). */
  function blockActions(
    value: string,
    user: { username?: string; id?: string } = { username: 'sre-jane' },
  ): Record<string, unknown> {
    return { type: 'block_actions', user, actions: [{ action_id: 'opt:0', value }] };
  }

  function lifecycleBlockActions(
    incidentId: string,
    to: 'open' | 'mitigated' | 'resolved' | 'closed',
    expectedVersion: number,
    actionTs: string,
    userId = 'U_LIFECYCLE',
  ): Record<string, unknown> {
    return {
      type: 'block_actions',
      trigger_id: `trigger-${actionTs}`,
      user: { id: userId, username: 'sre-jane' },
      actions: [
        {
          action_id: `incident_lifecycle:${to}`,
          action_ts: actionTs,
          value: JSON.stringify({ incidentId, to, expectedVersion }),
        },
      ],
    };
  }

  /** A Slack Events API message-event envelope for a human thread reply. */
  function messageEvent(
    over: Record<string, unknown> = {},
    eventOver: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: 'event_callback',
      event_id: `Ev-${randomUUID().slice(0, 8)}`,
      event: {
        type: 'message',
        channel: CHANNEL,
        user: 'U1',
        text: 'check the DB pool',
        thread_ts: THREAD_TS,
        ts: nextTs(),
        ...eventOver,
      },
      ...over,
    };
  }

  registerSlackInboundFixtureHooks({
    state,
    urls: { admin: ADMIN_URL, app: APP_URL, valkey: VALKEY_URL },
    channels: {
      primary: CHANNEL,
      origin: ORIGIN_CHANNEL,
      classify: CLS_SUB,
      classifyDisabled: CLS_DISABLED,
      classifyTarget: CLS_TARGET,
    },
    threadTs: THREAD_TS,
    bot: { userId: SELF_BOT, botId: SELF_BOT_ID },
    mentionThreads: { primary: ROOT_C3, target: ROOT_C4B },
    coalesce: { stream: COALESCE_STREAM, errors: coalesceOnErrors },
    attribution: {
      issuer: ATTR_ISSUER,
      subject: ATTR_SUBJECT,
      email: ATTR_EMAIL,
      threads: [T_C1, T_C2, T_C3, T_C4],
      ambiguousEmail: APPR_AMBIG_EMAIL,
      ambiguousSubjects: [AMBIG_SUBJECT_A, AMBIG_SUBJECT_B],
    },
    negative: {
      threads: [T_NEG, T_NEG_REJOIN, T_NEG_MEMBER, T_NEG_DOWN, T_NEG_DOWN_MISS],
      rejoinSubject: REJOIN_SUBJECT,
      userIds: [U_NEG, U_NEG_REJOIN, U_NEG_MEMBER, U_NEG_DOWN, U_NEG_DOWN_MISS],
      key: negKey,
    },
    queue,
    classifyQueue,
    classifyEnqueued,
    usersInfoCalls,
    usersInfoEmail,
  });

  beforeEach(() => {
    enqueued.length = 0;
  });
  return Object.assign(state, {
    ADMIN_URL,
    APP_URL,
    VALKEY_URL,
    CHANNEL,
    THREAD_TS,
    ORIGIN_CHANNEL,
    REVOKED_CHANNEL,
    COALESCE_STREAM,
    coalesceOnErrors,
    enqueued,
    queue,
    CLS_SUB,
    CLS_NONE,
    CLS_DISABLED,
    SELF_BOT,
    SELF_BOT_ID,
    classifyEnqueued,
    classifyQueue,
    nextTs,
    clsKey,
    rootEvent,
    ROOT_C3,
    ROOT_C4B,
    CLS_TARGET,
    mentionEvent,
    tenantAConfig,
    tenantBConfig,
    processBaseEvent,
    processClassifyEvent,
    ATTR_ISSUER,
    ATTR_SUBJECT,
    ATTR_EMAIL,
    T_C1,
    T_C2,
    T_C3,
    T_C4,
    U_C1,
    U_C4,
    usersInfoCalls,
    usersInfoEmail,
    APPR_AMBIG_EMAIL,
    AMBIG_SUBJECT_A,
    AMBIG_SUBJECT_B,
    U_APPR_C1,
    U_APPR_C2_NONE,
    U_APPR_C2_AMBIG,
    U_APPR_C3,
    U_APPR_C3_ERR,
    U_APPR_C4,
    NEG_STRANGER_EMAIL,
    REJOIN_EMAIL,
    REJOIN_SUBJECT,
    U_NEG,
    U_NEG_REJOIN,
    U_NEG_MEMBER,
    U_NEG_DOWN,
    U_NEG_DOWN_MISS,
    T_NEG,
    T_NEG_REJOIN,
    T_NEG_MEMBER,
    T_NEG_DOWN,
    T_NEG_DOWN_MISS,
    negKey,
    processAttributedEvent,
    processInteraction,
    freshApproval,
    decidedReply,
    blockActions,
    lifecycleBlockActions,
    messageEvent,
  });
}

export type TestFixture = ReturnType<typeof createFixture>;
