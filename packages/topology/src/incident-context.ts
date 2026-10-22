import { resolveIncidentEntityContext, type Db, type IncidentEntityContext } from '@sre/db';
import type {
  AffectedEntityCandidate,
  DiscoveredTopologyGraph,
  IncidentTopologyContext,
  OperationalTopology,
} from '@sre/contracts';
import { readDiscoveredTopology } from './discovery-repo';
import { selectTopologySubject } from './selection';
import { observedTopologySubject } from './observed-subject';
import { discoveredSourceEvidence } from './discovered-sources';
import type { TopologySourceEvidence } from '@sre/contracts';

/** Resolve structured service candidates without allowing classifier guesses to establish identity.
 * @param context - Original observations and optional human catalog corrections.
 * @param graph - Shared current operational topology.
 * @param discovery - Exact captured resource evidence, when available.
 */
export function incidentTopologyContext(
  context: IncidentEntityContext,
  graph: OperationalTopology,
  discovery?: DiscoveredTopologyGraph,
): IncidentTopologyContext {
  const candidates = [
    ...new Map(
      context.observations
        .flatMap((observation) => observation.candidates)
        .map((candidate) => [candidate.key, candidate]),
    ).values(),
  ];
  const assignments = context.mappings.filter((mapping) =>
    mapping.candidateKey.startsWith('incident-service:'),
  );
  const requests = assignments.length
    ? assignments.map((mapping) => ({
        key: mapping.candidateKey,
        name: mapping.serviceName,
        scope: {},
        inferred: false,
        subjectKey: undefined as string | undefined,
        candidate: undefined as AffectedEntityCandidate | undefined,
      }))
    : candidates.map((candidate) => {
        const override = context.mappings.find(
          (mapping) => mapping.candidateKey === candidate.key && mapping.method === 'human',
        );
        return {
          key: candidate.key,
          candidate: override ? undefined : candidate,
          name:
            override?.serviceName ??
            (candidate.kind === 'service' ? candidate.stableId : undefined),
          scope: candidate.scope,
          inferred: !override && candidate.provenance.kind === 'classifier_inference',
          subjectKey:
            !override && candidate.provenance.kind === 'platform_snapshot'
              ? candidate.topologySubjectKey
              : undefined,
        };
      });
  const resolutions: IncidentTopologyContext['resolutions'] = requests.map((request) => {
    if (request.inferred)
      return { candidateKey: request.key, status: 'needs_evidence', candidateSubjectKeys: [] };
    if (request.candidate?.topologyRef && discovery)
      return observedTopologySubject(request.candidate, discovery, graph);
    // Webhook labels keep plain name selection; only alert text names a resource without a locator.
    if (
      request.candidate?.provenance.kind === 'provider_label' &&
      request.candidate.provenance.source === 'alert_text' &&
      request.candidate.kind !== 'service' &&
      request.candidate.scope.namespace &&
      discovery
    )
      return labelledTopologySubject(request.candidate, discovery, graph);
    const result = selectTopologySubject(graph, {
      key: request.subjectKey,
      name: request.name,
      kind: 'service',
      scope: request.scope,
    });
    return result.status === 'resolved'
      ? {
          candidateKey: request.key,
          status: 'resolved',
          subjectKey: result.subject.key,
          candidateSubjectKeys: [],
        }
      : {
          candidateKey: request.key,
          status: result.status,
          candidateSubjectKeys: result.candidates.map((subject) => subject.key),
        };
  });
  const selected = new Set(
    resolutions.flatMap((resolution) => (resolution.subjectKey ? [resolution.subjectKey] : [])),
  );
  const relations = graph.relations.filter(
    (relation) => selected.has(relation.from) || selected.has(relation.to),
  );
  const keys = new Set([
    ...selected,
    ...resolutions.flatMap((resolution) => resolution.candidateSubjectKeys),
    ...relations.flatMap((relation) => [relation.from, relation.to]),
  ]);
  return {
    resolutions,
    subjects: graph.subjects.filter((subject) => keys.has(subject.key)),
    relations,
  };
}

/** Resolve a provider-labelled namespaced resource only through one fresh exact inventory entity.
 * @param candidate - Provider-labelled candidate carrying its namespace.
 * @param discovery - Tenant-scoped provider evidence.
 * @param graph - Shared operational projection.
 */
function labelledTopologySubject(
  candidate: AffectedEntityCandidate,
  discovery: DiscoveredTopologyGraph,
  graph: OperationalTopology,
): IncidentTopologyContext['resolutions'][number] {
  const hits = discovery.entities.filter(
    (entity) =>
      !entity.stale &&
      entity.kind === candidate.kind &&
      entity.name === candidate.stableId &&
      // Same scope rule as selectTopologySubject, so a cluster or source pin is never widened.
      Object.entries(candidate.scope).every(
        ([key, value]) =>
          !value ||
          (key === 'dataSourceId'
            ? entity.sources.some((source) => source.connectorId === value)
            : entity.scope[key] === value),
      ),
  );
  if (hits.length !== 1)
    return {
      candidateKey: candidate.key,
      status: hits.length ? 'ambiguous' : 'unmapped',
      candidateSubjectKeys: [],
    };
  // The matched inventory entity is now the exact locator, so ownership resolves as for a snapshot.
  return observedTopologySubject(
    {
      ...candidate,
      scope: {},
      topologyRef: hits[0]!.ref,
      provenance: { kind: 'platform_snapshot', source: candidate.provenance.source },
    },
    discovery,
    graph,
  );
}

/** Read incident context with shared automatic topology, preserving human corrections and raw observations.
 * @param db - RLS-scoped application database.
 * @param tenantId - Workspace owning the incident and connector evidence.
 * @param incidentId - Incident whose structured candidates should be resolved.
 */
export async function resolveIncidentTopologyContext(db: Db, tenantId: string, incidentId: string) {
  const context = await resolveIncidentEntityContext(db, tenantId, incidentId);
  if (!context) return null;
  const graph = await readDiscoveredTopology(db, tenantId);
  return { ...context, topology: incidentTopologyContext(context, graph.operational, graph) };
}

/** Read source associations for the incident's exact topology selection, without name fallback on ambiguity.
 * @param db - Tenant-scoped application database.
 * @param tenantId - Workspace owning the incident and discovery evidence.
 * @param incidentId - Incident whose affected identity selects the source context.
 * @param legacyService - Existing tool context, eligible only for an explicit matching human correction.
 */
export async function readIncidentTopologySources(
  db: Db,
  tenantId: string,
  incidentId: string,
  legacyService?: string,
): Promise<TopologySourceEvidence | null> {
  const context = await resolveIncidentEntityContext(db, tenantId, incidentId);
  if (!context) return null;
  const graph = await readDiscoveredTopology(db, tenantId);
  const kinds = new Map(
    context.observations.flatMap((observation) =>
      observation.candidates.map((candidate) => [candidate.key, candidate.kind] as const),
    ),
  );
  // Nodes and namespaces have no source of their own, so leaving one unmapped hides no repository.
  const resolutions = incidentTopologyContext(context, graph.operational, graph).resolutions.filter(
    (item) =>
      item.status !== 'unmapped' ||
      !['node', 'namespace'].includes(kinds.get(item.candidateKey) ?? ''),
  );
  if (!resolutions.length) return null;
  if (
    legacyService &&
    context.mappings.length &&
    context.mappings.every(
      (mapping) => mapping.method === 'human' && mapping.serviceName === legacyService,
    ) &&
    resolutions.every((item) => item.status === 'unmapped')
  )
    return null;
  const keys = [
    ...new Set(resolutions.flatMap((item) => (item.subjectKey ? [item.subjectKey] : []))),
  ];
  if (keys.length === 1 && resolutions.every((item) => item.status === 'resolved'))
    return discoveredSourceEvidence(graph, { key: keys[0] });
  return {
    status:
      resolutions.some((item) => item.status === 'ambiguous') || keys.length > 1
        ? 'ambiguous'
        : 'unavailable',
    subject: null,
    repositories: [],
    note: 'Affected topology identity is unresolved. No repository was selected from the conversation name or an inferred service.',
  };
}
