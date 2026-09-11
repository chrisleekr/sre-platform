import {
  listIncidentTags,
  listIncidentTagSuggestions,
  listPendingIncidentTagSuggestions,
  listTenantTagLinkRules,
  type Db,
} from '@sre/db';

/** Reads the tags and link policy rendered with one incident workspace. */
export async function readIncidentTagContext(db: Db, tenantId: string, incidentId: string) {
  const [tags, tagSuggestions, tagLinkRules, tagHistorySuggestions] = await Promise.all([
    listIncidentTags(db, tenantId, incidentId),
    listPendingIncidentTagSuggestions(db, tenantId, incidentId),
    listTenantTagLinkRules(db, tenantId),
    listIncidentTagSuggestions(db, tenantId, { limit: 20 }),
  ]);
  return { tags, tagSuggestions, tagLinkRules, tagHistorySuggestions };
}
