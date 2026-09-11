import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  connectorConfigs,
  investigationSubjects,
  services,
  withTenant,
  type Db,
  type InvestigationSubjectSnapshot,
  type InvestigationSubjectState,
} from '@sre/db';
import {
  normalizeConnectorVerificationObservation,
  normalizeInfrastructureObservation,
  normalizeTopologyServiceObservation,
  type NormalizedSnapshot,
} from '@sre/connectors';
import { scrubSecrets } from '@sre/agent-tools';
import type { SnapshotCache } from '@sre/queue';

export class SubjectSyncUnavailableError extends Error {}

export interface SubjectSyncObservation {
  state: InvestigationSubjectState;
  summary: string;
  snapshot: InvestigationSubjectSnapshot;
  contentHash: string;
  observedAt: Date;
}

const atSyncTime = (
  observation: Omit<SubjectSyncObservation, 'observedAt'> & { observedAt: Date },
  syncedAt: Date,
): SubjectSyncObservation => ({ ...observation, observedAt: syncedAt });

const safeInfrastructure = (snapshot: NormalizedSnapshot): SubjectSyncObservation => {
  const syncedAt = new Date();
  return atSyncTime(normalizeInfrastructureObservation(snapshot, syncedAt, scrubSecrets), syncedAt);
};

export function makeSubjectSyncResolver(deps: { db: Db; cache: SnapshotCache }) {
  return async (
    tenantId: string,
    subject: typeof investigationSubjects.$inferSelect,
  ): Promise<SubjectSyncObservation> => {
    if (subject.kind === 'deployment')
      return {
        state: subject.currentState,
        summary: subject.currentSummary,
        snapshot: subject.currentSnapshot,
        contentHash: subject.currentHash,
        observedAt: subject.lastSyncedAt,
      };
    if (subject.kind === 'connector_verification') {
      const config = await withTenant(deps.db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(connectorConfigs)
          .where(and(eq(connectorConfigs.id, subject.sourceId), isNull(connectorConfigs.deletedAt)))
          .limit(1);
        return rows[0] ?? null;
      });
      if (!config) throw new SubjectSyncUnavailableError('connector observation unavailable');
      const syncedAt = new Date();
      return atSyncTime(
        normalizeConnectorVerificationObservation(
          {
            connectorType: config.type,
            connectorName: config.name,
            enabled: config.enabled,
            failureCategory: config.verificationFailureCategory,
            attemptedAt: config.verificationAttemptedAt,
            succeededAt: config.verificationSucceededAt,
          },
          syncedAt,
          scrubSecrets,
        ),
        syncedAt,
      );
    }

    if (subject.kind === 'infrastructure_resource') {
      const config = await withTenant(deps.db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(connectorConfigs)
          .where(
            and(
              eq(connectorConfigs.id, subject.sourceId),
              inArray(connectorConfigs.type, ['kubernetes', 'argocd']),
              isNull(connectorConfigs.deletedAt),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      });
      if (!config) throw new SubjectSyncUnavailableError('runtime observation unavailable');
      let snapshots: NormalizedSnapshot[];
      try {
        snapshots = await deps.cache.get(tenantId, config.type, {
          id: config.id,
          lifecycleVersion: config.lifecycleVersion,
        });
      } catch {
        throw new SubjectSyncUnavailableError('runtime observation unavailable');
      }
      const current = snapshots.find((snapshot) => snapshot.entityId === subject.subjectId);
      if (!current) throw new SubjectSyncUnavailableError('runtime observation unavailable');
      return safeInfrastructure(current);
    }

    const service = await withTenant(deps.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(services)
        .where(eq(services.name, subject.subjectId))
        .limit(1);
      return rows[0] ?? null;
    });
    if (!service) throw new SubjectSyncUnavailableError('service observation unavailable');
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
    if (configs.length === 0)
      throw new SubjectSyncUnavailableError('runtime observation unavailable');
    let snapshots: NormalizedSnapshot[];
    try {
      snapshots = (
        await Promise.all(
          configs.map((config) =>
            deps.cache.get(tenantId, 'kubernetes', {
              id: config.id,
              lifecycleVersion: config.lifecycleVersion,
            }),
          ),
        )
      ).flat();
    } catch {
      throw new SubjectSyncUnavailableError('runtime observation unavailable');
    }
    const serviceSnapshots = snapshots.filter(
      (snapshot) =>
        snapshot.metadata.kind === 'pod' && snapshot.metadata.namespace === subject.subjectId,
    );
    if (serviceSnapshots.length === 0)
      throw new SubjectSyncUnavailableError('service runtime observation unavailable');
    const syncedAt = new Date();
    return atSyncTime(
      normalizeTopologyServiceObservation(
        {
          service: service.name,
          team: service.team,
          criticality: service.criticality,
          snapshots: serviceSnapshots,
        },
        syncedAt,
        scrubSecrets,
      ),
      syncedAt,
    );
  };
}
