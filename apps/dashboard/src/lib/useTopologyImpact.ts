import { useEffect, useMemo, useRef, useState } from 'react';
import type { CredentialGetter } from './request-credentials';
import type { BlastRadius, TopologyGraph } from './topology';
import { fetchBlastRadius } from './useTopology';

/** Refresh impact when its service or registered graph changes, discarding superseded responses. */
export function useTopologyImpact(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  graph: TopologyGraph,
  service: string | null,
  environment?: string,
  subjectKey?: string,
) {
  const [result, setResult] = useState<BlastRadius | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [resultKey, setResultKey] = useState('');
  const queryKey = JSON.stringify([apiBaseUrl, service, environment, subjectKey]);
  const credentials = useRef(getCredentials);
  credentials.current = getCredentials;
  const revision = useMemo(
    () =>
      JSON.stringify([
        graph.nodes.map((node) => [node.name, node.team, node.criticality, node.sources]),
        graph.edges,
        graph.discovery?.operational,
      ]),
    [graph.nodes, graph.edges, graph.discovery?.operational],
  );
  useEffect(() => {
    setResult(null);
    setError(null);
    setLoading(false);
    if (!service) return;
    let active = true;
    setLoading(true);
    void fetchBlastRadius(apiBaseUrl, credentials.current, service, environment, subjectKey)
      .then((value) => {
        if (active) {
          setResult(value);
          setResultKey(queryKey);
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setResultKey(queryKey);
          setError(
            failure instanceof Error ? failure.message : 'Could not load dependency impact.',
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiBaseUrl, service, revision, nonce, environment, subjectKey, queryKey]);
  return {
    result: resultKey === queryKey ? result : null,
    loading,
    error: resultKey === queryKey ? error : null,
    retry: () => setNonce((value) => value + 1),
  };
}
