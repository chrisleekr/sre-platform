import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  agentToolCalls,
  clearRecoveryTx,
  createIncident,
  getIncident,
  getIncidentDetail,
  incidents,
  recordToolCall,
  serializeSignalFence,
  withTenant,
} from '@sre/db';
import { createFixture } from './hub.fixture';

const fixture = createFixture();

describe('structured recovery questions', () => {
  test('stores current permitted attempts separately from health proof and replaces legacy views atomically', async () => {
    const incident = await createIncident(fixture.app.db, fixture.tenantA, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const sibling = await createIncident(fixture.app.db, fixture.tenantA, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'payments',
      severity: 'sev3',
    });
    const foreign = await createIncident(fixture.app.db, fixture.tenantB, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'other-tenant',
      severity: 'sev3',
    });
    const record = (tenantId: string, incidentId: string) =>
      recordToolCall(fixture.app.db, tenantId, {
        incidentId,
        tool: 'kubernetes_get',
        input: {},
        outcome: 'unavailable',
        latencyMs: 1,
      });
    const unavailable = await record(fixture.tenantA, incident.id);
    const stale = await record(fixture.tenantA, incident.id);
    const siblingId = await record(fixture.tenantA, sibling.id);
    const foreignId = await record(fixture.tenantB, foreign.id);
    await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx
        .update(agentToolCalls)
        .set({ createdAt: new Date('2020-01-01') })
        .where(eq(agentToolCalls.id, stale)),
    );
    const question = {
      question: 'Is the affected deployment ready?',
      category: 'missing_capability' as const,
      evidenceKind: 'runtime_state' as const,
      resolutionRelevance: 'blocking' as const,
      attemptedEvidenceIds: [unavailable, stale, siblingId, foreignId, randomUUID()],
      nextAction: 'Restore Kubernetes read access and check deployment readiness.',
    };
    const input = {
      expectedLifecycleVersion: 0,
      expectedSignalFence: serializeSignalFence([]),
      restoreInvestigationStatus: 'assessed' as const,
      verificationStartedAt: new Date(Date.now() - 60_000),
      eventKey: randomUUID(),
      content: 'Health check unavailable.',
      summary: 'Health is unknown.',
      outcome: 'needs_human' as const,
      attempt: 1,
      maxChecks: 3,
      recoveryEvidenceIds: [unavailable],
      recoveryUnknowns: ['Must be replaced by projection.'],
      recoveryQuestions: [question],
      recoveryNextStep: null,
      recoveryChecks: [],
      assessedMaterials: [],
    };
    const result = await fixture.hub.finalizeRecovery(fixture.tenantA, incident.id, input);
    const accepted = { ...question, attemptedEvidenceIds: [unavailable] };
    expect(result.message?.recovery).toMatchObject({
      questions: [accepted],
      unknowns: [question.question],
    });
    expect(await getIncidentDetail(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
      recoveryQuestions: [accepted],
      recoveryUnknowns: [question.question],
      recoveryEvidenceIds: [],
    });
    expect(await getIncidentDetail(fixture.app.db, fixture.tenantB, incident.id)).toBeNull();

    // An older Hub updates only legacy fields during a rolling deployment.
    await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx
        .update(incidents)
        .set({
          recoveryUnknowns: ['Historical unclassified question.'],
          recoveryUpdatedAt: sql`${incidents.recoveryUpdatedAt} + interval '1 second'`,
        })
        .where(eq(incidents.id, incident.id)),
    );
    expect(await getIncidentDetail(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
      recoveryQuestions: null,
      recoveryUnknowns: ['Historical unclassified question.'],
    });

    const { recoveryQuestions: _questions, ...legacy } = input;
    await fixture.hub.finalizeRecovery(fixture.tenantA, incident.id, {
      ...legacy,
      eventKey: randomUUID(),
    });
    expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
      recoveryQuestions: null,
      recoveryQuestionsUpdatedAt: null,
      recoveryUnknowns: ['Must be replaced by projection.'],
    });
    await fixture.hub.finalizeRecovery(fixture.tenantA, incident.id, {
      ...input,
      eventKey: randomUUID(),
    });
    await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      clearRecoveryTx(tx, fixture.tenantA, incident.id),
    );
    expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
      recoveryQuestions: null,
      recoveryQuestionsUpdatedAt: null,
      recoveryUnknowns: null,
    });
  });
});
