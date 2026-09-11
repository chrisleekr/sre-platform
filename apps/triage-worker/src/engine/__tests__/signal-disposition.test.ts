import { createHash } from 'node:crypto';
import {
  SEMANTIC_DISPOSITION_CONTRACT_VERSION,
  SIGNAL_DISPOSITION_CORPUS_SIZE,
  SIGNAL_DISPOSITION_CORPUS_VERSION,
} from '@sre/contracts';
import * as z from 'zod';
import { describe, expect, test, vi } from 'vitest';
import { SIGNAL_DISPOSITION_SCENARIOS } from '../signal-disposition-corpus';

const loadDisposition = () => import('../signal-disposition');

const investigate = {
  disposition: 'investigate',
  decision: 'new_incident',
  reason: 'Urgent, actionable, and currently customer-visible.',
  service: 'checkout',
  severity: 'sev1',
  title: 'Checkout majority 5xx',
};

const ticket = {
  disposition: 'ticket',
  decision: 'standalone',
  reason: 'Real reliability risk without current user impact.',
  service: 'kubernetes',
  severity: 'sev3',
  title: 'Cluster request overcommit',
  action: 'Restore node-failure headroom.',
  safeDeferralReason: 'The cluster is serving traffic and all nodes are healthy.',
  riskIfIgnored: 'A node loss may evict workloads.',
  reviewHorizonMinutes: 1_440,
};

const log = {
  disposition: 'log',
  decision: 'standalone',
  reason: 'Successful deployment notification with no reliability problem.',
};

describe('semantic disposition schema', () => {
  test.each([
    ['investigate', investigate],
    ['ticket', ticket],
    ['log', log],
  ])('accepts the complete %s contract', async (_name, value) => {
    const { semanticDispositionSchema } = await loadDisposition();
    expect(semanticDispositionSchema.parse(value)).toEqual(value);
  });

  test('requires every concrete deferral field for a ticket', async () => {
    const { semanticDispositionSchema } = await loadDisposition();
    for (const key of [
      'action',
      'safeDeferralReason',
      'riskIfIgnored',
      'reviewHorizonMinutes',
    ] as const) {
      const malformed: Record<string, unknown> = { ...ticket };
      delete malformed[key];
      expect(semanticDispositionSchema.safeParse(malformed).success).toBe(false);
    }
  });

  test('keeps disposition orthogonal to correlation', async () => {
    const { semanticDispositionSchema } = await loadDisposition();
    expect(
      semanticDispositionSchema.parse({
        ...ticket,
        decision: 'belongs_to',
        index: 2,
      }),
    ).toMatchObject({ disposition: 'ticket', decision: 'belongs_to', index: 2 });
  });

  test('requires bounded candidate selection for correlation and recovery', async () => {
    const { semanticDispositionSchema } = await loadDisposition();
    expect(semanticDispositionSchema.safeParse({ ...log, decision: 'belongs_to' }).success).toBe(
      false,
    );
    expect(
      semanticDispositionSchema.safeParse({
        ...log,
        decision: 'resolves_signal',
        signalIndex: 1,
      }).success,
    ).toBe(true);
    expect(
      semanticDispositionSchema.safeParse({
        ...investigate,
        decision: 'resolves_signal',
        signalIndex: 1,
      }).success,
    ).toBe(false);
  });
});

describe('durable semantic classification operation', () => {
  test('uses one generation over durable scrubbed context without diagnostic tools', async () => {
    const { classifyDurableSignal, SEMANTIC_DISPOSITION_RUBRIC } = await loadDisposition();
    const generate = vi.fn(async (_request: Record<string, unknown>, _system: string) => ticket);
    const rawMarker = 'RAW-SECRET-MUST-NOT-APPEAR';

    await expect(
      classifyDurableSignal(
        {
          signalId: 'signal-1',
          jobId: 'job-1',
          summary: 'Cluster requests exceed failover capacity.',
          source: 'alertmanager',
          author: 'provider',
          service: 'kubernetes',
          signalState: 'firing',
        },
        { generate },
      ),
    ).resolves.toEqual(ticket);

    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0]![0];
    const system = generate.mock.calls[0]![1];
    expect(JSON.stringify(request)).toContain('Cluster requests exceed failover capacity.');
    expect(JSON.stringify(request)).not.toContain(rawMarker);
    expect(JSON.stringify(request)).not.toContain(SEMANTIC_DISPOSITION_RUBRIC);
    expect(system).toBe(SEMANTIC_DISPOSITION_RUBRIC);
    expect(request).not.toHaveProperty('tools');
  });

  test('keeps the policy in the trusted system instruction', async () => {
    const { classifyDurableSignal } = await loadDisposition();
    const generate = vi.fn(async (_request: Record<string, unknown>, _system: string) => ticket);
    await classifyDurableSignal(
      {
        signalId: 'signal-2',
        jobId: 'job-2',
        summary: 'Something is slower, impact unknown.',
        source: 'slack',
        author: 'human',
        service: null,
        signalState: 'unknown',
      },
      { generate },
    );
    const prompt = generate.mock.calls[0]![1];
    expect(prompt).toContain('urgent');
    expect(prompt).toContain('actionable');
    expect(prompt).toContain('user-visible');
    expect(prompt).toMatch(/uncertain|ambigu/i);
    expect(prompt).toContain('ticket');
  });

  test('removes common credentials from the model request and structured result', async () => {
    const { classifyDurableSignal } = await loadDisposition();
    const privateKey =
      '-----BEGIN PRIVATE KEY-----\nplain-private-material\n-----END PRIVATE KEY-----';
    const generate = vi.fn(async (_request: Record<string, unknown>, _system: string) => ({
      ...ticket,
      action: 'rotate password=hunter2',
      safeDeferralReason: 'database postgres://alice:secret@db.example/app is reachable',
      riskIfIgnored: privateKey,
    }));
    const result = await classifyDurableSignal(
      {
        signalId: 'signal-secret',
        jobId: 'job-secret',
        summary: `DATABASE_URL=postgres://alice:secret@db.example/app ${privateKey}`,
        source: 'slack-human',
        author: 'human',
        service: null,
        signalState: 'unknown',
      },
      { generate },
    );

    const request = JSON.stringify(generate.mock.calls[0]![0]);
    const output = JSON.stringify(result);
    for (const secret of ['hunter2', 'alice:secret', 'plain-private-material']) {
      expect(request).not.toContain(secret);
      expect(output).not.toContain(secret);
    }
    expect(request).toContain('[REDACTED]');
    expect(output).toContain('[REDACTED]');
  });

  test('scrubs secrets from every model-authored persisted field', async () => {
    const { classifyDurableSignal } = await loadDisposition();
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const result = await classifyDurableSignal(
      {
        signalId: 'signal-secret',
        jobId: 'job-secret',
        summary: 'A scrubbed active provider signal.',
        source: 'alertmanager',
        author: 'provider',
        service: 'api',
        signalState: 'firing',
      },
      {
        generate: async () => ({
          ...ticket,
          service: `api-${secret}`,
          title: `Review ${secret}`,
          reason: `Reason ${secret}`,
          action: `Action ${secret}`,
          safeDeferralReason: `Deferral ${secret}`,
          riskIfIgnored: `Risk ${secret}`,
        }),
      },
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });

  test('never silently logs an active provider firing signal', async () => {
    const { classifyDurableSignal } = await loadDisposition();
    await expect(
      classifyDurableSignal(
        {
          signalId: 'signal-control',
          jobId: 'job-control',
          summary: 'Synthetic alert is firing.',
          source: 'alertmanager',
          author: 'provider',
          service: 'monitoring',
          signalState: 'firing',
        },
        { generate: async () => log },
      ),
    ).resolves.toMatchObject({
      disposition: 'ticket',
      reviewHorizonMinutes: 60,
    });
  });

  test('rejects a recovery decision for a non-recovery observation', async () => {
    const { classifyDurableSignal } = await loadDisposition();
    await expect(
      classifyDurableSignal(
        {
          signalId: 'signal-firing',
          jobId: 'job-firing',
          summary: 'Still firing.',
          source: 'alertmanager',
          author: 'provider',
          service: 'api',
          signalState: 'firing',
        },
        {
          generate: async () => ({
            ...log,
            decision: 'resolves_signal',
            signalIndex: 1,
          }),
        },
      ),
    ).rejects.toThrow('only a provider recovery');
  });
});

describe('frozen semantic corpus and shadow gate', () => {
  const expectedPrediction = (row: (typeof SIGNAL_DISPOSITION_SCENARIOS)[number]) => ({
    disposition: row.expected,
    decision: row.expectedDecision.decision,
    ...(row.expectedDecision.index === undefined ? {} : { index: row.expectedDecision.index }),
    ...(row.expectedDecision.signalIndex === undefined
      ? {}
      : { signalIndex: row.expectedDecision.signalIndex }),
    ...row.ticket,
  });

  test('requires an explicit corpus-version update when reviewed scenarios change', () => {
    expect(
      createHash('sha256').update(JSON.stringify(SIGNAL_DISPOSITION_SCENARIOS)).digest('hex'),
    ).toBe(SIGNAL_DISPOSITION_CORPUS_VERSION);
    expect(SIGNAL_DISPOSITION_SCENARIOS).toHaveLength(SIGNAL_DISPOSITION_CORPUS_SIZE);
  });

  test('binds enforcement to the exact trusted rubric and structured schema', async () => {
    const {
      semanticDispositionSchema,
      SEMANTIC_DISPOSITION_RUBRIC,
      SEMANTIC_DISPOSITION_BEHAVIOR_VERSION,
    } = await loadDisposition();
    const { STRUCTURED_UNTRUSTED_DATA_INSTRUCTION } = await import('../types');
    expect(
      createHash('sha256')
        .update(
          JSON.stringify({
            rubric: SEMANTIC_DISPOSITION_RUBRIC,
            schema: z.toJSONSchema(semanticDispositionSchema),
            structuredBoundary: STRUCTURED_UNTRUSTED_DATA_INSTRUCTION,
            behavior: SEMANTIC_DISPOSITION_BEHAVIOR_VERSION,
          }),
        )
        .digest('hex'),
    ).toBe(SEMANTIC_DISPOSITION_CONTRACT_VERSION);
  });

  test('covers all three classes, both live author shapes, and concrete ticket horizons', () => {
    expect(new Set(SIGNAL_DISPOSITION_SCENARIOS.map((row) => row.expected))).toEqual(
      new Set(['investigate', 'ticket', 'log']),
    );
    expect(new Set(SIGNAL_DISPOSITION_SCENARIOS.map((row) => row.durableContext.author))).toEqual(
      new Set(['human', 'bot']),
    );
    expect(
      SIGNAL_DISPOSITION_SCENARIOS.filter((row) => row.durableContext.author === 'human').every(
        (row) => row.durableContext.providerGroupKey === null,
      ),
    ).toBe(true);
    expect(SIGNAL_DISPOSITION_SCENARIOS.length).toBeGreaterThanOrEqual(18);
    expect(
      SIGNAL_DISPOSITION_SCENARIOS.filter((row) => row.expectedDecision).map(
        (row) => row.expectedDecision?.decision,
      ),
    ).toEqual(
      expect.arrayContaining(['belongs_to', 'resolves_signal', 'new_incident', 'standalone']),
    );
    for (const row of SIGNAL_DISPOSITION_SCENARIOS.filter(
      (scenario) => scenario.expected === 'ticket',
    )) {
      expect(row.ticket).toEqual(
        expect.objectContaining({
          action: expect.any(String),
          safeDeferralReason: expect.any(String),
          riskIfIgnored: expect.any(String),
          reviewHorizonMinutes: expect.any(Number),
        }),
      );
    }
  });

  test('blocks enforcement for one critical-safety miss even with operator approval', async () => {
    const { scoreSignalDispositionCorpus, semanticDispositionGate } = await loadDisposition();
    const predictions = new Map(
      SIGNAL_DISPOSITION_SCENARIOS.map((row) => [row.id, expectedPrediction(row)]),
    );
    predictions.set('checkout-majority-5xx', {
      disposition: 'ticket',
      decision: 'standalone',
    });
    const score = scoreSignalDispositionCorpus(SIGNAL_DISPOSITION_SCENARIOS, predictions);

    expect(score.criticalSafetyMisses).toBe(1);
    expect(score.classMetrics).toEqual(
      expect.objectContaining({ investigate: expect.any(Object), ticket: expect.any(Object) }),
    );
    expect(
      semanticDispositionGate({
        score,
        operatorApproval: {
          approved: true,
          actor: 'operator-1',
          reviewedTicketScenarioIds: score.ticketScenarioIds,
        },
      }),
    ).toEqual(expect.objectContaining({ enforce: false, reason: 'critical_safety_miss' }));
  });

  test('requires perfect reviewed-corpus conformance and audited operator approval', async () => {
    const { scoreSignalDispositionCorpus, semanticDispositionGate } = await loadDisposition();
    const predictions = new Map(
      SIGNAL_DISPOSITION_SCENARIOS.map((row) => [row.id, expectedPrediction(row)]),
    );
    const score = scoreSignalDispositionCorpus(SIGNAL_DISPOSITION_SCENARIOS, predictions);

    expect(semanticDispositionGate({ score, operatorApproval: null })).toEqual(
      expect.objectContaining({ enforce: false, reason: 'operator_approval_required' }),
    );
    expect(
      semanticDispositionGate({
        score,
        operatorApproval: {
          approved: true,
          actor: 'operator-1',
          reviewedTicketScenarioIds: score.ticketScenarioIds,
        },
      }),
    ).toEqual(expect.objectContaining({ enforce: true, reason: 'approved' }));

    predictions.set('successful-deployment', {
      disposition: 'ticket',
      decision: 'standalone',
    });
    expect(
      semanticDispositionGate({
        score: scoreSignalDispositionCorpus(SIGNAL_DISPOSITION_SCENARIOS, predictions),
        operatorApproval: {
          approved: true,
          actor: 'operator-1',
          reviewedTicketScenarioIds: score.ticketScenarioIds,
        },
      }),
    ).toEqual(expect.objectContaining({ enforce: false, reason: 'corpus_miss' }));
  });

  test('counts an incomplete or overly deferred ticket as an accuracy miss', async () => {
    const { scoreSignalDispositionCorpus } = await loadDisposition();
    const scenario = SIGNAL_DISPOSITION_SCENARIOS.find((row) => row.id === 'capacity-overcommit')!;
    const score = scoreSignalDispositionCorpus(
      [scenario],
      new Map([
        [
          scenario.id,
          {
            disposition: 'ticket',
            decision: 'standalone',
            action: '',
            safeDeferralReason: 'No impact.',
            riskIfIgnored: 'Capacity loss.',
            reviewHorizonMinutes: scenario.ticket!.reviewHorizonMinutes + 1,
          },
        ],
      ]),
    );
    expect(score.correct).toBe(0);
  });

  test('blocks contradictory free-form ticket semantics until every ticket is reviewed', async () => {
    const { scoreSignalDispositionCorpus, semanticDispositionGate } = await loadDisposition();
    const predictions = new Map(
      SIGNAL_DISPOSITION_SCENARIOS.map((row) => [row.id, expectedPrediction(row)]),
    );
    predictions.set('capacity-overcommit', {
      disposition: 'ticket',
      decision: 'standalone',
      action: 'Do nothing.',
      safeDeferralReason: 'There is no reason.',
      riskIfIgnored: 'There is no risk.',
      reviewHorizonMinutes: 60,
    });
    const score = scoreSignalDispositionCorpus(SIGNAL_DISPOSITION_SCENARIOS, predictions);
    expect(score.correct).toBe(score.total);
    expect(
      semanticDispositionGate({
        score,
        operatorApproval: {
          approved: true,
          actor: 'operator-1',
          reviewedTicketScenarioIds: score.ticketScenarioIds.filter(
            (id) => id !== 'capacity-overcommit',
          ),
        },
      }),
    ).toEqual({ enforce: false, reason: 'ticket_semantics_review_required' });
  });

  test('counts an unavailable routing target as a miss even when the disposition is correct', async () => {
    const { scoreSignalDispositionCorpus } = await loadDisposition();
    const scenario = SIGNAL_DISPOSITION_SCENARIOS.find((row) => row.id === 'capacity-overcommit')!;
    const score = scoreSignalDispositionCorpus(
      [scenario],
      new Map([
        [
          scenario.id,
          {
            ...expectedPrediction(scenario),
            decision: 'belongs_to',
            index: 1,
          },
        ],
      ]),
    );
    expect(score.correct).toBe(0);
  });
});
