import type { Db, Embedder } from '@sre/db';
import type { SnapshotCache } from '@sre/queue';
import {
  makeSearchRunbooksTool,
  makeFetchBlastRadiusTool,
  makeReadTopologyRuntimeTool,
  makeReadTopologySourcesTool,
  makeReadTopologyEndpointTool,
  makeReadTopologySourceFileTool,
  makeFetchRecentDeploysTool,
  makeInvestigateCodeTool,
  makeResolveEntityContextTool,
  makeSearchIncidentEvidenceTool,
  makeFetchSloStatusTool,
} from '@sre/agent-tools';

/** Bind platform tools independently of which connectors a tenant has enabled. */
export function makePlatformTools({
  db,
  embedder,
  cache,
}: {
  db: Db;
  embedder: Embedder;
  cache: SnapshotCache;
}) {
  return [
    makeSearchRunbooksTool({ embedder, db }),
    makeFetchBlastRadiusTool({ db }),
    makeReadTopologyRuntimeTool({
      db,
      read: (tenantId, source) => cache.get(tenantId, source.type, source),
    }),
    makeReadTopologySourcesTool({ db }),
    makeReadTopologyEndpointTool({ db }),
    makeReadTopologySourceFileTool({ db }),
    makeFetchRecentDeploysTool({ db }),
    makeInvestigateCodeTool({ db }),
    makeResolveEntityContextTool({ db }),
    makeSearchIncidentEvidenceTool({ db }),
    makeFetchSloStatusTool({ db }),
  ];
}
