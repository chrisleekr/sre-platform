import { memberships, surfaceIdentities, withTenant, type Db } from '@sre/db';
import type { HubMessage } from '@sre/hub';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * Resolves unambiguous Slack sender IDs from retained attribution, never message content.
 * @param db - Tenant-scoped database connection.
 * @param tenantId - Authorized incident tenant.
 * @param messages - Authorized history page.
 */
export async function slackAuthors(db: Db, tenantId: string, messages: HubMessage[]) {
  const ids = [
    ...new Set(
      messages
        .filter((message) => message.originSurface === 'slack' && message.author === 'human')
        .flatMap((message) => (message.authorUserId ? [message.authorUserId] : [])),
    ),
  ];
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        userId: surfaceIdentities.authorUserId,
        slackId: surfaceIdentities.surfaceUserId,
      })
      .from(surfaceIdentities)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, surfaceIdentities.authorUserId),
          eq(memberships.tenantId, tenantId),
          eq(memberships.status, 'active'),
        ),
      )
      .where(
        and(eq(surfaceIdentities.surface, 'slack'), inArray(surfaceIdentities.authorUserId, ids)),
      ),
  );
  for (const message of messages) {
    const matches = rows.filter((row) => row.userId === message.authorUserId);
    if (matches.length === 1) result.set(message.id, matches[0]!.slackId);
  }
  return result;
}
