import { and, asc, count as countRows, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Tx } from './rls';
import {
  directoryAccountLinks,
  directoryAccounts,
  identityProviders,
  users,
  type DirectoryEmail,
  type DirectoryName,
} from './schema';

export interface DirectoryAccountInput {
  externalId: string | null;
  userName: string;
  active: boolean;
  name: DirectoryName;
  emails: DirectoryEmail[];
}

export interface DirectoryAccountFilter {
  attribute: 'externalId' | 'userName';
  value: string;
}

export interface DirectoryMutationResult {
  account: typeof directoryAccounts.$inferSelect;
  revokedUserIds: string[];
}

/** Stable denial used to roll back unsafe directory link attempts. */
export class DirectoryAccessDeniedError extends Error {
  constructor() {
    super('directory account unavailable');
  }
}

/** Reads the provider credential and SCIM policy without exposing another provider's accounts.
 * @param db - Control-plane database connection.
 * @param providerId - Provider whose SCIM policy is requested.
 */
export async function getScimProvider(db: Db, providerId: string) {
  const [provider] = await db
    .select({
      id: identityProviders.id,
      status: identityProviders.status,
      kind: identityProviders.kind,
      browserClientId: identityProviders.browserClientId,
      scimEnabled: identityProviders.scimEnabled,
      scimTokenHash: identityProviders.scimTokenHash,
      scimTokenExpiresAt: identityProviders.scimTokenExpiresAt,
    })
    .from(identityProviders)
    .where(eq(identityProviders.id, providerId))
    .limit(1);
  return provider ?? null;
}

/** Lists one bounded page of current SCIM Users owned by a provider.
 * @param db - Control-plane database connection.
 * @param providerId - Provider that owns the accounts.
 * @param options - Validated page and optional equality filter.
 */
export async function listDirectoryAccounts(
  db: Db,
  providerId: string,
  options: { startIndex: number; count: number; filter?: DirectoryAccountFilter },
) {
  const filter = options.filter
    ? options.filter.attribute === 'externalId'
      ? eq(directoryAccounts.externalId, options.filter.value)
      : sql`lower(${directoryAccounts.userName}) = lower(${options.filter.value})`
    : undefined;
  const where = and(
    eq(directoryAccounts.providerId, providerId),
    isNull(directoryAccounts.deletedAt),
    filter,
  );
  const [total] = await db.select({ value: countRows() }).from(directoryAccounts).where(where);
  const accounts = await db
    .select()
    .from(directoryAccounts)
    .where(where)
    .orderBy(asc(directoryAccounts.createdAt), asc(directoryAccounts.id))
    .limit(options.count)
    .offset(options.startIndex - 1);
  return { total: Number(total?.value ?? 0), accounts };
}

/** Reads one current SCIM User owned by a provider.
 * @param db - Control-plane database connection.
 * @param providerId - Provider that owns the account.
 * @param accountId - Server-issued SCIM resource identifier.
 */
export async function getDirectoryAccount(db: Db, providerId: string, accountId: string) {
  const [account] = await db
    .select()
    .from(directoryAccounts)
    .where(
      and(
        eq(directoryAccounts.id, accountId),
        eq(directoryAccounts.providerId, providerId),
        isNull(directoryAccounts.deletedAt),
      ),
    )
    .limit(1);
  return account ?? null;
}

/** Creates one current provider-scoped SCIM User.
 * @param db - Control-plane database connection.
 * @param providerId - Provider that will own the account.
 * @param input - Validated SCIM User attributes.
 */
export async function createDirectoryAccount(
  db: Db,
  providerId: string,
  input: DirectoryAccountInput,
) {
  const [account] = await db
    .insert(directoryAccounts)
    .values({ providerId, ...input })
    .returning();
  if (!account) throw new Error('directory account insert returned no row');
  return account;
}

async function updateDirectoryAccountTx(
  tx: Tx,
  providerId: string,
  accountId: string,
  input: DirectoryAccountInput,
  deleted: boolean,
): Promise<DirectoryMutationResult | null> {
  const [current] = await tx
    .select()
    .from(directoryAccounts)
    .where(
      and(
        eq(directoryAccounts.id, accountId),
        eq(directoryAccounts.providerId, providerId),
        isNull(directoryAccounts.deletedAt),
      ),
    )
    .limit(1)
    .for('update');
  if (!current) return null;
  const [account] = await tx
    .update(directoryAccounts)
    .set({
      ...input,
      active: deleted ? false : input.active,
      deletedAt: deleted ? sql`clock_timestamp()` : null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(directoryAccounts.id, current.id))
    .returning();
  if (!account) throw new Error('directory account update returned no row');
  const deactivated = current.active && (!account.active || account.deletedAt !== null);
  if (!deactivated) return { account, revokedUserIds: [] };
  const links = await tx
    .select({ userId: directoryAccountLinks.userId })
    .from(directoryAccountLinks)
    .where(eq(directoryAccountLinks.directoryAccountId, current.id));
  const revokedUserIds = links.map(({ userId }) => userId);
  if (revokedUserIds.length) {
    await tx
      .update(users)
      .set({ notBefore: sql`clock_timestamp()` })
      .where(eq(users.id, revokedUserIds[0]!));
  }
  return { account, revokedUserIds };
}

/** Replaces one current SCIM User and advances linked access when deactivated.
 * @param db - Control-plane database connection.
 * @param providerId - Provider that owns the account.
 * @param accountId - Server-issued SCIM resource identifier.
 * @param input - Complete replacement attributes.
 */
export function replaceDirectoryAccount(
  db: Db,
  providerId: string,
  accountId: string,
  input: DirectoryAccountInput,
) {
  return db.transaction((tx) => updateDirectoryAccountTx(tx, providerId, accountId, input, false));
}

/** Tombstones one SCIM User and advances linked access in the same transaction.
 * @param db - Control-plane database connection.
 * @param providerId - Provider that owns the account.
 * @param accountId - Server-issued SCIM resource identifier.
 */
export function deleteDirectoryAccount(db: Db, providerId: string, accountId: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(directoryAccounts)
      .where(
        and(
          eq(directoryAccounts.id, accountId),
          eq(directoryAccounts.providerId, providerId),
          isNull(directoryAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (!current) return null;
    return updateDirectoryAccountTx(tx, providerId, accountId, current, true);
  });
}

async function candidates(
  tx: Tx,
  providerId: string,
  condition: ReturnType<typeof eq> | ReturnType<typeof sql>,
) {
  return tx
    .select({ id: directoryAccounts.id })
    .from(directoryAccounts)
    .leftJoin(
      directoryAccountLinks,
      eq(directoryAccountLinks.directoryAccountId, directoryAccounts.id),
    )
    .where(
      and(
        eq(directoryAccounts.providerId, providerId),
        eq(directoryAccounts.active, true),
        isNull(directoryAccounts.deletedAt),
        isNull(directoryAccountLinks.userId),
        condition,
      ),
    )
    .orderBy(desc(directoryAccounts.updatedAt))
    .limit(2)
    .for('update', { of: directoryAccounts });
}

/** Resolves the sole safe SCIM account for a verified sign-in identity.
 * @param tx - Sign-in transaction that owns account linking.
 * @param input - Provider, stable identity and verified-email evidence.
 */
export async function resolveDirectoryAccountForSignIn(
  tx: Tx,
  input: {
    providerId: string;
    userId: string | null;
    subject: string;
    email?: string;
    emailVerified: boolean;
  },
): Promise<{ status: 'allow'; accountId: string | null; link: boolean } | { status: 'deny' }> {
  if (input.userId) {
    const [linked] = await tx
      .select({
        accountId: directoryAccounts.id,
        active: directoryAccounts.active,
        deletedAt: directoryAccounts.deletedAt,
      })
      .from(directoryAccountLinks)
      .innerJoin(
        directoryAccounts,
        eq(directoryAccounts.id, directoryAccountLinks.directoryAccountId),
      )
      .where(
        and(
          eq(directoryAccountLinks.providerId, input.providerId),
          eq(directoryAccountLinks.userId, input.userId),
        ),
      )
      .limit(1);
    if (linked) {
      return linked.active && !linked.deletedAt
        ? { status: 'allow', accountId: linked.accountId, link: false }
        : { status: 'deny' };
    }
  }
  const [provider] = await tx
    .select({
      enabled: identityProviders.scimEnabled,
      required: identityProviders.requireProvisioned,
      identityAttribute: identityProviders.scimIdentityAttribute,
    })
    .from(identityProviders)
    .where(eq(identityProviders.id, input.providerId))
    .limit(1);
  if (!provider?.enabled) return { status: 'allow', accountId: null, link: false };
  const subjectMatch =
    provider.identityAttribute === 'externalId'
      ? eq(directoryAccounts.externalId, input.subject)
      : sql`lower(${directoryAccounts.userName}) = lower(${input.subject})`;
  let matches = await candidates(tx, input.providerId, subjectMatch);
  if (matches.length === 0 && input.emailVerified && input.email) {
    matches = await candidates(
      tx,
      input.providerId,
      or(
        sql`lower(${directoryAccounts.userName}) = lower(${input.email})`,
        sql`exists (select 1 from jsonb_array_elements(${directoryAccounts.emails}) email where lower(email->>'value') = lower(${input.email}))`,
      )!,
    );
  }
  if (matches.length === 1) return { status: 'allow', accountId: matches[0]!.id, link: true };
  return provider.required ? { status: 'deny' } : { status: 'allow', accountId: null, link: false };
}

/** Claims the selected account for a user or aborts the sign-in transaction on a race.
 * @param tx - Sign-in transaction that owns the claim.
 * @param providerId - Provider shared by the account and user link.
 * @param accountId - Directory account being claimed.
 * @param userId - Canonical platform user claiming the account.
 */
export async function linkDirectoryAccount(
  tx: Tx,
  providerId: string,
  accountId: string,
  userId: string,
): Promise<void> {
  const [link] = await tx
    .insert(directoryAccountLinks)
    .values({ providerId, directoryAccountId: accountId, userId })
    .onConflictDoNothing()
    .returning({ userId: directoryAccountLinks.userId });
  if (!link) throw new DirectoryAccessDeniedError();
}
