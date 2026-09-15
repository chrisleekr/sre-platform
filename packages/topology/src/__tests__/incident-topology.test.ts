import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  connectorConfigs,
  incidents,
  incidentSignals,
  incidentServiceAssignments,
  tenants,
  services,
  serviceDependencies,
  makeDb,
  persistTopologyDiscovery,
  type DbHandle,
  memberships,
  users,
  entityServiceMappings,
  upsertEntityServiceMapping,
  addDependency,
} from '@sre/db';
import { seedMembership } from '@sre/db/test-support';
import {
  entityCandidateKey,
  topologyRefKey,
  type AffectedEntityCandidate,
  type TopologyEntity,
} from '@sre/contracts';
import { computeBlastRadius } from '../blast-radius';
import { computeIncidentBlastRadius } from '../incident-impact';
import { resolveIncidentTopologyContext, readIncidentTopologySources } from '../incident-context';

const tenantId = randomUUID(),
  otherTenant = randomUUID(),
  sourceId = randomUUID(),
  runtimeSourceId = randomUUID();
let admin: DbHandle, app: DbHandle;
let userId: string;
const entity = (name: string, environment: string): TopologyEntity => ({
  ref: {
    authority: `connector:${sourceId}`,
    kind: 'service',
    id: JSON.stringify([environment, name]),
  },
  kind: 'service',
  name,
  scope: { environment },
  attributes: {},
});
const checkout = entity('checkout', 'production'),
  dev = entity('checkout', 'development'),
  payments = entity('payments', 'production');
const pod: TopologyEntity = {
  ref: { authority: 'kubernetes-cluster:runtime', kind: 'Pod', id: 'pod-uid' },
  aliases: [
    { authority: 'kubernetes-object', kind: 'Pod', id: JSON.stringify(['production', 'pod-uid']) },
  ],
  kind: 'workload',
  name: 'api-pod',
  scope: { namespace: 'production', cluster: 'kubernetes-cluster:runtime' },
  attributes: { uid: 'pod-uid' },
};
const candidate = (overrides: Partial<AffectedEntityCandidate> = {}): AffectedEntityCandidate => ({
  key: entityCandidateKey('service', 'checkout', { environment: 'production' }),
  kind: 'service',
  stableId: 'checkout',
  displayName: 'checkout',
  scope: { environment: 'production' },
  provenance: { kind: 'provider_label', source: 'datadog' },
  confidence: 1,
  observedAt: new Date().toISOString(),
  completeness: 'complete',
  requiredCapabilities: ['topology'],
  ...overrides,
});
async function incident(affected: AffectedEntityCandidate[]) {
  const id = randomUUID();
  await admin.db.insert(incidents).values({
    id,
    tenantId,
    fingerprint: id,
    alertSource: 'slack',
    service: 'slack:conversation',
    severity: 'sev3',
  });
  await admin.db.insert(incidentSignals).values({
    tenantId,
    incidentId: id,
    surface: 'slack',
    channel: 'test',
    externalMessageId: id,
    state: 'firing',
    lastEventType: 'opened',
    summary: 'Checkout errors',
    contentHash: id,
    lastEventKey: id,
    lastEventAt: new Date(),
    affectedEntities: affected,
  });
  return id;
}
beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values([
    { id: tenantId, name: 'Topology incident test' },
    { id: otherTenant, name: 'Other tenant' },
  ]);
  userId = await seedMembership(
    admin.db,
    { issuer: 'https://topology-test.example', subject: randomUUID() },
    tenantId,
  );
  await admin.db.insert(connectorConfigs).values([
    { id: sourceId, tenantId, type: 'datadog', name: 'APM' },
    { id: runtimeSourceId, tenantId, type: 'kubernetes', name: 'Runtime' },
  ]);
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: runtimeSourceId, lifecycleVersion: 0 },
    {
      observedAt: new Date().toISOString(),
      collections: [{ key: 'pods', completeness: 'complete', entities: [pod], relations: [] }],
    },
  );
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: sourceId, lifecycleVersion: 0 },
    {
      observedAt: new Date().toISOString(),
      collections: [
        {
          key: 'apm',
          completeness: 'partial',
          issue: 'sampling',
          entities: [checkout, dev, payments],
          relations: [
            {
              from: checkout.ref,
              to: pod.aliases![0]!,
              kind: 'runs_on',
              evidence: 'observed',
              description: 'Span identifies exact runtime pod',
            },
            {
              from: checkout.ref,
              to: payments.ref,
              kind: 'calls',
              evidence: 'observed',
              description: 'Paired parent and child spans',
            },
          ],
        },
      ],
    },
  );
});
afterAll(async () => {
  await admin.db.delete(entityServiceMappings).where(eq(entityServiceMappings.tenantId, tenantId));
  await admin.db
    .delete(incidentServiceAssignments)
    .where(eq(incidentServiceAssignments.tenantId, tenantId));
  await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
  await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
  await admin.db.delete(serviceDependencies).where(eq(serviceDependencies.tenantId, tenantId));
  await admin.db.delete(services).where(eq(services.tenantId, tenantId));
  await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
  await admin.db.delete(memberships).where(eq(memberships.userId, userId));
  await admin.db.delete(users).where(eq(users.id, userId));
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await admin.db.delete(tenants).where(eq(tenants.id, otherTenant));
  await Promise.all([admin.close(), app.close()]);
});

test('incident context and impact use the same scoped identity without a catalog entry', async () => {
  const id = await incident([candidate()]);
  const context = await resolveIncidentTopologyContext(app.db, tenantId, id);
  expect(context?.services).toEqual([]);
  expect(context?.topology.resolutions).toEqual([
    expect.objectContaining({ status: 'resolved', subjectKey: topologyRefKey(checkout.ref) }),
  ]);
  const impact = await computeIncidentBlastRadius(app.db, tenantId, id, 'slack:conversation');
  expect(impact).toMatchObject({
    mapped: true,
    service: 'checkout',
    subjectKey: context?.topology.resolutions[0]?.subjectKey,
    scope: { environment: 'production' },
    suspects: [
      expect.objectContaining({
        name: 'payments',
        subjectKey: topologyRefKey(payments.ref),
        syncType: 'unknown',
      }),
    ],
  });
  const callerImpact = await computeBlastRadius(app.db, tenantId, 'payments');
  expect(callerImpact.dependents.unclassified?.[0]?.subjectKey).toBe(topologyRefKey(checkout.ref));
  expect(await resolveIncidentTopologyContext(app.db, otherTenant, id)).toBeNull();
  expect(
    (
      await computeBlastRadius(app.db, otherTenant, 'checkout', {
        subjectKey: topologyRefKey(checkout.ref),
      })
    ).mapped,
  ).toBe(false);
});

test('a captured Kubernetes resource maps through the observed APM resource link without manual service mapping', async () => {
  const resource = candidate({
    key: 'captured-runtime-pod',
    kind: 'workload',
    stableId: 'production/api-pod',
    topologyRef: pod.aliases![0],
    scope: { dataSourceId: runtimeSourceId, namespace: 'production' },
    provenance: { kind: 'platform_snapshot', source: 'kubernetes' },
  });
  const id = await incident([resource]);
  const context = await resolveIncidentTopologyContext(app.db, tenantId, id);
  expect(context?.topology.resolutions[0]).toMatchObject({
    status: 'resolved',
    subjectKey: topologyRefKey(checkout.ref),
  });
  expect(context?.mappings).toEqual([]);
  expect(context?.observations[0]?.candidates[0]).toEqual(resource);
  const impact = await computeIncidentBlastRadius(app.db, tenantId, id, 'unclassified');
  expect(impact).toMatchObject({
    mapped: true,
    subjectKey: topologyRefKey(checkout.ref),
    service: 'checkout',
  });
  expect(impact.suspects[0]?.name).toBe('payments');
  const forged = await incident([
    { ...resource, provenance: { kind: 'classifier_inference', source: 'classifier' } },
  ]);
  expect(
    (await resolveIncidentTopologyContext(app.db, tenantId, forged))?.topology.resolutions[0]
      ?.status,
  ).toBe('needs_evidence');
});

test('missing environment returns candidates rather than arbitrarily choosing production', async () => {
  const id = await incident([candidate({ scope: {} })]);
  const context = await resolveIncidentTopologyContext(app.db, tenantId, id);
  expect(context?.topology.resolutions[0]?.status).toBe('ambiguous');
  expect(
    (await computeIncidentBlastRadius(app.db, tenantId, id, 'checkout')).candidates,
  ).toHaveLength(2);
  expect((await computeBlastRadius(app.db, tenantId, 'checkout')).mapped).toBe(false);
});

test('connector provenance scopes service candidates without requiring it as an entity identity attribute', async () => {
  const id = await incident([
    candidate({ scope: { environment: 'production', dataSourceId: sourceId } }),
  ]);
  expect(
    (await resolveIncidentTopologyContext(app.db, tenantId, id))?.topology.resolutions[0],
  ).toMatchObject({ status: 'resolved', subjectKey: topologyRefKey(checkout.ref) });
  const foreign = await incident([
    candidate({ scope: { environment: 'production', dataSourceId: randomUUID() } }),
  ]);
  expect(
    (await resolveIncidentTopologyContext(app.db, tenantId, foreign))?.topology.resolutions[0]
      ?.status,
  ).toBe('unmapped');
});

test('classifier confidence cannot establish the incident service identity', async () => {
  const id = await incident([
    candidate({ provenance: { kind: 'classifier_inference', source: 'classifier' } }),
  ]);
  expect(
    (await resolveIncidentTopologyContext(app.db, tenantId, id))?.topology.resolutions[0]?.status,
  ).toBe('needs_evidence');
  const impact = await computeIncidentBlastRadius(app.db, tenantId, id, 'checkout');
  expect(impact.mapped).toBe(false);
  expect(impact.note).toContain('one confirmed scoped service identity');
});

test('explicit incident assignments override provider candidates without rewriting observations', async () => {
  const original = candidate();
  const id = await incident([original]);
  await admin.db.insert(services).values({ tenantId, name: 'payments' });
  await admin.db.insert(incidentServiceAssignments).values({
    tenantId,
    incidentId: id,
    serviceName: 'payments',
    confirmedByUserId: userId,
    rationale: 'Payment service is affected',
  });
  const context = await resolveIncidentTopologyContext(app.db, tenantId, id);
  expect(context?.observations[0]?.candidates[0]).toEqual(original);
  expect(context?.topology.resolutions[0]?.subjectKey).toBe(topologyRefKey(payments.ref));
  expect(
    (await computeIncidentBlastRadius(app.db, tenantId, id, 'slack:conversation')).service,
  ).toBe('payments');
});

test('a scoped human correction cannot silently select an automatic service in another environment', async () => {
  const workload = candidate({
    key: 'workload-staging',
    kind: 'workload',
    stableId: 'worker',
    scope: { environment: 'staging' },
  });
  const id = await incident([workload]);
  await admin.db.insert(services).values({ tenantId, name: 'payments' }).onConflictDoNothing();
  await upsertEntityServiceMapping(app.db, tenantId, {
    candidateKey: workload.key,
    candidateKind: workload.kind,
    serviceName: 'payments',
    confirmedByUserId: userId,
    rationale: 'This staging workload runs payments.',
  });
  const context = await resolveIncidentTopologyContext(app.db, tenantId, id);
  expect(context?.topology.resolutions[0]?.status).toBe('unmapped');
  expect(await readIncidentTopologySources(app.db, tenantId, id, 'payments')).toBeNull();
  expect((await readIncidentTopologySources(app.db, tenantId, id, 'unrelated'))?.status).toBe(
    'unavailable',
  );
  const impact = await computeIncidentBlastRadius(app.db, tenantId, id, 'slack:conversation');
  expect(impact.service).toBe('payments');
  expect(impact.subjectKey).toBeUndefined();
  expect(impact.dependents.unclassified).toBeUndefined();
});

test('incident impact does not widen a resource-scoped correction to the unscoped catalog', async () => {
  const scope = { namespace: 'apps', cluster: 'unmatched-cluster', environment: 'production' };
  const workload = candidate({
    key: 'unresolved-runtime-correction',
    kind: 'workload',
    stableId: 'worker',
    scope,
  });
  const id = await incident([workload]);
  await admin.db.insert(services).values([
    { tenantId, name: 'catalog-only' },
    { tenantId, name: 'catalog-caller' },
  ]);
  await addDependency(app.db, tenantId, { upstream: 'catalog-caller', downstream: 'catalog-only' });
  await upsertEntityServiceMapping(app.db, tenantId, {
    candidateKey: workload.key,
    candidateKind: workload.kind,
    serviceName: 'catalog-only',
    confirmedByUserId: userId,
    rationale: 'This workload is the affected service.',
  });
  const context = await resolveIncidentTopologyContext(app.db, tenantId, id);
  expect(context?.topology.resolutions[0]?.status).toBe('unmapped');
  const impact = await computeIncidentBlastRadius(app.db, tenantId, id, 'slack:conversation');
  expect(impact).toMatchObject({ mapped: false, service: 'catalog-only', scope });
  expect(Object.values(impact.dependents).flat()).toEqual([]);
  expect(impact.suspects).toEqual([]);
});
