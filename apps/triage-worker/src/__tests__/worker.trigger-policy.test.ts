import { randomUUID } from 'node:crypto';

import {
  admitInvestigationRun,
  applySignalObservation,
  createIncident,
  getIncident,
  incidentSignals,
  incidents,
  investigationRuns,
  jobs,
} from '@sre/db';
import { and, eq, sql } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';

import type { TriageEngine, TriageInput } from '../engine/types';
import { createFixture } from './worker.fixture';

const __fixture = createFixture();
let observationSequence = 0;

async function observe(
  incidentId: string,
  monitorKey: string,
  suffix: string,
  state: 'firing' | 'resolved' = 'firing',
  episode: { externalMessageId?: string; startsAt?: Date } = {},
) {
  const externalMessageId = episode.externalMessageId ?? `signal-${suffix}`;
  return applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId,
    provider: 'alertmanager',
    providerFingerprint: `provider-${suffix}`,
    monitorKey,
    startsAt: episode.startsAt ?? new Date('2026-08-31T00:00:00.000Z'),
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId,
    state,
    summary: `Signal ${suffix} is ${state}.`,
    contentHash: `${suffix}-${state}`,
    materialHash: `material-${suffix}`,
    eventKey: `${externalMessageId}:${state}:${randomUUID()}`,
    eventAt: new Date(Date.now() + observationSequence++ * 1_000),
  });
}

test('a conclusive human follow-up promotes the current provider signal snapshot', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `resume-material-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev2',
  });
  const signal = await observe(incident.id, 'monitor:resume', randomUUID());
  const human = await __fixture.hub.append(__fixture.tenantId, incident.id, {
    author: 'human',
    kind: 'text',
    content: 'Reassess the root cause with the latest evidence.',
  });
  const worker = __fixture.workerWithEngine({
    provider: 'fake',
    investigate: async () => {
      throw new Error('investigate is not used');
    },
    resume: async () => ({
      provider: 'fake',
      sessionId: 'resume-material',
      model: 'fake',
      outcome: 'conclusive',
      disposition: 'rca',
      turnBudget: 1,
      summary: 'The current provider evidence confirms pool saturation.',
      confidence: 85,
    }),
    verifyRecovery: async () => {
      throw new Error('recovery is not used');
    },
  });

  await worker.handle(
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
    rcaSummary: 'The current provider evidence confirms pool saturation.',
    lastResumeMessageId: human.id,
  });
  expect(
    (
      await __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.id, signal.signal.id))
    )[0],
  ).toMatchObject({ lastInvestigatedMaterialHash: signal.signal.materialHash });
});

test('a refired provider episode uses a full investigation even when a trusted brief exists', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `refire-full-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev2',
  });
  const suffix = randomUUID();
  await observe(incident.id, 'monitor:refire', suffix);
  await observe(incident.id, 'monitor:refire', suffix, 'resolved');
  await __fixture.admin.db
    .update(incidents)
    .set({ rcaSummary: 'Prior episode diagnosis.', investigationStatus: 'assessed' })
    .where(eq(incidents.id, incident.id));
  await __fixture.hub.transitionIncident(__fixture.tenantId, incident.id, {
    to: 'resolved',
    reason: 'Prior episode recovered.',
    transitionKey: `resolved:${incident.id}`,
    author: 'system',
  });
  const refired = await observe(incident.id, 'monitor:refire', suffix, 'firing', {
    externalMessageId: `signal-${suffix}-episode-2`,
    startsAt: new Date('2026-08-31T00:10:00.000Z'),
  });
  let seen: TriageInput | undefined;
  const worker = __fixture.workerWithEngine({
    provider: 'fake',
    investigate: async (input) => {
      seen = input;
      return {
        provider: 'fake',
        sessionId: 'refire-full',
        model: 'fake',
        outcome: 'inconclusive',
        turnBudget: 8,
        summary: 'The new episode needs a full investigation.',
        confidence: 0,
      };
    },
    resume: async () => {
      throw new Error('resume is not used');
    },
    verifyRecovery: async () => {
      throw new Error('recovery is not used');
    },
  });

  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'signal.reassess',
      attempts: 1,
      payload: {
        incidentId: incident.id,
        signalChanges: [
          {
            signalId: refired.signal.id,
            signalVersion: refired.signal.version,
            triggerReason: 'new_episode',
          },
        ],
      },
    },
    { signal: new AbortController().signal },
  );

  expect(seen?.mode).toBe('full');
  expect(
    (
      await __fixture.admin.db
        .select()
        .from(investigationRuns)
        .where(eq(investigationRuns.incidentId, incident.id))
    )[0],
  ).toMatchObject({ triggerReason: 'new_episode', triggerAutomatic: true });
});

test('a second label-set instance in the same monitor records a material-change trigger', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `label-set-material-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev2',
  });
  const monitorKey = `monitor:label-set:${randomUUID()}`;
  await observe(incident.id, monitorKey, randomUUID());
  const changed = await observe(incident.id, monitorKey, randomUUID());
  let seen: TriageInput | undefined;
  const worker = __fixture.workerWithEngine({
    provider: 'fake',
    investigate: async (input) => {
      seen = input;
      return {
        provider: 'fake',
        sessionId: 'label-set-material',
        model: 'fake',
        outcome: 'inconclusive',
        turnBudget: 1,
        summary: 'The additional affected entity needs more evidence.',
        confidence: 0,
      };
    },
    resume: async () => {
      throw new Error('resume is not used');
    },
    verifyRecovery: async () => {
      throw new Error('recovery is not used');
    },
  });

  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'signal.reassess',
      attempts: 1,
      payload: {
        incidentId: incident.id,
        signalChanges: [
          {
            signalId: changed.signal.id,
            signalVersion: changed.signal.version,
            triggerReason: 'new_episode',
          },
        ],
      },
    },
    { signal: new AbortController().signal },
  );

  expect(seen).toMatchObject({
    mode: 'full',
    context:
      'Investigate the complete current signal set because no focused material-delta path applies.',
  });
  expect(
    (
      await __fixture.admin.db
        .select()
        .from(investigationRuns)
        .where(eq(investigationRuns.incidentId, incident.id))
    )[0],
  ).toMatchObject({ triggerReason: 'material_change', triggerMonitorKeys: [monitorKey] });
});

test('a noisy signal cannot discard a quiet outstanding cause from a conclusive reassessment', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `coalesced-partial-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev2',
  });
  const monitorA = `monitor:coalesced-a:${randomUUID()}`;
  const monitorB = `monitor:coalesced-b:${randomUUID()}`;
  const suffixA = randomUUID();
  const suffixB = randomUUID();
  const [signalA] = await Promise.all([
    observe(incident.id, monitorA, suffixA),
    observe(incident.id, monitorB, suffixB),
  ]);
  await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId: incident.id,
    provider: 'alertmanager',
    providerFingerprint: `provider-${suffixA}`,
    monitorKey: monitorA,
    startsAt: new Date('2026-08-31T00:00:00.000Z'),
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId: `signal-${suffixA}`,
    state: 'firing',
    summary: 'Signal A changed again.',
    contentHash: `${suffixA}-changed`,
    materialHash: `material-${suffixA}-changed`,
    eventKey: `${suffixA}:changed:${randomUUID()}`,
    eventAt: new Date(Date.now() + observationSequence++ * 1_000),
  });
  const currentB = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId: incident.id,
    provider: 'alertmanager',
    providerFingerprint: `provider-${suffixB}`,
    monitorKey: monitorB,
    startsAt: new Date('2026-08-31T00:00:00.000Z'),
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId: `signal-${suffixB}`,
    state: 'firing',
    summary: 'Signal B changed.',
    contentHash: `${suffixB}-changed`,
    materialHash: `material-${suffixB}-changed`,
    eventKey: `${suffixB}:changed:${randomUUID()}`,
    eventAt: new Date(Date.now() + observationSequence++ * 1_000),
  });
  await __fixture.admin.db
    .update(incidents)
    .set({ rcaSummary: 'Trusted prior assessment.', investigationStatus: 'assessed' })
    .where(eq(incidents.id, incident.id));
  const seen: TriageInput[] = [];
  let investigationCount = 0;
  const worker = __fixture.workerWithEngine(
    {
      provider: 'fake',
      investigate: async (input) => {
        seen.push(input);
        investigationCount += 1;
        if (investigationCount === 1) {
          const latestA = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
            incidentId: incident.id,
            provider: 'alertmanager',
            providerFingerprint: `provider-${suffixA}`,
            monitorKey: monitorA,
            startsAt: new Date('2026-08-31T00:00:00.000Z'),
            surface: 'slack',
            channel: 'C-alerts',
            externalMessageId: `signal-${suffixA}`,
            state: 'firing',
            summary: 'Signal A changed during assessment.',
            contentHash: `${suffixA}-changed-during-assessment`,
            materialHash: `material-${suffixA}-changed-during-assessment`,
            eventKey: `${suffixA}:changed-during-assessment:${randomUUID()}`,
            eventAt: new Date(Date.now() + observationSequence++ * 1_000),
          });
          await __fixture.admin.db.transaction((tx) =>
            __fixture.queue.insertReassessmentTx(
              tx,
              __fixture.tenantId,
              incident.id,
              latestA.signal.id,
              latestA.signal.version,
            ),
          );
        }
        return {
          provider: 'fake',
          sessionId: 'coalesced-partial',
          model: 'fake',
          outcome: 'conclusive',
          disposition: 'rca',
          turnBudget: 1,
          summary: 'The remaining current cause was investigated.',
          confidence: 80,
        };
      },
      resume: async () => {
        throw new Error('resume is not used');
      },
      verifyRecovery: async () => {
        throw new Error('recovery is not used');
      },
    },
    {
      getAutomaticInvestigationBudget: async () => ({
        tenantRunLimit: 0,
        monitorRunLimit: 1,
        tenantConfiguredCostLimitUsd: 0,
        monitorConfiguredCostLimitUsd: 0,
        configuredCostReady: true,
      }),
    },
  );

  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'signal.reassess',
      attempts: 1,
      payload: {
        incidentId: incident.id,
        signalChanges: [signalA, currentB].map(({ signal }) => ({
          signalId: signal.id,
          signalVersion: signal.version,
          triggerReason: 'material_change' as const,
        })),
      },
    },
    { signal: new AbortController().signal },
  );

  expect((seen[0]?.alert as { materialDeltas?: unknown[] } | undefined)?.materialDeltas).toEqual([
    expect.objectContaining({ signalId: currentB.signal.id }),
  ]);
  const afterFirst = await __fixture.admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.incidentId, incident.id));
  expect(afterFirst.find((signal) => signal.id === currentB.signal.id)).toMatchObject({
    lastInvestigatedVersion: currentB.signal.version,
  });
  const successor = (
    await __fixture.admin.db
      .select({ id: jobs.id, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, __fixture.tenantId),
          eq(jobs.type, 'signal.reassess'),
          eq(jobs.status, 'queued'),
          sql`payload->>'incidentId' = ${incident.id}`,
        ),
      )
  )[0];
  expect(successor).toBeDefined();
  expect(
    (successor!.payload as { signalChanges: Array<{ signalId: string }> }).signalChanges.map(
      (change) => change.signalId,
    ),
  ).toEqual([signalA.signal.id, currentB.signal.id].sort());

  await worker.handle(
    {
      id: successor!.id,
      tenantId: __fixture.tenantId,
      type: 'signal.reassess',
      attempts: 1,
      payload: successor!.payload,
    },
    { signal: new AbortController().signal },
  );
  expect((seen[1]?.alert as { materialDeltas?: unknown[] } | undefined)?.materialDeltas).toEqual([
    expect.objectContaining({ signalId: signalA.signal.id }),
  ]);

  const afterSuccessor = await __fixture.admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.incidentId, incident.id));
  expect(afterSuccessor).toHaveLength(2);
  expect(afterSuccessor.every((signal) => signal.lastInvestigatedVersion === signal.version)).toBe(
    true,
  );
  const runs = await __fixture.admin.db
    .select()
    .from(investigationRuns)
    .where(eq(investigationRuns.incidentId, incident.id));
  expect(runs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        outcome: 'conclusive',
        triggerMonitorKeys: [monitorB],
      }),
      expect.objectContaining({
        outcome: 'conclusive',
        triggerMonitorKeys: [monitorA],
      }),
    ]),
  );
  expect(runs).toHaveLength(2);
});

test('a coalesced reassessment charges every causal monitor before engine execution', async () => {
  const [blocker, incident] = await Promise.all(
    ['blocker', 'target'].map((name) =>
      createIncident(__fixture.app.db, __fixture.tenantId, {
        fingerprint: `multi-monitor-${name}-${randomUUID()}`,
        alertSource: 'alertmanager',
        service: 'checkout',
        severity: 'sev2',
      }),
    ),
  );
  const monitorA = `monitor:a:${randomUUID()}`;
  const monitorB = `monitor:b:${randomUUID()}`;
  const limits = {
    tenantRunLimit: 0,
    monitorRunLimit: 1,
    tenantConfiguredCostLimitUsd: 0,
    monitorConfiguredCostLimitUsd: 0,
    configuredCostReady: true,
  };
  await admitInvestigationRun(__fixture.app.db, __fixture.tenantId, blocker!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: monitorA },
    limits,
  });
  const [signalA, signalB] = await Promise.all([
    observe(incident!.id, monitorA, randomUUID()),
    observe(incident!.id, monitorB, randomUUID()),
  ]);
  const investigate = vi.fn<TriageEngine['investigate']>();
  const worker = __fixture.workerWithEngine(
    {
      provider: 'fake',
      investigate,
      resume: async () => {
        throw new Error('resume is not used');
      },
      verifyRecovery: async () => {
        throw new Error('recovery is not used');
      },
    },
    { getAutomaticInvestigationBudget: async () => limits },
  );

  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'signal.reassess',
      attempts: 1,
      payload: {
        incidentId: incident!.id,
        signalChanges: [signalA, signalB].map(({ signal }) => ({
          signalId: signal.id,
          signalVersion: signal.version,
          triggerReason: 'new_episode',
        })),
      },
    },
    { signal: new AbortController().signal },
  );

  expect(investigate).not.toHaveBeenCalled();
  const runs = await __fixture.admin.db
    .select()
    .from(investigationRuns)
    .where(eq(investigationRuns.incidentId, incident!.id));
  expect(runs).toEqual([
    expect.objectContaining({
      admissionDenied: true,
      triggerMonitorKeys: [monitorA, monitorB].sort(),
      triggerBudget: expect.objectContaining({ exhaustedBy: ['monitor_run_limit'] }),
    }),
  ]);
});
