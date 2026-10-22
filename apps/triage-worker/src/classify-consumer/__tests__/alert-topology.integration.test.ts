import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { connectorConfigs, incidentSignals, persistTopologyDiscovery } from '@sre/db';
import { topologyRefKey, type TopologyEntity, type TopologyRelation } from '@sre/contracts';
import { readIncidentTopologySources } from '@sre/topology';
import { ClassifyCore } from '../core';
import {
  CHANNEL,
  admin,
  app,
  hub,
  queue,
  redis,
  resolvedCandidate,
  tenantId,
  useRecoveryFixture,
} from './recovery-report.fixture';

useRecoveryFixture();

const workload = (kind: string, name: string): TopologyEntity => ({
  ref: { authority: 'kubernetes-cluster:one', kind, id: `${kind}-${name}` },
  kind: 'workload',
  name,
  scope: { cluster: 'kubernetes-cluster:one', namespace: 'edge' },
  attributes: { resourceKind: kind },
});
const owns = (from: TopologyEntity, to: TopologyEntity): TopologyRelation => ({
  from: from.ref,
  to: to.ref,
  kind: 'owns',
  evidence: 'provider_reference',
  description: 'owner',
});

test('a classifier service never blocks the source subject an alert-named pod selects', async () => {
  const runtimeId = randomUUID();
  await admin.db
    .insert(connectorConfigs)
    .values({ id: runtimeId, tenantId, type: 'kubernetes', name: 'Runtime' });
  const deployment = workload('Deployment', 'edge-proxy'),
    replicas = workload('ReplicaSet', 'edge-proxy-7c4584b84'),
    pod = workload('Pod', 'edge-proxy-7c4584b84-sp9ww');
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: runtimeId, lifecycleVersion: 0 },
    {
      observedAt: new Date().toISOString(),
      collections: [
        {
          key: 'inventory',
          completeness: 'complete',
          entities: [deployment, replicas, pod],
          relations: [owns(deployment, replicas), owns(replicas, pod)],
        },
      ],
    },
  );
  const core = new ClassifyCore({
    hub,
    embedder: { dim: 1, embed: async () => [[0]] },
    appDb: app.db,
    redis,
    reservationRedis: redis,
    queue,
  } as never);
  const summary = 'Pod edge/edge-proxy-7c4584b84-sp9ww has been in a non-ready state.';
  const candidate = resolvedCandidate(`slack:monitor-${randomUUID()}`, {
    signalState: 'firing',
    text: `[FIRING:1] ${summary}`,
    observations: undefined,
  });

  await core.openNewIncident(
    tenantId,
    `alert-topology-${randomUUID()}`,
    { channel: CHANNEL, threadId: candidate.externalId },
    // The classifier names a service too; it must not outvote the alert's exact resource.
    { service: 'edge-proxy', severity: 'sev3', title: summary },
    null,
    summary,
    core.openerFor(candidate, summary),
    async () => {},
    { signals: core.signalsFor(candidate) },
  );

  const [signal] = await admin.db
    .select({ incidentId: incidentSignals.incidentId })
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.tenantId, tenantId),
        eq(incidentSignals.externalMessageId, candidate.externalId),
      ),
    );
  const sources = await readIncidentTopologySources(app.db, tenantId, signal!.incidentId);
  expect(sources?.subject?.key).toBe(topologyRefKey(deployment.ref));
});
