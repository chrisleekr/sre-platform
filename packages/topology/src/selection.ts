import type { OperationalTopology, TopologySubject } from '@sre/contracts';

export interface TopologySelection {
  key?: string;
  name?: string;
  kind?: TopologySubject['kind'];
  scope?: Record<string, string>;
}

export type TopologySelectionResult =
  | { status: 'resolved'; subject: TopologySubject }
  | { status: 'unmapped' | 'ambiguous'; candidates: TopologySubject[] };

/** Select an existing identity without merging identities or inferring missing scope.
 * @param graph - Shared resolved operational topology.
 * @param input - Exact identity, or a provider service name constrained by known scope.
 */
export function selectTopologySubject(
  graph: OperationalTopology,
  input: TopologySelection,
): TopologySelectionResult {
  const candidates = graph.subjects.filter(
    (subject) =>
      (input.key
        ? subject.key === input.key
        : Boolean(input.name) && subject.name === input.name) &&
      (!input.kind || subject.kind === input.kind) &&
      Object.entries(input.scope ?? {}).every(
        ([key, value]) =>
          !value ||
          (key === 'dataSourceId'
            ? subject.sources.some((source) => source.connectorId === value)
            : subject.scope[key] === value),
      ),
  );
  if (candidates.length === 1 && !candidates[0]!.identityConflict)
    return { status: 'resolved', subject: candidates[0]! };
  return { status: candidates.length ? 'ambiguous' : 'unmapped', candidates };
}
