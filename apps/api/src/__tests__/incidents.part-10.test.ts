import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  applySignalObservation,
  createIncident,
  EMBED_DIM,
  entityServiceMappings,
  incidents,
  knowledgeChunks,
  serviceDependencies,
  serviceRepositories,
  services,
  upsertEntityServiceMapping,
} from '@sre/db';
import { entityCandidateKey } from '@sre/contracts';
import { eq } from 'drizzle-orm';
import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('incident entity mapping', () => {
  test('hydrates legacy signal entities on an unchanged provider repeat without another investigation', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `legacy-entity-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'unclassified',
      severity: 'sev3',
    });
    const externalMessageId = randomUUID();
    const firstAt = new Date('2026-08-31T01:00:00.000Z');
    const base = {
      incidentId: incident.id,
      provider: 'alertmanager',
      providerFingerprint: '0123456789abcdef',
      materialHash: 'unchanged-material',
      surface: 'slack',
      channel: 'C-operations',
      externalMessageId,
      state: 'firing' as const,
      summary: 'Worker is restarting.',
      contentHash: 'unchanged-content',
      eventKey: 'first-event',
      eventAt: firstAt,
    };
    const first = await applySignalObservation(__fixture.app.db, __fixture.tenantC, base);
    const key = entityCandidateKey('workload', 'worker-7d9f', { namespace: 'jobs' });
    const repeated = await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      ...base,
      eventKey: 'repeated-event',
      eventAt: new Date(firstAt.getTime() + 60_000),
      signalSource: {
        kind: 'monitor',
        provider: 'alertmanager',
        dataSourceId: null,
        externalId: 'worker-restarts',
        displayName: 'Worker restart monitor',
        observedAt: new Date(firstAt.getTime() + 60_000).toISOString(),
      },
      affectedEntities: [
        {
          key,
          kind: 'workload',
          stableId: 'worker-7d9f',
          displayName: 'worker-7d9f',
          scope: { namespace: 'jobs' },
          provenance: { kind: 'provider_label', source: 'pod' },
          confidence: 90,
          observedAt: new Date(firstAt.getTime() + 60_000).toISOString(),
          completeness: 'complete',
          requiredCapabilities: ['runtime', 'logs'],
        },
      ],
    });

    expect(repeated.applied).toBe(false);
    expect(repeated.signal.id).toBe(first.signal.id);
    expect(repeated.signal.version).toBe(1);
    expect(repeated.signal.signalSource).toMatchObject({ displayName: 'Worker restart monitor' });
    expect(repeated.signal.affectedEntities).toEqual([
      expect.objectContaining({ key, stableId: 'worker-7d9f' }),
    ]);

    const latestAt = new Date(firstAt.getTime() + 120_000);
    const latest = await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      ...base,
      eventKey: 'latest-repeat',
      eventAt: latestAt,
      signalSource: {
        ...repeated.signal.signalSource!,
        observedAt: latestAt.toISOString(),
      },
      affectedEntities: [
        {
          ...repeated.signal.affectedEntities![0]!,
          confidence: 95,
          observedAt: latestAt.toISOString(),
        },
      ],
    });
    expect(latest.applied).toBe(false);
    expect(latest.signal.version).toBe(1);
    expect(latest.signal.signalSource?.observedAt).toBe(latestAt.toISOString());
    expect(latest.signal.affectedEntities).toEqual([
      expect.objectContaining({ key, confidence: 95, observedAt: latestAt.toISOString() }),
    ]);

    const staleAt = new Date(firstAt.getTime() + 90_000);
    const stale = await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      ...base,
      eventKey: 'out-of-order-repeat',
      eventAt: staleAt,
      signalSource: {
        ...repeated.signal.signalSource!,
        observedAt: staleAt.toISOString(),
      },
      affectedEntities: [
        {
          ...repeated.signal.affectedEntities![0]!,
          confidence: 80,
          observedAt: staleAt.toISOString(),
        },
      ],
    });
    expect(stale.applied).toBe(false);
    expect(stale.signal.version).toBe(1);
    expect(stale.signal.signalSource?.observedAt).toBe(latestAt.toISOString());
    expect(stale.signal.affectedEntities).toEqual([
      expect.objectContaining({ key, confidence: 95, observedAt: latestAt.toISOString() }),
    ]);
  });

  test('persists a responder correction and resolves catalog ownership in the workspace', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `entity-context-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'unclassified',
      severity: 'sev2',
    });
    const candidateKey = entityCandidateKey('workload', 'controller-7d9f', {
      namespace: 'delivery-system',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-operations',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Controller is restarting.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
      signalSource: {
        kind: 'monitor',
        provider: 'alertmanager',
        dataSourceId: null,
        externalId: 'controller-restarts',
        displayName: 'Controller restart monitor',
        observedAt: new Date().toISOString(),
      },
      affectedEntities: [
        {
          key: candidateKey,
          kind: 'workload',
          stableId: 'controller-7d9f',
          displayName: 'controller-7d9f',
          scope: { namespace: 'delivery-system' },
          provenance: { kind: 'provider_label', source: 'pod' },
          confidence: 90,
          observedAt: new Date().toISOString(),
          completeness: 'complete',
          requiredCapabilities: ['runtime', 'metrics', 'logs'],
        },
      ],
    });
    await __fixture.admin.db.insert(services).values({
      tenantId: __fixture.tenantC,
      name: 'delivery-frontend',
      team: 'experience',
      criticality: 'tier2',
    });
    await __fixture.admin.db.insert(serviceDependencies).values({
      tenantId: __fixture.tenantC,
      upstream: 'delivery-frontend',
      downstream: 'argocd',
      protocol: 'https',
    });
    await __fixture.admin.db.insert(serviceRepositories).values({
      tenantId: __fixture.tenantC,
      service: 'argocd',
      provider: 'gitlab',
      repositoryFullName: 'delivery/argocd',
      path: 'services/argocd',
      source: 'catalog',
      confirmed: true,
    });
    const priorArgocdIncident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `prior-argocd-${randomUUID()}`,
      alertSource: 'argocd',
      service: 'argocd',
      severity: 'sev3',
    });
    await __fixture.admin.db.insert(knowledgeChunks).values({
      tenantId: __fixture.tenantC,
      source: 'runbook://argocd-restarts',
      title: 'Recover Argo CD restarts',
      content: 'Inspect controller pressure and restart history.',
      category: 'runbook',
      sourceIncidentIds: [priorArgocdIncident.id],
      verified: true,
      embedding: [1, ...Array.from({ length: EMBED_DIM - 1 }, () => 0)],
    });
    const token = await __fixture.sign(__fixture.orgC);
    const response = await __fixture.api.request(`/incidents/${incident.id}/entity-mapping`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        candidateKey,
        serviceName: 'delivery-frontend',
        rationale: 'Initial responder mapping before checking the control-plane catalog.',
      }),
    });
    expect(response.status).toBe(200);

    const correction = await __fixture.api.request(`/incidents/${incident.id}/entity-mapping`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        candidateKey,
        serviceName: 'argocd',
        rationale: 'Confirmed again after checking the catalog ownership record.',
      }),
    });
    expect(correction.status).toBe(200);

    const workspace = await __fixture.api.request(
      `/incidents/${incident.id}/workspace`,
      __fixture.auth(token),
    );
    expect(workspace.status).toBe(200);
    const body = (await workspace.json()) as {
      incident: { service: string };
      feedback: Array<{
        targetType: string;
        targetId: string;
        decision: string;
        rationale: string;
      }>;
      entityContext: {
        mappings: Array<Record<string, unknown>>;
        services: Array<{
          name: string;
          team: string | null;
          criticality: string | null;
          dependencies: unknown[];
          repositories: unknown[];
          deployments: unknown[];
          runbooks: unknown[];
        }>;
      };
      codeContext: { resolvedServices: string[] };
    };
    expect(body.feedback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetType: 'entity',
          targetId: candidateKey,
          decision: 'correct',
          rationale: 'Confirmed again after checking the catalog ownership record.',
        }),
      ]),
    );
    expect(body.incident.service).toBe('unclassified');
    expect(body.entityContext.mappings).toEqual([
      expect.objectContaining({
        candidateKey,
        serviceName: 'argocd',
        method: 'human',
        confirmedByUserId: __fixture.tenantCUserId,
      }),
    ]);
    expect(body.entityContext.services).toEqual([
      expect.objectContaining({
        name: 'argocd',
        team: 'platform',
        criticality: 'tier1',
        dependencies: [
          expect.objectContaining({
            direction: 'upstream',
            service: 'delivery-frontend',
            protocol: 'https',
          }),
        ],
        repositories: [
          expect.objectContaining({ provider: 'gitlab', fullName: 'delivery/argocd' }),
        ],
        deployments: [expect.objectContaining({ repository: 'argocd/platform' })],
        runbooks: [expect.objectContaining({ title: 'Recover Argo CD restarts' })],
      }),
    ]);
    expect(body.codeContext.resolvedServices).toEqual(['argocd']);
    const mappingRows = await __fixture.admin.db
      .select()
      .from(entityServiceMappings)
      .where(eq(entityServiceMappings.candidateKey, candidateKey));
    expect(mappingRows).toHaveLength(1);
    const [mapping] = mappingRows;
    expect(mapping?.serviceName).toBe('argocd');
    expect(mapping?.rationale).toContain('Confirmed again');
    const [updated] = await __fixture.admin.db
      .select({ service: incidents.service })
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    expect(updated?.service).toBe('unclassified');
  });

  test('reuses a tenant mapping for a later incident without another correction', async () => {
    const candidateKey = entityCandidateKey('workload', 'controller-7d9f', {
      namespace: 'delivery-system',
    });
    const prior = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `entity-reuse-prior-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'unclassified',
      severity: 'sev3',
    });
    const priorObservedAt = new Date('2026-08-30T00:00:00.000Z');
    await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      incidentId: prior.id,
      surface: 'slack',
      channel: 'C-operations',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Controller previously restarted.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: priorObservedAt,
      affectedEntities: [
        {
          key: candidateKey,
          kind: 'workload',
          stableId: 'controller-7d9f',
          displayName: 'controller-7d9f',
          scope: { namespace: 'delivery-system' },
          provenance: { kind: 'provider_label', source: 'pod' },
          confidence: 90,
          observedAt: priorObservedAt.toISOString(),
          completeness: 'complete',
          requiredCapabilities: ['runtime', 'logs'],
        },
      ],
    });
    await __fixture.admin.db.insert(knowledgeChunks).values({
      tenantId: __fixture.tenantC,
      source: 'runbook://mapped-controller-restarts',
      title: 'Recover mapped controller restarts',
      content: 'Inspect the mapped controller runtime and deployment history.',
      category: 'runbook',
      sourceIncidentIds: [prior.id],
      verified: true,
      embedding: [1, ...Array.from({ length: EMBED_DIM - 1 }, () => 0)],
    });
    const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `entity-reuse-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'unclassified',
      severity: 'sev3',
    });
    await upsertEntityServiceMapping(__fixture.app.db, __fixture.tenantC, {
      candidateKey,
      candidateKind: 'workload',
      serviceName: 'argocd',
      confirmedByUserId: __fixture.tenantCUserId,
      rationale: 'Previously confirmed catalog ownership.',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-operations',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Controller restarted again.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
      affectedEntities: [
        {
          key: candidateKey,
          kind: 'workload',
          stableId: 'controller-7d9f',
          displayName: 'controller-7d9f',
          scope: { namespace: 'delivery-system' },
          provenance: { kind: 'provider_label', source: 'pod' },
          confidence: 90,
          observedAt: new Date().toISOString(),
          completeness: 'complete',
          requiredCapabilities: ['runtime', 'logs'],
        },
      ],
    });
    const token = await __fixture.sign(__fixture.orgC);
    const workspace = await __fixture.api.request(
      `/incidents/${incident.id}/workspace`,
      __fixture.auth(token),
    );
    const body = (await workspace.json()) as {
      entityContext: {
        mappings: Array<Record<string, unknown>>;
        services: Array<{ name: string; runbooks: Array<{ title: string }> }>;
      };
    };
    expect(body.entityContext.mappings).toEqual([
      expect.objectContaining({
        candidateKey,
        serviceName: 'argocd',
        method: 'human',
        confirmedByUserId: __fixture.tenantCUserId,
      }),
    ]);
    expect(body.entityContext.services).toEqual([
      expect.objectContaining({
        name: 'argocd',
        runbooks: expect.arrayContaining([
          expect.objectContaining({ title: 'Recover mapped controller restarts' }),
        ]),
      }),
    ]);
  });

  test('resolves code context for every mapped service instead of an arbitrary first mapping', async () => {
    const argocdKey = entityCandidateKey('workload', 'argocd-controller', {
      namespace: 'argocd',
    });
    const homelabKey = entityCandidateKey('workload', 'homelab-api', {
      namespace: 'homelab',
    });
    const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `multi-entity-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'unclassified',
      severity: 'sev2',
    });
    await __fixture.admin.db
      .insert(services)
      .values({ tenantId: __fixture.tenantC, name: 'homelab', team: 'platform' })
      .onConflictDoNothing();
    await __fixture.admin.db.insert(serviceRepositories).values({
      tenantId: __fixture.tenantC,
      service: 'argocd',
      provider: 'github',
      repositoryFullName: 'acme/homelab-service',
      path: '',
      source: 'catalog',
      confirmed: false,
    });
    const observedAt = new Date();
    await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-operations',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Two workloads are unhealthy.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: observedAt,
      affectedEntities: [
        {
          key: argocdKey,
          kind: 'workload',
          stableId: 'argocd-controller',
          displayName: 'argocd-controller',
          scope: { namespace: 'argocd' },
          provenance: { kind: 'provider_label', source: 'pod' },
          confidence: 90,
          observedAt: observedAt.toISOString(),
          completeness: 'complete',
          requiredCapabilities: ['runtime'],
        },
        {
          key: homelabKey,
          kind: 'workload',
          stableId: 'homelab-api',
          displayName: 'homelab-api',
          scope: { namespace: 'homelab' },
          provenance: { kind: 'provider_label', source: 'pod' },
          confidence: 90,
          observedAt: observedAt.toISOString(),
          completeness: 'complete',
          requiredCapabilities: ['source_code'],
        },
      ],
    });
    for (const [candidateKey, serviceName] of [
      [argocdKey, 'argocd'],
      [homelabKey, 'homelab'],
    ] as const)
      await upsertEntityServiceMapping(__fixture.app.db, __fixture.tenantC, {
        candidateKey,
        candidateKind: 'workload',
        serviceName,
        confirmedByUserId: __fixture.tenantCUserId,
        rationale: `Confirmed ${serviceName} ownership.`,
      });

    const token = await __fixture.sign(__fixture.orgC);
    const response = await __fixture.api.request(
      `/incidents/${incident.id}/workspace`,
      __fixture.auth(token),
    );
    const body = (await response.json()) as {
      codeContext: {
        resolvedServices: string[];
        repositories: Array<{ serviceName: string; fullName: string }>;
      };
    };
    expect(body.codeContext.resolvedServices).toEqual(['argocd', 'homelab']);
    expect(body.codeContext.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: 'homelab',
          fullName: 'acme/homelab-service',
          path: 'services/homelab',
        }),
        expect.objectContaining({
          serviceName: 'argocd',
          fullName: 'acme/homelab-service',
          path: '',
        }),
      ]),
    );
    const confirmation = await __fixture.api.request(
      `/incidents/${incident.id}/code-context/confirm`,
      {
        method: 'POST',
        ...__fixture.auth(token),
        body: JSON.stringify({
          provider: 'github',
          dataSourceId: __fixture.codeSourceId,
          repositoryId: '202',
          serviceName: 'argocd',
          path: '',
        }),
      },
    );
    expect(confirmation.status).toBe(200);
    const relationships = await __fixture.admin.db
      .select({
        service: serviceRepositories.service,
        path: serviceRepositories.path,
        confirmed: serviceRepositories.confirmed,
      })
      .from(serviceRepositories)
      .where(eq(serviceRepositories.repositoryFullName, 'acme/homelab-service'));
    expect(relationships).toEqual(
      expect.arrayContaining([
        { service: 'argocd', path: '', confirmed: true },
        { service: 'homelab', path: 'services/homelab', confirmed: false },
      ]),
    );
  });
});
