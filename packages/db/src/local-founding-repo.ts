import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import type { WorkspaceFounding } from './founding-repo';
import { workspaceFoundings } from './schema';

/**
 * Creates or returns the development-only founding that feeds the real provisioner.
 *
 * @param db - Administrator database connection.
 * @param input - Local provider and founder identity.
 */
export async function ensureLocalProvisioningFounding(
  db: Db,
  input: { providerId: string; founderUserId: string; requestedName: string },
): Promise<WorkspaceFounding> {
  const inserted = await db
    .insert(workspaceFoundings)
    .values({
      path: 'own_directory',
      slug: 'local-dev',
      requestedName: input.requestedName,
      providerId: input.providerId,
      founderUserId: input.founderUserId,
      status: 'provisioning',
      expiresAt: null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  const rows = await db
    .select()
    .from(workspaceFoundings)
    .where(
      and(
        eq(workspaceFoundings.slug, 'local-dev'),
        inArray(workspaceFoundings.status, ['provisioning', 'active']),
      ),
    )
    .limit(1);
  const founding = rows[0];
  if (
    !founding ||
    founding.providerId !== input.providerId ||
    founding.founderUserId !== input.founderUserId
  ) {
    throw new Error('local-dev workspace address belongs to another founding');
  }
  return founding;
}

/**
 * Backfills the active local founding for a development database created by an older release.
 *
 * @param db - Administrator database connection.
 * @param input - Existing local provider, founder, and workspace identity.
 */
export async function ensureActiveLocalFounding(
  db: Db,
  input: {
    providerId: string;
    founderUserId: string;
    tenantId: string;
    requestedName: string;
  },
): Promise<void> {
  const rows = await db
    .insert(workspaceFoundings)
    .values({
      path: 'own_directory',
      slug: 'local-dev',
      requestedName: input.requestedName,
      providerId: input.providerId,
      founderUserId: input.founderUserId,
      tenantId: input.tenantId,
      status: 'active',
      expiresAt: null,
    })
    .onConflictDoNothing()
    .returning({ id: workspaceFoundings.id });
  if (rows[0]) return;
  const existing = await db
    .select({ tenantId: workspaceFoundings.tenantId })
    .from(workspaceFoundings)
    .where(
      and(
        eq(workspaceFoundings.slug, 'local-dev'),
        inArray(workspaceFoundings.status, ['provisioning', 'active']),
      ),
    )
    .limit(1);
  if (existing[0]?.tenantId !== input.tenantId) {
    throw new Error('local-dev workspace address belongs to another founding');
  }
}
