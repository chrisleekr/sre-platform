import { and, desc, eq, sql } from 'drizzle-orm';
import { makeStatusCakeConnector } from '@sre/connectors';
import { reconcileConnectorLifecycle } from '@sre/agent-tools';
import { LockContentionError, type Job } from '@sre/queue';
import type { SignalClearProvenance } from '@sre/contracts';
import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import {
  applySignalObservation,
  connectorConfigs,
  incidentSignals,
  jobs,
  createApproval,
  createIncident,
  getIncident,
  serializeSignalFence,
} from '@sre/db';
import { makeFakeEngine } from '../engine/fake';
import { createFixture } from './worker.fixture';
const fixture = createFixture();

async function seed(
  policy: 'provider_clear' | 'verified_recovery',
  provenance?: SignalClearProvenance,
) {
  const input = {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
    resolutionPolicy: policy,
  };
  const dataSourceId = randomUUID();
  await fixture.admin.db.insert(connectorConfigs).values({
    id: dataSourceId,
    tenantId: fixture.tenantId,
    type: 'statuscake',
    name: dataSourceId,
    enabled: true,
  });
  const incident = await createIncident(fixture.app.db, fixture.tenantId, input);
  const observation = {
    incidentId: incident.id,
    dataSourceId,
    providerFingerprint: randomUUID(),
    startsAt: new Date(Date.now() - 60000),
    signalSource: {
      kind: 'monitor' as const,
      lifecycleVersion: 0,
      provider: 'statuscake',
      dataSourceId,
      externalId: '73',
      displayName: 'Checkout uptime',
      observedAt: new Date().toISOString(),
    },
    surface: 'slack',
    channel: 'C_PROVIDER',
    externalMessageId: randomUUID(),
    state: 'resolved' as const,
    summary: 'The exact monitor recovered.',
    contentHash: randomUUID(),
    eventKey: `${randomUUID()}:producer:bot:B_MONITOR`,
    eventAt: new Date(),
    monitorKey: 'checkout-availability',
    provider: 'statuscake',
    clearProvenance: provenance,
  };
  const clear = await applySignalObservation(fixture.app.db, fixture.tenantId, observation);
  const job = {
    id: randomUUID(),
    tenantId: fixture.tenantId,
    type: 'recovery.verify',
    attempts: 1,
    payload: {
      incidentId: incident.id,
      lifecycleVersion: 0,
      signalFence: serializeSignalFence([clear.signal]),
    },
  };
  return { incident, observation, job };
}
const unavailableEngine = () => {
  const verifyRecovery = vi.fn(async () => ({
    provider: 'fake' as const,
    sessionId: 'unavailable',
    outcome: 'inconclusive' as const,
    turnBudget: 1,
    summary: 'Service health cannot be independently verified.',
    confidence: 0,
    unknowns: [],
    evidenceReceipts: [],
  }));
  return { engine: { ...makeFakeEngine(), verifyRecovery }, verifyRecovery };
};

test('authoritative provider clear resolves before model admission without asserting verified health', async () => {
  const { incident, job } = await seed('provider_clear', 'provider');
  const { engine, verifyRecovery } = unavailableEngine();
  const worker = fixture.workerWithEngine(engine);
  await worker.handle(job, { signal: new AbortController().signal });
  await worker.handle(job, { signal: new AbortController().signal });
  expect(verifyRecovery).not.toHaveBeenCalled();
  const row = await getIncident(fixture.app.db, fixture.tenantId, incident.id);
  expect(row).toMatchObject({
    status: 'resolved',
    resolutionPolicy: 'provider_clear',
    resolutionBasis: 'provider_clear',
  });
  expect(row?.recoveryState).not.toBe('verified');
  expect(
    (await fixture.hub.history(fixture.tenantId, incident.id)).filter(
      (message) => message.kind === 'lifecycle',
    ),
  ).toHaveLength(1);
});

test.each(['operator', 'suppression', 'unknown', undefined] as const)(
  'provider-clear policy refuses unauthoritative %s clearance without model fallback',
  async (provenance) => {
    const { incident, job } = await seed('provider_clear', provenance);
    const { engine, verifyRecovery } = unavailableEngine();
    await fixture.workerWithEngine(engine).handle(job, { signal: new AbortController().signal });
    expect(verifyRecovery).not.toHaveBeenCalled();
    expect(await getIncident(fixture.app.db, fixture.tenantId, incident.id)).toMatchObject({
      status: 'open',
      resolutionBasis: null,
    });
  },
);

test('strict policy continues through verified recovery even when its provider signal clears', async () => {
  const { incident, job } = await seed('verified_recovery', 'provider');
  const { engine, verifyRecovery } = unavailableEngine();
  await fixture.workerWithEngine(engine).handle(job, { signal: new AbortController().signal });
  expect(verifyRecovery).toHaveBeenCalledTimes(1);
  expect(await getIncident(fixture.app.db, fixture.tenantId, incident.id)).toMatchObject({
    status: 'open',
    resolutionPolicy: 'verified_recovery',
    resolutionBasis: null,
  });
});

test('a pending approval prevents provider-only resolution', async () => {
  const { incident, job } = await seed('provider_clear', 'provider');
  await createApproval(fixture.app.db, fixture.tenantId, {
    incidentId: incident.id,
    actionId: randomUUID(),
    prompt: 'Apply the pending change?',
    options: [{ id: 'deny', label: 'Deny' }],
  });
  const { engine, verifyRecovery } = unavailableEngine();
  await fixture.workerWithEngine(engine).handle(job, { signal: new AbortController().signal });
  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(await getIncident(fixture.app.db, fixture.tenantId, incident.id)).toMatchObject({
    status: 'open',
    resolutionBasis: null,
  });
});

test('a refire invalidates an older provider-clear job and leaves no resolution basis', async () => {
  const { incident, observation, job } = await seed('provider_clear', 'provider');
  await applySignalObservation(fixture.app.db, fixture.tenantId, {
    ...observation,
    externalMessageId: `${observation.externalMessageId}:new-episode`,
    startsAt: new Date(observation.eventAt.getTime() + 1000),
    state: 'firing',
    eventKey: randomUUID(),
    eventAt: new Date(observation.eventAt.getTime() + 1000),
  });
  const { engine, verifyRecovery } = unavailableEngine();
  await fixture.workerWithEngine(engine).handle(job, { signal: new AbortController().signal });
  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(await getIncident(fixture.app.db, fixture.tenantId, incident.id)).toMatchObject({
    status: 'open',
    resolutionBasis: null,
  });
});

test('provider clearance does not consume automatic investigation admission or require an available engine', async () => {
  const { incident, job } = await seed('provider_clear', 'provider');
  const getAutomaticInvestigationBudget = vi.fn(async () => {
    throw new Error('Model admission unavailable');
  });
  const { engine, verifyRecovery } = unavailableEngine();
  await fixture
    .workerWithEngine(engine, { getAutomaticInvestigationBudget })
    .handle(job, { signal: new AbortController().signal });
  expect(getAutomaticInvestigationBudget).not.toHaveBeenCalled();
  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(await getIncident(fixture.app.db, fixture.tenantId, incident.id)).toMatchObject({
    status: 'resolved',
    resolutionBasis: 'provider_clear',
  });
});

test('a connector write holding the generation row redelivers the provider clear as lock contention', async () => {
  const { incident, observation, job } = await seed('provider_clear', 'provider');
  const { engine, verifyRecovery } = unavailableEngine();
  const worker = fixture.workerWithEngine(engine);
  // Same row lock a connector write takes, held on another connection until the body finishes.
  await fixture.admin.db.transaction(async (holder) => {
    await holder.execute(
      sql`select id from connector_configs where id = ${observation.dataSourceId} for no key update`,
    );
    await expect(
      worker.handle(job, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(LockContentionError);
  });
  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(await getIncident(fixture.app.db, fixture.tenantId, incident.id)).toMatchObject({
    status: 'open',
    resolutionBasis: null,
  });
  await worker.handle(job, { signal: new AbortController().signal });
  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(await getIncident(fixture.app.db, fixture.tenantId, incident.id)).toMatchObject({
    status: 'resolved',
    resolutionBasis: 'provider_clear',
  });
});

test('a committed provider lifecycle can be republished after a fanout failure', async () => {
  const { incident, job } = await seed('provider_clear', 'provider');
  const { engine, verifyRecovery } = unavailableEngine();
  const publish = vi
    .spyOn(fixture.redis, 'publish')
    .mockRejectedValueOnce(new Error('Temporary fanout failure'));
  const worker = fixture.workerWithEngine(engine);
  await expect(
    worker.handle(job, { signal: new AbortController().signal }),
  ).resolves.toBeUndefined();
  await worker.handle(job, { signal: new AbortController().signal });
  expect(publish).toHaveBeenCalledTimes(2);
  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(
    (await fixture.hub.history(fixture.tenantId, incident.id)).filter(
      (message) => message.kind === 'lifecycle',
    ),
  ).toHaveLength(1);
  publish.mockRestore();
});

test('rotating a connector fences an already queued clear until fresh exact reconciliation', async () => {
  const { incident, observation, job } = await seed('provider_clear', 'provider');
  const { engine, verifyRecovery } = unavailableEngine();
  const worker = fixture.workerWithEngine(engine);
  await fixture.admin.db
    .update(connectorConfigs)
    .set({ lifecycleVersion: 1 })
    .where(eq(connectorConfigs.id, observation.dataSourceId));
  await worker.handle(job, { signal: new AbortController().signal });
  expect(await getIncident(fixture.app.db, fixture.tenantId, incident.id)).toMatchObject({
    status: 'open',
    resolutionBasis: null,
  });
  const connector = makeStatusCakeConnector(
    {
      id: observation.dataSourceId,
      tenantId: fixture.tenantId,
      type: 'statuscake',
      name: 'Uptime',
      settings: {},
      getCredential: async () => 'read-token',
    },
    (async (input) =>
      Response.json(
        new URL(String(input)).pathname.endsWith('/periods')
          ? {
              data: [
                {
                  status: 'down',
                  created_at: observation.startsAt.toISOString(),
                  ended_at: observation.eventAt.toISOString(),
                },
              ],
              links: {},
            }
          : { data: { id: '73', status: 'up', paused: false } },
      )) as typeof fetch,
  );
  Object.defineProperty(connector, 'generation', {
    value: { id: observation.dataSourceId, lifecycleVersion: 1 },
  });
  await fixture.admin.db
    .update(incidentSignals)
    .set({ labels: { monitor_id: '73', check_type: 'uptime' } })
    .where(eq(incidentSignals.incidentId, incident.id));
  const result = await reconcileConnectorLifecycle({
    db: fixture.app.db,
    tenantId: fixture.tenantId,
    connector,
    hub: fixture.hub,
    queue: fixture.queue,
  });
  expect(result.verified).toBe(1);
  const [fresh] = await fixture.admin.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, fixture.tenantId),
        eq(jobs.type, 'recovery.verify'),
        sql`${jobs.payload}->>'incidentId' = ${incident.id}`,
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  expect(fresh).toBeDefined();
  await worker.handle(fresh as Job, { signal: new AbortController().signal });
  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(await getIncident(fixture.app.db, fixture.tenantId, incident.id)).toMatchObject({
    status: 'resolved',
    resolutionBasis: 'provider_clear',
  });
});
