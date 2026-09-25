import { createHash, randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  EMBED_DIM,
  advanceSurfaceStatusPostByBinding,
  claimSurfaceDelivery,
  clearWorkingPost,
  finishSurfaceDelivery,
  getBindingById,
  getBindingByExternal,
  getBindingByIncident,
  getIncident,
  getSurfaceStatusPostByBinding,
  getWorkingPost,
  hasAmbiguousLifecyclePostCreation,
  jobs,
  listIncidentSignals,
  listIncidents,
  listMessageDeliveryTargets,
  listQueuedSurfaceMessagesSystem,
  setWorkingPost,
  surfaceBindings,
} from '@sre/db';
import { makeDbAuditSink, type ToolContext } from '@sre/agent-tools';
import { slackInboundConnector, type IDataSourceConnector } from '@sre/connectors';
import { type HubMessage } from '@sre/hub';
import { SurfaceRegistry, type SurfacePoster, type SurfaceTarget } from '@sre/surfaces';
import { handleSlackEvent } from '../../../api/src/surfaces/slack-inbound';
import { fanoutHubMessage, type FanoutDeps } from '../../../surface-worker/src/fanout';
import { makeClassifyHandler } from '../classify-consumer';
import { makeFakeClassifier } from '../engine/classify';
import type { TriageEngine, TriageInput, TriageResult } from '../engine/types';
import { makeRedisLock } from '../lock';
import { TriageWorker } from '../worker';
import { createFixture } from './incident-lifecycle.acceptance.fixture';
const __fixture = createFixture();
const CONCLUSIVE_RUN = { outcome: 'conclusive' as const, turnBudget: 1 };
test('Slack edits remain advisory while human actions preserve one audited lifecycle and status post', async () => {
  const investigate = vi.fn(async (input: TriageInput): Promise<TriageResult> => {
    const alert = input.alert as
      { eventType?: string; materialDeltas?: Array<{ eventType?: string }> } | undefined;
    const eventType = alert?.materialDeltas?.[0]?.eventType ?? alert?.eventType;
    const summary =
      eventType === 'refired'
        ? 'Refired RCA: checkout errors returned after closure.'
        : eventType === 'updated'
          ? 'Terminal RCA: the checkout pool saturated after a deploy.'
          : 'Initial RCA: checkout errors correlate with pool saturation.';
    return {
      provider: 'fake',
      sessionId: `fake:${input.incident.id}:${investigate.mock.calls.length}`,
      ...CONCLUSIVE_RUN,
      disposition: 'rca',
      summary,
      confidence: 80,
      unknowns: [],
      nextStep: null,
    };
  });
  const engine: TriageEngine = {
    provider: 'fake',
    investigate,
    async resume() {
      throw new Error('lifecycle-only command batch must not invoke resume');
    },
    async verifyRecovery(input, runtime) {
      const recoveryEvidenceId = await runtime.ctx.audit.record({
        tenantId: __fixture.tenantId,
        incidentId: input.incident.id,
        tool: 'prometheus_query_range',
        input: { query: 'rate(errors_total[5m])' },
        output: { data: { resultType: 'matrix', result: [] } },
        latencyMs: 1,
        outcome: 'data',
      });
      return {
        provider: 'fake',
        sessionId: `fake:${input.incident.id}:recovery`,
        ...CONCLUSIVE_RUN,
        disposition: 'recovery',
        summary: 'Checkout recovered after the provider signal cleared.',
        confidence: 0,
        evidenceReceipts: [
          { evidenceId: recoveryEvidenceId, tool: 'prometheus_query_range', outcome: 'complete' },
        ],
        recovery: {
          recovered: true,
          evidence: [
            {
              name: 'Checkout health',
              before: 'Error rate and pool saturation above threshold',
              now: 'Error rate and pool saturation returned to baseline',
            },
          ],
          evidenceIds: [recoveryEvidenceId],
          unknowns: [],
          nextStep: 'Track the preventative scheduling change as follow-up work.',
        },
      };
    },
  };
  const worker = new TriageWorker({
    generator: __fixture.responderGenerator(),
    appDb: __fixture.app.db,
    hub: __fixture.hub,
    engine,
    queue: __fixture.triageQueue,
    auditSink: makeDbAuditSink({ db: __fixture.app.db }),
    connectorProvider:
      (): ToolContext['resolveConnectors'] => async (): Promise<IDataSourceConnector[]> => [],
    tools: [],
    lock: makeRedisLock(__fixture.redis),
    clearResumeGate: (incidentId) => __fixture.triageQueue.clearResumeGate(incidentId),
  });
  const classifier = makeClassifyHandler({
    appDb: __fixture.app.db,
    redis: __fixture.redis,
    reservationRedis: __fixture.redis,
    queue: __fixture.triageQueue,
    hub: __fixture.hub,
    embedder: {
      dim: EMBED_DIM,
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: EMBED_DIM }, () => 0)),
    },
    classify: makeFakeClassifier(() => ({
      decision: 'new_incident',
      service: 'checkout',
      severity: 'sev1',
      title: 'Checkout error rate is high',
    })),
  });
  const inboundDeps = {
    adminDb: __fixture.admin.db,
    appDb: __fixture.app.db,
    hub: __fixture.hub,
    queue: __fixture.triageQueue,
    classifyQueue: __fixture.classifyQueue,
    redis: __fixture.redis,
    reservationRedis: __fixture.redis,
  };
  const slackConfig = {
    tenantId: __fixture.tenantId,
    surface: 'slack',
    botUserId: 'U_PLATFORM',
    botId: 'B_PLATFORM',
  };
  const firingEnvelope = __fixture.messageEnvelope({
    subtype: 'bot_message',
    bot_id: __fixture.botId,
    text: __fixture.rootText('FIRING', 'Checkout 5xx errors exceed 20%.'),
  });
  expect(
    slackInboundConnector.evaluate(firingEnvelope.event, { botUserId: 'U_PLATFORM' }),
  ).toMatchObject({ disposition: 'admit' });
  expect(
    await handleSlackEvent(inboundDeps, __fixture.surfaceConfigId, slackConfig, firingEnvelope),
  ).toBe('classify_enqueued');
  await __fixture.finishDirectJob(await __fixture.newestQueued('classify'), classifier);
  const opened = await listIncidents(__fixture.app.db, __fixture.tenantId);
  expect(opened).toHaveLength(1);
  const incidentId = opened[0]!.id;
  await __fixture.finishDirectJob(await __fixture.newestQueued('triage'), (job) =>
    worker.handle(job, { signal: new AbortController().signal }),
  );
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
    status: 'open',
    investigationStatus: 'assessed',
    lifecycleVersion: 0,
    rcaSummary: 'Initial RCA: checkout errors correlate with pool saturation.',
  });
  const editedEnvelope = __fixture.messageEnvelope({
    subtype: 'message_changed',
    event_ts: '1787400001.000001',
    message: {
      type: 'message',
      subtype: 'bot_message',
      bot_id: __fixture.botId,
      ts: __fixture.rootTs,
      text: __fixture.rootText('FIRING', 'Checkout 5xx errors now exceed 35%.'),
      edited: { user: 'U_ALERTMANAGER', ts: '1787400001.000001' },
    },
  });
  expect(
    await handleSlackEvent(inboundDeps, __fixture.surfaceConfigId, slackConfig, editedEnvelope),
  ).toBe('edit_enqueued');
  await __fixture.finishDirectJob(await __fixture.newestQueued('classify'), classifier);
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
    status: 'open',
    investigationStatus: 'assessed',
    rcaSummary: 'Initial RCA: checkout errors correlate with pool saturation.',
  });

  const mitigate = __fixture.messageEnvelope({
    user: 'U_RESPONDER',
    ts: '1787400002.000002',
    event_ts: '1787400002.000002',
    thread_ts: __fixture.rootTs,
    text: 'Mark the incident mitigated: traffic shifted to the healthy pool.',
  });
  expect(
    await handleSlackEvent(inboundDeps, __fixture.surfaceConfigId, slackConfig, mitigate),
  ).toBe('resume_enqueued');
  await __fixture.finishDirectJob(await __fixture.newestQueued('resume'), (job) =>
    worker.handle(job, { signal: new AbortController().signal }),
  );
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
    status: 'mitigated',
    lifecycleVersion: 1,
  });

  const resumeJobsBeforeResolution = await __fixture.admin.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.tenantId, __fixture.tenantId), eq(jobs.type, 'resume')));
  const resolvedEnvelope = __fixture.messageEnvelope({
    subtype: 'bot_message',
    bot_id: __fixture.botId,
    ts: '1787400003.000001',
    event_ts: '1787400003.000001',
    thread_ts: __fixture.rootTs,
    text: __fixture.rootText('RESOLVED', 'Checkout error rate returned below threshold.'),
  });
  expect(
    await handleSlackEvent(inboundDeps, __fixture.surfaceConfigId, slackConfig, resolvedEnvelope),
  ).toBe('classify_enqueued');
  await __fixture.finishDirectJob(await __fixture.newestQueued('classify'), classifier);
  expect(await listIncidents(__fixture.app.db, __fixture.tenantId)).toHaveLength(1);
  expect(await listIncidentSignals(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject(
    [{ state: 'unknown', lastEventType: 'opened' }],
  );
  expect(
    await __fixture.admin.db
      .select({ id: surfaceBindings.id })
      .from(surfaceBindings)
      .where(eq(surfaceBindings.tenantId, __fixture.tenantId)),
  ).toHaveLength(1);
  expect(
    await __fixture.admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.tenantId, __fixture.tenantId), eq(jobs.type, 'resume'))),
  ).toHaveLength(resumeJobsBeforeResolution.length);
  await __fixture.hub.transitionIncident(__fixture.tenantId, incidentId, {
    to: 'resolved',
    reason: 'Responder verified current service health independently.',
    transitionKey: `manual-recovery:${incidentId}`,
    author: 'human',
    authorUserId: __fixture.actorUserId,
    originSurface: 'dashboard',
    expectedVersion: 1,
  });
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
    status: 'resolved',
    investigationStatus: 'assessed',
    lifecycleVersion: 2,
    rcaSummary: 'Initial RCA: checkout errors correlate with pool saturation.',
  });

  // Verified recovery resolves the occurrence; follow-up work does not keep it active.
  const closed = await __fixture.hub.transitionIncident(__fixture.tenantId, incidentId, {
    to: 'closed',
    reason: 'Dashboard responder completed the incident record.',
    transitionKey: `dashboard:${incidentId}:${randomUUID()}`,
    author: 'human',
    authorUserId: __fixture.actorUserId,
    originSurface: 'dashboard',
    expectedVersion: 2,
  });
  expect(closed.transition.outcome).toBe('applied');

  const refiredEnvelope = __fixture.messageEnvelope({
    subtype: 'message_changed',
    event_ts: '1787400004.000001',
    message: {
      type: 'message',
      subtype: 'bot_message',
      bot_id: __fixture.botId,
      ts: __fixture.rootTs,
      text: __fixture.rootText('FIRING', 'Checkout errors returned after the incident was closed.'),
      edited: { user: 'U_ALERTMANAGER', ts: '1787400004.000001' },
    },
  });
  expect(
    await handleSlackEvent(inboundDeps, __fixture.surfaceConfigId, slackConfig, refiredEnvelope),
  ).toBe('edit_enqueued');
  await __fixture.finishDirectJob(await __fixture.newestQueued('classify'), classifier);
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
    status: 'closed',
    lifecycleVersion: 3,
  });
  await __fixture.hub.transitionIncident(__fixture.tenantId, incidentId, {
    to: 'open',
    reason: 'Responder observed a new outage.',
    transitionKey: `manual-refire:${incidentId}`,
    author: 'human',
    authorUserId: __fixture.actorUserId,
    originSurface: 'dashboard',
    expectedVersion: 3,
  });

  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
    status: 'open',
    investigationStatus: 'assessed',
    lifecycleVersion: 4,
    rcaSummary: 'Initial RCA: checkout errors correlate with pool saturation.',
  });
  const signals = await listIncidentSignals(__fixture.app.db, __fixture.tenantId, incidentId);
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({ state: 'unknown', lastEventType: 'opened', version: 1 });

  const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
  expect(
    history
      .filter((message) => message.kind === 'signal')
      .map((message) => message.signalEventType),
  ).toEqual(['opened']);
  const lifecycle = history.filter((message) => message.kind === 'lifecycle');
  expect(lifecycle.map((message) => [message.lifecycleTo, message.lifecycleVersion])).toEqual([
    ['open', 0],
    ['mitigated', 1],
    ['resolved', 2],
    ['closed', 3],
    ['open', 4],
  ]);
  const findings = history.filter((message) => message.kind === 'finding');
  expect(findings.some((message) => message.content.includes('Initial RCA:'))).toBe(true);
  expect(findings.some((message) => message.content.startsWith('RECOVERED'))).toBe(false);

  const posts: Array<{ threadId: string; message: HubMessage }> = [];
  const updates: Array<{ messageId: string; message: HubMessage }> = [];
  const poster: SurfacePoster = {
    surface: 'slack',
    async post(_target: SurfaceTarget, threadId: string, message: HubMessage) {
      posts.push({ threadId, message });
      return 'platform-status-1';
    },
    async update(_target: SurfaceTarget, messageId: string, message: HubMessage) {
      updates.push({ messageId, message });
    },
    async delete() {},
  };
  const registry = new SurfaceRegistry();
  registry.register(poster);
  const fanoutDeps: FanoutDeps = {
    registry,
    lock: {
      async acquire() {
        return randomUUID();
      },
      async renew() {
        return true;
      },
      async release() {},
    },
    resolveTenant: async (id) => (id === incidentId ? __fixture.tenantId : null),
    listDeliveryTargets: async (t, messageId) =>
      (await listMessageDeliveryTargets(__fixture.app.db, t, messageId)) as Array<{
        surface: 'slack';
        bindingId: string;
        bindingAssignmentVersion: number;
      }>,
    claimDelivery: (t, surface, bindingId, messageId) =>
      claimSurfaceDelivery(__fixture.app.db, t, surface, bindingId, messageId),
    finishDelivery: (t, surface, bindingId, messageId, result) =>
      finishSurfaceDelivery(__fixture.app.db, t, surface, bindingId, messageId, result),
    scheduleDeliveryRetry: async () => true,
    blockDelivery: async () => {},
    getToken: async () => 'xoxb-acceptance-only',
    resolveAuthorLabel: async () => null,
    getBinding: async (t, surface, bindingId) => {
      const binding = await getBindingById(__fixture.app.db, t, surface, bindingId);
      return binding ? { channel: binding.channel, threadId: binding.threadId } : null;
    },
    getStatusPost: (t, surface, bindingId) =>
      getSurfaceStatusPostByBinding(__fixture.app.db, t, surface, bindingId),
    hasAmbiguousStatusPostCreation: (t, surface, bindingId, messageId) =>
      hasAmbiguousLifecyclePostCreation(__fixture.app.db, t, surface, bindingId, messageId),
    advanceStatusPost: (t, surface, bindingId, id, assignmentVersion, messageId, version) =>
      advanceSurfaceStatusPostByBinding(
        __fixture.app.db,
        t,
        surface,
        bindingId,
        id,
        assignmentVersion,
        messageId,
        version,
      ),
    getWorkingPost: (t, bindingId) => getWorkingPost(__fixture.app.db, t, bindingId),
    setWorkingPost: (t, bindingId, messageId) =>
      setWorkingPost(__fixture.app.db, t, bindingId, messageId),
    clearWorkingPost: (t, bindingId) => clearWorkingPost(__fixture.app.db, t, bindingId),
    dashboardBaseUrl: 'http://dashboard.test',
  };
  const recoveredLifecycle = (await listQueuedSurfaceMessagesSystem(__fixture.admin.db, 100))
    .filter((item) => item.message.incidentId === incidentId && item.message.kind === 'lifecycle')
    .map((item) => item.message)
    .sort((a, b) => (a.lifecycleVersion ?? -1) - (b.lifecycleVersion ?? -1));
  expect(recoveredLifecycle).toHaveLength(5);
  for (const message of recoveredLifecycle) await fanoutHubMessage(fanoutDeps, message);

  expect(posts).toEqual([
    expect.objectContaining({
      threadId: __fixture.rootTs,
      message: expect.objectContaining({ lifecycleTo: 'open', lifecycleVersion: 0 }),
    }),
  ]);
  expect(updates).toHaveLength(4);
  expect(updates.every((update) => update.messageId === 'platform-status-1')).toBe(true);
  expect(updates.some((update) => update.messageId === __fixture.rootTs)).toBe(false);
  expect(updates.at(-1)?.message).toMatchObject({ lifecycleTo: 'open', lifecycleVersion: 4 });
  const primaryBinding = await getBindingByIncident(
    __fixture.app.db,
    __fixture.tenantId,
    'slack',
    incidentId,
  );
  expect(
    await getSurfaceStatusPostByBinding(
      __fixture.app.db,
      __fixture.tenantId,
      'slack',
      primaryBinding!.id,
    ),
  ).toEqual({
    messageId: 'platform-status-1',
    version: 4,
  });

  const sourceHash = createHash('sha256')
    .update(__fixture.rootText('FIRING', 'Checkout 5xx errors exceed 20%.'))
    .digest('hex');
  expect(signals[0]!.contentHash).toBe(sourceHash);
}, 30_000);
test('a separate stock StatusCake went-Up root remains advisory until an exact connector binding', async () => {
  const downTs = '1787900810.813739';
  const upTs = '1787901766.830379';
  const statusCakeBot = 'B_STATUSCAKE';
  const downText = [
    "Website | Your site '<http://checkout.example|checkout.example>' (<https://checkout.example>) went Down [HTTP 504] [Unexpected Status Code]",
    '<http://checkout.example|checkout.example> - <https://checkout.example>',
    'Your site went down!',
    '*Code:* 504 - *Reason:* Unexpected Status Code',
  ].join('\n');
  const upText = [
    "Website | Your site '<http://checkout.example|checkout.example>' (<https://checkout.example>) went Up [HTTP 200] [Successful Connection]",
    '<http://checkout.example|checkout.example> - <https://checkout.example>',
    'Your site went back up!',
    '*Code:* 200 - *Downtime:* 000:15:55',
  ].join('\n');
  const engine: TriageEngine = {
    provider: 'fake',
    async investigate(input) {
      return {
        provider: 'fake',
        sessionId: `fake:${input.incident.id}:statuscake`,
        ...CONCLUSIVE_RUN,
        summary: 'The monitored public site returned HTTP 504.',
        confidence: 70,
        unknowns: [],
        nextStep: null,
      };
    },
    async resume() {
      throw new Error('StatusCake lifecycle acceptance must not invoke resume');
    },
    async verifyRecovery() {
      throw new Error('Provider clearance must not require a recovery model');
    },
  };
  const worker = new TriageWorker({
    generator: __fixture.responderGenerator(),
    appDb: __fixture.app.db,
    hub: __fixture.hub,
    engine,
    queue: __fixture.triageQueue,
    auditSink: makeDbAuditSink({ db: __fixture.app.db }),
    connectorProvider:
      (): ToolContext['resolveConnectors'] => async (): Promise<IDataSourceConnector[]> => [],
    tools: [],
    lock: makeRedisLock(__fixture.redis),
    clearResumeGate: (incidentId) => __fixture.triageQueue.clearResumeGate(incidentId),
  });
  const classifier = makeClassifyHandler({
    appDb: __fixture.app.db,
    redis: __fixture.redis,
    reservationRedis: __fixture.redis,
    queue: __fixture.triageQueue,
    hub: __fixture.hub,
    embedder: {
      dim: EMBED_DIM,
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: EMBED_DIM }, () => 0)),
    },
    classify: makeFakeClassifier((candidate) => {
      if (candidate.text.includes('went Up')) {
        throw new Error('Normalized uptime recovery must bypass classification');
      }
      return {
        decision: 'new_incident',
        service: 'website',
        severity: 'sev1',
        title: 'checkout.example down — HTTP 504 from uptime monitor',
      };
    }),
  });
  const inboundDeps = {
    adminDb: __fixture.admin.db,
    appDb: __fixture.app.db,
    hub: __fixture.hub,
    queue: __fixture.triageQueue,
    classifyQueue: __fixture.classifyQueue,
    redis: __fixture.redis,
    reservationRedis: __fixture.redis,
  };
  const slackConfig = {
    tenantId: __fixture.tenantId,
    surface: 'slack',
    botUserId: 'U_PLATFORM',
    botId: 'B_PLATFORM',
  };

  const downEnvelope = __fixture.messageEnvelope({
    subtype: 'bot_message',
    bot_id: statusCakeBot,
    ts: downTs,
    event_ts: downTs,
    text: downText,
  });
  expect(
    await handleSlackEvent(inboundDeps, __fixture.surfaceConfigId, slackConfig, downEnvelope),
  ).toBe('classify_enqueued');
  await __fixture.finishDirectJob(await __fixture.newestQueued('classify'), classifier);
  const binding = await getBindingByExternal(
    __fixture.app.db,
    __fixture.tenantId,
    'slack',
    `${__fixture.channel}:${downTs}`,
  );
  const incident = binding
    ? await getIncident(__fixture.app.db, __fixture.tenantId, binding.incidentId)
    : undefined;
  expect(incident).toBeDefined();
  await __fixture.finishDirectJob(await __fixture.newestQueued('triage'), (job) =>
    worker.handle(job, { signal: new AbortController().signal }),
  );

  const upEnvelope = __fixture.messageEnvelope({
    subtype: 'bot_message',
    bot_id: statusCakeBot,
    ts: upTs,
    event_ts: upTs,
    text: upText,
  });
  expect(
    slackInboundConnector.evaluate(upEnvelope.event, { botUserId: 'U_PLATFORM' }),
  ).toMatchObject({ disposition: 'admit' });
  expect(
    await handleSlackEvent(inboundDeps, __fixture.surfaceConfigId, slackConfig, upEnvelope),
  ).toBe('classify_enqueued');
  await __fixture.finishDirectJob(await __fixture.newestQueued('classify'), classifier);

  expect(
    await listIncidentSignals(__fixture.app.db, __fixture.tenantId, incident!.id),
  ).toMatchObject([
    {
      externalMessageId: downTs,
      state: 'unknown',
      lastEventType: 'opened',
      version: 1,
    },
  ]);
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident!.id)).toMatchObject({
    status: 'open',
  });
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident!.id)).toMatchObject({
    status: 'open',
    resolutionPolicy: 'verified_recovery',
    resolutionBasis: null,
  });
  expect(
    await __fixture.admin.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, __fixture.tenantId), eq(jobs.type, 'recovery.verify'))),
  ).toHaveLength(0);
}, 30_000);
