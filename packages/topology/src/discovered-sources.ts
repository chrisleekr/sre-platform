import {
  topologyRefKey,
  type DiscoveredTopologyGraph,
  type OperationalTopology,
  type TopologySourceEvidence,
} from '@sre/contracts';
import type { Db } from '@sre/db';
import { discoveredOperationalTopology } from './operational';
import { readDiscoveredTopology } from './discovery-repo';
import { selectTopologySubject, type TopologySelection } from './selection';

/** Follow exact runtime ownership and deployment references, never repository-name similarity.
 * @param graph - Resolved tenant discovery, including per-fact freshness and identity conflicts.
 * @param selection - Exact subject or unambiguous scoped identity.
 */
export function discoveredSourceEvidence(
  graph: DiscoveredTopologyGraph & { operational?: OperationalTopology },
  selection: TopologySelection,
): TopologySourceEvidence {
  const selected = selectTopologySubject(
    graph.operational ?? discoveredOperationalTopology(graph),
    selection,
  );
  if (selected.status !== 'resolved')
    return {
      status: selected.status === 'ambiguous' ? 'ambiguous' : 'unavailable',
      subject: null,
      repositories: [],
      note: 'Select one unambiguous scoped topology subject before resolving its repositories.',
    };
  const subject = selected.subject;
  const entities = new Map(graph.entities.map((entity) => [entity.key, entity]));
  const conflicts = new Set(
    graph.conflicts
      .filter((conflict) => conflict.reason === 'conflicting_identity')
      .map((conflict) => topologyRefKey(conflict.ref)),
  );
  const current = graph.relations.filter(
    (relation) =>
      !relation.stale &&
      relation.evidence !== 'inferred' &&
      relation.fromKey &&
      relation.toKey &&
      !entities.get(relation.fromKey)?.stale &&
      !entities.get(relation.toKey)?.stale &&
      !conflicts.has(relation.fromKey) &&
      !conflicts.has(relation.toKey),
  );
  const outgoing = new Map<string, typeof current>(),
    incoming = new Map<string, typeof current>();
  for (const relation of current) {
    outgoing.set(relation.fromKey!, [...(outgoing.get(relation.fromKey!) ?? []), relation]);
    incoming.set(relation.toKey!, [...(incoming.get(relation.toKey!) ?? []), relation]);
  }
  const pending = [{ key: subject.key, path: [] as string[] }];
  const visited = new Set<string>();
  const repositories = new Map<string, TopologySourceEvidence['repositories'][number]>();
  let limited = false,
    ambiguous = false;
  while (pending.length && visited.size < 500) {
    const item = pending.shift()!;
    if (visited.has(item.key)) continue;
    visited.add(item.key);
    const out = outgoing.get(item.key) ?? [],
      into = incoming.get(item.key) ?? [];
    for (const relation of out.filter(
      (edge) => edge.kind === 'deployed_from' || edge.kind === 'declared_in',
    )) {
      const repo = entities.get(relation.toKey!);
      if (repo?.kind !== 'repository') continue;
      const role =
        relation.kind === 'deployed_from' && relation.attributes?.role === 'application_source'
          ? 'application_source'
          : relation.kind === 'deployed_from' && relation.attributes?.role === 'deployment_config'
            ? 'deployment_config'
            : 'unknown';
      const path = relation.scope?.path ?? null;
      const revision = relation.attributes?.revision ?? null;
      const key = JSON.stringify([item.key, repo.key, role, path, revision]);
      repositories.set(key, {
        key,
        repository: repo.ref,
        repositoryKey: repo.key,
        name: repo.name,
        role,
        path,
        revision,
        declaredBy: entities.get(item.key)?.name ?? item.key,
        evidenceKeys: [...item.path, relation.key],
        sources: [...relation.sources, ...repo.sources],
      });
    }
    const owners = into.filter(
      (edge) => edge.kind === 'owns' && edge.evidence === 'provider_reference',
    );
    const uniqueOwners = new Set(owners.map((edge) => edge.fromKey));
    if (uniqueOwners.size > 1) ambiguous = true;
    for (const edge of into) {
      if (
        edge.evidence === 'provider_reference' &&
        (edge.kind === 'manages' || (edge.kind === 'owns' && uniqueOwners.size === 1))
      )
        pending.push({ key: edge.fromKey!, path: [...item.path, edge.key] });
    }
    for (const edge of out) {
      // A service's sampled pod association does not authorize walking down to sibling pods.
      if (
        (edge.kind === 'runs_on' && item.key === subject.key && subject.kind === 'service') ||
        (edge.kind === 'owns' &&
          edge.evidence === 'provider_reference' &&
          subject.kind === 'workload')
      )
        pending.push({ key: edge.toKey!, path: [...item.path, edge.key] });
    }
  }
  if (pending.length || repositories.size > 50) limited = true;
  return {
    status: repositories.size ? 'partial' : 'unavailable',
    subject,
    repositories: [...repositories.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
      .slice(0, 50),
    note: `Repository roles and revisions are declarations, not proof of a running image's source. Multiple components and revisions remain separate. Repository access still requires an authorized connection.${ambiguous ? ' Conflicting runtime ownership was not traversed.' : ''}${limited ? ' Source traversal reached its limit; additional evidence may exist.' : ''}`,
  };
}

/** Read repository associations through the same scoped discovery used by runtime and impact.
 * @param db - Tenant-scoped application database.
 * @param tenantId - Workspace owning the subject and all evidence.
 * @param selection - Exact subject or unambiguous scoped identity.
 */
export async function readTopologySources(db: Db, tenantId: string, selection: TopologySelection) {
  return discoveredSourceEvidence(await readDiscoveredTopology(db, tenantId), selection);
}
