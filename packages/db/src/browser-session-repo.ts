import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Tx } from './rls';
import {
  browserSessions,
  identityProviders,
  mailboxProofs,
  oidcAttempts,
  users,
  workspaceFoundings,
  type PendingMailboxIdentity,
} from './schema';

/** Hashes a random browser credential before it reaches durable storage.
 * @param value - Credential or one-time proof.
 */
export function browserCredentialHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Returns a cryptographically random opaque browser credential. */
export function newBrowserCredential(): string {
  return randomBytes(32).toString('base64url');
}

/** Serializes credential rotation with logout of the same upstream session.
 * @param tx - Transaction holding the lock until its changes commit.
 * @param providerId - Exact provider registration.
 * @param clientId - OIDC client registration.
 * @param sessionId - Upstream session identifier, absent when the provider omits sid.
 */
export async function lockOidcSession(
  tx: Tx,
  providerId: string,
  clientId: string,
  sessionId: string | null,
): Promise<void> {
  if (sessionId === null) return;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['oidc-session', providerId, clientId, sessionId])}, 0))`,
  );
}

/** Persists a bounded authorization attempt before redirecting the browser.
 * @param db - Control-plane connection.
 * @param input - Fixed provider, callback, browser binding and PKCE context.
 */
export async function createOidcAttempt(
  db: Db,
  input: Omit<typeof oidcAttempts.$inferInsert, 'stateHash'>,
) {
  const state = newBrowserCredential();
  await db.delete(oidcAttempts).where(sql`${oidcAttempts.expiresAt} <= clock_timestamp()`);
  await db.insert(oidcAttempts).values({ ...input, stateHash: browserCredentialHash(state) });
  return state;
}

/** Atomically consumes an unexpired attempt only in its originating browser.
 * @param db - Control-plane connection.
 * @param state - Callback state.
 * @param browserCredential - Host-only attempt cookie.
 */
export async function consumeOidcAttempt(db: Db, state: string, browserCredential: string) {
  const [attempt] = await db
    .delete(oidcAttempts)
    .where(
      and(
        eq(oidcAttempts.stateHash, browserCredentialHash(state)),
        eq(oidcAttempts.browserHash, browserCredentialHash(browserCredential)),
        gt(oidcAttempts.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .returning();
  return attempt ?? null;
}

/** Creates a fresh application session without retaining upstream credentials.
 * @param db - Control-plane connection.
 * @param input - Verified identity, original authentication time and configured bounds.
 */
export async function createBrowserSession(
  db: Db,
  input: {
    providerId: string;
    clientId: string;
    userId: string;
    foundingId: string | null;
    oidcSubject: string;
    oidcSessionId?: string;
    bindingClaimValue: string | null;
    authenticatedAt: Date;
    idleSeconds: number;
    absoluteSeconds: number;
  },
) {
  const credential = newBrowserCredential();
  const { idleSeconds, absoluteSeconds, ...identity } = input;
  const absoluteExpiresAt = new Date(input.authenticatedAt.getTime() + absoluteSeconds * 1_000);
  const [session] = await db
    .insert(browserSessions)
    .values({
      ...identity,
      credentialHash: browserCredentialHash(credential),
      absoluteExpiresAt,
      idleExpiresAt: new Date(
        Math.min(Date.now() + idleSeconds * 1_000, absoluteExpiresAt.getTime()),
      ),
    })
    .returning();
  if (!session) throw new Error('browser session insert returned no row');
  return { credential, session };
}

/** Reads current credential and account gates without extending the authentication baseline.
 * @param db - Control-plane connection.
 * @param credential - Browser's opaque credential.
 * @param idleSeconds - Idle window applied only after a valid request.
 */
export async function getBrowserSession(db: Db, credential: string, idleSeconds: number) {
  const [row] = await db
    .select({ session: browserSessions, user: users, provider: identityProviders })
    .from(browserSessions)
    .innerJoin(users, eq(users.id, browserSessions.userId))
    .innerJoin(identityProviders, eq(identityProviders.id, browserSessions.providerId))
    .where(
      and(
        eq(browserSessions.credentialHash, browserCredentialHash(credential)),
        isNull(browserSessions.revokedAt),
        gt(browserSessions.idleExpiresAt, sql`clock_timestamp()`),
        gt(browserSessions.absoluteExpiresAt, sql`clock_timestamp()`),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.user.status !== 'active' ||
    row.provider.issuer !== row.user.issuer ||
    row.provider.browserClientId !== row.session.clientId ||
    (row.user.notBefore && row.session.authenticatedAt < row.user.notBefore)
  )
    return null;
  if (row.provider.status !== 'active') {
    if (
      !row.session.foundingId ||
      !['provisional', 'pending_verification'].includes(row.provider.status)
    )
      return null;
    const [founding] = await db
      .select({ id: workspaceFoundings.id })
      .from(workspaceFoundings)
      .where(
        and(
          eq(workspaceFoundings.id, row.session.foundingId),
          eq(workspaceFoundings.providerId, row.provider.id),
          eq(workspaceFoundings.founderUserId, row.user.id),
          sql`${workspaceFoundings.status} <> 'expired'`,
          sql`(${workspaceFoundings.status} = 'active' or ${workspaceFoundings.expiresAt} is null or ${workspaceFoundings.expiresAt} > clock_timestamp())`,
        ),
      )
      .limit(1);
    if (!founding) return null;
  }
  await db
    .update(browserSessions)
    .set({
      idleExpiresAt: sql`least(${browserSessions.absoluteExpiresAt}, clock_timestamp() + ${idleSeconds} * interval '1 second')`,
    })
    .where(and(eq(browserSessions.id, row.session.id), isNull(browserSessions.revokedAt)));
  return row;
}

/** Invalidates one browser credential; other sessions remain independent.
 * @param db - Control-plane connection.
 * @param credential - Browser credential being signed out.
 */
export async function revokeBrowserSession(db: Db, credential: string) {
  const [session] = await db
    .update(browserSessions)
    .set({ revokedAt: sql`clock_timestamp()` })
    .where(eq(browserSessions.credentialHash, browserCredentialHash(credential)))
    .returning();
  return session ?? null;
}

/** Stores one bounded mailbox proof, never in the product notification inbox.
 * @param db - Control-plane connection.
 * @param identity - Verified OIDC identity whose mailbox still needs proof.
 * @param code - Code delivered only to that mailbox.
 */
export async function createMailboxProof(db: Db, identity: PendingMailboxIdentity, code: string) {
  const credential = newBrowserCredential();
  await db.delete(mailboxProofs).where(sql`${mailboxProofs.expiresAt} <= clock_timestamp()`);
  await db.insert(mailboxProofs).values({
    credentialHash: browserCredentialHash(credential),
    codeHash: browserCredentialHash(code),
    identity,
    expiresAt: new Date(Date.now() + 600_000),
  });
  return credential;
}

/** Returns browser-bound proof context without exposing its code or hash.
 * @param db - Control-plane connection.
 * @param credential - HttpOnly proof credential.
 */
export async function getMailboxProof(db: Db, credential: string) {
  const [row] = await db
    .select({
      identity: mailboxProofs.identity,
      expiresAt: mailboxProofs.expiresAt,
      lastSentAt: mailboxProofs.lastSentAt,
    })
    .from(mailboxProofs)
    .where(
      and(
        eq(mailboxProofs.credentialHash, browserCredentialHash(credential)),
        gt(mailboxProofs.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Replaces an old mailbox code at most once per minute, within the original sign-in window.
 * @param db - Control-plane connection.
 * @param credential - HttpOnly proof credential.
 * @param code - Replacement code delivered only by SMTP.
 */
export async function resendMailboxProof(db: Db, credential: string, code: string) {
  const [row] = await db
    .update(mailboxProofs)
    .set({
      codeHash: browserCredentialHash(code),
      attempts: 0,
      lastSentAt: sql`clock_timestamp()`,
      expiresAt: sql`clock_timestamp() + interval '10 minutes'`,
    })
    .where(
      and(
        eq(mailboxProofs.credentialHash, browserCredentialHash(credential)),
        gt(mailboxProofs.expiresAt, sql`clock_timestamp()`),
        sql`${mailboxProofs.lastSentAt} <= clock_timestamp() - interval '60 seconds'`,
        sql`(${mailboxProofs.identity}->>'authenticatedAt')::timestamptz > clock_timestamp() - interval '30 minutes'`,
      ),
    )
    .returning({
      identity: mailboxProofs.identity,
      expiresAt: mailboxProofs.expiresAt,
      lastSentAt: mailboxProofs.lastSentAt,
    });
  return row ?? null;
}

/** Consumes a correct proof once and bounds incorrect guesses under a row lock.
 * @param db - Control-plane connection.
 * @param credential - Browser-bound proof credential.
 * @param code - Mailbox code entered by its recipient.
 */
export async function consumeMailboxProof(db: Db, credential: string, code: string) {
  return db.transaction(async (tx) => {
    const hash = browserCredentialHash(credential);
    const [row] = await tx
      .select()
      .from(mailboxProofs)
      .where(
        and(
          eq(mailboxProofs.credentialHash, hash),
          gt(mailboxProofs.expiresAt, sql`clock_timestamp()`),
          sql`${mailboxProofs.attempts} < 5`,
        ),
      )
      .for('update');
    if (!row) return null;
    if (
      !timingSafeEqual(
        Buffer.from(row.codeHash, 'hex'),
        Buffer.from(browserCredentialHash(code), 'hex'),
      )
    ) {
      await tx
        .update(mailboxProofs)
        .set({ attempts: row.attempts + 1 })
        .where(eq(mailboxProofs.credentialHash, hash));
      return null;
    }
    await tx.delete(mailboxProofs).where(eq(mailboxProofs.credentialHash, hash));
    return row.identity;
  });
}
