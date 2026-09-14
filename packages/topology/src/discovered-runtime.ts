import { and, eq, inArray, isNull } from 'drizzle-orm';
import { connectorConfigs, withTenant, type Db } from '@sre/db';
import { isConnectorType, type ConnectorType, type NormalizedSnapshot } from '@sre/connectors';
import { topologyRefKey, type TopologyRuntimeEvidence } from '@sre/contracts';
import { readDiscoveredTopology } from './discovery-repo';
import { selectTopologySubject, type TopologySelection } from './selection';

export type TopologyRuntimeReader = (
  tenantId: string,
  source: { id: string; type: ConnectorType; lifecycleVersion: number },
) => Promise<NormalizedSnapshot[]>;

/** Read only runtime resources proven to belong to the selected scoped topology subject.
 * @param db - RLS-scoped application database.
 * @param tenantId - Workspace owning both discovery and observations.
 * @param selection - Exact subject identity or unambiguous scoped name.
 * @param read - Generation-aware snapshot reader. No provider discovery is triggered by this read.
 */
export async function readTopologyRuntime(
  db: Db,
  tenantId: string,
  selection: TopologySelection,
  read: TopologyRuntimeReader,
): Promise<TopologyRuntimeEvidence> {
  const graph = await readDiscoveredTopology(db, tenantId);
  const selected = selectTopologySubject(graph.operational, selection);
  if (selected.status !== 'resolved')
    return {
      status: selected.status === 'ambiguous' ? 'ambiguous' : 'unavailable',
      subject: null,
      observations: [],
      note:
        selected.status === 'ambiguous'
          ? 'Runtime identity is ambiguous. Select an exact topology subject and scope.'
          : 'No runtime subject matches this identity and scope.',
    };
  const subject = selected.subject;
  const resourceKeys = new Set(subject.resourceKeys);
  const resources = graph.entities.filter(
    (entity) => resourceKeys.has(entity.key) && entity.kind !== 'service',
  );
  const ids = [
    ...new Set(
      resources.flatMap((resource) => resource.sources.map((source) => source.connectorId)),
    ),
  ];
  const sources = ids.length
    ? await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(connectorConfigs)
          .where(
            and(
              inArray(connectorConfigs.id, ids),
              eq(connectorConfigs.enabled, true),
              isNull(connectorConfigs.deletedAt),
            ),
          ),
      )
    : [];
  const observations = new Map<string, TopologyRuntimeEvidence['observations'][number]>();
  let failed = 0,
    conflicting = false;
  for (const source of sources) {
    if (!isConnectorType(source.type)) continue;
    const eligible = resources.filter(
      (resource) =>
        !resource.stale &&
        resource.sources.some(
          (evidence) =>
            evidence.connectorId === source.id &&
            evidence.lifecycleVersion === source.lifecycleVersion &&
            evidence.completeness !== 'unavailable',
        ),
    );
    if (!eligible.length) continue;
    const byRef = new Map<string, typeof eligible>();
    for (const resource of eligible)
      for (const ref of [resource.ref, ...(resource.aliases ?? [])]) {
        const key = topologyRefKey(ref);
        byRef.set(key, [...(byRef.get(key) ?? []), resource]);
      }
    let snapshots: NormalizedSnapshot[];
    try {
      snapshots = await read(tenantId, {
        id: source.id,
        type: source.type,
        lifecycleVersion: source.lifecycleVersion,
      });
    } catch {
      failed++;
      continue;
    }
    for (const snapshot of snapshots) {
      if (snapshot.tenantId !== tenantId || snapshot.source !== source.type || !snapshot.topology)
        continue;
      const matches = byRef.get(topologyRefKey(snapshot.topology.ref));
      if (matches?.length !== 1) continue;
      const resource = matches[0]!;
      const observed = new Date(snapshot.observedAt).getTime();
      const now = Date.now();
      if (!Number.isFinite(observed) || observed > now) continue;
      const stale = now - observed > 60_000 || Boolean(source.pollFailureCategory);
      const state = stale ? 'unknown' : snapshot.topology.state;
      const prior = observations.get(resource.key);
      const observedAt = new Date(observed).toISOString();
      const evidence = resource.sources
        .filter(
          (item) =>
            item.connectorId === source.id && item.lifecycleVersion === source.lifecycleVersion,
        )
        .map((item) => ({ ...item, observedAt }));
      if (prior && prior.observedAt > observedAt) continue;
      if (prior && prior.observedAt === observedAt && prior.state !== state) conflicting = true;
      observations.set(resource.key, {
        resourceKey: resource.key,
        name: resource.name,
        kind: resource.kind,
        scope: resource.scope,
        state:
          prior && prior.observedAt === observedAt && prior.state !== state ? 'unknown' : state,
        observedAt,
        stale,
        sources:
          prior && prior.observedAt === observedAt ? [...prior.sources, ...evidence] : evidence,
      });
    }
  }
  return {
    status: observations.size ? 'partial' : 'unavailable',
    subject,
    observations: [...observations.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.resourceKey.localeCompare(b.resourceKey),
    ),
    note: `These are observed resource associations, not complete service coverage. They cannot prove overall service recovery.${failed ? ` ${failed} source reads failed.` : ''}${conflicting ? ' Sources reported conflicting resource state.' : ''}${!observations.size ? ' No identity-matched runtime observations are available.' : ''}`,
  };
}
