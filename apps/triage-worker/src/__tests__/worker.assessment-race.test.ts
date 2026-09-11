import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';

import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  incidentSignals,
  investigationRuns,
} from '@sre/db';

import type { TriageEngine } from '../engine/types';
import { createFixture } from './worker.fixture';

const __fixture = createFixture();

test('a signal added during investigation prevents stale trusted-assessment promotion', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `assessment-signal-set-race-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev2',
  });
  await applyTriageResult(__fixture.app.db, __fixture.tenantId, incident.id, {
    provider: 'fake',
    sessionId: `trusted-before-addition:${incident.id}`,
    summary: 'Trusted assessment before another affected entity appeared.',
    confidence: 74,
  });
  const monitorKey = `alertmanager:checkout:${randomUUID()}`;
  const firstMaterialHash = randomUUID();
  const first = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId: incident.id,
    provider: 'alertmanager',
    providerFingerprint: randomUUID(),
    monitorKey,
    startsAt: new Date('2026-08-31T02:00:00.000Z'),
    surface: 'alertmanager',
    channel: 'prometheus-a',
    externalMessageId: `first-${randomUUID()}`,
    state: 'firing',
    summary: 'Checkout errors affect instance one.',
    contentHash: randomUUID(),
    materialHash: firstMaterialHash,
    eventKey: randomUUID(),
    eventAt: new Date('2026-08-31T02:00:00.000Z'),
  });
  const secondMaterialHash = randomUUID();
  const engine: TriageEngine = {
    provider: 'fake',
    investigate: async () => {
      await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
        incidentId: incident.id,
        provider: 'alertmanager',
        providerFingerprint: randomUUID(),
        monitorKey,
        startsAt: new Date('2026-08-31T02:01:00.000Z'),
        surface: 'alertmanager',
        channel: 'prometheus-a',
        externalMessageId: `second-${randomUUID()}`,
        state: 'firing',
        summary: 'Checkout errors now affect instance two.',
        contentHash: randomUUID(),
        materialHash: secondMaterialHash,
        eventKey: randomUUID(),
        eventAt: new Date('2026-08-31T02:01:00.000Z'),
      });
      return {
        provider: 'fake',
        sessionId: `stale-after-addition:${incident.id}`,
        outcome: 'conclusive',
        turnBudget: 1,
        disposition: 'rca',
        summary: 'This assessment did not include the second affected entity.',
        confidence: 90,
      };
    },
    resume: async () => {
      throw new Error('resume is not used');
    },
    verifyRecovery: async () => {
      throw new Error('recovery is not used');
    },
  };
  const jobId = randomUUID();

  await __fixture.workerWithEngine(engine).handle(
    {
      id: jobId,
      tenantId: __fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: {
        incidentId: incident.id,
        signalMaterials: [{ signalId: first.signal.id, materialHash: firstMaterialHash }],
      },
    },
    { signal: new AbortController().signal },
  );

  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
    rcaSummary: 'Trusted assessment before another affected entity appeared.',
    confidence: 74,
    investigationStatus: 'assessed',
  });
  expect(
    await __fixture.admin.db
      .select({ materialHash: incidentSignals.lastInvestigatedMaterialHash })
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incident.id)),
  ).toEqual([{ materialHash: null }, { materialHash: null }]);
  expect(
    await __fixture.admin.db
      .select({ outcome: investigationRuns.outcome, result: investigationRuns.result })
      .from(investigationRuns)
      .where(eq(investigationRuns.jobId, jobId)),
  ).toEqual([
    {
      outcome: 'failed',
      result: expect.objectContaining({ reason: 'stale_signal_material' }),
    },
  ]);
});
