import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { adminActions, users } from '../schema';

export interface AdminActionCursor {
  createdAt: string;
  id: string;
}

/**
 * Lists newest administrator audit entries with an exact keyset cursor.
 *
 * @param db - Control-plane database connection.
 * @param input - Page size, optional target filter, and keyset cursor.
 */
export async function listAdminActions(
  db: Db,
  input: { limit: number; targetKind?: string; targetId?: string; after?: AdminActionCursor },
) {
  const cursor = input.after
    ? sql`(${adminActions.createdAt}, ${adminActions.id}) < (${input.after.createdAt}::timestamptz, ${input.after.id}::uuid)`
    : undefined;
  const rows = await db
    .select({
      id: adminActions.id,
      actorUserId: adminActions.actorUserId,
      actorEmail: users.email,
      action: adminActions.action,
      targetKind: adminActions.targetKind,
      targetId: adminActions.targetId,
      reason: adminActions.reason,
      details: adminActions.details,
      createdAt: adminActions.createdAt,
      cursorCreatedAt: sql<string>`${adminActions.createdAt}::text`,
    })
    .from(adminActions)
    .innerJoin(users, eq(users.id, adminActions.actorUserId))
    .where(
      and(
        input.targetKind ? eq(adminActions.targetKind, input.targetKind) : undefined,
        input.targetId ? eq(adminActions.targetId, input.targetId) : undefined,
        cursor,
      ),
    )
    .orderBy(desc(adminActions.createdAt), desc(adminActions.id))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const tail = hasMore ? page.at(-1) : undefined;
  return {
    actions: page.map(({ cursorCreatedAt: _cursorCreatedAt, ...row }) => row),
    nextCursor: tail ? { createdAt: tail.cursorCreatedAt, id: tail.id } : null,
  };
}
