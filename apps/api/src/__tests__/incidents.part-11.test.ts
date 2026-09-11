import { entityCandidateKey } from '@sre/contracts';
import {
  applySignalObservation,
  createIncident,
  deployments,
  EMBED_DIM,
  entityServiceMappings,
  incidents,
  knowledgeChunks,
  resolveIncidentEntityContext,
  services,
  upsertEntityServiceMapping,
} from '@sre/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

test('bounds deployments and runbooks per service so a noisy service cannot starve another', async () => {
  const noisyService = `noisy-${randomUUID().slice(0, 8)}`;
  const quietService = `quiet-${randomUUID().slice(0, 8)}`;
  await __fixture.admin.db.insert(services).values([
    { tenantId: __fixture.tenantC, name: noisyService },
    { tenantId: __fixture.tenantC, name: quietService },
  ]);
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `bounded-context-${randomUUID()}`,
    alertSource: 'test',
    service: 'unclassified',
    severity: 'sev3',
  });
  const observedAt = new Date('2026-08-31T00:00:00.000Z');
  const noisyKey = entityCandidateKey('service', noisyService);
  const quietKey = entityCandidateKey('service', quietService);
  await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
    incidentId: incident.id,
    surface: 'dashboard',
    channel: 'manual',
    externalMessageId: randomUUID(),
    state: 'firing',
    summary: 'Two catalog services need context.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: observedAt,
    affectedEntities: [noisyService, quietService].map((serviceName, index) => ({
      key: index === 0 ? noisyKey : quietKey,
      kind: 'service' as const,
      stableId: serviceName,
      displayName: serviceName,
      scope: {},
      provenance: { kind: 'catalog' as const, source: 'test_catalog' },
      confidence: 100,
      observedAt: observedAt.toISOString(),
      completeness: 'complete' as const,
      requiredCapabilities: ['deployments' as const, 'runbooks' as const],
    })),
  });
  for (const [candidateKey, serviceName] of [
    [noisyKey, noisyService],
    [quietKey, quietService],
  ] as const)
    await upsertEntityServiceMapping(__fixture.app.db, __fixture.tenantC, {
      candidateKey,
      candidateKind: 'service',
      serviceName,
      confirmedByUserId: __fixture.tenantCUserId,
      rationale: `Confirmed ${serviceName}.`,
    });

  await __fixture.admin.db.insert(deployments).values([
    ...Array.from({ length: 31 }, (_, index) => ({
      tenantId: __fixture.tenantC,
      source: 'test',
      repo: `acme/${noisyService}`,
      sha: `noisy-${randomUUID()}`,
      service: noisyService,
      status: 'success',
      deployedAt: new Date(`2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
    })),
    {
      tenantId: __fixture.tenantC,
      source: 'test',
      repo: `acme/${quietService}`,
      sha: `quiet-${randomUUID()}`,
      service: quietService,
      status: 'success',
      deployedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ]);
  const quietPriorId = randomUUID();
  await __fixture.admin.db.insert(incidents).values([
    ...Array.from({ length: 101 }, (_, index) => ({
      id: randomUUID(),
      tenantId: __fixture.tenantC,
      fingerprint: `noisy-history-${index}-${randomUUID()}`,
      alertSource: 'test',
      service: noisyService,
      severity: 'sev3',
      createdAt: new Date(`2026-08-31T${String(index % 24).padStart(2, '0')}:00:00.000Z`),
    })),
    {
      id: quietPriorId,
      tenantId: __fixture.tenantC,
      fingerprint: `quiet-history-${randomUUID()}`,
      alertSource: 'test',
      service: quietService,
      severity: 'sev3',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ]);
  await __fixture.admin.db.insert(knowledgeChunks).values({
    tenantId: __fixture.tenantC,
    source: `runbook://${quietService}`,
    title: 'Quiet service recovery',
    content: 'Recovery steps for the quiet service.',
    category: 'runbook',
    sourceIncidentIds: [quietPriorId],
    verified: true,
    embedding: [1, ...Array.from({ length: EMBED_DIM - 1 }, () => 0)],
  });

  const context = await resolveIncidentEntityContext(
    __fixture.app.db,
    __fixture.tenantC,
    incident.id,
  );
  const quiet = context?.services.find((service) => service.name === quietService);
  expect(quiet?.deployments).toEqual([
    expect.objectContaining({ repository: `acme/${quietService}` }),
  ]);
  expect(quiet?.runbooks).toEqual([expect.objectContaining({ title: 'Quiet service recovery' })]);
});

test('gives a human service correction precedence when reusing incident runbooks', async () => {
  const originalService = `original-${randomUUID().slice(0, 8)}`;
  const correctedService = `corrected-${randomUUID().slice(0, 8)}`;
  await __fixture.admin.db.insert(services).values([
    { tenantId: __fixture.tenantC, name: originalService },
    { tenantId: __fixture.tenantC, name: correctedService },
  ]);
  const prior = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `corrected-history-${randomUUID()}`,
    alertSource: 'test',
    service: originalService,
    severity: 'sev3',
  });
  const correctedKey = entityCandidateKey('service', originalService, {
    cluster: 'production',
  });
  const observedAt = new Date('2026-08-30T00:00:00.000Z');
  await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
    incidentId: prior.id,
    surface: 'dashboard',
    channel: 'manual',
    externalMessageId: randomUUID(),
    state: 'firing',
    summary: 'Provider named the wrong catalog service.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: observedAt,
    affectedEntities: [
      {
        key: correctedKey,
        kind: 'service',
        stableId: originalService,
        displayName: originalService,
        scope: { cluster: 'production' },
        provenance: { kind: 'provider_label', source: 'service' },
        confidence: 90,
        observedAt: observedAt.toISOString(),
        completeness: 'complete',
        requiredCapabilities: ['runbooks'],
      },
    ],
  });
  await upsertEntityServiceMapping(__fixture.app.db, __fixture.tenantC, {
    candidateKey: correctedKey,
    candidateKind: 'service',
    serviceName: correctedService,
    confirmedByUserId: __fixture.tenantCUserId,
    rationale: 'The provider label is an alias for the corrected service.',
  });
  await __fixture.admin.db.insert(knowledgeChunks).values({
    tenantId: __fixture.tenantC,
    source: `runbook://${correctedService}`,
    title: 'Corrected ownership recovery',
    content: 'Recovery steps owned by the corrected service.',
    category: 'runbook',
    sourceIncidentIds: [prior.id],
    verified: true,
    embedding: [1, ...Array.from({ length: EMBED_DIM - 1 }, () => 0)],
  });

  const current = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `corrected-current-${randomUUID()}`,
    alertSource: 'test',
    service: 'unclassified',
    severity: 'sev3',
  });
  await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
    incidentId: current.id,
    surface: 'dashboard',
    channel: 'manual',
    externalMessageId: randomUUID(),
    state: 'firing',
    summary: 'Both catalog services need context.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: new Date('2026-08-31T00:00:00.000Z'),
    affectedEntities: [
      {
        key: entityCandidateKey('service', originalService, { cluster: 'staging' }),
        kind: 'service',
        stableId: originalService,
        displayName: originalService,
        scope: { cluster: 'staging' },
        provenance: { kind: 'catalog', source: 'test' },
        confidence: 100,
        observedAt: '2026-08-31T00:00:00.000Z',
        completeness: 'complete',
        requiredCapabilities: ['runbooks'],
      },
      {
        key: entityCandidateKey('service', correctedService),
        kind: 'service',
        stableId: correctedService,
        displayName: correctedService,
        scope: {},
        provenance: { kind: 'catalog', source: 'test' },
        confidence: 100,
        observedAt: '2026-08-31T00:00:00.000Z',
        completeness: 'complete',
        requiredCapabilities: ['runbooks'],
      },
    ],
  });

  const context = await resolveIncidentEntityContext(
    __fixture.app.db,
    __fixture.tenantC,
    current.id,
  );
  const original = context?.services.find((service) => service.name === originalService);
  const corrected = context?.services.find((service) => service.name === correctedService);
  expect(original?.runbooks).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Corrected ownership recovery' })]),
  );
  expect(corrected?.runbooks).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Corrected ownership recovery' })]),
  );
});

test('does not expose a foreign tenant candidate through the correction endpoint', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `foreign-entity-${randomUUID()}`,
    alertSource: 'test',
    service: 'unclassified',
    severity: 'sev3',
  });
  const token = await __fixture.sign(__fixture.orgB);
  const response = await __fixture.api.request(`/incidents/${incident.id}/entity-mapping`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      candidateKey: entityCandidateKey('service', 'argocd'),
      serviceName: 'argocd',
      rationale: 'Foreign tenant attempt.',
    }),
  });
  expect(response.status).toBe(404);
});

test('keeps the same provider entity key isolated between tenant catalogs', async () => {
  const candidateKey = entityCandidateKey('workload', 'shared-controller', {
    namespace: 'delivery-system',
  });
  await upsertEntityServiceMapping(__fixture.app.db, __fixture.tenantC, {
    candidateKey,
    candidateKind: 'workload',
    serviceName: 'argocd',
    confirmedByUserId: __fixture.tenantCUserId,
    rationale: 'Tenant C owns this provider identity.',
  });
  await __fixture.admin.db.insert(services).values({
    tenantId: __fixture.tenantB,
    name: 'argocd',
    team: 'tenant-b-platform',
  });
  const incident = await createIncident(__fixture.app.db, __fixture.tenantB, {
    fingerprint: `tenant-b-entity-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'unclassified',
    severity: 'sev3',
  });
  await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C-operations',
    externalMessageId: randomUUID(),
    state: 'firing',
    summary: 'Shared controller is restarting.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: new Date(),
    affectedEntities: [
      {
        key: candidateKey,
        kind: 'workload',
        stableId: 'shared-controller',
        displayName: 'shared-controller',
        scope: { namespace: 'delivery-system' },
        provenance: { kind: 'provider_label', source: 'pod' },
        confidence: 90,
        observedAt: new Date().toISOString(),
        completeness: 'complete',
        requiredCapabilities: ['runtime'],
      },
    ],
  });
  const token = await __fixture.sign(__fixture.orgB);
  const response = await __fixture.api.request(`/incidents/${incident.id}/entity-mapping`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      candidateKey,
      serviceName: 'argocd',
      rationale: 'Tenant B independently owns its identically named workload.',
    }),
  });
  expect(response.status).toBe(200);
  const mappings = await __fixture.admin.db
    .select({
      tenantId: entityServiceMappings.tenantId,
      serviceName: entityServiceMappings.serviceName,
    })
    .from(entityServiceMappings)
    .where(eq(entityServiceMappings.candidateKey, candidateKey));
  expect(mappings).toEqual(
    expect.arrayContaining([
      { tenantId: __fixture.tenantC, serviceName: 'argocd' },
      { tenantId: __fixture.tenantB, serviceName: 'argocd' },
    ]),
  );
  expect(mappings).toHaveLength(2);
});
