import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  connectorConfigs,
  deployments,
  services,
  withTenant,
  type Db,
  type InvestigationSubjectIdentity,
  listActiveInvestigationSubjects,
} from '@sre/db';
import {
  normalizeConnectorVerificationObservation,
  normalizeInfrastructureObservation,
  normalizeTopologyServiceObservation,
  type NormalizedSnapshot,
} from '@sre/connectors';
import { scrubSecrets } from '@sre/agent-tools';
import type { Queue, SnapshotCache } from '@sre/queue';
import { openIncidentWorkspace, type OpenIncidentSubject } from '@sre/alerts';
import {
  entityCandidateKey,
  type AffectedEntityCandidate,
  type EntityCapability,
  type SignalSource,
} from '@sre/contracts';

export type ObservationSubject =
  | { kind: 'infrastructure_resource'; dataSourceId: string; entityId: string }
  | { kind: 'deployment'; deploymentId: string }
  | { kind: 'connector_verification'; connectorId: string }
  | { kind: 'topology_service'; service: string };

import {
  ObservationNotFoundError,
  ObservationNotActionableError,
  ObservationUnavailableError,
} from './observation-errors';
export {
  ObservationNotFoundError,
  ObservationNotActionableError,
  ObservationUnavailableError,
} from './observation-errors';

export interface ResolvedObservation {
  source: string;
  service: string;
  severity: string;
  title: string;
  subject: OpenIncidentSubject;
}

const MAX_STRING = 500;

const text = (value: unknown, max = MAX_STRING): string | undefined =>
  typeof value === 'string' && value.trim()
    ? Array.from(scrubSecrets(value), (character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f ? ' ' : character;
      })
        .join('')
        .trim()
        .slice(0, max)
    : undefined;

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function generation(config: typeof connectorConfigs.$inferSelect) {
  return { id: config.id, lifecycleVersion: config.lifecycleVersion };
}

const entityCapabilities = (kind: AffectedEntityCandidate['kind']): EntityCapability[] => {
  if (kind === 'service') return ['runtime', 'metrics', 'logs', 'source_code', 'deployments'];
  if (kind === 'repository') return ['source_code', 'deployments'];
  if (kind === 'deployment') return ['deployments'];
  if (kind === 'connector') return [];
  return ['runtime', 'metrics', 'logs'];
};

function entityCandidate(
  kind: AffectedEntityCandidate['kind'],
  stableId: string,
  observedAt: Date,
  source: string,
  scope: Record<string, string> = {},
): AffectedEntityCandidate {
  return {
    key: entityCandidateKey(kind, stableId, scope),
    kind,
    stableId,
    displayName: stableId,
    scope,
    provenance: { kind: 'platform_snapshot', source },
    confidence: 100,
    observedAt: observedAt.toISOString(),
    completeness: 'complete',
    requiredCapabilities: entityCapabilities(kind),
  };
}

function platformSource(input: {
  provider: string;
  dataSourceId: string | null;
  externalId: string;
  displayName: string;
  observedAt: Date;
}): SignalSource {
  return {
    kind: 'platform_observer',
    provider: input.provider,
    dataSourceId: input.dataSourceId,
    externalId: input.externalId,
    displayName: input.displayName,
    observedAt: input.observedAt.toISOString(),
  };
}

function infrastructureObservation(
  config: typeof connectorConfigs.$inferSelect,
  snapshot: NormalizedSnapshot,
): ResolvedObservation {
  const observation = normalizeInfrastructureObservation(snapshot, new Date(), scrubSecrets);
  if (observation.state === 'resolved')
    throw new ObservationNotActionableError('observation is healthy');
  const explicitService = text(snapshot.metadata.service, 200);
  const namespace = observation.namespace ?? text(snapshot.metadata.namespace, 200);
  const entityKind = snapshot.metadata.kind === 'node' ? 'node' : 'workload';
  const scope: Record<string, string> = {
    dataSourceId: config.id,
    ...(namespace ? { namespace } : {}),
  };
  return {
    source: 'platform',
    service: explicitService ?? 'unclassified',
    severity: observation.hasError ? 'sev2' : 'sev3',
    title: `${scrubSecrets(snapshot.entityId).slice(0, 250)} needs attention`,
    subject: {
      kind: 'infrastructure_resource',
      sourceId: config.id,
      subjectId: snapshot.entityId,
      sourcePath: '/infrastructure',
      state: observation.state,
      summary: observation.summary,
      observedAt: observation.observedAt,
      snapshot: observation.snapshot,
      contentHash: observation.contentHash,
      syncEnabled: true,
      signalSource: platformSource({
        provider: config.type,
        dataSourceId: config.id,
        externalId: snapshot.entityId,
        displayName: `${text(config.name, 200) ?? config.type} observation`,
        observedAt: observation.observedAt,
      }),
      affectedEntities: [
        ...(explicitService
          ? [
              entityCandidate(
                'service',
                explicitService,
                observation.observedAt,
                config.type,
                scope,
              ),
            ]
          : []),
        entityCandidate(entityKind, snapshot.entityId, observation.observedAt, config.type, scope),
        ...(namespace
          ? [
              entityCandidate('namespace', namespace, observation.observedAt, config.type, {
                dataSourceId: config.id,
              }),
            ]
          : []),
      ],
    },
  };
}

export interface ObservationResolverDeps {
  db: Db;
  cache: SnapshotCache;
}

/** Re-resolve a typed identifier under the authenticated tenant. Client evidence is never accepted. */
export async function resolveObservation(
  deps: ObservationResolverDeps,
  tenantId: string,
  subject: ObservationSubject,
): Promise<ResolvedObservation> {
  if (subject.kind === 'infrastructure_resource') {
    const config = await withTenant(deps.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.id, subject.dataSourceId),
            inArray(connectorConfigs.type, ['kubernetes', 'argocd']),
            isNull(connectorConfigs.deletedAt),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
    if (!config) throw new ObservationNotFoundError('observation not found');
    let snapshots: NormalizedSnapshot[];
    try {
      snapshots = await deps.cache.get(tenantId, config.type, generation(config));
    } catch {
      throw new ObservationUnavailableError('observation source unavailable');
    }
    const snapshot = snapshots.find((item) => item.entityId === subject.entityId);
    if (!snapshot) throw new ObservationNotFoundError('observation not found');
    return infrastructureObservation(config, snapshot);
  }

  if (subject.kind === 'deployment') {
    const deployment = await withTenant(deps.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.id, subject.deploymentId))
        .limit(1);
      return rows[0] ?? null;
    });
    if (!deployment) throw new ObservationNotFoundError('observation not found');
    if (
      !['failed', 'failure', 'error', 'degraded', 'cancelled', 'canceled'].includes(
        deployment.status.toLowerCase(),
      )
    )
      throw new ObservationNotActionableError('observation is healthy');
    const source = text(deployment.source, 100) ?? 'deployment';
    const status = text(deployment.status, 50) ?? 'failed';
    const service = text(deployment.service, 200) ?? 'unclassified';
    const summary = `${source} deployment ${status}`;
    const snapshot = {
      source,
      repo: text(deployment.repo),
      ref: text(deployment.ref),
      environment: text(deployment.environment),
      sha: text(deployment.sha, 100),
      status,
      deployedAt: deployment.deployedAt.toISOString(),
    };
    return {
      source: 'platform',
      service,
      severity: 'sev3',
      title: `Deployment failed: ${service}`,
      subject: {
        kind: 'deployment',
        sourceId: 'deployment',
        subjectId: deployment.id,
        sourcePath: '/deployments',
        state: 'firing',
        summary,
        observedAt: deployment.deployedAt,
        snapshot,
        contentHash: hash(snapshot),
        syncEnabled: false,
        signalSource: platformSource({
          provider: source,
          dataSourceId: deployment.connectorId,
          externalId: deployment.id,
          displayName: `${source} deployment`,
          observedAt: deployment.deployedAt,
        }),
        affectedEntities: [
          entityCandidate('deployment', deployment.id, deployment.deployedAt, source, {
            source,
            ...(deployment.connectorId ? { dataSourceId: deployment.connectorId } : {}),
          }),
          entityCandidate('repository', deployment.repo, deployment.deployedAt, source, {
            source,
            ...(deployment.connectorId ? { dataSourceId: deployment.connectorId } : {}),
          }),
          ...(deployment.service
            ? [entityCandidate('service', deployment.service, deployment.deployedAt, source)]
            : []),
        ],
      },
    };
  }

  if (subject.kind === 'connector_verification') {
    const config = await withTenant(deps.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(connectorConfigs)
        .where(
          and(eq(connectorConfigs.id, subject.connectorId), isNull(connectorConfigs.deletedAt)),
        )
        .limit(1);
      return rows[0] ?? null;
    });
    if (!config) throw new ObservationNotFoundError('observation not found');
    const observation = normalizeConnectorVerificationObservation(
      {
        connectorType: config.type,
        connectorName: config.name,
        enabled: config.enabled,
        failureCategory: config.verificationFailureCategory,
        attemptedAt: config.verificationAttemptedAt,
        succeededAt: config.verificationSucceededAt,
      },
      new Date(),
      scrubSecrets,
    );
    if (observation.state === 'unknown')
      throw new ObservationNotActionableError('connector has not been verified');
    if (observation.state === 'resolved')
      throw new ObservationNotActionableError('observation is healthy');
    const connectorName = String(observation.snapshot.connectorName);
    return {
      source: 'platform',
      service: 'unclassified',
      severity: 'sev3',
      title: `${connectorName} connector verification failed`,
      subject: {
        kind: 'connector_verification',
        sourceId: config.id,
        subjectId: config.id,
        sourcePath: '/connectors',
        state: observation.state,
        summary: observation.summary,
        observedAt: observation.observedAt,
        snapshot: observation.snapshot,
        contentHash: observation.contentHash,
        syncEnabled: true,
        signalSource: platformSource({
          provider: config.type,
          dataSourceId: config.id,
          externalId: config.id,
          displayName: `${connectorName} verification`,
          observedAt: observation.observedAt,
        }),
        affectedEntities: [
          entityCandidate('connector', config.id, observation.observedAt, config.type),
        ],
      },
    };
  }

  const service = await withTenant(deps.db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(services)
      .where(eq(services.name, subject.service))
      .limit(1);
    return rows[0] ?? null;
  });
  if (!service) throw new ObservationNotFoundError('observation not found');
  const configs = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select()
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.type, 'kubernetes'),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ),
      ),
  );
  let snapshots: NormalizedSnapshot[];
  try {
    snapshots = (
      await Promise.all(
        configs.map((config) => deps.cache.get(tenantId, 'kubernetes', generation(config))),
      )
    ).flat();
  } catch {
    throw new ObservationUnavailableError('observation source unavailable');
  }
  const runtime = snapshots.filter(
    (item) => item.metadata.kind === 'pod' && item.metadata.namespace === service.name,
  );
  if (runtime.length === 0)
    throw new ObservationNotActionableError('service has no unhealthy runtime');
  const observation = normalizeTopologyServiceObservation(
    {
      service: service.name,
      team: service.team,
      criticality: service.criticality,
      snapshots: runtime,
    },
    new Date(),
    scrubSecrets,
  );
  if (observation.state === 'resolved')
    throw new ObservationNotActionableError('observation is healthy');
  const serviceName = String(observation.snapshot.service);
  return {
    source: 'platform',
    service: serviceName,
    severity: service.criticality === 'tier1' ? 'sev2' : 'sev3',
    title: `${serviceName} runtime needs attention`,
    subject: {
      kind: 'topology_service',
      sourceId: 'topology',
      subjectId: service.name,
      sourcePath: '/topology',
      state: observation.state,
      summary: observation.summary,
      observedAt: observation.observedAt,
      snapshot: observation.snapshot,
      contentHash: observation.contentHash,
      syncEnabled: true,
      signalSource: platformSource({
        provider: 'topology',
        dataSourceId: null,
        externalId: service.name,
        displayName: 'Service catalog observation',
        observedAt: observation.observedAt,
      }),
      affectedEntities: [
        {
          ...entityCandidate('service', service.name, observation.observedAt, 'service_catalog'),
          provenance: { kind: 'catalog', source: 'service_catalog' },
        },
      ],
    },
  };
}

export async function declareObservation(
  deps: ObservationResolverDeps & { queue: Queue },
  tenantId: string,
  subject: ObservationSubject,
) {
  const resolved = await resolveObservation(deps, tenantId, subject);
  return openIncidentWorkspace(
    { appDb: deps.db, queue: deps.queue },
    {
      tenantId,
      ...resolved,
      context: resolved.subject.snapshot,
      investigationTrigger: {
        reason: 'manual_investigation',
        automatic: false,
        monitorKey: null,
      },
    },
  );
}

export function observationIdentity(subject: ObservationSubject): InvestigationSubjectIdentity {
  switch (subject.kind) {
    case 'infrastructure_resource':
      return { kind: subject.kind, sourceId: subject.dataSourceId, subjectId: subject.entityId };
    case 'deployment':
      return { kind: subject.kind, sourceId: 'deployment', subjectId: subject.deploymentId };
    case 'connector_verification':
      return { kind: subject.kind, sourceId: subject.connectorId, subjectId: subject.connectorId };
    case 'topology_service':
      return { kind: subject.kind, sourceId: 'topology', subjectId: subject.service };
  }
}

export async function activeObservationWorkspaces(
  db: Db,
  tenantId: string,
  subjects: ObservationSubject[],
) {
  return listActiveInvestigationSubjects(db, tenantId, subjects.map(observationIdentity));
}
