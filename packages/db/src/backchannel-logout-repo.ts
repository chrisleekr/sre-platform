import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from './client';
import { lockOidcSession } from './browser-session-repo';
import { backchannelLogoutReceipts, browserSessions, users } from './schema';

const EXPIRED_RECEIPT_BATCH = 100;

export interface RevokedBrowserSession {
  id: string;
  userId: string;
}

export type BackchannelLogoutTarget =
  | { kind: 'subject'; oidcSubject: string }
  | { kind: 'session'; oidcSessionId: string; oidcSubject?: string };

export type BackchannelLogoutResult =
  | { status: 'replay'; userIds: []; sessions: [] }
  | { status: 'applied'; userIds: string[]; sessions: RevokedBrowserSession[] };

/**
 * Atomically consumes one provider token and applies its subject- or session-scoped revocation.
 *
 * @param db - Control-plane database connection.
 * @param input - Hashed token identity, expiry, OIDC client, and exact logout target.
 */
export function applyBackchannelLogout(
  db: Db,
  input: {
    providerId: string;
    clientId: string;
    jtiHash: string;
    expiresAt: Date;
    target: BackchannelLogoutTarget;
  },
): Promise<BackchannelLogoutResult> {
  return db.transaction(async (tx) => {
    await tx
      .delete(backchannelLogoutReceipts)
      .where(
        and(
          eq(backchannelLogoutReceipts.providerId, input.providerId),
          eq(backchannelLogoutReceipts.jtiHash, input.jtiHash),
          lte(backchannelLogoutReceipts.expiresAt, sql`clock_timestamp()`),
        ),
      );
    const expired = await tx
      .select({ id: backchannelLogoutReceipts.id })
      .from(backchannelLogoutReceipts)
      .where(lte(backchannelLogoutReceipts.expiresAt, sql`clock_timestamp()`))
      .orderBy(asc(backchannelLogoutReceipts.expiresAt))
      .limit(EXPIRED_RECEIPT_BATCH);
    if (expired.length) {
      await tx.delete(backchannelLogoutReceipts).where(
        inArray(
          backchannelLogoutReceipts.id,
          expired.map(({ id }) => id),
        ),
      );
    }
    const [receipt] = await tx
      .insert(backchannelLogoutReceipts)
      .values({
        providerId: input.providerId,
        jtiHash: input.jtiHash,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing({
        target: [backchannelLogoutReceipts.providerId, backchannelLogoutReceipts.jtiHash],
      })
      .returning({ id: backchannelLogoutReceipts.id });
    if (!receipt) return { status: 'replay', userIds: [], sessions: [] };

    if (input.target.kind === 'session') {
      await lockOidcSession(tx, input.providerId, input.clientId, input.target.oidcSessionId);
      const subject = input.target.oidcSubject
        ? eq(browserSessions.oidcSubject, input.target.oidcSubject)
        : undefined;
      const sessions = await tx
        .update(browserSessions)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(browserSessions.providerId, input.providerId),
            eq(browserSessions.clientId, input.clientId),
            eq(browserSessions.oidcSessionId, input.target.oidcSessionId),
            subject,
            isNull(browserSessions.revokedAt),
          ),
        )
        .returning({ id: browserSessions.id, userId: browserSessions.userId });
      return { status: 'applied', userIds: [], sessions };
    }

    const mappedUsers = await tx
      .selectDistinct({ userId: browserSessions.userId })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.providerId, input.providerId),
          eq(browserSessions.clientId, input.clientId),
          eq(browserSessions.oidcSubject, input.target.oidcSubject),
        ),
      );
    const sessions = await tx
      .update(browserSessions)
      .set({ revokedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(browserSessions.providerId, input.providerId),
          eq(browserSessions.clientId, input.clientId),
          eq(browserSessions.oidcSubject, input.target.oidcSubject),
          isNull(browserSessions.revokedAt),
        ),
      )
      .returning({ id: browserSessions.id, userId: browserSessions.userId });
    const userIds = [
      ...new Set([
        ...mappedUsers.map(({ userId }) => userId),
        ...sessions.map(({ userId }) => userId),
      ]),
    ];
    if (userIds.length) {
      await tx
        .update(users)
        .set({
          notBefore: sql`greatest(
            coalesce(${users.notBefore}, '-infinity'::timestamptz),
            clock_timestamp()
          )`,
        })
        .where(inArray(users.id, userIds));
    }
    return { status: 'applied', userIds, sessions };
  });
}
