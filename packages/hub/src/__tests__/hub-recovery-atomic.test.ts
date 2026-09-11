import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  beginInvestigationRun,
  createIncident,
  getIncident,
  incidents,
  recordToolCall,
  serializeSignalFence,
} from '@sre/db';
import { createFixture } from './hub.fixture';

const __fixture = createFixture();

describe('atomic recovery finalization', () => {
  test('rolls back run completion when the recovery decision cannot commit', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `atomic-recovery-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: incident.id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: randomUUID(),
      state: 'resolved',
      summary: 'Checkout alert cleared.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    const verificationStartedAt = new Date(Date.now() - 1_000);
    const evidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantA, {
      incidentId: incident.id,
      tool: 'query_metrics',
      input: { service: 'checkout' },
      output: { errorRate: 0.001 },
      latencyMs: 2,
      outcome: 'data',
    });
    const runId = await beginInvestigationRun(__fixture.app.db, __fixture.tenantA, incident.id, {
      operation: 'verify-recovery',
    });
    const historyBefore = await __fixture.hub.history(__fixture.tenantA, incident.id);

    await expect(
      __fixture.hub.finalizeRecovery(__fixture.tenantA, incident.id, {
        expectedLifecycleVersion: 0,
        expectedSignalFence: serializeSignalFence([cleared.signal]),
        restoreInvestigationStatus: 'assessed',
        verificationStartedAt,
        eventKey: `recovery:${randomUUID()}`,
        content: 'Checkout is improving; verify once more.',
        summary: 'Checkout is improving.',
        outcome: 'recheck',
        attempt: 1,
        maxChecks: 3,
        recoveryEvidenceIds: [evidenceId],
        recoveryUnknowns: [],
        recoveryNextStep: 'Recheck checkout health.',
        recoveryChecks: [{ name: 'Error rate', before: 'high', now: 'normalizing' }],
        assessedMaterials: [],
        runCompletion: {
          id: runId,
          provider: 'fake',
          engineModel: 'fake-recovery',
          engineSessionId: `fake:${runId}`,
          turnBudget: 1,
          outcome: 'conclusive',
          result: { summary: 'Checkout is improving.' },
          evidenceIds: [evidenceId],
        },
        finding: {
          runId,
          outcome: 'conclusive',
          promotion: 'conversation_only',
          promotionReason: 'terminal_incident',
          evidenceIds: [evidenceId],
          currentState: 'Checkout is improving.',
          impact: null,
          nextStep: 'Recheck checkout health.',
        },
        scheduleRecheck: {
          nextCheckAt: new Date(Date.now() + 5 * 60_000),
          reason: 'Checkout is still converging.',
          enqueueTx: async () => {
            throw new Error('schedule write failed');
          },
        },
      }),
    ).rejects.toThrow('schedule write failed');

    const [run] = (await __fixture.admin.db.execute(sql`
      select outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantA} and id = ${runId}
    `)) as unknown as Array<{ outcome: string | null; completedAt: Date | null }>;
    expect(run).toEqual({ outcome: null, completedAt: null });
    expect(await __fixture.hub.history(__fixture.tenantA, incident.id)).toHaveLength(
      historyBefore.length,
    );
  });

  test('a superseded recovery run cannot overwrite a newer resume watermark', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `superseded-recovery-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: incident.id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: randomUUID(),
      state: 'resolved',
      summary: 'Checkout alert cleared.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    const oldMessage = await __fixture.hub.append(__fixture.tenantA, incident.id, {
      author: 'human',
      kind: 'text',
      content: 'Check the recovery state.',
    });
    const newerMessage = await __fixture.hub.append(__fixture.tenantA, incident.id, {
      author: 'human',
      kind: 'text',
      content: 'Use this newer instruction instead.',
    });
    const oldRunId = await beginInvestigationRun(__fixture.app.db, __fixture.tenantA, incident.id, {
      operation: 'resume',
    });
    await beginInvestigationRun(__fixture.app.db, __fixture.tenantA, incident.id, {
      operation: 'resume',
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ lastResumeMessageId: newerMessage.id })
      .where(eq(incidents.id, incident.id));
    const expectedSignalFence = serializeSignalFence([cleared.signal]);
    await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: incident.id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: cleared.signal.externalMessageId,
      state: 'firing',
      summary: 'Checkout alert refired.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    const historyBefore = await __fixture.hub.history(__fixture.tenantA, incident.id);

    const result = await __fixture.hub.finalizeRecovery(__fixture.tenantA, incident.id, {
      expectedLifecycleVersion: 0,
      expectedSignalFence,
      restoreInvestigationStatus: 'assessed',
      verificationStartedAt: new Date(Date.now() - 1_000),
      eventKey: `recovery:${randomUUID()}`,
      content: 'Checkout recovered.',
      summary: 'Checkout recovered.',
      outcome: 'recovered',
      attempt: 1,
      maxChecks: 3,
      recoveryEvidenceIds: [],
      recoveryUnknowns: [],
      recoveryNextStep: null,
      recoveryChecks: [],
      assessedMaterials: [],
      resumeMessageId: oldMessage.id,
      runCompletion: {
        id: oldRunId,
        provider: 'fake',
        engineModel: 'fake-recovery',
        engineSessionId: `fake:${oldRunId}`,
        turnBudget: 1,
        outcome: 'conclusive',
        result: { summary: 'Checkout recovered.' },
        evidenceIds: [],
      },
    });

    expect(result).toMatchObject({
      applied: false,
      runCompleted: false,
      message: null,
      replyMessage: null,
    });
    expect(await getIncident(__fixture.app.db, __fixture.tenantA, incident.id)).toMatchObject({
      lastResumeMessageId: newerMessage.id,
    });
    expect(await __fixture.hub.history(__fixture.tenantA, incident.id)).toEqual(historyBefore);
  });
});
