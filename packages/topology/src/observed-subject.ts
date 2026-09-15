import {
  topologyRefKey,
  type AffectedEntityCandidate,
  type DiscoveredTopologyGraph,
  type OperationalTopology,
  type IncidentTopologyContext,
} from '@sre/contracts';

/** Resolve a captured resource through fresh exact locators and proven service-to-resource links.
 * @param candidate - Platform-owned snapshot candidate, including its source and namespace scope.
 * @param discovery - Tenant-scoped provider evidence with alias conflicts and freshness.
 * @param operational - Shared operational projection shown by the topology page.
 */
export function observedTopologySubject(
  candidate: AffectedEntityCandidate,
  discovery: DiscoveredTopologyGraph,
  operational: OperationalTopology,
): IncidentTopologyContext['resolutions'][number] {
  const unresolved = {
    candidateKey: candidate.key,
    status: 'needs_evidence' as const,
    candidateSubjectKeys: [],
  };
  if (candidate.provenance.kind !== 'platform_snapshot' || !candidate.topologyRef)
    return unresolved;
  const reference = topologyRefKey(candidate.topologyRef);
  const matches = discovery.entities.filter(
    (entity) =>
      [entity.ref, ...(entity.aliases ?? [])].some((ref) => topologyRefKey(ref) === reference) &&
      entity.kind === candidate.kind &&
      Object.entries(candidate.scope).every(
        ([key, value]) =>
          !value ||
          (key === 'dataSourceId'
            ? entity.sources.some(
                (source) => source.connectorId === value && source.completeness !== 'unavailable',
              )
            : entity.scope[key] === value),
      ),
  );
  if (!matches.length) return unresolved;
  const resourceKeys = new Set(
    matches.filter((entity) => !entity.stale).map((entity) => entity.key),
  );
  if (!resourceKeys.size) return unresolved;
  const subjects = operational.subjects.filter(
    (subject) =>
      !subject.stale &&
      !subject.identityConflict &&
      (resourceKeys.has(subject.key) || subject.resourceKeys.some((key) => resourceKeys.has(key))),
  );
  const services = subjects.filter(
    (subject) =>
      subject.kind === 'service' &&
      discovery.relations.some(
        (relation) =>
          relation.kind === 'runs_on' &&
          !relation.stale &&
          relation.fromKey === subject.key &&
          relation.toKey &&
          resourceKeys.has(relation.toKey) &&
          (relation.evidence === 'observed' || relation.evidence === 'provider_reference'),
      ),
  );
  const candidates = services.length
    ? services
    : subjects.filter((subject) => subject.kind !== 'service');
  if (!candidates.length) return unresolved;
  const conflict = discovery.conflicts.some(
    (item) => topologyRefKey(item.ref) === reference || resourceKeys.has(topologyRefKey(item.ref)),
  );
  if (matches.length === 1 && candidates.length === 1 && !conflict)
    return {
      candidateKey: candidate.key,
      status: 'resolved',
      subjectKey: candidates[0]!.key,
      candidateSubjectKeys: [],
    };
  return {
    candidateKey: candidate.key,
    status: 'ambiguous',
    candidateSubjectKeys: candidates.map((subject) => subject.key),
  };
}
