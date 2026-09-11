import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import {
  applySignalObservation,
  beginInvestigationRun,
  createIncident,
  getIncident,
  recordToolCall,
  recordSurfaceBinding,
  setInvestigationStatus,
  surfaceDeliveries,
  upsertSurfaceConfig,
} from '@sre/db';

import { eq, sql } from 'drizzle-orm';

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

describe('terminal investigation-run persistence', () => {
  test('a redelivered attempt terminalizes the interrupted pending run before opening its successor', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `interrupted-run-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const interruptedId = await beginInvestigationRun(__fixture.app.db, __fixture.tenantId, id, {
      operation: 'investigate',
    });
    const successorId = await beginInvestigationRun(__fixture.app.db, __fixture.tenantId, id, {
      operation: 'investigate',
    });

    const runs = (await __fixture.admin.db.execute(sql`
      select id, outcome, result, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and incident_id = ${id}
      order by started_at asc, id asc
    `)) as unknown as Array<{
      id: string;
      outcome: string | null;
      result: Record<string, unknown> | null;
      completedAt: Date | string | null;
    }>;
    const interrupted = runs.find((run) => run.id === interruptedId)!;
    expect({ ...interrupted, completedAt: completedAtDate(interrupted.completedAt) }).toMatchObject(
      {
        outcome: 'failed',
        result: { reason: 'superseded_pending_run' },
        completedAt: expect.any(Date),
      },
    );
    expect(runs.find((run) => run.id === successorId)).toMatchObject({
      outcome: null,
      result: null,
      completedAt: null,
    });
  });

  test.each(
    (['inconclusive', 'blocked_missing_capability', 'budget_exhausted', 'failed'] as const).flatMap(
      (outcome) => (['queued', 'gathering'] as const).map((status) => [outcome, status] as const),
    ),
  )('an initial %s run from %s leaves the incident degraded', async (outcome, status) => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `initial-${status}-${outcome}-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    if (status === 'gathering')
      await setInvestigationStatus(__fixture.app.db, __fixture.tenantId, id, 'gathering');
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, { surface: 'slack' });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-TERMINAL',
      threadId: randomUUID(),
    });

    await __fixture.workerWithEngine(engineFor(terminalResult(id, outcome))).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: id },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      investigationStatus: 'degraded',
      rcaSummary: null,
      confidence: null,
      trustedAssessmentRunId: null,
      assessmentUpdatedAt: null,
    });
    const [run] = (await __fixture.admin.db.execute(sql`
      select id, outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and incident_id = ${id}
      order by started_at desc
      limit 1
    `)) as unknown as Array<{ id: string; outcome: string; completedAt: Date | string | null }>;
    expect({ ...run, completedAt: completedAtDate(run!.completedAt) }).toMatchObject({
      outcome,
      completedAt: expect.any(Date),
    });
    const finding = (await __fixture.hub.history(__fixture.tenantId, id)).find(
      (message) => message.finding?.runId === run!.id,
    );
    const reasons = {
      inconclusive: 'investigation_inconclusive',
      blocked_missing_capability: 'missing_capability',
      budget_exhausted: 'budget_exhausted',
      failed: 'investigation_failed',
    } as const;
    expect(finding?.finding).toMatchObject({
      runId: run!.id,
      outcome,
      promotion: 'not_promoted',
      promotionReason: reasons[outcome],
    });
    expect(
      await __fixture.admin.db
        .select({ id: surfaceDeliveries.id })
        .from(surfaceDeliveries)
        .where(eq(surfaceDeliveries.messageId, finding!.id)),
    ).toHaveLength(outcome === 'inconclusive' ? 0 : 1);
  });

  test.each(['inconclusive', 'blocked_missing_capability', 'budget_exhausted', 'failed'] as const)(
    'a newer %s run preserves the trusted assessment projection',
    async (outcome) => {
      const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
        fingerprint: `non-destructive-${outcome}-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'checkout',
        severity: 'sev2',
      });
      const evidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantId, {
        incidentId: id,
        tool: 'query_metrics',
        input: { service: 'checkout' },
        output: { saturated: true },
        latencyMs: 4,
        outcome: 'data',
      });
      await __fixture
        .workerWithEngine(
          engineFor(
            terminalResult(id, 'conclusive', {
              disposition: 'rca',
              summary: 'Connection pool saturation is the trusted assessment.',
              confidence: 86,
              evidenceReceipts: [{ evidenceId, tool: 'query_metrics', outcome: 'complete' }],
              evidenceIds: [evidenceId],
              rankedHypotheses: [
                {
                  hypothesis: 'Pool saturation',
                  confidence: 86,
                  evidence: 'The pool stayed at capacity.',
                  supportingEvidenceIds: [evidenceId],
                },
              ],
              unknowns: [
                {
                  question: 'Whether a rollout changed pool sizing.',
                  category: 'partial_evidence',
                  evidenceKind: 'deployment_as_of',
                  attemptedEvidenceIds: [evidenceId],
                },
              ],
            }),
          ),
        )
        .handle(
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
      expect(before?.trustedAssessmentRunId).toEqual(expect.any(String));

      await __fixture.workerWithEngine(engineFor(terminalResult(id, outcome))).handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'triage',
          attempts: 1,
          payload: { incidentId: id },
        },
        { signal: new AbortController().signal },
      );

      const after = await getIncident(__fixture.app.db, __fixture.tenantId, id);
      expect(after).toMatchObject({
        investigationStatus: 'assessed',
        rcaSummary: 'Connection pool saturation is the trusted assessment.',
        confidence: 86,
        assessmentEvidenceIds: [evidenceId],
        trustedAssessmentRunId: before!.trustedAssessmentRunId,
        rankedHypotheses: [expect.objectContaining({ supportingEvidenceIds: [evidenceId] })],
        unknowns: [expect.objectContaining({ attemptedEvidenceIds: [evidenceId] })],
      });
      expect(after!.assessmentUpdatedAt!.getTime()).toBe(before!.assessmentUpdatedAt!.getTime());

      const rawRuns = (await __fixture.admin.db.execute(sql`
        select operation, outcome, completed_at as "completedAt"
        from investigation_runs
        where tenant_id = ${__fixture.tenantId} and incident_id = ${id}
        order by started_at desc
      `)) as unknown as Array<{
        operation: string;
        outcome: string;
        completedAt: Date | string | null;
      }>;
      const runs = rawRuns.map((run) => ({
        ...run,
        completedAt: completedAtDate(run.completedAt),
      }));
      expect(runs[0]).toMatchObject({
        operation: 'investigate',
        outcome,
        completedAt: expect.any(Date),
      });
    },
  );

  test('a superseded run cannot publish its terminal reply', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `superseded-reply-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate(input) {
        await beginInvestigationRun(__fixture.app.db, __fixture.tenantId, input.incident.id, {
          operation: 'resume',
        });
        return terminalResult(input.incident.id, 'conclusive', {
          disposition: 'reply',
          summary: 'Stale reply',
          detail: 'This reply belongs to the superseded run.',
        });
      },
      async resume() {
        throw new Error('not used');
      },
      verifyRecovery: __fixture.verifyRecovery,
    };

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: incident.id },
      },
      { signal: new AbortController().signal },
    );

    const history = await __fixture.hub.history(__fixture.tenantId, incident.id);
    expect(history.some((message) => message.content.includes('superseded run'))).toBe(false);
    const runs = (await __fixture.admin.db.execute(sql`
      select operation, outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and incident_id = ${incident.id}
      order by started_at asc
    `)) as unknown as Array<{ operation: string; outcome: string; completedAt: Date | null }>;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ operation: 'investigate', outcome: 'failed' });
    expect(runs[1]).toMatchObject({ operation: 'resume', outcome: null, completedAt: null });
  });

  test('an inconclusive human follow-up records a completed resume run without replacing the brief', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `resume-run-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const trusted = terminalResult(incident.id, 'conclusive', {
      disposition: 'rca',
      summary: 'The rollout saturated the connection pool.',
      confidence: 84,
    });
    await __fixture.workerWithEngine(engineFor(trusted)).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: incident.id },
      },
      { signal: new AbortController().signal },
    );
    const before = await getIncident(__fixture.app.db, __fixture.tenantId, incident.id);
    const human = await __fixture.hub.append(__fixture.tenantId, incident.id, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      kind: 'text',
      content: 'Can you verify the database pool now?',
      originSurface: 'slack',
    });
    const resumeResult = terminalResult(incident.id, 'inconclusive', {
      summary: 'The current database evidence is incomplete.',
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        return trusted;
      },
      async resume() {
        return resumeResult;
      },
      verifyRecovery: __fixture.verifyRecovery,
    };

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'resume',
        attempts: 1,
        payload: { incidentId: incident.id, humanMessageId: human.id },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
      investigationStatus: 'assessed',
      rcaSummary: 'The rollout saturated the connection pool.',
      confidence: 84,
      trustedAssessmentRunId: before!.trustedAssessmentRunId,
      lastResumeMessageId: human.id,
    });
    const [run] = (await __fixture.admin.db.execute(sql`
      select operation, outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and incident_id = ${incident.id}
      order by started_at desc
      limit 1
    `)) as unknown as Array<{ operation: string; outcome: string; completedAt: Date | string }>;
    expect({ ...run, completedAt: completedAtDate(run!.completedAt) }).toMatchObject({
      operation: 'resume',
      outcome: 'inconclusive',
      completedAt: expect.any(Date),
    });
  });

  test('a thrown reassessment records failure without demoting the trusted assessment', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `reassessment-throw-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    await __fixture
      .workerWithEngine(
        engineFor(
          terminalResult(id, 'conclusive', {
            disposition: 'rca',
            summary: 'The rollout saturated the connection pool.',
            confidence: 84,
          }),
        ),
      )
      .handle(
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
    const observed = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: `updated-${id}`,
      state: 'firing',
      summary: 'Checkout error rate increased.',
      contentHash: `updated-hash-${id}`,
      eventKey: `updated-event-${id}`,
      eventAt: new Date('2026-08-31T00:00:00.000Z'),
    });

    await expect(
      __fixture.workerWithEngine(throwingEngine()).handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'signal.reassess',
          attempts: 1,
          payload: {
            incidentId: id,
            signalId: observed.signal.id,
            signalVersion: observed.signal.version,
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('finalizer transport failed');

    const after = await getIncident(__fixture.app.db, __fixture.tenantId, id);
    expect(after).toMatchObject({
      investigationStatus: 'assessed',
      rcaSummary: 'The rollout saturated the connection pool.',
      confidence: 84,
      trustedAssessmentRunId: before!.trustedAssessmentRunId,
    });
    expect(after!.assessmentUpdatedAt!.getTime()).toBe(before!.assessmentUpdatedAt!.getTime());
    const [run] = (await __fixture.admin.db.execute(sql`
      select operation, outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and incident_id = ${id}
      order by started_at desc
      limit 1
    `)) as unknown as Array<{ operation: string; outcome: string; completedAt: Date }>;
    expect({ ...run, completedAt: completedAtDate(run!.completedAt) }).toMatchObject({
      operation: 'reassess',
      outcome: 'failed',
      completedAt: expect.any(Date),
    });
  });

  test('reassessment setup failure records the run and preserves the trusted assessment', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `reassessment-setup-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    const trusted = terminalResult(id, 'conclusive', {
      disposition: 'rca',
      summary: 'The rollout saturated the connection pool.',
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
    const observed = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: `setup-updated-${id}`,
      state: 'firing',
      summary: 'Checkout error rate increased.',
      contentHash: `setup-hash-${id}`,
      eventKey: `setup-event-${id}`,
      eventAt: new Date('2026-08-31T00:00:00.000Z'),
    });
    const worker = __fixture.workerWithEngine(engineFor(trusted), {
      connectorProvider: () => async () => {
        throw new Error('connector registry unavailable');
      },
    });

    await expect(
      worker.handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'signal.reassess',
          attempts: 1,
          payload: {
            incidentId: id,
            signalId: observed.signal.id,
            signalVersion: observed.signal.version,
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('connector registry unavailable');

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      investigationStatus: 'assessed',
      rcaSummary: 'The rollout saturated the connection pool.',
      confidence: 84,
      trustedAssessmentRunId: before!.trustedAssessmentRunId,
    });
    const [run] = (await __fixture.admin.db.execute(sql`
      select operation, outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId} and incident_id = ${id}
      order by started_at desc
      limit 1
    `)) as unknown as Array<{ operation: string; outcome: string; completedAt: Date }>;
    expect({ ...run, completedAt: completedAtDate(run!.completedAt) }).toMatchObject({
      operation: 'reassess',
      outcome: 'failed',
      completedAt: expect.any(Date),
    });
  });
});
