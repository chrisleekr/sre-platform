import { useMemo } from 'react';
import type { TopologySubject } from '@sre/contracts';
import type { TopologyDiscoveryGraph } from '../lib/topology';
import type { CredentialGetter } from '../lib/request-credentials';
import { useTopologyImpact } from '../lib/useTopologyImpact';
import { TopologyImpact } from './TopologyImpact';

export interface TopologyAccess {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
}

/** Request impact with the selected scoped identity, not just its potentially duplicated name. */
export function TopologySubjectImpact({
  graph,
  subject,
  access,
  onSelect,
}: {
  graph: TopologyDiscoveryGraph;
  subject: TopologySubject;
  access: TopologyAccess;
  onSelect: (key: string) => void;
}) {
  const impactGraph = useMemo(() => ({ nodes: [], edges: [], discovery: graph }), [graph]);
  const impact = useTopologyImpact(
    access.apiBaseUrl,
    access.getCredentials,
    impactGraph,
    subject.kind === 'service' ? subject.name : null,
    subject.scope.environment,
    subject.key,
  );
  if (subject.kind !== 'service') return null;
  return (
    <TopologyImpact
      service={subject.name}
      result={impact.result}
      loading={impact.loading}
      error={impact.error}
      onRetry={impact.retry}
      onSelect={(name, key) => {
        if (key && graph.operational.subjects.some((item) => item.key === key)) onSelect(key);
        else window.location.assign(`/w/topology?catalogService=${encodeURIComponent(name)}`);
      }}
    />
  );
}
