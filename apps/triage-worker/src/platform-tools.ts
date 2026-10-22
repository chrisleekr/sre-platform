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
  makeRecordLearningTool,
} from '@sre/agent-tools';
import { makeBlamelessCleaner, tenantMemberEmails } from './blameless';

/**
 * Bind the run-scoped record_learning tool. Its statements are stripped of the tenant's member
 * identifiers before they reach shared memory.
 *
 * @param deps - Store, local embedder, and an optional member email lister for tests.
 */
export function makeLearningTool({
  db,
  embedder,
  listMemberEmails = (tenantId) => tenantMemberEmails(db, tenantId),
}: {
  db: Db;
  embedder: Embedder;
  listMemberEmails?: (tenantId: string) => Promise<string[]>;
}) {
  return makeRecordLearningTool({
    db,
    embedder,
    clean: makeBlamelessCleaner(listMemberEmails),
    cleanTopic: makeBlamelessCleaner(listMemberEmails, false),
  });
}

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
