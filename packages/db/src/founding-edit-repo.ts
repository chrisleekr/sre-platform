import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { createOidcWorkspaceFounding } from './founding-oidc-repo';
import { identityProviders, mailboxProofs, workspaceFoundings } from './schema';

/** Returns a browser-owned draft only before workspace creation has been submitted.
 * @param db - Control-plane database.
 * @param id - Exact setup request protected by the browser edit permission.
 */
export async function getEditableFounding(db: Db, id: string) {
  return editableFounding(db, eq(workspaceFoundings.id, id));
}

/** Finds an editable draft by address before checking its browser credential.
 * @param db - Control-plane database.
 * @param slug - Exact normalized workspace address.
 */
export async function getEditableFoundingBySlug(db: Db, slug: string) {
  return editableFounding(db, eq(workspaceFoundings.slug, slug));
}

export type FoundingEditDisposition = 'authentication' | 'continue' | 'expired' | 'unavailable';

/** Classifies a browser-owned request that is no longer editable.
 * @param db - Control-plane database.
 * @param id - Exact setup request protected by the browser edit permission.
 */
export async function getFoundingEditState(
  db: Db,
  id: string,
): Promise<{ disposition: FoundingEditDisposition; providerId: string | null }> {
  const [row] = await db
    .select({
      status: workspaceFoundings.status,
      expiresAt: workspaceFoundings.expiresAt,
      providerId: workspaceFoundings.providerId,
      providerExpiresAt: identityProviders.expiresAt,
    })
    .from(workspaceFoundings)
    .leftJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
    .where(eq(workspaceFoundings.id, id))
    .limit(1);
  if (!row) return { disposition: 'unavailable', providerId: null };
  const expired =
    row.status === 'expired' ||
    (row.status !== 'active' &&
      (!row.expiresAt ||
        row.expiresAt.getTime() <= Date.now() ||
        !row.providerExpiresAt ||
        row.providerExpiresAt.getTime() <= Date.now()));
  if (expired) return { disposition: 'expired', providerId: row.providerId };
  if (row.status === 'authenticating_founder') {
    return { disposition: 'authentication', providerId: row.providerId };
  }
  return {
    disposition: ['pending', 'approved', 'provisioning', 'active', 'failed'].includes(row.status)
      ? 'continue'
      : 'unavailable',
    providerId: row.providerId,
  };
}

async function editableFounding(db: Db, target: ReturnType<typeof eq>) {
  const [row] = await db
    .select({ founding: workspaceFoundings, provider: identityProviders })
    .from(workspaceFoundings)
    .innerJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
    .where(
      and(
        target,
        inArray(workspaceFoundings.status, ['awaiting_founder', 'founder_authenticated']),
        isNull(workspaceFoundings.tenantId),
        gt(workspaceFoundings.expiresAt, sql`clock_timestamp()`),
        eq(identityProviders.status, 'provisional'),
        eq(identityProviders.scope, 'tenant'),
        gt(identityProviders.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Replaces draft credentials and invalidates old callbacks in one transaction.
 * @param db - Control-plane database.
 * @param id - Browser-owned setup to update.
 * @param expectedProviderId - Version guard against concurrent edits or identity completion.
 * @param providerId - New provider whose secret has already been stored under a unique key.
 * @param input - Validated workspace and discovered directory metadata.
 */
export async function replaceFoundingDraft(
  db: Db,
  id: string,
  expectedProviderId: string,
  providerId: string,
  input: Parameters<typeof createOidcWorkspaceFounding>[1],
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: workspaceFoundings.id })
      .from(workspaceFoundings)
      .where(eq(workspaceFoundings.id, id))
      .for('update');
    const row = await getEditableFounding(tx as Db, id);
    if (!row || row.provider.id !== expectedProviderId) return null;
    await tx.insert(identityProviders).values({
      id: providerId,
      displayName: input.requestedName,
      ...input.metadata,
      audience: input.apiAudience,
      browserClientId: input.clientId,
      clientAuthentication: input.clientAuthentication,
      subjectClaim: input.subjectClaim,
      authorizationScopes: input.authorizationScopes,
      authorizationAudience: input.authorizationAudience,
      kind: 'oidc',
      scope: 'tenant',
      status: 'provisional',
      expiresAt: row.provider.expiresAt,
    });
    await tx
      .update(workspaceFoundings)
      .set({
        slug: input.slug,
        requestedName: input.requestedName,
        declaredDomain: input.declaredDomain,
        providerId,
        status: 'awaiting_founder',
        founderUserId: null,
        authAttemptId: null,
        authAttemptStartedAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workspaceFoundings.id, id));
    await tx.delete(mailboxProofs).where(sql`${mailboxProofs.identity}->>'foundingId' = ${id}`);
    await tx.delete(identityProviders).where(eq(identityProviders.id, expectedProviderId));
    return { providerId, foundingId: id };
  });
}
