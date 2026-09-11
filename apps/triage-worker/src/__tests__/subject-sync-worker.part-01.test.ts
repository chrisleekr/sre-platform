import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  connectorConfigs,
  incidentMessages,
  incidentSignals,
  investigationSubjects,
  jobs,
  services,
} from '@sre/db';

import {
  normalizeConnectorVerificationObservation,
  normalizeInfrastructureObservation,
  normalizeTopologyServiceObservation,
  type NormalizedSnapshot,
} from '@sre/connectors';

import { openIncidentWorkspace } from '@sre/alerts';

import { makeSubjectSyncResolver } from '../subject-sync';

import { createFixture } from './subject-sync-worker.fixture';

const __fixture = createFixture();

describe('subject.sync worker', () => {
  test('resolves infrastructure from its exact Kubernetes or Argo CD source generation', async () => {
    const [failingSource, healthySource, argoSource] = await __fixture.admin.db
      .insert(connectorConfigs)
      .values([
        {
          tenantId: __fixture.tenantId,
          type: 'kubernetes',
          name: `Failing Kubernetes ${randomUUID()}`,
          settings: {},
          enabled: true,
        },
        {
          tenantId: __fixture.tenantId,
          type: 'kubernetes',
          name: `Healthy Kubernetes ${randomUUID()}`,
          settings: {},
          enabled: true,
        },
        {
          tenantId: __fixture.tenantId,
          type: 'argocd',
          name: `Argo CD ${randomUUID()}`,
          settings: {},
          enabled: true,
        },
      ])
      .returning();
    const entityId = `shared/resource-${randomUUID()}`;
    const snapshot = (source: 'kubernetes' | 'argocd', firing: boolean): NormalizedSnapshot => ({
      tenantId: __fixture.tenantId,
      source,
      entityId,
      metrics: { ready: 1, restartCount: firing ? 1 : 0, oomKilled: firing ? 1 : 0 },
      metadata: { kind: 'pod', namespace: 'shared', phase: 'Running' },
      observedAt: new Date(),
    });
    const bySource = new Map([
      [failingSource!.id, snapshot('kubernetes', true)],
      [healthySource!.id, snapshot('kubernetes', false)],
      [argoSource!.id, snapshot('argocd', true)],
    ]);
    const calls: string[] = [];
    const resolver = makeSubjectSyncResolver({
      db: __fixture.app.db,
      cache: {
        get: async (_tenant, _type, generation) => {
          if (!generation) return [];
          calls.push(generation.id);
          const value = bySource.get(generation.id);
          return value ? [value] : [];
        },
        set: async () => undefined,
      },
    });
    const initial = normalizeInfrastructureObservation(
      bySource.get(failingSource!.id)!,
      new Date(),
    );
    const openedIncident = await openIncidentWorkspace(
      { appDb: __fixture.app.db, queue: __fixture.queue },
      {
        tenantId: __fixture.tenantId,
        source: 'platform',
        service: 'shared',
        severity: 'sev3',
        subject: {
          kind: 'infrastructure_resource',
          sourceId: failingSource!.id,
          subjectId: entityId,
          sourcePath: '/infrastructure',
          ...initial,
        },
      },
    );
    const [subject] = await __fixture.admin.db
      .select()
      .from(investigationSubjects)
      .where(sql`incident_id = ${openedIncident.incidentId}`);

    expect((await resolver(__fixture.tenantId, subject!)).state).toBe('firing');
    expect(
      await resolver(__fixture.tenantId, { ...subject!, sourceId: healthySource!.id }),
    ).toMatchObject({
      state: 'resolved',
    });
    expect(
      await resolver(__fixture.tenantId, { ...subject!, sourceId: argoSource!.id }),
    ).toMatchObject({
      state: 'firing',
    });
    expect(calls).toEqual([failingSource!.id, healthySource!.id, argoSource!.id]);
  });

  test('keeps a canonically unchanged infrastructure snapshot quiet and reassesses a material change', async () => {
    const [config] = await __fixture.admin.db
      .insert(connectorConfigs)
      .values({
        tenantId: __fixture.tenantId,
        type: 'kubernetes',
        name: `Subject sync Kubernetes ${randomUUID()}`,
        settings: {},
        enabled: true,
      })
      .returning();
    const entityId = `monitoring/prometheus-${randomUUID()}`;
    let current: NormalizedSnapshot = {
      tenantId: __fixture.tenantId,
      source: 'kubernetes',
      entityId,
      metrics: { ready: 1, restartCount: 1, oomKilled: 1 },
      metadata: {
        kind: 'pod',
        namespace: 'monitoring',
        phase: 'Running',
        pressures: [],
        containers: [
          {
            name: 'prometheus',
            ready: true,
            restartCount: 1,
            terminatedReason: 'OOMKilled',
          },
        ],
      },
      observedAt: new Date(),
    };
    const initial = normalizeInfrastructureObservation(current, new Date());
    const incident = await openIncidentWorkspace(
      { appDb: __fixture.app.db, queue: __fixture.queue },
      {
        tenantId: __fixture.tenantId,
        source: 'platform',
        service: 'monitoring',
        severity: 'sev3',
        title: `${entityId} needs attention`,
        subject: {
          kind: 'infrastructure_resource',
          sourceId: config!.id,
          subjectId: entityId,
          sourcePath: '/infrastructure',
          syncEnabled: true,
          state: initial.state,
          summary: initial.summary,
          snapshot: initial.snapshot,
          contentHash: initial.contentHash,
          observedAt: initial.observedAt,
        },
      },
    );
    const resolver = makeSubjectSyncResolver({
      db: __fixture.app.db,
      cache: {
        get: async () => [current],
        set: async () => undefined,
      },
    });
    const signalBefore = await __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(sql`incident_id = ${incident.incidentId}`);

    current = { ...current, observedAt: new Date() };
    await __fixture.worker(resolver).handle(__fixture.job(incident.incidentId), {
      signal: new AbortController().signal,
    });

    const [signalAfterNoop, reassessmentAfterNoop] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'signal.reassess' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    expect(signalAfterNoop).toHaveLength(1);
    expect(signalAfterNoop[0]!.version).toBe(signalBefore[0]!.version);
    expect(reassessmentAfterNoop).toHaveLength(0);

    current = {
      ...current,
      metrics: { ...current.metrics, restartCount: 2 },
      metadata: {
        ...current.metadata,
        error: 'Probe failed with Bearer abc.def.ghi123XYZ',
      },
      observedAt: new Date(),
    };
    await __fixture.worker(resolver).handle(__fixture.job(incident.incidentId), {
      signal: new AbortController().signal,
    });

    const [signalAfterChange, reassessmentAfterChange] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'signal.reassess' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    expect(signalAfterChange).toHaveLength(1);
    expect(signalAfterChange[0]!.version).toBe(signalBefore[0]!.version + 1);
    expect(reassessmentAfterChange).toHaveLength(1);
    const [storedSubject, storedMessages] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(investigationSubjects)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(incidentMessages)
        .where(sql`incident_id = ${incident.incidentId}`),
    ]);
    expect(JSON.stringify([storedSubject, signalAfterChange, storedMessages])).not.toContain(
      'abc.def.ghi123XYZ',
    );
  });

  test('keeps connector verification unchanged without model work and schedules recovery on success', async () => {
    const attemptedAt = new Date();
    const [config] = await __fixture.admin.db
      .insert(connectorConfigs)
      .values({
        tenantId: __fixture.tenantId,
        type: 'github',
        name: `GitHub ${randomUUID()}`,
        settings: {},
        enabled: false,
        verificationAttemptedAt: attemptedAt,
        verificationFailureCategory: 'permission_denied',
      })
      .returning();
    const initial = normalizeConnectorVerificationObservation(
      {
        connectorType: config!.type,
        connectorName: config!.name,
        enabled: config!.enabled,
        failureCategory: config!.verificationFailureCategory,
        attemptedAt,
        succeededAt: null,
      },
      new Date(),
    );
    const incident = await openIncidentWorkspace(
      { appDb: __fixture.app.db, queue: __fixture.queue },
      {
        tenantId: __fixture.tenantId,
        source: 'platform',
        service: config!.name,
        severity: 'sev3',
        subject: {
          kind: 'connector_verification',
          sourceId: config!.id,
          subjectId: config!.id,
          sourcePath: '/connectors',
          ...initial,
        },
      },
    );
    const resolver = makeSubjectSyncResolver({
      db: __fixture.app.db,
      cache: { get: async () => [], set: async () => undefined },
    });

    await __fixture.worker(resolver).handle(__fixture.job(incident.incidentId), {
      signal: new AbortController().signal,
    });
    expect(
      await __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type in ('signal.reassess','recovery.verify') and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ).toHaveLength(0);

    await __fixture.admin.db
      .update(connectorConfigs)
      .set({ verificationSucceededAt: new Date(attemptedAt.getTime() + 1_000) })
      .where(sql`id = ${config!.id}`);
    await __fixture.worker(resolver).handle(__fixture.job(incident.incidentId), {
      signal: new AbortController().signal,
    });
    expect(
      await __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'recovery.verify' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ).toHaveLength(1);
  });

  test('keeps topology material stable and schedules recovery when its runtime becomes healthy', async () => {
    const serviceName = `service-${randomUUID()}`;
    await __fixture.admin.db.insert(services).values({
      tenantId: __fixture.tenantId,
      name: serviceName,
      team: 'platform',
      criticality: 'tier1',
    });
    const [config] = await __fixture.admin.db
      .insert(connectorConfigs)
      .values({
        tenantId: __fixture.tenantId,
        type: 'kubernetes',
        name: `Topology Kubernetes ${randomUUID()}`,
        settings: {},
        enabled: true,
      })
      .returning();
    let runtime: NormalizedSnapshot = {
      tenantId: __fixture.tenantId,
      source: 'kubernetes',
      entityId: `${serviceName}/pod-0`,
      metrics: { ready: 1, restartCount: 1, oomKilled: 1 },
      metadata: { kind: 'pod', namespace: serviceName, phase: 'Running' },
      observedAt: new Date(),
    };
    const initial = normalizeTopologyServiceObservation(
      { service: serviceName, team: 'platform', criticality: 'tier1', snapshots: [runtime] },
      new Date(),
    );
    const incident = await openIncidentWorkspace(
      { appDb: __fixture.app.db, queue: __fixture.queue },
      {
        tenantId: __fixture.tenantId,
        source: 'platform',
        service: serviceName,
        severity: 'sev2',
        subject: {
          kind: 'topology_service',
          sourceId: 'topology',
          subjectId: serviceName,
          sourcePath: '/topology',
          ...initial,
        },
      },
    );
    const resolver = makeSubjectSyncResolver({
      db: __fixture.app.db,
      cache: {
        get: async (_tenant, _type, generation) => (generation?.id === config!.id ? [runtime] : []),
        set: async () => undefined,
      },
    });

    await __fixture.worker(resolver).handle(__fixture.job(incident.incidentId), {
      signal: new AbortController().signal,
    });
    expect(
      await __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type in ('signal.reassess','recovery.verify') and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ).toHaveLength(0);
    runtime = {
      ...runtime,
      metrics: { ready: 1, restartCount: 0, oomKilled: 0 },
      observedAt: new Date(),
    };
    await __fixture.worker(resolver).handle(__fixture.job(incident.incidentId), {
      signal: new AbortController().signal,
    });
    expect(
      await __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'recovery.verify' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ).toHaveLength(1);
  });

  test('updates only the sync timestamp when the material observation is unchanged', async () => {
    const incident = await __fixture.opened();
    const [before] = await __fixture.admin.db
      .select()
      .from(investigationSubjects)
      .where(sql`incident_id = ${incident.incidentId}`);
    const messageCount = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(sql`incident_id = ${incident.incidentId}`);
    await __fixture
      .worker(async () => ({
        state: before!.currentState,
        summary: before!.currentSummary,
        snapshot: before!.currentSnapshot,
        contentHash: before!.currentHash,
        observedAt: new Date(),
      }))
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });

    const [messages, modelWork] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentMessages)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type in ('signal.reassess', 'recovery.verify') and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    expect(messages).toHaveLength(messageCount.length);
    expect(modelWork).toHaveLength(0);
  });

  test('a claimed synchronization schedules and coalesces exactly one future successor', async () => {
    const incident = await __fixture.opened();
    const [subject] = await __fixture.admin.db
      .select()
      .from(investigationSubjects)
      .where(sql`incident_id = ${incident.incidentId}`);
    const [claimed] = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(
        sql`tenant_id = ${__fixture.tenantId} and type = 'subject.sync' and payload->>'incidentId' = ${incident.incidentId}`,
      );
    await __fixture.admin.db
      .update(jobs)
      .set({ status: 'processing' })
      .where(sql`id = ${claimed!.id}`);
    const resolve = async () => ({
      state: subject!.currentState,
      summary: subject!.currentSummary,
      snapshot: subject!.currentSnapshot,
      contentHash: subject!.currentHash,
      observedAt: new Date(),
    });

    await __fixture
      .worker(resolve)
      .handle(
        { ...__fixture.job(incident.incidentId), id: claimed!.id },
        { signal: new AbortController().signal },
      );
    await __fixture
      .worker(resolve)
      .handle(
        { ...__fixture.job(incident.incidentId), id: claimed!.id },
        { signal: new AbortController().signal },
      );

    const successors = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(
        sql`tenant_id = ${__fixture.tenantId} and type = 'subject.sync' and status = 'queued' and payload->>'incidentId' = ${incident.incidentId}`,
      );
    expect(successors).toHaveLength(1);
    expect(successors[0]!.availableAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  test('writes one resolved signal event and enters existing recovery verification', async () => {
    const incident = await __fixture.opened();
    await __fixture
      .worker(async () => ({
        state: 'resolved',
        summary: 'All runtime pods are healthy',
        snapshot: { pods: 3, unhealthyPods: 0 },
        contentHash: randomUUID().replaceAll('-', ''),
        observedAt: new Date(),
      }))
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });

    const [signals, messages, recovery] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(incidentMessages)
        .where(sql`incident_id = ${incident.incidentId} and kind = 'signal'`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'recovery.verify' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.state).toBe('resolved');
    expect(messages).toHaveLength(1);
    expect(recovery).toHaveLength(1);
  });

  test('allows a platform subject to resolve and refire while invalidating recovery', async () => {
    const incident = await __fixture.opened();
    const resolvedAt = new Date(Date.now() + 1_000);
    await __fixture
      .worker(async () => ({
        state: 'resolved',
        summary: 'Runtime recovered',
        snapshot: { pods: 3, unhealthyPods: 0 },
        contentHash: `resolved-${randomUUID()}`,
        observedAt: resolvedAt,
      }))
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });
    const [recovery] = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(
        sql`tenant_id = ${__fixture.tenantId} and type = 'recovery.verify' and payload->>'incidentId' = ${incident.incidentId}`,
      );

    await __fixture
      .worker(async () => ({
        state: 'firing',
        summary: 'Runtime failure returned',
        snapshot: { pods: 3, unhealthyPods: 1 },
        contentHash: `refired-${randomUUID()}`,
        observedAt: new Date(resolvedAt.getTime() + 1_000),
      }))
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });

    const [signals, recoveryAfter, reassessment] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(sql`id = ${recovery!.id}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'signal.reassess' and status = 'queued' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      state: 'firing',
      lastEventType: 'refired',
      version: 3,
      providerFingerprint: null,
    });
    expect(recoveryAfter[0]!.status).toBe('done');
    expect(reassessment).toHaveLength(1);
  });
});
