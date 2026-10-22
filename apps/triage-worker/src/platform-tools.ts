import { incidentMessages, withTenant, type Db, type Embedder } from '@sre/db';
import { eq } from 'drizzle-orm';
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
import {
  collectHumanIdentifiers,
  stripHumanIdentifiers,
  tenantMemberEmails,
  topicNamesPerson,
} from './blameless';

/**
 * Bind the run-scoped record_learning tool. Its topic and statement are checked against the tenant's
 * member identifiers and the mention labels in the incident's conversation, as the distil does.
 *
 * @param deps - Store, local embedder, and optional member email and conversation readers for tests.
 */
export function makeLearningTool({
  db,
  embedder,
  listMemberEmails = (tenantId) => tenantMemberEmails(db, tenantId),
  readConversation = (tenantId, incidentId) => incidentConversation(db, tenantId, incidentId),
}: {
  db: Db;
  embedder: Embedder;
  listMemberEmails?: (tenantId: string) => Promise<string[]>;
  readConversation?: (tenantId: string, incidentId: string) => Promise<string>;
}) {
  const identifiers = async (tenantId: string, incidentId: string, text: string) =>
    collectHumanIdentifiers(
      await listMemberEmails(tenantId),
      `${await readConversation(tenantId, incidentId)}\n${text}`,
    );
  return makeRecordLearningTool({
    db,
    embedder,
    clean: async (tenantId, incidentId, text) =>
      stripHumanIdentifiers(text, await identifiers(tenantId, incidentId, text)),
    // record_learning refuses a topic this changes; the empty string marks one that names a person.
    cleanTopic: async (tenantId, incidentId, topic) =>
      topicNamesPerson(
        await listMemberEmails(tenantId),
        topic,
        await readConversation(tenantId, incidentId),
      )
        ? ''
        : topic,
  });
}

async function incidentConversation(db: Db, tenantId: string, incidentId: string): Promise<string> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ content: incidentMessages.content })
      .from(incidentMessages)
      .where(eq(incidentMessages.incidentId, incidentId)),
  );
  return rows.map((row) => row.content).join('\n');
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
