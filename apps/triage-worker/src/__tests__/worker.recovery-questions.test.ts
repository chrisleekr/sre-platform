import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  agentToolCalls,
  recordToolCall,
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  incidents,
  listIncidents,
  serializeSignalFence,
  withTenant,
} from '@sre/db';
import type { TriageResult } from '../engine/types';
import { createFixture } from './worker.fixture';
import { reviewedEngine } from '../engine/evidence-review';
import { makeFakeEngine, makeFakeGenerator } from '../engine/fake';
import { incidentOperatorState } from '../../../api/src/incidents/operator-state';
const __fixture = createFixture();
const signal = (id: string) => ({
  incidentId: id,
  surface: 'slack',
  channel: 'C-lifecycle',
  externalMessageId: `signal-${id}`,
  state: 'firing' as const,
  summary: 'Checkout errors',
  contentHash: 'firing',
  eventKey: `firing-${id}`,
  eventAt: new Date('2026-08-21T02:00:00Z'),
});
test.each(['resume', 'recovery.verify'] as const)(
  '%s exposes a current reviewer failure blocker without promoting recovery or replacing RCA',
  async (kind) => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: 'prior',
      summary: 'Previously trusted cause.',
      confidence: 70,
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      eventKey: randomUUID(),
      contentHash: randomUUID(),
    });
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .update(incidents)
        .set({
          recoveryState: kind === 'resume' ? 'not_verified' : null,
          recoverySummary: 'Old recovery question.',
          recoveryUnknowns: ['Old question.'],
        })
        .where(eq(incidents.id, id)),
    );
    const human = await __fixture.hub.append(__fixture.tenantId, id, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      kind: 'text',
      content: 'Recheck current recovery.',
    });
    const question = {
      question: 'Evidence review provider was unavailable; coverage is incomplete.',
      category: 'partial_evidence' as const,
      evidenceKind: null,
      attemptedEvidenceIds: [],
      resolutionRelevance: 'blocking' as const,
      nextAction: 'Retry recovery review with current evidence.',
    };
    const result = async (): Promise<TriageResult> => ({
      provider: 'fake',
      sessionId: 'review',
      outcome: 'inconclusive',
      turnBudget: 1,
      disposition: 'recovery',
      confidence: 0,
      summary: 'Recovery review could not complete.',
      recovery: {
        outcome: 'needs_human',
        recovered: false,
        evidence: [],
        evidenceIds: [],
        unknowns: [question.question],
        questions: [question],
        nextStep: null,
      },
    });
    await __fixture
      .workerWithEngine({
        provider: 'fake',
        investigate: result,
        resume: result,
        verifyRecovery: result,
      })
      .handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: kind,
          attempts: 1,
          payload:
            kind === 'resume'
              ? { incidentId: id, humanMessageId: human.id }
              : {
                  incidentId: id,
                  lifecycleVersion: 0,
                  signalFence: serializeSignalFence([cleared.signal]),
                },
        },
        { signal: new AbortController().signal },
      );
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      lifecycleVersion: 0,
      rcaSummary: 'Previously trusted cause.',
      recoveryState: 'not_verified',
      recoverySummary: 'Recovery review could not complete.',
      recoveryQuestions: [question],
      recoveryUnknowns: [question.question],
    });
    const queued = (await listIncidents(__fixture.app.db, __fixture.tenantId)).find(
      (item) => item.id === id,
    )!;
    expect(queued).toMatchObject({
      recoveryNextStep: question.nextAction,
      latestInvestigationRun: { nextStep: question.nextAction },
      attentionReason: 'investigation_inconclusive',
    });
    expect(incidentOperatorState(queued, []).attention?.decision).toBe(question.nextAction);
    const history = await __fixture.hub.history(__fixture.tenantId, id);
    expect(history.some((message) => message.kind === 'lifecycle')).toBe(false);
    expect(history.at(-1)?.finding).toMatchObject({
      outcome: 'inconclusive',
      promotion: 'not_promoted',
      promotionReason: 'investigation_inconclusive',
    });
    expect(history.at(-1)?.recovery).toMatchObject({
      outcome: 'needs_human',
      questions: [question],
    });
  },
);

test('a failed recovery review preserves a current unavailable attempt after twenty historical receipts', async () => {
  const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
  });
  const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    ...signal(id),
    state: 'resolved',
    eventKey: randomUUID(),
    contentHash: randomUUID(),
  });
  const historical: string[] = [];
  for (let index = 0; index < 20; index++)
    historical.push(
      await recordToolCall(__fixture.app.db, __fixture.tenantId, {
        incidentId: id,
        tool: 'query_metrics',
        input: { query: `historical_${index}` },
        output: { value: index },
        latencyMs: 1,
        outcome: 'data',
      }),
    );
  await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx
      .update(agentToolCalls)
      .set({ createdAt: new Date('2020-01-01') })
      .where(eq(agentToolCalls.incidentId, id)),
  );
  let current = '';
  const engine = reviewedEngine(
    {
      ...makeFakeEngine(),
      async verifyRecovery(input, runtime): Promise<TriageResult> {
        expect(input.evidence?.map((item) => item.id)).toEqual(expect.arrayContaining(historical));
        current = await runtime.ctx.audit.record({
          tenantId: __fixture.tenantId,
          incidentId: id,
          tool: 'query_metrics',
          input: { query: 'current_health' },
          latencyMs: 1,
          outcome: 'error',
        });
        return {
          provider: 'fake',
          sessionId: 'review-current-attempt',
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          confidence: 0,
          summary: 'The current health query is unavailable.',
          evidenceReceipts: [
            ...historical.map((evidenceId) => ({
              evidenceId,
              tool: 'query_metrics',
              outcome: 'complete' as const,
            })),
            { evidenceId: current, tool: 'query_metrics', outcome: 'unavailable' },
          ],
          recovery: {
            outcome: 'needs_human',
            recovered: false,
            evidence: [],
            evidenceIds: [],
            unknowns: [],
            nextStep: null,
            questions: [
              {
                question: 'Is checkout healthy?',
                category: 'missing_capability',
                evidenceKind: 'metrics',
                attemptedEvidenceIds: [current],
                resolutionRelevance: 'blocking',
                nextAction: 'Restore the metrics connection and check current health.',
              },
            ],
          },
        };
      },
    },
    makeFakeGenerator(() => ({ supported: 'invalid output' })),
  );
  await __fixture.workerWithEngine(engine).handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'recovery.verify',
      attempts: 1,
      payload: {
        incidentId: id,
        lifecycleVersion: 0,
        signalFence: serializeSignalFence([cleared.signal]),
      },
    },
    { signal: new AbortController().signal },
  );
  expect(current).not.toBe('');
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
    status: 'open',
    recoveryState: 'not_verified',
    recoveryEvidenceIds: [],
    recoveryQuestions: [{ resolutionRelevance: 'blocking', attemptedEvidenceIds: [current] }],
  });
  const history = await __fixture.hub.history(__fixture.tenantId, id);
  expect(history.at(-1)?.recovery?.questions?.[0]?.attemptedEvidenceIds).toEqual([current]);
});
