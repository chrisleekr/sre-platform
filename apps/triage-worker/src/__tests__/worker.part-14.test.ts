import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import {
  applySignalObservation,
  applyTriageResult,
  beginInvestigationRun,
  completeInvestigationRun,
  createIncident,
  getIncident,
  recordToolCall,
  serializeSignalFence,
} from '@sre/db';

import { sql } from 'drizzle-orm';

import type { TriageEngine, TriageResult } from '../engine/types';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

function completedAtDate(value: Date | string | null): Date | null {
  return value instanceof Date ? value : value === null ? null : new Date(value);
}

type TerminalOutcome =
  'conclusive' | 'inconclusive' | 'blocked_missing_capability' | 'budget_exhausted' | 'failed';

function terminalResult(
  incidentId: string,
  outcome: TerminalOutcome,
  over: Partial<TriageResult> = {},
): TriageResult {
  return {
    provider: 'fake',
    sessionId: `fake:${incidentId}`,
    model: 'fake-terminal',
    outcome,
    turnBudget: 1,
    evidenceReceipts: [],
    summary: 'Investigation did not produce a promotable assessment.',
    confidence: 0,
    rankedHypotheses: [],
    ...over,
  } as unknown as TriageResult;
}

function engineFor(result: TriageResult): TriageEngine {
  return {
    provider: 'fake',
    async investigate() {
      return result;
    },
    async resume() {
      throw new Error('resume is not used by this test');
    },
    async verifyRecovery() {
      return result;
    },
  };
}

function throwingEngine(): TriageEngine {
  const fail = async (): Promise<TriageResult> => {
    throw new Error('finalizer transport failed');
  };
  return { provider: 'fake', investigate: fail, resume: fail, verifyRecovery: fail };
}

describe('terminal investigation-run provenance and recovery', () => {
  test('a conclusive run atomically promotes its immutable same-incident evidence provenance', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `conclusive-run-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const sibling = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `conclusive-sibling-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    const record = (incidentId: string) =>
      recordToolCall(__fixture.app.db, __fixture.tenantId, {
        incidentId,
        tool: 'query_metrics',
        input: { service: 'checkout' },
        output: { errorRate: 0.42 },
        latencyMs: 4,
        outcome: 'data',
      });
    const validEvidenceId = await record(incident.id);
    const siblingEvidenceId = await record(sibling.id);
    const summary = 'A connection leak exhausted the checkout pool.';
    const rawNextStep =
      'Compare pool usage using sk-abcdefghijklmnopqrstuvwxyz1234 with the rollout timeline.';
    const persistedNextStep = 'Compare pool usage using [REDACTED] with the rollout timeline.';
    const result = terminalResult(incident.id, 'conclusive', {
      disposition: 'rca',
      evidenceReceipts: [
        { evidenceId: validEvidenceId, tool: 'query_metrics', outcome: 'complete' },
      ],
      summary,
      confidence: 91,
      evidenceIds: [validEvidenceId],
      currentState: 'The checkout pool is at capacity.',
      impact: 'Checkout requests are failing.',
      rankedHypotheses: [
        {
          hypothesis: 'Connection leak',
          confidence: 91,
          evidence: 'Active connections rose without falling.',
          state: 'leading',
          supportingEvidenceIds: [validEvidenceId],
        },
      ],
      unknowns: [
        {
          question: 'Whether the rollout was reverted.',
          category: 'observable',
          evidenceKind: 'deployment_as_of',
          attemptedEvidenceIds: [validEvidenceId],
        },
      ],
      nextStep: rawNextStep,
    });

    await __fixture.workerWithEngine(engineFor(result)).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: incident.id },
      },
      { signal: new AbortController().signal },
    );

    const [rawLinked] = (await __fixture.admin.db.execute(sql`
      select r.id,
             r.operation,
             r.outcome,
             r.result,
             r.evidence_ids as "evidenceIds",
             r.completed_at as "completedAt",
             i.trusted_assessment_run_id as "trustedAssessmentRunId"
      from incidents i
      join investigation_runs r
        on r.tenant_id = i.tenant_id
       and r.incident_id = i.id
       and r.id = i.trusted_assessment_run_id
      where i.tenant_id = ${__fixture.tenantId} and i.id = ${incident.id}
    `)) as unknown as Array<{
      id: string;
      operation: string;
      outcome: string;
      result: Record<string, unknown>;
      evidenceIds: string[];
      completedAt: Date | string | null;
      trustedAssessmentRunId: string;
    }>;
    const linked = rawLinked
      ? { ...rawLinked, completedAt: completedAtDate(rawLinked.completedAt) }
      : undefined;
    expect(linked).toMatchObject({
      operation: 'investigate',
      outcome: 'conclusive',
      evidenceIds: [validEvidenceId],
      completedAt: expect.any(Date),
      trustedAssessmentRunId: linked!.id,
      result: {
        summary,
        currentState: 'The checkout pool is at capacity.',
        impact: 'Checkout requests are failing.',
        rankedHypotheses: [
          {
            hypothesis: 'Connection leak',
            confidence: 91,
            evidence: 'Active connections rose without falling.',
            state: 'leading',
            supportingEvidenceIds: [validEvidenceId],
            contradictingEvidenceIds: [],
          },
        ],
        unknowns: [
          {
            question: 'Whether the rollout was reverted.',
            category: 'observable',
            evidenceKind: 'deployment_as_of',
            attemptedEvidenceIds: [validEvidenceId],
          },
        ],
        nextStep: persistedNextStep,
      },
    });
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
      rcaSummary: summary,
      confidence: 91,
      assessmentEvidenceIds: [validEvidenceId],
      rankedHypotheses: [expect.objectContaining({ supportingEvidenceIds: [validEvidenceId] })],
      unknowns: [expect.objectContaining({ attemptedEvidenceIds: [validEvidenceId] })],
      nextStep: persistedNextStep,
    });
    await expect(
      completeInvestigationRun(__fixture.app.db, __fixture.tenantId, incident.id, {
        id: linked!.id,
        provider: 'fake',
        engineModel: 'fake-terminal',
        engineSessionId: `retry:${incident.id}`,
        turnBudget: 1,
        outcome: 'failed',
        result: { summary: 'A retry must not replace the terminal result.' },
        evidenceIds: [siblingEvidenceId],
      }),
    ).resolves.toBeNull();
    const [immutable] = (await __fixture.admin.db.execute(sql`
      select outcome, result, evidence_ids as "evidenceIds"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and id = ${linked!.id}
    `)) as unknown as Array<{
      outcome: string;
      result: Record<string, unknown>;
      evidenceIds: string[];
    }>;
    expect(immutable).toMatchObject({
      outcome: 'conclusive',
      result: {
        summary,
        rankedHypotheses: [
          {
            hypothesis: 'Connection leak',
            evidence: 'Active connections rose without falling.',
          },
        ],
        nextStep: persistedNextStep,
      },
      evidenceIds: [validEvidenceId],
    });
  });

  test('a conclusive claim that cites an unavailable read is downgraded without losing the attempt', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `unavailable-citation-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    const failedEvidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantId, {
      incidentId: incident.id,
      tool: 'query_metrics',
      input: { service: 'checkout' },
      latencyMs: 4,
      outcome: 'error',
    });
    const result = terminalResult(incident.id, 'conclusive', {
      disposition: 'rca',
      evidenceReceipts: [
        { evidenceId: failedEvidenceId, tool: 'query_metrics', outcome: 'unavailable' },
      ],
      summary: 'The failed metrics read proves pool exhaustion.',
      confidence: 90,
      evidenceIds: [failedEvidenceId],
      rankedHypotheses: [
        {
          hypothesis: 'Pool exhaustion',
          confidence: 90,
          evidence: 'The metrics read failed.',
          supportingEvidenceIds: [failedEvidenceId],
        },
      ],
      unknowns: [
        {
          question: 'What is the current pool saturation?',
          category: 'observable',
          evidenceKind: 'runtime_state',
          attemptedEvidenceIds: [failedEvidenceId],
        },
      ],
    });

    await __fixture.workerWithEngine(engineFor(result)).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: incident.id },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
      investigationStatus: 'degraded',
      rcaSummary: null,
      trustedAssessmentRunId: null,
    });
    const [run] = (await __fixture.admin.db.execute(sql`
      select outcome, result, evidence_ids as "evidenceIds"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and incident_id = ${incident.id}
      order by started_at desc
      limit 1
    `)) as unknown as Array<{
      outcome: string;
      result: {
        evidenceIds: string[];
        rankedHypotheses: Array<{ supportingEvidenceIds: string[] }>;
        unknowns: Array<{ attemptedEvidenceIds: string[] }>;
      };
      evidenceIds: string[];
    }>;
    expect(run).toMatchObject({
      outcome: 'inconclusive',
      result: {
        evidenceIds: [],
        rankedHypotheses: [{ supportingEvidenceIds: [] }],
        unknowns: [{ attemptedEvidenceIds: [failedEvidenceId] }],
      },
      evidenceIds: [failedEvidenceId],
    });
  });

  test('a superseded recovery run cannot resolve the incident or publish a finding', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `superseded-recovery-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    const trusted = terminalResult(id, 'conclusive', {
      disposition: 'rca',
      summary: 'The checkout deployment caused the error spike.',
      confidence: 84,
    });
    await __fixture.workerWithEngine(engineFor(trusted)).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: id },
      },
      { signal: new AbortController().signal },
    );
    const before = await getIncident(__fixture.app.db, __fixture.tenantId, id);
    const historyBefore = await __fixture.hub.history(__fixture.tenantId, id);
    const observed = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: `superseded-resolved-${id}`,
      state: 'resolved',
      summary: 'Checkout error rate is below threshold.',
      contentHash: `superseded-hash-${id}`,
      eventKey: `superseded-event-${id}`,
      eventAt: new Date('2026-08-31T00:00:00.000Z'),
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        return trusted;
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery(input, runtime) {
        const evidenceId = await runtime.ctx.audit.record({
          tenantId: __fixture.tenantId,
          incidentId: id,
          tool: 'query_metrics',
          input: { service: 'checkout' },
          output: { errorRate: 0.001 },
          latencyMs: 4,
          outcome: 'data',
        });
        await beginInvestigationRun(__fixture.app.db, __fixture.tenantId, input.incident.id, {
          operation: 'verify-recovery',
        });
        return terminalResult(id, 'conclusive', {
          disposition: 'recovery',
          summary: 'Checkout recovered.',
          evidenceReceipts: [{ evidenceId, tool: 'query_metrics', outcome: 'complete' }],
          recovery: {
            outcome: 'recovered',
            recovered: true,
            evidence: [{ name: 'Error rate', before: 'high', now: 'normal' }],
            evidenceIds: [evidenceId],
            unknowns: [],
            nextStep: null,
          },
        });
      },
    };

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'recovery.verify',
        attempts: 1,
        payload: {
          incidentId: id,
          lifecycleVersion: 0,
          signalFence: serializeSignalFence([observed.signal]),
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      investigationStatus: 'assessed',
      recoveryState: null,
      trustedAssessmentRunId: before!.trustedAssessmentRunId,
    });
    expect(await __fixture.hub.history(__fixture.tenantId, id)).toHaveLength(historyBefore.length);
    const runs = (await __fixture.admin.db.execute(sql`
      select outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId}
        and incident_id = ${id}
        and operation = 'verify-recovery'
      order by started_at asc
    `)) as unknown as Array<{ outcome: string | null; completedAt: Date | null }>;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ outcome: 'failed' });
    expect(runs[1]).toMatchObject({ outcome: null, completedAt: null });
  });

  test('a resolved failed recovery result restores the trusted assessment without publishing', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-result-failed-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    const trusted = terminalResult(id, 'conclusive', {
      disposition: 'rca',
      summary: 'The checkout deployment caused the error spike.',
      confidence: 84,
    });
    await __fixture.workerWithEngine(engineFor(trusted)).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: id },
      },
      { signal: new AbortController().signal },
    );
    const before = await getIncident(__fixture.app.db, __fixture.tenantId, id);
    const historyBefore = await __fixture.hub.history(__fixture.tenantId, id);
    const observed = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: `failed-result-resolved-${id}`,
      state: 'resolved',
      summary: 'Checkout error rate is below threshold.',
      contentHash: `failed-result-hash-${id}`,
      eventKey: `failed-result-event-${id}`,
      eventAt: new Date('2026-08-31T00:00:00.000Z'),
    });

    await expect(
      __fixture.workerWithEngine(engineFor(terminalResult(id, 'failed'))).handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'recovery.verify',
          attempts: 1,
          payload: {
            incidentId: id,
            lifecycleVersion: 0,
            signalFence: serializeSignalFence([observed.signal]),
          },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();

    const after = await getIncident(__fixture.app.db, __fixture.tenantId, id);
    expect(after).toMatchObject({
      investigationStatus: 'assessed',
      rcaSummary: 'The checkout deployment caused the error spike.',
      confidence: 84,
      trustedAssessmentRunId: before!.trustedAssessmentRunId,
      recoveryState: null,
      recoveryUpdatedAt: null,
    });
    expect(after!.assessmentUpdatedAt!.getTime()).toBe(before!.assessmentUpdatedAt!.getTime());
    const history = await __fixture.hub.history(__fixture.tenantId, id);
    expect(history).toHaveLength(historyBefore.length + 1);
    expect(history.at(-1)?.finding).toMatchObject({
      outcome: 'failed',
      promotion: 'not_promoted',
      promotionReason: 'investigation_failed',
    });
    const [run] = (await __fixture.admin.db.execute(sql`
      select operation, outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and incident_id = ${id}
      order by started_at desc
      limit 1
    `)) as unknown as Array<{ operation: string; outcome: string; completedAt: Date | string }>;
    expect({ ...run, completedAt: completedAtDate(run!.completedAt) }).toMatchObject({
      operation: 'verify-recovery',
      outcome: 'failed',
      completedAt: expect.any(Date),
    });
  });

  test('a rejected recovery call completes the run and restores prior progress without refreshing the assessment', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-finalizer-failed-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `trusted:${id}`,
      summary: 'The checkout deployment caused the error spike.',
      confidence: 84,
    });
    const before = await getIncident(__fixture.app.db, __fixture.tenantId, id);
    const observed = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: `resolved-${id}`,
      state: 'resolved',
      summary: 'Checkout error rate is below threshold.',
      contentHash: `resolved-hash-${id}`,
      eventKey: `resolved-event-${id}`,
      eventAt: new Date('2026-08-31T00:00:00.000Z'),
    });

    await expect(
      __fixture.workerWithEngine(throwingEngine()).handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'recovery.verify',
          attempts: 1,
          payload: {
            incidentId: id,
            lifecycleVersion: 0,
            signalFence: serializeSignalFence([observed.signal]),
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('finalizer transport failed');

    const after = await getIncident(__fixture.app.db, __fixture.tenantId, id);
    expect(after).toMatchObject({
      investigationStatus: 'assessed',
      rcaSummary: 'The checkout deployment caused the error spike.',
      confidence: 84,
      recoveryState: null,
      recoveryUpdatedAt: null,
    });
    expect(after!.assessmentUpdatedAt!.getTime()).toBe(before!.assessmentUpdatedAt!.getTime());

    const [rawRun] = (await __fixture.admin.db.execute(sql`
      select operation, outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and incident_id = ${id}
      order by started_at desc
      limit 1
    `)) as unknown as Array<{
      operation: string;
      outcome: string;
      completedAt: Date | string | null;
    }>;
    const run = rawRun
      ? { ...rawRun, completedAt: completedAtDate(rawRun.completedAt) }
      : undefined;
    expect(run).toMatchObject({
      operation: 'verify-recovery',
      outcome: 'failed',
      completedAt: expect.any(Date),
    });
  });
});
