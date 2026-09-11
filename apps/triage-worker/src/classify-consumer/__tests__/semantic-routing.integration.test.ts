import { seedMembership } from '@sre/db/test-support';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SEMANTIC_DISPOSITION_CONTRACT_VERSION,
  SIGNAL_DISPOSITION_CORPUS_SIZE,
  SIGNAL_DISPOSITION_CORPUS_VERSION,
} from '@sre/contracts';
import {
  approveSignalDispositionEnforcement,
  createIncident,
  incidentSignals,
  incidents,
  makeDb,
  memberships,
  signalDispositionEvaluations,
  signalDispositions,
  recordSignalDisposition,
  returnSignalDispositionToShadow,
  tenantSignalPolicies,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import type { InboundCandidate } from '@sre/connectors';
import type { Job } from '@sre/queue';
import { makeClassifyHandler } from '../../classify-consumer';
import { ClassifyCore } from '../core';
import { proposeSemanticDisposition } from '../semantic-routing';
import type { LlmRuntimeManager } from '../../llm-runtime';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const RUNTIME = 'semantic-routing-runtime';

let admin: DbHandle;
let app: DbHandle;
const shadowTenant = randomUUID();
const enforceTenant = randomUUID();
let shadowUser: string;
let enforceUser: string;
let enforceEvaluationId: string;

const semantic = {
  investigate: {
    disposition: 'investigate',
    decision: 'new_incident',
    reason: 'Active customer-visible failure.',
    service: 'checkout',
    severity: 'sev2',
    title: 'Checkout unavailable',
  },
  ticket: {
    disposition: 'ticket',
    decision: 'standalone',
    reason: 'Reliability risk without current impact.',
    service: 'checkout',
    severity: 'sev3',
    title: 'Checkout capacity risk',
    action: 'Restore headroom.',
    safeDeferralReason: 'Traffic is currently healthy.',
    riskIfIgnored: 'A node failure may affect customers.',
    reviewHorizonMinutes: 60,
  },
  log: {
    disposition: 'log',
    decision: 'standalone',
    reason: 'Context only.',
  },
} as const;
const evaluationScenarioResults = Array.from(
  { length: SIGNAL_DISPOSITION_CORPUS_SIZE },
  (_value, index) => ({
    id: `scenario-${index}`,
    expected: index === 0 ? 'ticket' : 'log',
    expectedTicket:
      index === 0
        ? {
            action: 'Review',
            safeDeferralReason: 'Safe',
            riskIfIgnored: 'Risk',
            reviewHorizonMinutes: 60,
          }
        : null,
    prediction: { disposition: index === 0 ? 'ticket' : 'log' },
  }),
);
const reviewedTicketScenarioIds = ['scenario-0'];

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  await admin.db.insert(tenants).values([
    { id: shadowTenant, name: 'semantic-routing-shadow' },
    { id: enforceTenant, name: 'semantic-routing-enforce' },
  ]);
  shadowUser = await seedMembership(
    admin.db,
    { issuer: 'https://semantic-routing.test/', subject: `shadow-${randomUUID()}` },
    shadowTenant,
  );
  enforceUser = await seedMembership(
    admin.db,
    { issuer: 'https://semantic-routing.test/', subject: `enforce-${randomUUID()}` },
    enforceTenant,
  );
  const evaluationId = randomUUID();
  enforceEvaluationId = evaluationId;
  await admin.db.insert(signalDispositionEvaluations).values({
    id: evaluationId,
    tenantId: enforceTenant,
    status: 'completed',
    corpusVersion: SIGNAL_DISPOSITION_CORPUS_VERSION,
    contractVersion: SEMANTIC_DISPOSITION_CONTRACT_VERSION,
    runtimeFingerprint: RUNTIME,
    total: SIGNAL_DISPOSITION_CORPUS_SIZE,
    correct: SIGNAL_DISPOSITION_CORPUS_SIZE,
    criticalSafetyMisses: 0,
    classMetrics: {},
    scenarioResults: evaluationScenarioResults,
    requestedByUserId: enforceUser,
    completedAt: new Date(),
  });
  await approveSignalDispositionEnforcement(app.db, enforceTenant, {
    evaluationId,
    userId: enforceUser,
    runtimeFingerprint: RUNTIME,
    reviewedTicketScenarioIds,
  });
});

afterAll(async () => {
  if (admin) {
    await admin.db
      .delete(signalDispositions)
      .where(sql`tenant_id in (${shadowTenant}, ${enforceTenant})`);
    await admin.db
      .delete(incidentSignals)
      .where(sql`tenant_id in (${shadowTenant}, ${enforceTenant})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${shadowTenant}, ${enforceTenant})`);
    await admin.db
      .delete(tenantSignalPolicies)
      .where(sql`tenant_id in (${shadowTenant}, ${enforceTenant})`);
    await admin.db
      .delete(signalDispositionEvaluations)
      .where(sql`tenant_id in (${shadowTenant}, ${enforceTenant})`);
    await admin.db.delete(memberships).where(sql`tenant_id in (${shadowTenant}, ${enforceTenant})`);
    await admin.db.delete(users).where(sql`id in (${shadowUser}, ${enforceUser})`);
    await admin.db.delete(tenants).where(sql`id in (${shadowTenant}, ${enforceTenant})`);
    await admin.close();
  }
  if (app) await app.close();
});

function candidate(id: string, overrides: Partial<InboundCandidate> = {}): InboundCandidate {
  const text = overrides.text ?? 'Checkout reliability signal.';
  return {
    externalId: id,
    channel: 'C-SEMANTIC',
    author: 'human',
    text,
    raw: { text },
    signalState: 'unknown',
    eventKey: `slack:C-SEMANTIC:${id}`,
    eventAt: '2026-09-02T02:00:00.000Z',
    contentHash: createHash('sha256').update(text).digest('hex'),
    isEdit: false,
    ...overrides,
  };
}

function job(tenantId: string, value: InboundCandidate, attempts = 1): Job {
  return {
    id: randomUUID(),
    tenantId,
    type: 'classify',
    attempts,
    payload: value,
  };
}

function handler(result: unknown, runtimeFingerprint = RUNTIME) {
  const generate = vi.fn(async () => result);
  const execute = vi.fn(async (_meta, run) => run({ generator: { generate } } as never));
  const llm = {
    execute,
    configurationFingerprint: async () => runtimeFingerprint,
  } as unknown as LlmRuntimeManager;
  const route = vi.fn(async () => ({
    deduped: false,
    reused: false,
    incidentId: randomUUID(),
  }));
  const onOutcome = vi.fn();
  const classify = makeClassifyHandler({
    llm,
    semanticDispositionEnabled: true,
    appDb: app.db,
    redis: {} as never,
    reservationRedis: {} as never,
    queue: { publishJob: vi.fn() } as never,
    embedder: { dim: 1, embed: async () => [[0]] },
    route,
    onOutcome,
  });
  return { classify, generate, route, onOutcome };
}

describe('production semantic routing', () => {
  test.each([semantic.ticket, semantic.log])(
    'shadow mode observes $disposition without suppressing investigation',
    async (result) => {
      const runtime = handler(result);
      const value = candidate(randomUUID());
      await runtime.classify(job(shadowTenant, value));
      expect(runtime.generate).toHaveBeenCalledOnce();
      expect(runtime.route).toHaveBeenCalledOnce();
      expect(runtime.onOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'new_incident' }),
      );
    },
  );

  test.each([
    [semantic.ticket, 'ticket'],
    [semantic.log, 'log'],
  ] as const)('enforce mode applies %s without opening an incident', async (result, outcome) => {
    const runtime = handler(result);
    await runtime.classify(job(enforceTenant, candidate(randomUUID())));
    expect(runtime.generate).toHaveBeenCalledOnce();
    expect(runtime.route).not.toHaveBeenCalled();
    expect(runtime.onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
  });

  test('fails open when enforcement is revoked while classification is in flight', async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = vi.fn(async () => {
      started();
      await releasePromise;
      return semantic.ticket;
    });
    const route = vi.fn(async () => ({
      deduped: false,
      reused: false,
      incidentId: randomUUID(),
    }));
    const onOutcome = vi.fn();
    const classify = makeClassifyHandler({
      llm: {
        execute: async (_meta, run) => run({ generator: { generate } } as never),
        configurationFingerprint: async () => RUNTIME,
      } as LlmRuntimeManager,
      semanticDispositionEnabled: true,
      appDb: app.db,
      redis: {} as never,
      reservationRedis: {} as never,
      queue: { publishJob: vi.fn() } as never,
      embedder: { dim: 1, embed: async () => [[0]] },
      route,
      onOutcome,
    });
    const value = candidate(randomUUID());
    const running = classify(job(enforceTenant, value));
    await startedPromise;
    await returnSignalDispositionToShadow(app.db, enforceTenant);
    try {
      release();
      await running;

      expect(route).toHaveBeenCalledOnce();
      expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'new_incident' }));
      const rows = await admin.db
        .select()
        .from(signalDispositions)
        .where(sql`tenant_id = ${enforceTenant} and source_event_key = ${value.eventKey}`);
      expect(rows[0]).toMatchObject({
        disposition: 'ticket',
        effectiveDisposition: 'investigate',
      });
    } finally {
      release();
      await running.catch(() => undefined);
      await approveSignalDispositionEnforcement(app.db, enforceTenant, {
        evaluationId: enforceEvaluationId,
        userId: enforceUser,
        runtimeFingerprint: RUNTIME,
        reviewedTicketScenarioIds,
      });
    }
  });

  test('enforce mode opens an investigation for an investigate result', async () => {
    const runtime = handler(semantic.investigate);
    await runtime.classify(job(enforceTenant, candidate(randomUUID())));
    expect(runtime.route).toHaveBeenCalledOnce();
  });

  test('classifier failure and an unavailable correlation target both fail open', async () => {
    const failed = handler(semantic.investigate);
    failed.generate.mockRejectedValueOnce(new Error('provider failed'));
    await failed.classify(job(enforceTenant, candidate(randomUUID()), 5));
    expect(failed.route).toHaveBeenCalledOnce();
    expect(failed.onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'fail_open' }),
    );

    const correlation = handler({
      disposition: 'investigate',
      decision: 'belongs_to',
      index: 1,
      reason: 'Claims to attach to a target that was not offered.',
    });
    await correlation.classify(job(enforceTenant, candidate(randomUUID()), 5));
    expect(correlation.route).toHaveBeenCalledOnce();
    expect(correlation.onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'fail_open' }),
    );
  });

  test('replays the first durable decision without a second model call', async () => {
    const runtime = handler(semantic.investigate);
    const value = candidate(randomUUID());
    await runtime.classify(job(enforceTenant, value));
    await runtime.classify(job(enforceTenant, value));
    expect(runtime.generate).toHaveBeenCalledOnce();
    expect(runtime.route).toHaveBeenCalledTimes(2);
  });

  test('replays an old enforced decision conservatively after the tenant returns to shadow', async () => {
    const runtime = handler(semantic.log);
    const value = candidate(randomUUID());
    await runtime.classify(job(enforceTenant, value));
    expect(runtime.route).not.toHaveBeenCalled();
    await returnSignalDispositionToShadow(app.db, enforceTenant);
    try {
      await runtime.classify(job(enforceTenant, value));
      expect(runtime.generate).toHaveBeenCalledOnce();
      expect(runtime.route).toHaveBeenCalledOnce();
    } finally {
      await approveSignalDispositionEnforcement(app.db, enforceTenant, {
        evaluationId: enforceEvaluationId,
        userId: enforceUser,
        runtimeFingerprint: RUNTIME,
        reviewedTicketScenarioIds,
      });
    }
  });

  test('replays an old enforced decision conservatively after the model runtime changes', async () => {
    const initial = handler(semantic.log);
    const value = candidate(randomUUID());
    await initial.classify(job(enforceTenant, value));
    expect(initial.route).not.toHaveBeenCalled();

    const changed = handler(semantic.log, 'different-runtime');
    await changed.classify(job(enforceTenant, value));
    expect(changed.generate).not.toHaveBeenCalled();
    expect(changed.route).toHaveBeenCalledOnce();
  });

  test('replays a persisted recovery target after it leaves the unresolved candidate list', async () => {
    const incident = await createIncident(app.db, enforceTenant, {
      fingerprint: `recovery-replay-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const signalId = randomUUID();
    await admin.db.insert(incidentSignals).values({
      id: signalId,
      tenantId: enforceTenant,
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-SEMANTIC',
      externalMessageId: 'root-alert',
      state: 'resolved',
      lastEventType: 'resolved',
      summary: 'checkout-api 5xx was elevated',
      contentHash: 'content',
      lastEventKey: 'resolved-event',
      lastEventAt: new Date(),
    });
    const value = candidate(randomUUID(), {
      text: 'Resolved: checkout-api 5xx returned to baseline.',
      signalState: 'resolved',
    });
    await recordSignalDisposition(app.db, enforceTenant, {
      source: 'slack-human',
      sourceEventKey: value.eventKey,
      sourceEventAt: new Date(value.eventAt),
      signalKey: `slack:C-SEMANTIC:${value.externalId}`,
      surface: 'slack',
      channel: value.channel,
      threadId: value.externalId,
      summary: value.text,
      reason: 'The provider reports recovery for the stored signal.',
      disposition: 'log',
      classificationMode: 'enforce',
      effectiveDisposition: 'log',
      runtimeFingerprint: RUNTIME,
      corpusVersion: SIGNAL_DISPOSITION_CORPUS_VERSION,
      contractVersion: SEMANTIC_DISPOSITION_CONTRACT_VERSION,
      correlationDecision: 'resolves_signal',
      correlatedSignalId: signalId,
      ticket: null,
    });
    const generate = vi.fn();
    const core = new ClassifyCore({
      llm: {
        configurationFingerprint: async () => RUNTIME,
      } as LlmRuntimeManager,
      semanticDispositionEnabled: true,
      appDb: app.db,
      redis: {} as never,
      reservationRedis: {} as never,
      queue: {} as never,
      embedder: { dim: 1, embed: async () => [[0]] },
      generator: { generate },
    });
    const resolutionCandidates = [] as Parameters<
      typeof proposeSemanticDisposition
    >[0]['resolutionCandidates'];
    const allResolutionCandidates = [] as Parameters<
      typeof proposeSemanticDisposition
    >[0]['allResolutionCandidates'];
    const result = await proposeSemanticDisposition({
      core,
      candidate: value,
      scrubbedCandidate: value,
      job: job(enforceTenant, value),
      signal: new AbortController().signal,
      candidates: [],
      resolutionCandidates,
      allResolutionCandidates,
      scrubbedText: value.text,
    });

    expect(result).toMatchObject({
      mode: 'enforce',
      semantic: { decision: 'resolves_signal', signalIndex: 1 },
    });
    expect(resolutionCandidates).toHaveLength(1);
    expect(allResolutionCandidates).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });
});
