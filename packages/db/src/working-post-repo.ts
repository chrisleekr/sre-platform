import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { surfaceWorkingPosts } from './schema';

// Working-post repo: the conversation binding's mutable message id. All
// reads/writes go through withTenant (RLS), so one tenant can never read or clobber another's post.

/**
 * The conversation's current working-post message id, or null when none is open.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param bindingId - Surface binding targeted by the operation.
 */
export async function getWorkingPost(
  db: Db,
  tenantId: string,
  bindingId: string,
): Promise<string | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ messageTs: surfaceWorkingPosts.messageTs })
      .from(surfaceWorkingPosts)
      .where(eq(surfaceWorkingPosts.bindingId, bindingId))
      .limit(1);
    return rows[0]?.messageTs ?? null;
  });
}

/**
 * Upsert the working-post message id for one bound conversation.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param bindingId - Surface binding targeted by the operation.
 * @param messageTs - Value supplied for message ts.
 */
export async function setWorkingPost(
  db: Db,
  tenantId: string,
  bindingId: string,
  messageTs: string,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .insert(surfaceWorkingPosts)
      .values({ tenantId, bindingId, messageTs })
      .onConflictDoUpdate({
        target: [surfaceWorkingPosts.tenantId, surfaceWorkingPosts.bindingId],
        set: { messageTs },
      }),
  );
}

/**
 * Clear the working post once the turn concludes (agent reply/finding) or is dropped (silent).
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param bindingId - Surface binding targeted by the operation.
 */
export async function clearWorkingPost(db: Db, tenantId: string, bindingId: string): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.delete(surfaceWorkingPosts).where(eq(surfaceWorkingPosts.bindingId, bindingId)),
  );
}
