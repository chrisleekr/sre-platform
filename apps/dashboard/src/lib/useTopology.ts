import type { CredentialGetter } from './request-credentials';
import { useCallback, useState } from 'react';
import type { TopologyGraph, BlastRadius } from './topology';
import { authenticatedFetch } from './authenticatedFetch';
import { checkResponse } from './request-error';
import { useFetchResource } from './useFetchResource';

export interface UseTopology {
  graph: TopologyGraph;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

/** Matches connector polling, so runtime health and incident-derived inventory refresh together. */
const POLL_MS = 30_000;

const EMPTY: TopologyGraph = { nodes: [], edges: [], infrastructure: [] };
const selectGraph = (body: unknown): TopologyGraph => {
  const graph = body as TopologyGraph;
  return {
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
    infrastructure: graph.infrastructure ?? [],
    ...(graph.incidentMappings ? { incidentMappings: graph.incidentMappings } : {}),
    ...(graph.incidents ? { incidents: graph.incidents } : {}),
    ...(graph.coverage ? { coverage: graph.coverage } : {}),
    ...(graph.runtimeBindings ? { runtimeBindings: graph.runtimeBindings } : {}),
    ...(graph.historicalAt ? { historicalAt: graph.historicalAt } : {}),
    ...(graph.discovery ? { discovery: graph.discovery } : {}),
  };
};

/**
 * Fetch the tenant's service graph from the API and re-poll on an interval (there is no dashboard WS;
 * topology and runtime inventory change on the connector cadence). The token authorizes and scopes the read. `loading`
 * is only true for the first load, and the last-good graph is retained on a transient poll error, so a
 * background poll never flickers or blanks the panel (the shared useFetchResource poll variant).
 */
export function useTopology(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  pollMs?: number;
  at?: string;
}): UseTopology {
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((value) => value + 1), []);
  const { data, loading, error } = useFetchResource<TopologyGraph>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: `/topology/graph${opts.at ? `?at=${encodeURIComponent(opts.at)}` : ''}`,
    initial: EMPTY,
    select: selectGraph,
    pollMs: opts.pollMs ?? POLL_MS,
    nonce,
  });
  const sameTime = (data.historicalAt ?? '') === (opts.at ?? '');
  return {
    graph: sameTime ? data : { ...EMPTY, ...(opts.at ? { historicalAt: opts.at } : {}) },
    loading,
    error,
    refetch,
  };
}

async function topologyMutation(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  path: string,
  body: unknown,
  method: 'PUT' | 'DELETE' = 'PUT',
): Promise<void> {
  const res = await authenticatedFetch(`${apiBaseUrl}${path}`, getCredentials, {
    method,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  await checkResponse(res, 'Topology update failed. Refresh and retry.');
}

export async function saveTopologyService(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  input: { name: string; team: string | null; criticality: string | null },
): Promise<void> {
  await topologyMutation(
    apiBaseUrl,
    getCredentials,
    `/topology/services/${encodeURIComponent(input.name)}`,
    {
      team: input.team,
      criticality: input.criticality,
    },
  );
}

export async function saveTopologyDependency(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  input: {
    upstream: string;
    downstream: string;
    syncType: 'sync' | 'async';
    circuitBreaker: boolean;
    protocol?: string | null;
    environment?: string;
    rationale?: string | null;
  },
): Promise<void> {
  await topologyMutation(apiBaseUrl, getCredentials, '/topology/dependencies', input);
}

/** Remove a declared relationship without deleting either service. */
export async function deleteTopologyDependency(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  input: { upstream: string; downstream: string; environment?: string },
): Promise<void> {
  await topologyMutation(apiBaseUrl, getCredentials, '/topology/dependencies', input, 'DELETE');
}

/** Remove only the catalog entry; live sources can still show the service. */
export async function deleteTopologyService(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  name: string,
): Promise<void> {
  await topologyMutation(
    apiBaseUrl,
    getCredentials,
    `/topology/services/${encodeURIComponent(name)}`,
    undefined,
    'DELETE',
  );
}

/**
 * Fetch dependency impact for one service. The caller refreshes on selection or catalog changes
 * and presents failures without blanking the service graph.
 */
export async function fetchBlastRadius(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  service: string,
  environment?: string,
  subjectKey?: string,
): Promise<BlastRadius> {
  const res = await authenticatedFetch(
    `${apiBaseUrl}/topology/blast-radius?service=${encodeURIComponent(service)}${environment ? `&environment=${encodeURIComponent(environment)}` : ''}${subjectKey ? `&subjectKey=${encodeURIComponent(subjectKey)}` : ''}`,
    getCredentials,
  );
  await checkResponse(res, 'Could not load dependency impact. Try again.');
  return (await res.json()) as BlastRadius;
}
