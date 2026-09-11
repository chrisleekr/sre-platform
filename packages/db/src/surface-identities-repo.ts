// Auto-attribution cache repo. Reads/writes surface_identities under tenant RLS via the app
// connection. The cache lets a repeat surface author skip the users.info round-trip; a miss is simply
// not cached, so the next reply re-resolves.
import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { memberships, surfaceIdentities } from './schema';

/**
 * Provides lookup surface identity.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param surfaceUserId - Provider-owned user identifier.
 */
export async function lookupSurfaceIdentity(
  db: Db,
  tenantId: string,
  surface: string,
  surfaceUserId: string,
): Promise<string | null> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ authorUserId: surfaceIdentities.authorUserId })
      .from(surfaceIdentities)
      // Both predicates hit memberships_user_id_tenant_id_unique (user_id, tenant_id), so a hit stays a
      // single index lookup and still skips the users.info round-trip the cache exists to avoid.
      .innerJoin(memberships, eq(memberships.userId, surfaceIdentities.authorUserId))
      .where(
        and(
          eq(surfaceIdentities.surface, surface),
          eq(surfaceIdentities.surfaceUserId, surfaceUserId),
          eq(memberships.tenantId, tenantId),
        ),
      )
      .limit(1),
  );
  return rows[0]?.authorUserId ?? null;
}

export interface NewSurfaceIdentity {
  surface: string;
  surfaceUserId: string;
  authorUserId: string;
  /** Provenance; defaults to 'auto' (email match). */
  source?: string;
}

/**
 * Provides persist surface identity.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function persistSurfaceIdentity(
  db: Db,
  tenantId: string,
  input: NewSurfaceIdentity,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .insert(surfaceIdentities)
      // Trusted tenantId last so an input field can never override the session tenant.
      .values({ ...input, source: input.source ?? 'auto', tenantId })
      .onConflictDoNothing({
        target: [
          surfaceIdentities.tenantId,
          surfaceIdentities.surface,
          surfaceIdentities.surfaceUserId,
        ],
      }),
  );
}
