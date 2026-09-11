import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  applySignalObservation,
  createIncident,
  entityServiceMappings,
  incidentFeedback,
  incidentSignals,
  incidents,
  investigationRuns,
  jobs,
  services,
  upsertEntityServiceMapping,
} from '@sre/db';
import { eq } from 'drizzle-orm';
import { createFixture } from './incidents.fixture';

const __fixture = createFixture();
test('records attributed finding and noise feedback and exposes current response policy', async () => {
  const serviceName = `feedback-checkout-${randomUUID()}`;
  await __fixture.admin.db.insert(services).values({
    tenantId: __fixture.tenantC,
    name: serviceName,
    team: 'checkout-on-call',
  });
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `feedback-${randomUUID()}`,
    alertSource: 'prometheus',
    service: serviceName,
    severity: 'sev2',
  });
  const runId = randomUUID();
  const completedAt = new Date();
  await __fixture.admin.db.insert(investigationRuns).values({
    id: runId,
    tenantId: __fixture.tenantC,
    incidentId: incident.id,
    operation: 'investigate',
    outcome: 'conclusive',
    result: { summary: 'Pool saturation caused the errors.' },
    completedAt,
  });
  await __fixture.hub.append(__fixture.tenantC, incident.id, {
    author: 'agent',
    kind: 'finding',
    content: 'Pool saturation caused the errors.',
    finding: {
      runId,
      outcome: 'conclusive',
      promotion: 'trusted_assessment',
      promotionReason: 'conclusive_assessment',
      evidenceIds: [],
      currentState: 'Checkout requests are failing.',
      impact: 'Checkout is degraded.',
      nextStep: 'Inspect connection ownership.',
    },
  });
  const episodeExpiresAt = new Date(Date.now() + 60 * 60_000);
  await __fixture.admin.db
    .update(incidents)
    .set({
      trustedAssessmentRunId: runId,
      rcaSummary: 'Pool saturation caused the errors.',
      investigationStatus: 'assessed',
      correlationMaxAgeAt: episodeExpiresAt,
    })
    .where(eq(incidents.id, incident.id));
  const signalId = randomUUID();
  await __fixture.admin.db.insert(incidentSignals).values({
    id: signalId,
    tenantId: __fixture.tenantC,
    incidentId: incident.id,
    provider: 'alertmanager',
    monitorKey: `monitor:${randomUUID()}`,
    surface: 'slack',
    channel: 'C-FEEDBACK',
    externalMessageId: randomUUID(),
    state: 'firing',
    lastEventType: 'opened',
    summary: 'Checkout error rate is high.',
    contentHash: randomUUID(),
    lastEventKey: randomUUID(),
    lastEventAt: new Date(),
  });
  const token = await __fixture.sign(__fixture.orgC);
  const auth = __fixture.auth(token);

  const finding = await __fixture.api.request(`/incidents/${incident.id}/feedback`, {
    ...auth,
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      targetType: 'finding',
      targetId: runId,
      decision: 'correct',
      rationale: 'The trace identifies a connection leak.',
      replacement: 'A connection leak exhausted the pool.',
    }),
  });
  expect(finding.status).toBe(201);
  await expect(finding.json()).resolves.toMatchObject({
    feedback: {
      incidentId: incident.id,
      targetType: 'finding',
      targetId: runId,
      decision: 'correct',
      createdByUserId: __fixture.tenantCUserId,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    },
  });

  const noise = await __fixture.api.request(`/incidents/${incident.id}/feedback`, {
    ...auth,
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      targetType: 'noise',
      targetId: signalId,
      decision: 'not_noise',
      rationale: 'The alert maps to confirmed customer errors.',
      replacement: null,
    }),
  });
  expect(noise.status).toBe(201);

  const workspace = await __fixture.api.request(`/incidents/${incident.id}/workspace`, auth);
  expect(workspace.status).toBe(200);
  const workspaceBody = (await workspace.json()) as Record<string, unknown> & {
    feedback: Array<Record<string, unknown>>;
  };
  expect(workspaceBody).toMatchObject({
    incident: {
      trustedAssessmentRunId: runId,
      correlationMaxAgeAt: episodeExpiresAt.toISOString(),
    },
    attention: {
      decision: expect.stringContaining('high-severity'),
      owner: 'checkout-on-call',
      nextAutomation: null,
    },
    automation: {
      currentBudget: {
        windowHours: 24,
        tenant: { runLimit: 100, configuredCostLimitUsd: 25 },
      },
      episodeExpiresAt: episodeExpiresAt.toISOString(),
    },
    feedbackEligibleFindingRunIds: [runId],
  });
  expect(workspaceBody.feedback).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        targetType: 'noise',
        targetId: signalId,
        decision: 'not_noise',
      }),
      expect.objectContaining({
        targetType: 'finding',
        targetId: runId,
        decision: 'correct',
      }),
    ]),
  );
  const queue = await __fixture.api.request('/incidents?state=open', auth);
  expect(queue.status).toBe(200);
  const queueBody = (await queue.json()) as {
    incidents: Array<Record<string, unknown>>;
  };
  expect(queueBody.incidents.find((item) => item.id === incident.id)).toMatchObject({
    attentionDecision: expect.stringContaining('high-severity'),
    responsibleOwner: 'checkout-on-call',
    nextAutomation: null,
    correlationMaxAgeAt: episodeExpiresAt.toISOString(),
  });
  await __fixture.admin.db
    .update(incidents)
    .set({ trustedAssessmentRunId: null })
    .where(eq(incidents.id, incident.id));
  await __fixture.admin.db.delete(investigationRuns).where(eq(investigationRuns.id, runId));
});

test('rejects invalid and unknown feedback targets', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `feedback-validation-${randomUUID()}`,
    alertSource: 'manual',
    service: 'checkout',
    severity: 'sev3',
  });
  const token = await __fixture.sign(__fixture.orgC);
  const invalid = await __fixture.api.request(`/incidents/${incident.id}/feedback`, {
    ...__fixture.auth(token),
    method: 'POST',
    headers: {
      ...__fixture.auth(token).headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      targetType: 'finding',
      targetId: randomUUID(),
      decision: 'correct',
      rationale: 'Missing replacement.',
    }),
  });
  expect(invalid.status).toBe(400);

  const silentRunId = randomUUID();
  await __fixture.admin.db.insert(investigationRuns).values({
    id: silentRunId,
    tenantId: __fixture.tenantC,
    incidentId: incident.id,
    operation: 'resume',
    outcome: 'conclusive',
    result: { disposition: 'stay_silent', summary: 'No responder-facing conclusion.' },
    completedAt: new Date(),
  });
  await __fixture.admin.db
    .update(incidents)
    .set({
      trustedAssessmentRunId: silentRunId,
      rcaSummary: 'Legacy assessment without structured finding provenance.',
      investigationStatus: 'assessed',
    })
    .where(eq(incidents.id, incident.id));
  const silent = await __fixture.api.request(`/incidents/${incident.id}/feedback`, {
    ...__fixture.auth(token),
    method: 'POST',
    headers: {
      ...__fixture.auth(token).headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      targetType: 'finding',
      targetId: silentRunId,
      decision: 'confirm',
      rationale: 'A run without a finding cannot be confirmed.',
      replacement: null,
    }),
  });
  expect(silent.status).toBe(404);
  const legacyWorkspace = await __fixture.api.request(
    `/incidents/${incident.id}/workspace`,
    __fixture.auth(token),
  );
  expect(legacyWorkspace.status).toBe(200);
  await expect(legacyWorkspace.json()).resolves.toMatchObject({
    incident: { trustedAssessmentRunId: silentRunId },
    feedbackEligibleFindingRunIds: [],
  });

  const missing = await __fixture.api.request(`/incidents/${incident.id}/feedback`, {
    ...__fixture.auth(token),
    method: 'POST',
    headers: {
      ...__fixture.auth(token).headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      targetType: 'noise',
      targetId: randomUUID(),
      decision: 'noise',
      rationale: 'No matching signal exists.',
      replacement: null,
    }),
  });
  expect(missing.status).toBe(404);
  expect(
    await __fixture.admin.db
      .select({ id: incidentFeedback.id })
      .from(incidentFeedback)
      .where(eq(incidentFeedback.incidentId, incident.id)),
  ).toEqual([]);
});

test('rejects an oversized feedback payload before parsing it', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `feedback-size-${randomUUID()}`,
    alertSource: 'manual',
    service: 'checkout',
    severity: 'sev3',
  });
  const token = await __fixture.sign(__fixture.orgC);
  const response = await __fixture.api.request(`/incidents/${incident.id}/feedback`, {
    ...__fixture.auth(token),
    method: 'POST',
    headers: {
      ...__fixture.auth(token).headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      targetType: 'finding',
      targetId: randomUUID(),
      decision: 'correct',
      rationale: 'Evidence contradicts the finding.',
      replacement: 'x'.repeat(9 * 1024),
    }),
  });
  expect(response.status).toBe(413);
});

test('projects a mapped entity owner into the incident queue', async () => {
  const serviceName = `mapped-owner-${randomUUID()}`;
  const candidateKey = `kubernetes:workload:${randomUUID()}`;
  await __fixture.admin.db.insert(services).values({
    tenantId: __fixture.tenantC,
    name: serviceName,
    team: 'runtime-on-call',
  });
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `mapped-owner-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'unclassified',
    severity: 'sev2',
  });
  await upsertEntityServiceMapping(__fixture.app.db, __fixture.tenantC, {
    candidateKey,
    candidateKind: 'workload',
    serviceName,
    confirmedByUserId: __fixture.tenantCUserId,
    rationale: 'The workload belongs to the runtime team.',
  });
  const observedAt = new Date();
  await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C-OWNER',
    externalMessageId: randomUUID(),
    state: 'firing',
    summary: 'Mapped workload is unhealthy.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: observedAt,
    affectedEntities: [
      {
        key: candidateKey,
        kind: 'workload',
        stableId: 'runtime-controller',
        displayName: 'runtime-controller',
        scope: { namespace: 'runtime' },
        provenance: { kind: 'provider_label', source: 'pod' },
        confidence: 90,
        observedAt: observedAt.toISOString(),
        completeness: 'complete',
        requiredCapabilities: ['runtime'],
      },
    ],
  });
  const availableAt = new Date(Date.now() + 5 * 60_000);
  await __fixture.admin.db.insert(jobs).values({
    tenantId: __fixture.tenantC,
    type: 'signal.reassess',
    payload: { incidentId: incident.id },
    status: 'queued',
    stream: 'sre:jobs',
    availableAt,
  });
  const token = await __fixture.sign(__fixture.orgC);
  const response = await __fixture.api.request('/incidents?state=open', __fixture.auth(token));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { incidents: Array<Record<string, unknown>> };
  expect(body.incidents.find((item) => item.id === incident.id)).toMatchObject({
    responsibleOwner: 'runtime-on-call',
    nextAutomation: {
      description: 'Reassess changed provider signals',
      scheduledAt: availableAt.toISOString(),
    },
  });
  const workspace = await __fixture.api.request(
    `/incidents/${incident.id}/workspace`,
    __fixture.auth(token),
  );
  await expect(workspace.json()).resolves.toMatchObject({
    attention: {
      owner: 'runtime-on-call',
      nextAutomation: {
        description: 'Reassess changed provider signals',
        scheduledAt: availableAt.toISOString(),
      },
    },
  });
});

test('uses the latest blocked run action instead of a stale trusted next step', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `blocked-handoff-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev3',
  });
  const trustedRunId = randomUUID();
  await __fixture.admin.db.insert(investigationRuns).values({
    id: trustedRunId,
    tenantId: __fixture.tenantC,
    incidentId: incident.id,
    operation: 'investigate',
    outcome: 'conclusive',
    result: { summary: 'A rollout caused the errors.', nextStep: 'Roll back the deployment.' },
    completedAt: new Date(Date.now() - 60_000),
  });
  await __fixture.admin.db
    .update(incidents)
    .set({
      trustedAssessmentRunId: trustedRunId,
      rcaSummary: 'A rollout caused the errors.',
      nextStep: 'Roll back the deployment.',
      investigationStatus: 'assessed',
    })
    .where(eq(incidents.id, incident.id));
  const blockedRunId = randomUUID();
  await __fixture.admin.db.insert(investigationRuns).values({
    id: blockedRunId,
    tenantId: __fixture.tenantC,
    incidentId: incident.id,
    operation: 'reassess',
    outcome: 'blocked_missing_capability',
    result: {
      summary: 'Workload logs are unavailable.',
      nextStep: 'Grant workload log access or inspect the logs manually.',
    },
    completedAt: new Date(),
  });
  const token = await __fixture.sign(__fixture.orgC);
  const workspace = await __fixture.api.request(
    `/incidents/${incident.id}/workspace`,
    __fixture.auth(token),
  );
  expect(workspace.status).toBe(200);
  await expect(workspace.json()).resolves.toMatchObject({
    incident: {
      latestInvestigationRun: {
        id: blockedRunId,
        outcome: 'blocked_missing_capability',
        nextStep: 'Grant workload log access or inspect the logs manually.',
      },
      attentionReason: 'investigation_blocked',
    },
    attention: {
      decision: 'Grant workload log access or inspect the logs manually.',
    },
  });
});

test('rate limits append-only feedback writes per attributed responder', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `feedback-rate-${randomUUID()}`,
    alertSource: 'manual',
    service: 'checkout',
    severity: 'sev3',
  });
  await __fixture.admin.db.insert(incidentFeedback).values(
    Array.from({ length: 30 }, () => ({
      tenantId: __fixture.tenantC,
      incidentId: incident.id,
      targetType: 'noise' as const,
      targetId: randomUUID(),
      decision: 'noise' as const,
      rationale: 'Rate-limit fixture.',
      createdByUserId: __fixture.tenantCUserId,
    })),
  );
  const token = await __fixture.sign(__fixture.orgC);
  const auth = __fixture.auth(token);
  const response = await __fixture.api.request(`/incidents/${incident.id}/feedback`, {
    ...auth,
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      targetType: 'noise',
      targetId: randomUUID(),
      decision: 'noise',
      rationale: 'This write should be throttled.',
      replacement: null,
    }),
  });
  expect(response.status).toBe(429);

  const candidateKey = `kubernetes:workload:${randomUUID()}`;
  const serviceName = `rate-limited-mapping-${randomUUID()}`;
  await __fixture.admin.db.insert(services).values({
    tenantId: __fixture.tenantC,
    name: serviceName,
    team: 'runtime-on-call',
  });
  const observedAt = new Date();
  await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C-RATE-LIMIT',
    externalMessageId: randomUUID(),
    state: 'firing',
    summary: 'Rate-limited workload is unhealthy.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: observedAt,
    affectedEntities: [
      {
        key: candidateKey,
        kind: 'workload',
        stableId: 'runtime-controller',
        displayName: 'runtime-controller',
        scope: { namespace: 'runtime' },
        provenance: { kind: 'provider_label', source: 'pod' },
        confidence: 90,
        observedAt: observedAt.toISOString(),
        completeness: 'complete',
        requiredCapabilities: ['runtime'],
      },
    ],
  });
  const mapping = await __fixture.api.request(`/incidents/${incident.id}/entity-mapping`, {
    ...auth,
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      candidateKey,
      serviceName,
      rationale: 'This correction should be throttled before changing the mapping.',
    }),
  });
  expect(mapping.status).toBe(429);
  expect(
    await __fixture.admin.db
      .select({ id: entityServiceMappings.id })
      .from(entityServiceMappings)
      .where(eq(entityServiceMappings.candidateKey, candidateKey)),
  ).toEqual([]);
  expect(
    await __fixture.admin.db
      .select({ id: incidentFeedback.id })
      .from(incidentFeedback)
      .where(eq(incidentFeedback.incidentId, incident.id)),
  ).toHaveLength(30);
});
