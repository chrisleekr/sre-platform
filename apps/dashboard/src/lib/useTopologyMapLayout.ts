import { useEffect, useState } from 'react';
import ELK, { type ElkNode } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import {
  topologyLayoutGraph,
  topologyLayoutResult,
  type MapLayout,
  type MapProjection,
} from './topology-map-layout';

/** Lay out off the UI thread; discard results from an obsolete scope or selection. */
export function useTopologyMapLayout(model: MapProjection) {
  const signature = JSON.stringify(topologyLayoutGraph(model));
  const [result, setResult] = useState<{
    signature: string;
    layout?: MapLayout;
    error?: boolean;
  }>();
  useEffect(() => {
    let current = true;
    let elk: InstanceType<typeof ELK> | undefined;
    const fail = () => {
      if (current) setResult({ signature, error: true });
    };
    try {
      elk = new ELK({
        algorithms: ['layered'],
        workerFactory: () => {
          const worker = new Worker(workerUrl);
          worker.addEventListener('error', fail);
          return worker;
        },
      });
      void elk
        .layout(JSON.parse(signature) as ElkNode)
        .then((graph) => {
          if (current) setResult({ signature, layout: topologyLayoutResult(graph) });
        })
        .catch(fail);
    } catch {
      fail();
    }
    return () => {
      current = false;
      elk?.terminateWorker();
    };
  }, [signature]);
  return result?.signature === signature ? result : undefined;
}
