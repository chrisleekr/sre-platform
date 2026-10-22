import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { activeResponderTx } from './membership-repo';
import { incidentMessages, knowledgeChunks } from './schema';

/** One saved learning, as the workspace reviews it. */
export interface KnowledgeFact {
  id: string;
  topic: string | null;
  /** Statement, then a `Basis:` line naming observed, responder or hypothesis and its source. */
  content: string;
  occurrenceCount: number;
  sourceIncidentIds: string[];
  updatedAt: Date;
}

/**
 * Lists the tenant's saved learnings, most recently changed first.
 *
 * @param db - RLS-scoped connection.
 * @param tenantId - Workspace whose facts are listed.
 * @param limit - Maximum rows.
 */
export async function listKnowledgeFacts(
  db: Db,
  tenantId: string,
  limit: number,
): Promise<KnowledgeFact[]> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: knowledgeChunks.id,
        topic: knowledgeChunks.title,
        content: knowledgeChunks.content,
        occurrenceCount: knowledgeChunks.occurrenceCount,
        sourceIncidentIds: knowledgeChunks.sourceIncidentIds,
        updatedAt: knowledgeChunks.updatedAt,
      })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.category, 'fact'))
      .orderBy(desc(knowledgeChunks.updatedAt), desc(knowledgeChunks.id))
      .limit(limit),
  );
  return rows.map((row) => ({ ...row, sourceIncidentIds: row.sourceIncidentIds as string[] }));
}

/**
 * Deletes one saved learning. An owner or administrator may always delete; anyone else must be an
 * active responder, the same check that gates other responder changes.
 *
 * @param db - RLS-scoped connection.
 * @param tenantId - Workspace that owns the fact.
 * @param factId - Fact to delete; another category or another tenant's row is not found.
 * @param actor - The caller's user id and whether their role is owner or admin.
 */
export async function deleteKnowledgeFact(
  db: Db,
  tenantId: string,
  factId: string,
  actor: { userId?: string | null; admin: boolean },
): Promise<'deleted' | 'not_found' | 'forbidden'> {
  return withTenant(db, tenantId, async (tx) => {
    if (!actor.admin && !(await activeResponderTx(tx, tenantId, actor.userId))) return 'forbidden';
    const deleted = await tx
      .delete(knowledgeChunks)
      .where(and(eq(knowledgeChunks.id, factId), eq(knowledgeChunks.category, 'fact')))
      .returning({ id: knowledgeChunks.id });
    return deleted.length > 0 ? 'deleted' : 'not_found';
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cited messages that an active workspace member wrote in this incident, in cited order. A human
 * line with no member attribution can come from anyone who can post in the thread.
 *
 * @param db - RLS-scoped connection.
 * @param tenantId - Workspace that owns the incident.
 * @param incidentId - Incident whose conversation is checked.
 * @param proposed - Cited message ids; a malformed id is dropped rather than sent to Postgres.
 */
export async function filterIncidentMemberMessageIds(
  db: Db,
  tenantId: string,
  incidentId: string,
  proposed: string[],
): Promise<string[]> {
  const unique = [...new Set(proposed)].filter((id) => UUID.test(id));
  if (unique.length === 0) return [];
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: incidentMessages.id, authorUserId: incidentMessages.authorUserId })
      .from(incidentMessages)
      .where(
        and(
          eq(incidentMessages.incidentId, incidentId),
          inArray(incidentMessages.id, unique),
          eq(incidentMessages.author, 'human'),
          isNotNull(incidentMessages.authorUserId),
        ),
      );
    const allowed = new Set<string>();
    // Membership is checked now: a removed member's earlier lines no longer vouch for a fact.
    for (const row of rows)
      if (await activeResponderTx(tx, tenantId, row.authorUserId)) allowed.add(row.id);
    return unique.filter((id) => allowed.has(id));
  });
}
