import { beforeAll, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { SIGNAL_DISPOSITION_CORPUS_SIZE } from '@sre/contracts';
import {
  claimSignalDispositionEvaluation,
  completeSignalDispositionEvaluation,
  jobs,
  signalDispositionEvaluations,
} from '@sre/db';
import { createFixture } from './incidents.fixture';

const __fixture = createFixture();
let token: string;
const scenarioResults = Array.from({ length: SIGNAL_DISPOSITION_CORPUS_SIZE }, (_value, index) => ({
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
}));

beforeAll(async () => {
  token = await __fixture.sign(__fixture.orgC);
});

const request = (path: string, init?: RequestInit) =>
  __fixture.api.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

describe('signal classifier policy', () => {
  test('rejects an operator-supplied score and queues a server-owned runtime evaluation', async () => {
    const fabricated = await request('/signals/policy', {
      method: 'PUT',
      body: JSON.stringify({
        retentionDays: 30,
        unsolvedAfterMinutes: 60,
        secondTeamEnabled: true,
        customerVisibleEnabled: true,
        corpusCriticalSafetyMisses: 0,
      }),
    });
    expect(fabricated.status).toBe(400);

    const response = await request('/signals/evaluations', { method: 'POST' });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      evaluation: { id: string; jobId: string; status: string };
    };
    expect(body.evaluation.status).toBe('queued');
    const queued = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(
        sql`tenant_id = ${__fixture.tenantC} and type = 'signal.disposition.evaluate' and payload->>'evaluationId' = ${body.evaluation.id}`,
      );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe(body.evaluation.jobId);
  });

  test('requires the queued zero-critical-miss result before audited enforcement approval', async () => {
    const rows = await __fixture.admin.db
      .select()
      .from(signalDispositionEvaluations)
      .where(eq(signalDispositionEvaluations.tenantId, __fixture.tenantC));
    const evaluation = rows.at(-1)!;
    await claimSignalDispositionEvaluation(
      __fixture.app.db,
      __fixture.tenantC,
      evaluation.id,
      evaluation.jobId!,
    );
    await completeSignalDispositionEvaluation(__fixture.app.db, __fixture.tenantC, evaluation.id, {
      total: SIGNAL_DISPOSITION_CORPUS_SIZE,
      correct: SIGNAL_DISPOSITION_CORPUS_SIZE,
      criticalSafetyMisses: 0,
      classMetrics: { investigate: { recall: 1 } },
      scenarioResults,
    });

    const approved = await request('/signals/policy/enforce', {
      method: 'POST',
      body: JSON.stringify({
        evaluationId: evaluation.id,
        reviewedTicketScenarioIds: ['scenario-0'],
      }),
    });
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      policy: {
        classificationMode: 'enforce',
        approvedEvaluationId: evaluation.id,
      },
      effectiveClassificationMode: 'enforce',
    });
  });
});
