import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  incidentSignals,
  jobs,
  recordToolCall,
  recordIncidentRelation,
} from '@sre/db';

import { type TriageEngine, type TriageInput, type TriageResult } from '../engine/types';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('signal-driven recovery and explicit lifecycle commands', () => {
  const signal = (
    id: string,
    over: Partial<Parameters<typeof applySignalObservation>[2]> = {},
  ) => ({
    incidentId: id,
    surface: 'slack',
    channel: 'C-lifecycle',
    externalMessageId: `signal-${id}`,
    state: 'firing' as const,
    summary: 'Checkout errors are firing',
    contentHash: 'firing-hash',
    eventKey: `firing-${id}`,
    eventAt: new Date('2026-08-21T02:00:00.000Z'),
    ...over,
  });

  test('opening investigation receives prior RCA and relation evidence as comparison context', async () => {
    const prior = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `relation-prior-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, prior.id, {
      provider: 'fake',
      sessionId: `fake:${prior.id}`,
      summary: 'A deployment exhausted the database connection pool.',
      confidence: 88,
    });
    const current = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `relation-current-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    await recordIncidentRelation(__fixture.app.db, __fixture.tenantId, {
      sourceIncidentId: current.id,
      targetIncidentId: prior.id,
      type: 'recurrence_of',
      rationale: 'Alertmanager reported a new episode for the same provider fingerprint.',
      evidence: ['provider_fingerprint:abc'],
      decidedBy: 'system',
    });
    let seenContext = '';
    const relationEngine: TriageEngine = {
      provider: 'fake',
      async investigate(input) {
        seenContext = input.context ?? '';
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'rca',
          summary: 'The recurrence was assessed independently.',
          confidence: 70,
        };
      },
      async resume() {
        throw new Error('not used');
      },
      verifyRecovery: __fixture.verifyRecovery,
    };

    await __fixture.workerWithEngine(relationEngine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: current.id, alert: { status: 'firing' } },
      },
      { signal: new AbortController().signal },
    );

    expect(seenContext).toContain(`incident=${prior.id}`);
    expect(seenContext).toContain(
      'prior_assessment=A deployment exhausted the database connection pool.',
    );
    expect(seenContext).toContain('similarity is not proof');
  });

  test('a coalesced reassessment gives the engine every current signal, not only the newest trigger', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `reassess-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const firstFingerprint = randomUUID();
    const secondFingerprint = randomUUID();
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `prior:${id}`,
      summary: 'The trusted prior assessment attributes errors to pool saturation.',
      confidence: 78,
    });
    const priorEvidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      tool: 'query_metrics',
      input: { service: 'checkout' },
      output: { errorRate: 0.2 },
      latencyMs: 2,
      outcome: 'data',
    });
    const first = await applySignalObservation(
      __fixture.app.db,
      __fixture.tenantId,
      signal(id, {
        provider: 'alertmanager',
        providerFingerprint: firstFingerprint,
        startsAt: new Date('2026-08-21T01:55:00.000Z'),
        materialHash: 'first-initial-material',
      }),
    );
    const second = await applySignalObservation(
      __fixture.app.db,
      __fixture.tenantId,
      signal(id, {
        externalMessageId: `signal-b-${id}`,
        provider: 'alertmanager',
        providerFingerprint: secondFingerprint,
        startsAt: new Date('2026-08-21T01:56:00.000Z'),
        materialHash: 'second-initial-material',
        contentHash: 'second-firing',
        eventKey: `second-firing-${id}`,
        eventAt: new Date('2026-08-21T02:00:30.000Z'),
      }),
    );
    const firstLatest = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      provider: 'alertmanager',
      providerFingerprint: firstFingerprint,
      startsAt: new Date('2026-08-21T01:55:00.000Z'),
      materialHash: 'first-current-material',
      summary: 'Checkout errors increased to 20%',
      contentHash: 'first-updated',
      eventKey: `first-updated-${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const latest = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id, { externalMessageId: `signal-b-${id}` }),
      provider: 'alertmanager',
      providerFingerprint: secondFingerprint,
      startsAt: new Date('2026-08-21T01:56:00.000Z'),
      materialHash: 'second-current-material',
      summary: 'Checkout latency is also high',
      contentHash: 'second-updated',
      eventKey: `second-updated-${id}`,
      eventAt: new Date('2026-08-21T02:02:00.000Z'),
    });
    expect(first.signal.id).not.toBe(second.signal.id);

    let seenInput: TriageInput | undefined;
    const investigate = vi.fn(async (input: TriageInput): Promise<TriageResult> => {
      seenInput = input;
      return {
        provider: 'fake',
        sessionId: `fake:${input.incident.id}`,
        outcome: 'conclusive',
        turnBudget: 1,
        disposition: 'rca',
        summary: 'Both current signals were assessed.',
        confidence: 70,
      };
    });
    const engine: TriageEngine = {
      provider: 'fake',
      investigate,
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery() {
        throw new Error('not used');
      },
    };

    const reassessmentJob = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'signal.reassess',
      attempts: 1,
      payload: {
        incidentId: id,
        signalChanges: [firstLatest, latest].map(({ signal: current }) => ({
          signalId: current.id,
          signalVersion: current.version,
          triggerReason: 'material_change' as const,
        })),
      },
    };
    const reassessmentWorker = __fixture.workerWithEngine(engine);
    const publishAppended = __fixture.hub.publishAppended.bind(__fixture.hub);
    let failedAssessmentPublish = false;
    const publishSpy = vi
      .spyOn(__fixture.hub, 'publishAppendedBestEffort')
      .mockImplementation(async (message) => {
        if (!failedAssessmentPublish && message.content === 'Both current signals were assessed.') {
          failedAssessmentPublish = true;
          return;
        }
        await publishAppended(message);
      });
    try {
      await reassessmentWorker.handle(reassessmentJob, {
        signal: new AbortController().signal,
      });
      await reassessmentWorker.handle(
        { ...reassessmentJob, attempts: 2 },
        { signal: new AbortController().signal },
      );
    } finally {
      publishSpy.mockRestore();
    }

    expect(seenInput?.alert).toMatchObject({
      priorAssessment: {
        summary: 'The trusted prior assessment attributes errors to pool saturation.',
        confidence: 78,
      },
      materialDeltas: [
        {
          signalId: firstLatest.signal.id,
          triggerReason: 'material_change',
        },
        {
          signalId: latest.signal.id,
          triggerReason: 'material_change',
        },
      ],
      signals: [
        { summary: 'Checkout errors increased to 20%', version: 2 },
        { summary: 'Checkout latency is also high', version: 2 },
      ],
    });
    expect(seenInput?.evidence).toEqual([
      expect.objectContaining({ id: priorEvidenceId, tool: 'query_metrics' }),
    ]);
    expect(seenInput?.context).toContain('Reassess only the material delta');
    expect(investigate).toHaveBeenCalledTimes(1);
    expect(
      await Promise.all(
        [first.signal.id, second.signal.id].map(
          async (signalId) =>
            (
              await __fixture.admin.db
                .select({
                  materialHash: incidentSignals.materialHash,
                  lastInvestigatedMaterialHash: incidentSignals.lastInvestigatedMaterialHash,
                })
                .from(incidentSignals)
                .where(eq(incidentSignals.id, signalId))
            )[0],
        ),
      ),
    ).toEqual([
      {
        materialHash: 'first-current-material',
        lastInvestigatedMaterialHash: 'first-current-material',
      },
      {
        materialHash: 'second-current-material',
        lastInvestigatedMaterialHash: 'second-current-material',
      },
    ]);
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).filter(
        (message) => message.content === 'Both current signals were assessed.',
      ),
    ).toHaveLength(1);
  });

  test('a delayed opening job cannot overwrite a completed signal reassessment', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `signal-before-opening-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    const observed = await applySignalObservation(__fixture.app.db, __fixture.tenantId, signal(id));
    const investigate = vi.fn(async (input: TriageInput): Promise<TriageResult> => {
      const fromSignal = Boolean(
        input.alert &&
        typeof input.alert === 'object' &&
        'materialDeltas' in input.alert &&
        Array.isArray(input.alert.materialDeltas) &&
        input.alert.materialDeltas.length > 0,
      );
      return {
        provider: 'fake',
        sessionId: `fake:${input.incident.id}`,
        outcome: 'conclusive',
        turnBudget: 1,
        disposition: 'rca',
        summary: fromSignal ? 'Current signal assessment.' : 'Stale opening assessment.',
        confidence: 70,
      };
    });
    const engine: TriageEngine = {
      provider: 'fake',
      investigate,
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery() {
        throw new Error('not used');
      },
    };
    const delayedWorker = __fixture.workerWithEngine(engine);

    const delayedJob = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'triage',
      attempts: 1,
      createdAt: new Date('2000-01-01T00:00:00.000Z'),
      payload: { incidentId: id, alert: { summary: 'Older opening payload' } },
    };

    await delayedWorker.handle(
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
    );
    await delayedWorker.handle(delayedJob, { signal: new AbortController().signal });

    expect(investigate).toHaveBeenCalledTimes(1);
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      investigationStatus: 'assessed',
      rcaSummary: 'Current signal assessment.',
    });
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).filter(
        (message) => message.kind === 'finding',
      ),
    ).toEqual([expect.objectContaining({ content: 'Current signal assessment.' })]);
  });

  test('opening assessment and finding roll back together and recover on redelivery', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `atomic-opening-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    const investigate = vi.fn(async (input: TriageInput): Promise<TriageResult> => ({
      provider: 'fake',
      sessionId: `fake:${input.incident.id}`,
      outcome: 'conclusive',
      turnBudget: 1,
      disposition: 'rca',
      summary: 'Atomic opening assessment.',
      confidence: 70,
    }));
    const engine: TriageEngine = {
      provider: 'fake',
      investigate,
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery() {
        throw new Error('not used');
      },
    };
    const atomicWorker = __fixture.workerWithEngine(engine);
    const job = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: { incidentId: id, alert: { summary: 'Opening payload' } },
    };
    const append = vi
      .spyOn(__fixture.hub, 'appendTxOnce')
      .mockRejectedValueOnce(new Error('simulated finding write failure'));
    try {
      await expect(
        atomicWorker.handle(job, { signal: new AbortController().signal }),
      ).rejects.toThrow('simulated finding write failure');
      expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
        investigationStatus: 'gathering',
        rcaSummary: null,
      });
      expect(
        (await __fixture.hub.history(__fixture.tenantId, id)).filter(
          (message) => message.kind === 'finding',
        ),
      ).toHaveLength(0);

      const publishAppended = __fixture.hub.publishAppended.bind(__fixture.hub);
      let failedPostCommitPublish = false;
      const publish = vi
        .spyOn(__fixture.hub, 'publishAppendedBestEffort')
        .mockImplementation(async (message) => {
          if (!failedPostCommitPublish) {
            failedPostCommitPublish = true;
            return;
          }
          await publishAppended(message);
        });
      try {
        await atomicWorker.handle(
          { ...job, attempts: 2 },
          { signal: new AbortController().signal },
        );
        expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
          investigationStatus: 'assessed',
          rcaSummary: 'Atomic opening assessment.',
        });
        expect(
          (await __fixture.hub.history(__fixture.tenantId, id)).filter(
            (message) => message.content === 'Atomic opening assessment.',
          ),
        ).toHaveLength(1);

        await atomicWorker.handle(
          { ...job, attempts: 3 },
          { signal: new AbortController().signal },
        );

        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({ content: 'Atomic opening assessment.' }),
        );
      } finally {
        publish.mockRestore();
      }

      expect(investigate).toHaveBeenCalledTimes(2);
      expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
        investigationStatus: 'assessed',
        rcaSummary: 'Atomic opening assessment.',
      });
      expect(
        (await __fixture.hub.history(__fixture.tenantId, id)).filter(
          (message) => message.content === 'Atomic opening assessment.',
        ),
      ).toHaveLength(1);
    } finally {
      append.mockRestore();
    }
  });

  test('a provider episode first observed resolved schedules recovery after its opening assessment', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `resolved-provider-opening-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev3',
    });
    const materialHash = randomUUID();
    const observed = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      provider: 'alertmanager',
      providerFingerprint: randomUUID(),
      startsAt: new Date('2026-08-21T01:55:00.000Z'),
      state: 'resolved',
      summary: '[RESOLVED] Checkout errors',
      materialHash,
      contentHash: `resolved-provider-opening:${id}`,
      eventKey: `resolved-provider-opening:${id}`,
    });
    const investigate = vi.fn(async (input: TriageInput): Promise<TriageResult> => ({
      provider: 'fake',
      sessionId: `fake:${input.incident.id}`,
      outcome: 'conclusive',
      turnBudget: 1,
      disposition: 'rca',
      summary: 'The alert cleared before the platform received its first delivery.',
      confidence: 65,
    }));
    const engine: TriageEngine = {
      provider: 'fake',
      investigate,
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
        payload: {
          incidentId: id,
          alert: { status: 'resolved' },
          signalMaterials: [{ signalId: observed.signal.id, materialHash }],
        },
      },
      { signal: new AbortController().signal },
    );

    expect(investigate).toHaveBeenCalledTimes(1);
    expect(
      await __fixture.admin.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          sql`${jobs.tenantId} = ${__fixture.tenantId} and ${jobs.type} = 'recovery.verify' and ${jobs.payload}->>'incidentId' = ${id}`,
        ),
    ).toHaveLength(1);
    expect(
      await __fixture.admin.db
        .select({ lastInvestigatedMaterialHash: incidentSignals.lastInvestigatedMaterialHash })
        .from(incidentSignals)
        .where(eq(incidentSignals.id, observed.signal.id)),
    ).toEqual([{ lastInvestigatedMaterialHash: materialHash }]);
  });
});
