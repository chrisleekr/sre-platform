import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  DirectoryAccessDeniedError,
  linkDirectoryAccount,
  resolveDirectoryAccountForSignIn,
} from './directory-repo';
import type { Identity } from './identity-repo';
import { users, type UserStatus } from './schema';

export interface SignInUser {
  userId: string;
  status: UserStatus;
  notBefore: Date | null;
}

export interface SignInIdentity extends Identity {
  providerId?: string;
  emailVerified?: boolean;
}

export type SignInResult = SignInUser | { status: 'directory_unverified' };

/**
 * Upserts a verified identity and records sign-in activity at most once per minute.
 *
 * @param db - Control-plane application connection used for identity persistence.
 * @param identity - Verified provider identity from the token.
 */
export function upsertUserForSignIn(
  db: Db,
  identity: SignInIdentity & { providerId: string },
): Promise<SignInResult>;
/**
 * Upserts an identity when no provider-scoped directory policy is available.
 *
 * @param db - Control-plane application connection used for identity persistence.
 * @param identity - Verified legacy identity from the token.
 */
export function upsertUserForSignIn(db: Db, identity: Identity): Promise<SignInUser>;
/**
 * Applies directory policy and persists a verified sign-in identity atomically.
 *
 * @param db - Control-plane application connection used for identity persistence.
 * @param identity - Verified provider identity from the token.
 */
export async function upsertUserForSignIn(db: Db, identity: SignInIdentity): Promise<SignInResult> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.issuer, identity.issuer), eq(users.subject, identity.subject)))
        .limit(1)
        .for('update');
      const directory = identity.providerId
        ? await resolveDirectoryAccountForSignIn(tx, {
            providerId: identity.providerId,
            userId: existing?.id ?? null,
            subject: identity.subject,
            email: identity.email,
            emailVerified: identity.emailVerified === true,
          })
        : { status: 'allow' as const, accountId: null, link: false };
      if (directory.status === 'deny') throw new DirectoryAccessDeniedError();
      const [inserted] = await tx
        .insert(users)
        .values({ issuer: identity.issuer, subject: identity.subject, email: identity.email })
        .onConflictDoUpdate({
          target: [users.issuer, users.subject],
          set: { email: sql`coalesce(${identity.email ?? null}, ${users.email})` },
          setWhere: sql`${users.email} is distinct from coalesce(${identity.email ?? null}, ${users.email})`,
        })
        .returning({ id: users.id });
      const [resolved] =
        inserted || existing
          ? []
          : await tx
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.issuer, identity.issuer), eq(users.subject, identity.subject)))
              .limit(1);
      const userId = inserted?.id ?? existing?.id ?? resolved?.id;
      if (!userId) throw new Error('user upsert returned no row');
      if (directory.accountId && directory.link) {
        await linkDirectoryAccount(tx, identity.providerId!, directory.accountId, userId);
      }
      await tx
        .update(users)
        .set({ lastSignInAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(users.id, userId),
            or(
              isNull(users.lastSignInAt),
              lt(users.lastSignInAt, sql`now() - interval '1 minute'`),
            ),
          ),
        );
      const [row] = await tx
        .select({ status: users.status, notBefore: users.notBefore })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!row) throw new Error('signed-in user disappeared');
      return { userId, status: row.status, notBefore: row.notBefore };
    });
  } catch (error) {
    if (error instanceof DirectoryAccessDeniedError) return { status: 'directory_unverified' };
    throw error;
  }
}
