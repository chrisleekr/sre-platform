import { ClassifyAttachments } from '../classify-consumer/attachments';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { slackInboundConnector, type InboundCandidate } from '@sre/connectors';
import {
  SEMANTIC_DISPOSITION_CONTRACT_VERSION,
  SIGNAL_DISPOSITION_CORPUS_SIZE,
  SIGNAL_DISPOSITION_CORPUS_VERSION,
} from '@sre/contracts';
import {
  alertCohortMembers,
  alertCohorts,
  applySignalObservation,
  approveSignalDispositionEnforcement,
  createIncident,
  EMBED_DIM,
  getIncident,
  incidentSignals,
  inboundSideEffects,
  incidents,
  jobs,
  signalDispositionEvaluations,
  signalDispositions,
  surfaceBindings,
  tenantSignalPolicies,
} from '@sre/db';
import { makeClassifyHandler } from '../classify-consumer';
import { ClassifyCore } from '../classify-consumer/core';
import { ProviderUnavailableError } from '../engine/types';
import type { LlmRuntimeManager } from '../llm-runtime';
import { createFixture } from './worker.fixture';

const fixture = createFixture();
const RUNTIME = 'provider-enrollment-fixture';
const investigate = {
  disposition: 'investigate',
  decision: 'new_incident',
  reason: 'The provider reports an active outage.',
  service: 'checkout',
  severity: 'sev2',
  title: 'Checkout unavailable',
} as const;
const ticket = {
  disposition: 'ticket',
  decision: 'standalone',
  reason: 'Deferred reliability work.',
  service: 'checkout',
  severity: 'sev3',
  title: 'Review checkout capacity',
  action: 'Review capacity.',
  safeDeferralReason: 'Current traffic is healthy.',
  riskIfIgnored: 'Capacity may be exhausted.',
  reviewHorizonMinutes: 60,
} as const;
const log = { disposition: 'log', decision: 'standalone', reason: 'Context only.' } as const;

// The shared worker fixture owns incidents/jobs; these extra classifier records must be removed first.
afterEach(async () => {
  const tenantId = fixture.tenantId;
  await fixture.admin.db
    .delete(inboundSideEffects)
    .where(eq(inboundSideEffects.tenantId, tenantId));
  await fixture.admin.db
    .delete(signalDispositions)
    .where(eq(signalDispositions.tenantId, tenantId));
  await fixture.admin.db
    .delete(tenantSignalPolicies)
    .where(eq(tenantSignalPolicies.tenantId, tenantId));
  await fixture.admin.db
    .delete(signalDispositionEvaluations)
    .where(eq(signalDispositionEvaluations.tenantId, tenantId));
  await fixture.admin.db
    .delete(alertCohortMembers)
    .where(eq(alertCohortMembers.tenantId, tenantId));
  await fixture.admin.db.delete(alertCohorts).where(eq(alertCohorts.tenantId, tenantId));
});

function normalize(event: Record<string, unknown>): InboundCandidate {
  const result = slackInboundConnector.evaluate(event, { botUserId: 'U_PLATFORM' });
  if (result?.disposition !== 'admit')
    throw new Error('Fixture event must be admitted by the real adapter');
  return result.candidate;
}
function episode() {
  const channel = `C_PROVIDER_${randomUUID()}`;
  const seconds = Math.floor(Date.now() / 1000) - 5;
  const url = `https://checkout.example/health/${randomUUID()}`;
  const event = (state: 'Up' | 'Down', offset = 0) => ({
    type: 'message',
    subtype: 'bot_message',
    channel,
    bot_id: 'B_MONITOR',
    ts: `${seconds + offset}.000100`,
    text: `Website | Your site '<${url}|checkout>' went ${state} [HTTP ${state === 'Up' ? 200 : 503}]`,
  });
  return { event, down: normalize(event('Down')), up: normalize(event('Up', 1)) };
}

test.each(['grouped recovery', 'exact-root edit', 'legacy recovery', 'grouped edit'] as const)(
  'unverified Slack %s preserves the durable firing signal without AI',
  async (path) => {
    const source = episode();
    const classifier = runtime(undefined, true);
    let down = source.down;
    let up = source.up;
    if (path === 'legacy recovery') {
      const summary = (state: string) =>
        `<https://alerts.example/#/alerts|[${state}:1] Checkout unavailable>`;
      down = { ...down, text: summary('FIRING'), observations: undefined };
      up = { ...up, text: summary('RESOLVED'), observations: undefined };
    }
    if (path === 'exact-root edit') down = { ...down, observations: undefined };
    if (path.endsWith('edit')) {
      up = {
        ...up,
        externalId: down.externalId,
        isEdit: true,
        observations:
          path === 'exact-root edit'
            ? undefined
            : up.observations?.map((observation, index) => ({
                ...observation,
                externalMessageId: down.observations![index]!.externalMessageId,
                provider: undefined,
              })),
      };
    }
    const incident = await createIncident(fixture.app.db, fixture.tenantId, {
      fingerprint: `historical-unverified-recovery-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    // Represent a retained historical signal without granting authority to a new Slack intake.
    const observation = down.observations?.[0];
    await applySignalObservation(fixture.app.db, fixture.tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: down.channel,
      externalMessageId: observation?.externalMessageId ?? down.externalId,
      state: 'firing',
      summary: observation?.summary ?? down.text,
      contentHash: observation?.contentHash ?? down.contentHash,
      eventKey: observation?.eventKey ?? down.eventKey,
      eventAt: new Date(observation?.eventAt ?? down.eventAt),
      eventVersion: observation?.eventVersion ?? down.eventVersion,
      provider: observation?.provider,
      providerGroupKey: observation?.providerGroupKey,
      monitorKey: observation?.monitorKey,
      alertName: observation?.alertName,
    });
    const before = await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incident.id));
    expect(before).toHaveLength(1);
    expect(before[0]?.state).toBe('firing');
    await classifier.deliver(up, 5);
    const after = await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incident.id));
    expect(after).toEqual(before);
    const recovery = await fixture.admin.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, fixture.tenantId), eq(jobs.type, 'recovery.verify')));
    expect(recovery).toHaveLength(0);
  },
);

test.each(['plain', 'grouped'] as const)(
  'canonical %s signal projection cannot seed or attach a text-only provider clearance',
  (kind) => {
    const { up } = episode();
    const candidate = kind === 'plain' ? { ...up, observations: undefined } : up;
    const signals = ClassifyCore.prototype.signalsFor(candidate);
    expect(signals.some((signal) => signal.state === 'resolved')).toBe(false);
  },
);
function runtime(result: unknown = investigate, missing = false) {
  const generate = vi.fn(async () => result);
  const execute = vi.fn(async (_meta, run) => run({ generator: { generate } } as never));
  const llm = {
    execute,
    configurationFingerprint: async () => RUNTIME,
  } as unknown as LlmRuntimeManager;
  const onOutcome = vi.fn();
  const handler = makeClassifyHandler({
    ...(missing ? {} : { llm }),
    semanticDispositionEnabled: true,
    appDb: fixture.app.db,
    redis: fixture.redis,
    reservationRedis: fixture.redis,
    queue: fixture.queue,
    hub: fixture.hub,
    embedder: {
      dim: EMBED_DIM,
      embed: async (texts) => texts.map(() => Array.from({ length: EMBED_DIM }, () => 0)),
    },
    onOutcome,
  });
  const deliver = (candidate: InboundCandidate, attempts = 1) =>
    handler({
      id: randomUUID(),
      tenantId: fixture.tenantId,
      type: 'classify',
      payload: candidate,
      attempts,
    });
  return { deliver, generate, execute, onOutcome };
}
async function incidentFor(candidate: InboundCandidate) {
  const [binding] = await fixture.admin.db
    .select()
    .from(surfaceBindings)
    .where(
      and(
        eq(surfaceBindings.tenantId, fixture.tenantId),
        eq(surfaceBindings.channel, candidate.channel),
        eq(surfaceBindings.threadId, candidate.externalId),
      ),
    );
  expect(binding).toBeDefined();
  return (await getIncident(fixture.app.db, fixture.tenantId, binding!.incidentId))!;
}
async function counts() {
  const incidentRows = await fixture.admin.db
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.tenantId, fixture.tenantId));
  const triage = await fixture.admin.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.tenantId, fixture.tenantId), eq(jobs.type, 'triage')));
  return { incidents: incidentRows.length, triage: triage.length };
}
async function enforce() {
  const evaluationId = randomUUID();
  await fixture.admin.db.insert(signalDispositionEvaluations).values({
    id: evaluationId,
    tenantId: fixture.tenantId,
    status: 'completed',
    corpusVersion: SIGNAL_DISPOSITION_CORPUS_VERSION,
    contractVersion: SEMANTIC_DISPOSITION_CONTRACT_VERSION,
    runtimeFingerprint: RUNTIME,
    total: SIGNAL_DISPOSITION_CORPUS_SIZE,
    correct: SIGNAL_DISPOSITION_CORPUS_SIZE,
    criticalSafetyMisses: 0,
    classMetrics: {},
    requestedByUserId: fixture.actorUserId,
    completedAt: new Date(),
    scenarioResults: Array.from({ length: SIGNAL_DISPOSITION_CORPUS_SIZE }, (_, index) => ({
      id: `scenario-${index}`,
      expected: index === 0 ? 'ticket' : 'log',
      prediction: { disposition: index === 0 ? 'ticket' : 'log' },
    })),
  });
  await approveSignalDispositionEnforcement(fixture.app.db, fixture.tenantId, {
    evaluationId,
    userId: fixture.actorUserId,
    runtimeFingerprint: RUNTIME,
    reviewedTicketScenarioIds: ['scenario-0'],
  });
}

test('an unverified provider-shaped firing retains strict recovery policy', async () => {
  const { down } = episode();
  const classifier = runtime();
  await classifier.deliver(down);
  expect(await incidentFor(down)).toMatchObject({
    resolutionPolicy: 'verified_recovery',
    investigationStatus: 'queued',
  });
});

test.each(['unavailable', 'missing'] as const)(
  'unverified provider notifications remain advisory when classification is %s',
  async (failure) => {
    const { down, up } = episode();
    const classifier = runtime(undefined, failure === 'missing');
    if (failure === 'unavailable')
      classifier.generate.mockRejectedValue(new ProviderUnavailableError());
    await classifier.deliver(down, 5);
    const incident = await incidentFor(down);
    expect(incident).toMatchObject({
      resolutionPolicy: 'verified_recovery',
      investigationStatus: 'degraded',
      status: 'open',
      resolutionBasis: null,
    });
    const before = await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incident.id));
    expect(before).toEqual([expect.objectContaining({ state: 'unknown', clearProvenance: null })]);
    const calls = classifier.execute.mock.calls.length;
    await classifier.deliver(up);
    expect(classifier.execute).toHaveBeenCalledTimes(calls);
    expect(
      await fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, incident.id)),
    ).toEqual(before);
    expect(
      await fixture.admin.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.tenantId, fixture.tenantId), eq(jobs.type, 'recovery.verify'))),
    ).toHaveLength(0);
  },
);

test('approved semantic investigation cannot authorize provider recovery', async () => {
  await enforce();
  const { down } = episode();
  const classifier = runtime();
  await classifier.deliver(down);
  expect(await incidentFor(down)).toMatchObject({ resolutionPolicy: 'verified_recovery' });
  const [disposition] = await fixture.admin.db
    .select()
    .from(signalDispositions)
    .where(
      and(
        eq(signalDispositions.tenantId, fixture.tenantId),
        eq(signalDispositions.sourceEventKey, down.eventKey),
      ),
    );
  expect(disposition).toMatchObject({
    classificationMode: 'enforce',
    effectiveDisposition: 'investigate',
  });
});

test('an unverified untracked edit remains visible without opening a provider incident', async () => {
  const source = episode();
  const down = source.event('Down');
  const edited = normalize({
    type: 'message',
    subtype: 'message_changed',
    channel: down.channel,
    event_ts: source.event('Down', 1).ts,
    message: { ...down, edited: { ts: source.event('Down', 1).ts } },
  });
  const classifier = runtime();
  const before = await counts();
  await classifier.deliver(edited);
  expect(await counts()).toEqual(before);
  expect(classifier.onOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'resolution_unmatched' }),
  );
  expect(classifier.execute).not.toHaveBeenCalled();
});

test('eligible provider intake retains the bounded unavailable-classifier retry', async () => {
  const { down } = episode();
  const classifier = runtime();
  classifier.generate.mockRejectedValue(new ProviderUnavailableError());
  const before = await counts();
  await expect(classifier.deliver(down, 4)).rejects.toThrow('classify provider unavailable');
  expect(await counts()).toEqual(before);
  expect(classifier.onOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'retry', reason: 'provider_unavailable', attempts: 4 }),
  );
});

test.each([
  { name: 'ticket disposition', result: ticket },
  { name: 'firing-log safety guard', result: log },
])('approved semantic $name is not bypassed by provider enrollment', async ({ result }) => {
  await enforce();
  const { down } = episode();
  const before = await counts();
  const classifier = runtime(result);
  await classifier.deliver(down);
  expect(await counts()).toEqual(before);
  expect(classifier.generate).toHaveBeenCalledTimes(1);
  expect(classifier.onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ticket' }));
  const [disposition] = await fixture.admin.db
    .select()
    .from(signalDispositions)
    .where(
      and(
        eq(signalDispositions.tenantId, fixture.tenantId),
        eq(signalDispositions.sourceEventKey, down.eventKey),
      ),
    );
  expect(disposition).toMatchObject({
    classificationMode: 'enforce',
    disposition: 'ticket',
    effectiveDisposition: 'ticket',
  });
  if (result.disposition === 'log')
    expect(disposition).toMatchObject({
      reason: 'An active provider signal requires human review before suppression.',
      action: 'Confirm whether this firing signal is expected or requires investigation.',
      reviewHorizonMinutes: 60,
    });
});

test.each([
  'unstructured bot',
  'no observations',
  'partial monitor identity',
  'missing producer',
  'human',
] as const)('%s input remains strict when classification fails open', async (kind) => {
  const source = episode();
  let candidate = source.down;
  if (kind === 'missing producer') candidate = { ...candidate, producerId: undefined };
  else if (kind !== 'human')
    candidate = normalize({
      ...source.event('Down'),
      text:
        kind === 'unstructured bot'
          ? 'Deployment failed for checkout'
          : kind === 'no observations'
            ? '[FIRING:1] Checkout errors'
            : '[FIRING:2]\n*Alert:* Checkout errors *Source:* Prometheus Alertmanager\n*Alert:* Missing monitor scope',
    });
  else
    candidate = normalize({
      ...source.event('Down'),
      bot_id: undefined,
      subtype: undefined,
      user: 'U_RESPONDER',
    });
  const classifier = runtime();
  classifier.generate.mockRejectedValue(new ProviderUnavailableError());
  await classifier.deliver(candidate, 5);
  expect(await incidentFor(candidate)).toMatchObject({
    resolutionPolicy: 'verified_recovery',
    investigationStatus: 'degraded',
    status: 'open',
  });
});

test.each(['firing', 'resolved'] as const)(
  'a model attachment cannot downgrade existing %s evidence to unknown',
  async (state) => {
    const source = episode();
    const candidate = {
      ...source.down,
      observations: undefined,
      eventAt: new Date().toISOString(),
      eventKey: randomUUID(),
      text: 'Advisory model attachment',
    };
    const incident = await createIncident(fixture.app.db, fixture.tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const before = (
      await applySignalObservation(fixture.app.db, fixture.tenantId, {
        incidentId: incident.id,
        surface: 'slack',
        channel: candidate.channel,
        externalMessageId: candidate.externalId,
        state,
        clearProvenance: state === 'resolved' ? 'provider' : undefined,
        summary: 'Historical evidence',
        contentHash: 'historical',
        eventKey: randomUUID(),
        eventAt: new Date(Date.now() - 60000),
      })
    ).signal;
    const core = new ClassifyCore({
      appDb: fixture.app.db,
      hub: fixture.hub,
      redis: fixture.redis,
      reservationRedis: fixture.redis,
      queue: fixture.queue,
      embedder: {
        dim: EMBED_DIM,
        embed: async (texts) => texts.map(() => Array(EMBED_DIM).fill(0)),
      },
    });
    await new ClassifyAttachments(core).attachBot(
      fixture.tenantId,
      incident.id,
      candidate,
      candidate.text,
    );
    const [after] = await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.id, before.id));
    expect(after).toEqual(before);
  },
);
