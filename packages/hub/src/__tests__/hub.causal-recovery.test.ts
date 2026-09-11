import { randomUUID } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  getIncident,
  investigationRuns,
  recordIncidentRelation,
  recordToolCall,
  serializeSignalFence,
  withTenant,
} from '@sre/db';
import { createFixture } from './hub.fixture';

const fixture = createFixture();

describe('causal response recovery', () => {
  test('a child signal correction queues one complete root-owned recovery', async () => {
    const rootId = (
      await createIncident(fixture.app.db, fixture.tenantA, {
        fingerprint: `correction-root-${randomUUID()}`,
        alertSource: 'slack',
        service: 'database',
        severity: 'sev2',
      })
    ).id;
    const childId = (
      await createIncident(fixture.app.db, fixture.tenantA, {
        fingerprint: `correction-child-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    await recordIncidentRelation(fixture.app.db, fixture.tenantA, {
      sourceIncidentId: childId,
      targetIncidentId: rootId,
      type: 'caused_by',
      rationale: 'The child is governed by the root recovery.',
      evidence: ['human:signal-correction'],
      decidedBy: 'human',
    });
    await applySignalObservation(fixture.app.db, fixture.tenantA, {
      incidentId: rootId,
      surface: 'slack',
      channel: 'C-CAUSAL-CORRECTION',
      externalMessageId: `root-${randomUUID()}`,
      state: 'resolved',
      summary: 'Root provider signal resolved',
      contentHash: randomUUID(),
      eventKey: `root-resolved-${randomUUID()}`,
      eventAt: new Date(),
    });
    const childSignal = await applySignalObservation(fixture.app.db, fixture.tenantA, {
      incidentId: childId,
      surface: 'slack',
      channel: 'C-CAUSAL-CORRECTION',
      externalMessageId: `child-${randomUUID()}`,
      state: 'firing',
      summary: 'Child provider signal still firing',
      contentHash: randomUUID(),
      eventKey: `child-firing-${randomUUID()}`,
      eventAt: new Date(),
    });
    const enqueueRecoveryTx = vi.fn(async () => 'root-recovery-job');

    const result = await fixture.hub.correctSignal(
      fixture.tenantA,
      childId,
      childSignal.signal.id,
      {
        reason: 'Provider incorrectly left this notification active.',
        correctionKey: `causal-correction-${randomUUID()}`,
        author: 'human',
        expectedVersion: childSignal.signal.version,
        resolvedAt: new Date(),
        enqueueRecoveryTx,
      },
    );

    expect(result.recoveryJobId).toBe('root-recovery-job');
    expect(enqueueRecoveryTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        incidentId: rootId,
        signalFence: expect.stringContaining(`${childSignal.signal.id}:2:resolved`),
      }),
    );
  });

  test('resolves the root and every active symptom in one recovery decision', async () => {
    const rootId = (
      await createIncident(fixture.app.db, fixture.tenantA, {
        fingerprint: `root-${randomUUID()}`,
        alertSource: 'slack',
        service: 'database',
        severity: 'sev2',
      })
    ).id;
    const symptomId = (
      await createIncident(fixture.app.db, fixture.tenantA, {
        fingerprint: `symptom-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    await recordIncidentRelation(fixture.app.db, fixture.tenantA, {
      sourceIncidentId: symptomId,
      targetIncidentId: rootId,
      type: 'caused_by',
      rationale: 'Current traces show database saturation caused checkout errors.',
      evidence: ['human:verified'],
      decidedBy: 'human',
    });
    const [rootSignal, symptomSignal] = await Promise.all(
      [rootId, symptomId].map((incidentId) =>
        applySignalObservation(fixture.app.db, fixture.tenantA, {
          incidentId,
          surface: 'slack',
          channel: 'C-CAUSAL-RECOVERY',
          externalMessageId: `resolved-${incidentId}`,
          state: 'resolved',
          summary: 'Provider episode resolved',
          contentHash: randomUUID(),
          eventKey: `resolved-${randomUUID()}`,
          eventAt: new Date(),
        }),
      ),
    );
    const verificationStartedAt = new Date(Date.now() - 1_000);
    const evidenceId = await recordToolCall(fixture.app.db, fixture.tenantA, {
      incidentId: rootId,
      tool: 'prometheus_query_range',
      input: { query: 'errors_total' },
      output: { data: { resultType: 'matrix', result: [] } },
      latencyMs: 1,
      outcome: 'data',
    });

    const result = await fixture.hub.finalizeRecovery(fixture.tenantA, rootId, {
      expectedLifecycleVersion: 0,
      expectedSignalFence: serializeSignalFence([rootSignal!.signal, symptomSignal!.signal]),
      restoreInvestigationStatus: 'assessed',
      verificationStartedAt,
      eventKey: `recovery:${randomUUID()}`,
      content: 'The complete causal response group is healthy.',
      summary: 'Root cause and downstream symptom recovered.',
      outcome: 'recovered',
      attempt: 1,
      maxChecks: 3,
      recoveryEvidenceIds: [evidenceId],
      recoveryUnknowns: [],
      recoveryNextStep: null,
      recoveryChecks: [{ name: 'Error rate', before: 'Firing', now: 'Baseline' }],
      assessedMaterials: [],
      autoResolve: {
        reason: 'Provider signals cleared and recovery verification passed.',
        transitionKey: `causal-recovery:${randomUUID()}`,
      },
    });

    expect(result).toMatchObject({ applied: true, autoResolved: true });
    expect(result.additionalLifecycleMessages).toHaveLength(1);
    expect(await getIncident(fixture.app.db, fixture.tenantA, rootId)).toMatchObject({
      status: 'resolved',
    });
    expect(await getIncident(fixture.app.db, fixture.tenantA, symptomId)).toMatchObject({
      status: 'resolved',
    });
  });

  test('keeps an interactive child reply on that conversation while resolving the response root', async () => {
    const rootId = (
      await createIncident(fixture.app.db, fixture.tenantA, {
        fingerprint: `interactive-root-${randomUUID()}`,
        alertSource: 'slack',
        service: 'database',
        severity: 'sev2',
      })
    ).id;
    const childId = (
      await createIncident(fixture.app.db, fixture.tenantA, {
        fingerprint: `interactive-child-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    await recordIncidentRelation(fixture.app.db, fixture.tenantA, {
      sourceIncidentId: childId,
      targetIncidentId: rootId,
      type: 'caused_by',
      rationale: 'The child is a verified symptom of the root.',
      evidence: ['human:interactive-recovery'],
      decidedBy: 'human',
    });
    const [rootSignal, childSignal] = await Promise.all(
      [rootId, childId].map((incidentId) =>
        applySignalObservation(fixture.app.db, fixture.tenantA, {
          incidentId,
          surface: 'slack',
          channel: 'C-CAUSAL-INTERACTIVE',
          externalMessageId: `resolved-${incidentId}`,
          state: 'resolved',
          summary: 'Provider episode resolved',
          contentHash: randomUUID(),
          eventKey: `resolved-${randomUUID()}`,
          eventAt: new Date(),
        }),
      ),
    );
    const verificationStartedAt = new Date(Date.now() - 1_000);
    const evidenceId = await recordToolCall(fixture.app.db, fixture.tenantA, {
      incidentId: childId,
      tool: 'prometheus_query_range',
      input: { query: 'checkout_errors_total' },
      output: { data: { resultType: 'matrix', result: [] } },
      latencyMs: 1,
      outcome: 'data',
    });
    const runId = await withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
      const rows = await tx
        .insert(investigationRuns)
        .values({ tenantId: fixture.tenantA, incidentId: childId, operation: 'resume' })
        .returning({ id: investigationRuns.id });
      return rows[0]!.id;
    });

    const result = await fixture.hub.finalizeRecovery(fixture.tenantA, rootId, {
      conversationIncidentId: childId,
      expectedLifecycleVersion: 0,
      expectedSignalFence: serializeSignalFence([rootSignal!.signal, childSignal!.signal]),
      runCompletion: {
        id: runId,
        provider: 'fake',
        engineModel: 'fake',
        engineSessionId: `fake:${childId}`,
        turnBudget: 0,
        outcome: 'conclusive',
        result: { summary: 'The complete causal group recovered.' },
        evidenceIds: [evidenceId],
      },
      restoreInvestigationStatus: 'assessed',
      verificationStartedAt,
      eventKey: `interactive-recovery:${randomUUID()}`,
      content: 'The complete causal response group is healthy.',
      summary: 'Root cause and downstream symptom recovered.',
      outcome: 'recovered',
      attempt: 1,
      maxChecks: 3,
      recoveryEvidenceIds: [evidenceId],
      recoveryUnknowns: [],
      recoveryNextStep: null,
      recoveryChecks: [{ name: 'Error rate', before: 'Firing', now: 'Baseline' }],
      assessedMaterials: [],
      autoResolve: {
        reason: 'Provider signals cleared and recovery verification passed.',
        transitionKey: `interactive-causal-recovery:${randomUUID()}`,
      },
    });

    expect(result.message).toMatchObject({ incidentId: childId });
    expect(await getIncident(fixture.app.db, fixture.tenantA, rootId)).toMatchObject({
      status: 'resolved',
      recoveryState: 'verified',
    });
    expect(await getIncident(fixture.app.db, fixture.tenantA, childId)).toMatchObject({
      status: 'resolved',
    });
    const completed = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx.select().from(investigationRuns).where(eq(investigationRuns.id, runId)),
    );
    expect(completed[0]).toMatchObject({ incidentId: childId, outcome: 'conclusive' });
  });
});
