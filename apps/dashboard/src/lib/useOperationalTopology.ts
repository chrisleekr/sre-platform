import { useEffect, useMemo, useState } from 'react';
import { operationalTopologyGraph, scopeTopologyGraph, type TopologyGraph } from './topology';

/** Age cached health periodically without rescanning runtime on search or selection changes. */
export function useOperationalTopology(graph: TopologyGraph, environment: string) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return useMemo(
    () =>
      operationalTopologyGraph(
        scopeTopologyGraph(graph, environment),
        graph.incidents ?? [],
        Date.now(),
      ),
    [graph, environment, tick],
  );
}
