import { seedMembership } from '@sre/db/test-support';
import {
  approvals,
  createApproval,
  createIncident,
  inboundChannels,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  makeDb,
  memberships,
  recordSurfaceBinding,
  subscribeChannel,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  surfaceIdentities,
  surfaceInboundEvents,
  tenants,
  upsertSurfaceConfig,
  users,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { ClassifyProducer, ResumeProducer, SlackInboundDeps } from '../slack-inbound';
import type { SlackInboundFixtureState } from './slack-inbound-fixture-state';

interface FixtureHooksInput {
  state: SlackInboundFixtureState;
  urls: { admin: string; app: string; valkey: string };
  channels: {
    primary: string;
    origin: string;
    classify: string;
    classifyDisabled: string;
    classifyTarget: string;
  };
  threadTs: string;
  bot: { userId: string; botId: string };
  mentionThreads: { primary: string; target: string };
  coalesce: { stream: string; errors: unknown[] };
  attribution: {
    issuer: string;
    subject: string;
    email: string;
    threads: [string, string, string, string];
    ambiguousEmail: string;
    ambiguousSubjects: [string, string];
  };
  negative: {
    threads: [string, string, string, string, string];
    rejoinSubject: string;
    userIds: [string, string, string, string, string];
    key: (surfaceUserId: string) => string;
  };
  queue: ResumeProducer;
  classifyQueue: ClassifyProducer;
  classifyEnqueued: unknown[];
  usersInfoCalls: string[];
  usersInfoEmail: NonNullable<SlackInboundDeps['usersInfoEmail']>;
}

async function createBoundIncident(
  state: SlackInboundFixtureState,
  channel: string,
  threadId: string,
): Promise<string> {
  const { id } = await createIncident(state.app.db, state.tenantId, {
    fingerprint: `fp-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev2',
  });
  await recordSurfaceBinding(state.app.db, state.tenantId, {
    incidentId: id,
    surface: 'slack',
    channel,
    threadId,
  });
  return id;
}

/** Registers database, queue, identity, and cleanup hooks for the split Slack inbound suite. */
export function registerSlackInboundFixtureHooks(input: FixtureHooksInput): void {
  const {
    state,
    urls,
    channels,
    threadTs,
    bot,
    mentionThreads,
    coalesce,
    attribution,
    negative,
    queue,
    classifyQueue,
    classifyEnqueued,
    usersInfoCalls,
    usersInfoEmail,
  } = input;

  beforeAll(async () => {
    state.admin = makeDb(urls.admin);
    state.app = makeDb(urls.app);
    state.redis = new Redis(urls.valkey, { maxRetriesPerRequest: null });
    state.hub = new ConversationHub(state.app.db, state.redis);
    state.baseDeps = {
      adminDb: state.admin.db,
      appDb: state.app.db,
      hub: state.hub,
      queue,
      classifyQueue,
      redis: state.redis,
      reservationRedis: state.redis,
    };

    state.tenantId = randomUUID();
    state.tenantB = randomUUID();
    await state.admin.db.insert(tenants).values([
      { id: state.tenantId, name: 'SL' },
      { id: state.tenantB, name: 'SLB' },
    ]);
    state.slackConfigId = (
      await upsertSurfaceConfig(state.app.db, state.tenantId, { surface: 'slack' })
    ).id;
    for (const channel of [channels.primary, channels.origin]) {
      await subscribeChannel(state.app.db, {
        tenantId: state.tenantId,
        surface: 'slack',
        channel,
        enabled: true,
      });
    }

    state.incidentId = (
      await createIncident(state.app.db, state.tenantId, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    await recordSurfaceBinding(state.app.db, state.tenantId, {
      incidentId: state.incidentId,
      surface: 'slack',
      channel: channels.primary,
      threadId: threadTs,
    });

    state.approvalId = (
      await createApproval(state.app.db, state.tenantId, {
        incidentId: state.incidentId,
        actionId: 'act-1',
        prompt: 'Restart the service?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      })
    ).row.id;
    const { id: incidentB } = await createIncident(state.app.db, state.tenantB, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'billing',
      severity: 'sev3',
    });
    state.approvalIdB = (
      await createApproval(state.app.db, state.tenantB, {
        incidentId: incidentB,
        actionId: 'act-b',
        prompt: 'B?',
        options: [{ id: 'yes', label: 'Yes' }],
      })
    ).row.id;
  }, 30_000);

  beforeAll(async () => {
    state.classifyConfigId = (
      await upsertSurfaceConfig(state.app.db, state.tenantB, {
        surface: 'slack',
        botUserId: bot.userId,
        botId: bot.botId,
      })
    ).id;
    await subscribeChannel(state.app.db, {
      tenantId: state.tenantB,
      surface: 'slack',
      channel: channels.classify,
      enabled: true,
    });
    await subscribeChannel(state.app.db, {
      tenantId: state.tenantB,
      surface: 'slack',
      channel: channels.classifyDisabled,
      enabled: false,
    });
    state.classifyDeps = {
      adminDb: state.admin.db,
      appDb: state.app.db,
      hub: state.hub,
      queue,
      redis: state.redis,
      reservationRedis: state.redis,
      classifyQueue,
    };
  }, 30_000);

  beforeAll(async () => {
    state.mentionIncidentId = (
      await createIncident(state.app.db, state.tenantB, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    await recordSurfaceBinding(state.app.db, state.tenantB, {
      incidentId: state.mentionIncidentId,
      surface: 'slack',
      channel: channels.classify,
      threadId: mentionThreads.primary,
    });
    state.resumeIncidentId = (
      await createIncident(state.app.db, state.tenantB, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'slack',
        service: 'billing',
        severity: 'sev3',
      })
    ).id;
    await recordSurfaceBinding(state.app.db, state.tenantB, {
      incidentId: state.resumeIncidentId,
      surface: 'slack',
      channel: channels.classifyTarget,
      threadId: mentionThreads.target,
    });
  }, 30_000);

  beforeAll(async () => {
    state.realQueue = new Queue(state.admin.db, state.redis, {
      stream: coalesce.stream,
      group: 'slack-coalesce',
    });
    await state.realQueue.ensureGroup();
    state.coalesceDeps = {
      adminDb: state.admin.db,
      appDb: state.app.db,
      hub: state.hub,
      queue: state.realQueue,
      classifyQueue,
      redis: state.redis,
      reservationRedis: state.redis,
      onError: (error) => coalesce.errors.push(error),
    };
  }, 30_000);

  beforeAll(async () => {
    state.attrMemberUserId = await seedMembership(
      state.admin.db,
      {
        issuer: attribution.issuer,
        subject: attribution.subject,
        email: attribution.email,
      },
      state.tenantId,
    );
    const [c1, c2, c3, c4] = attribution.threads;
    state.attrIncidentC1 = await createBoundIncident(state, channels.primary, c1);
    state.attrIncidentC2 = await createBoundIncident(state, channels.primary, c2);
    state.attrIncidentC3 = await createBoundIncident(state, channels.primary, c3);
    state.attrIncidentC4 = await createBoundIncident(state, channels.primary, c4);
    state.attrDeps = {
      adminDb: state.admin.db,
      appDb: state.app.db,
      hub: state.hub,
      queue,
      classifyQueue,
      redis: state.redis,
      reservationRedis: state.redis,
      usersInfoEmail,
    };
  }, 30_000);

  beforeAll(async () => {
    for (const subject of attribution.ambiguousSubjects) {
      await seedMembership(
        state.admin.db,
        { issuer: attribution.issuer, subject, email: attribution.ambiguousEmail },
        state.tenantId,
      );
    }
  }, 30_000);

  beforeAll(async () => {
    const [unmatched, rejoin, member, down, downMiss] = negative.threads;
    state.attrIncidentNeg = await createBoundIncident(state, channels.primary, unmatched);
    state.attrIncidentRejoin = await createBoundIncident(state, channels.primary, rejoin);
    state.attrIncidentMember = await createBoundIncident(state, channels.primary, member);
    state.attrIncidentDown = await createBoundIncident(state, channels.primary, down);
    state.attrIncidentDownMiss = await createBoundIncident(state, channels.primary, downMiss);
    state.brokenRedis = new Redis({
      port: 1,
      host: '127.0.0.1',
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    state.brokenRedis.on('error', () => {});
    state.downDeps = {
      adminDb: state.admin.db,
      appDb: state.app.db,
      hub: state.hub,
      queue,
      classifyQueue,
      redis: state.brokenRedis,
      reservationRedis: state.brokenRedis,
      usersInfoEmail,
    };
  }, 30_000);

  beforeEach(() => {
    classifyEnqueued.length = 0;
    state.classifyShouldThrow = false;
  });

  afterAll(async () => {
    if (state.admin) {
      const tenantScope = sql`tenant_id in (${state.tenantId}, ${state.tenantB})`;
      for (const table of [
        jobs,
        inboundChannels,
        surfaceDeliveries,
        surfaceInboundEvents,
        incidentMessages,
        incidentSignals,
        surfaceIdentities,
        approvals,
        surfaceBindings,
        surfaceConfigs,
        incidents,
        memberships,
      ]) {
        await state.admin.db.delete(table).where(tenantScope);
      }
      await state.admin.db
        .delete(users)
        .where(sql`issuer = ${attribution.issuer} and subject = ${attribution.subject}`);
      const [ambiguousA, ambiguousB] = attribution.ambiguousSubjects;
      await state.admin.db
        .delete(users)
        .where(sql`issuer = ${attribution.issuer} and subject in (${ambiguousA}, ${ambiguousB})`);
      await state.admin.db
        .delete(users)
        .where(sql`issuer = ${attribution.issuer} and subject = ${negative.rejoinSubject}`);
      await state.admin.db.delete(tenants).where(sql`id in (${state.tenantId}, ${state.tenantB})`);
      await state.admin.close();
    }
    if (state.redis) await state.redis.del(coalesce.stream);
    if (state.redis) await state.redis.del(...negative.userIds.map(negative.key));
    if (state.app) await state.app.close();
    if (state.redis) await state.redis.quit();
    if (state.brokenRedis) state.brokenRedis.disconnect();
  });

  beforeEach(() => {
    usersInfoCalls.length = 0;
    state.usersInfoImpl = async () => null;
  });
}
