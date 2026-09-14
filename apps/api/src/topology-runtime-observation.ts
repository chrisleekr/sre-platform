import { createHash } from 'node:crypto';
import type { Db } from '@sre/db';
import type { SnapshotCache } from '@sre/queue';
import { readTopologyRuntime } from '@sre/topology';
import { entityCandidateKey } from '@sre/contracts';
import { normalizeDiscoveredRuntimeObservation } from '@sre/connectors';
import { scrubSecrets } from '@sre/agent-tools';
import type { ResolvedObservation } from './incident-observations';
import { ObservationNotFoundError, ObservationNotActionableError } from './observation-errors';

/** Keep persisted observation identity bounded without truncating an exact provider identity. */
export function topologyObservationId(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Capture only the selected service's unhealthy resource evidence after an explicit operator request. */
export async function resolveTopologyRuntimeObservation(
  deps: { db: Db; cache: SnapshotCache },
  tenantId: string,
  key: string,
): Promise<ResolvedObservation> {
  const evidence = await readTopologyRuntime(
    deps.db,
    tenantId,
    { key, kind: 'service' },
    (tenant, source) => deps.cache.get(tenant, source.type, source),
  );
  if (!evidence.subject)
    throw new ObservationNotFoundError(
      'Topology service identity is unavailable or ambiguous. Refresh its evidence.',
    );
  const observation = normalizeDiscoveredRuntimeObservation(evidence, new Date(), scrubSecrets);
  if (observation.state !== 'firing')
    throw new ObservationNotActionableError(
      'No current unhealthy runtime resources are associated with this service. Partial evidence does not prove recovery.',
    );
  const service = evidence.subject;
  return {
    source: 'platform',
    service: service.name,
    severity: 'sev3',
    title: `${service.name} observed runtime needs attention`,
    subject: {
      kind: 'topology_service',
      sourceId: 'topology-discovery',
      subjectId: topologyObservationId(key),
      sourcePath: '/topology',
      ...observation,
      syncEnabled: true,
      signalSource: {
        kind: 'platform_observer',
        provider: 'topology',
        dataSourceId: null,
        externalId: key,
        displayName: 'Discovered runtime observation',
        observedAt: observation.observedAt.toISOString(),
      },
      affectedEntities: [
        {
          key: entityCandidateKey('service', service.name, service.scope),
          topologySubjectKey: key,
          kind: 'service',
          stableId: service.name,
          displayName: service.name,
          scope: service.scope,
          provenance: { kind: 'platform_snapshot', source: 'topology-discovery' },
          confidence: 1,
          observedAt: observation.observedAt.toISOString(),
          completeness: 'partial',
          requiredCapabilities: ['runtime', 'topology'],
        },
      ],
    },
  };
}
