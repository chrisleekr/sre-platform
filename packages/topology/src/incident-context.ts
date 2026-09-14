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
  const selection = incidentTopologyContext(context, graph.operational, graph);
  if (!selection.resolutions.length) return null;
  if (
    legacyService &&
    context.mappings.length &&
    context.mappings.every(
      (mapping) => mapping.method === 'human' && mapping.serviceName === legacyService,
    ) &&
    selection.resolutions.every((item) => item.status === 'unmapped')
  )
    return null;
  const keys = [
    ...new Set(selection.resolutions.flatMap((item) => (item.subjectKey ? [item.subjectKey] : []))),
  ];
  if (keys.length === 1 && selection.resolutions.every((item) => item.status === 'resolved'))
    return discoveredSourceEvidence(graph, { key: keys[0] });
  return {
    status:
      selection.resolutions.some((item) => item.status === 'ambiguous') || keys.length > 1
        ? 'ambiguous'
        : 'unavailable',
    subject: null,
    repositories: [],
    note: 'Affected topology identity is unresolved. No repository was selected from the conversation name or an inferred service.',
  };
}
