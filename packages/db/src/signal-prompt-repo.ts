import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { signalDispositions, tenantSignalPolicies } from './schema';
import { actionableSignalTicketFilter } from './signal-control-repo';

/**
 * Starts ticket review once.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param signalId - Ticket to review.
 */
export function startSignalReview(db: Db, tenantId: string, signalId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(signalDispositions)
      .set({ reviewStartedAt: sql`coalesce(review_started_at, now())`, updatedAt: sql`now()` })
      .where(and(eq(signalDispositions.id, signalId), actionableSignalTicketFilter()))
      .returning();
    return rows[0] ?? null;
  });
}

/**
 * Leases due reviewed tickets for delivery; callers must acknowledge or release each lease.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param limit - Maximum claims.
 */
export function claimDueSignalPrompts(db: Db, tenantId: string, limit: number) {
  return withTenant(db, tenantId, async (tx) => {
    const policy = await tx.select().from(tenantSignalPolicies).limit(1);
    const age = policy[0] ? policy[0].unsolvedAfterMinutes : 60;
    if (age === null) return [];
    const candidates = await tx
      .select({ id: signalDispositions.id })
      .from(signalDispositions)
      .where(
        and(
          actionableSignalTicketFilter(),
          isNull(signalDispositions.promotionSuggestedAt),
          or(
            isNull(signalDispositions.promotionPromptClaimedAt),
            sql`${signalDispositions.promotionPromptClaimedAt} < now() - interval '5 minutes'`,
          ),
          sql`${signalDispositions.reviewStartedAt} is not null`,
          sql`${signalDispositions.reviewStartedAt} + make_interval(mins => ${age}) <= now()`,
        ),
      )
      .orderBy(asc(signalDispositions.reviewStartedAt), asc(signalDispositions.id))
      .limit(Math.max(1, Math.min(100, Math.trunc(limit))))
      .for('update', { skipLocked: true });
    if (candidates.length === 0) return [];
    const claimed = await tx
      .update(signalDispositions)
      .set({
        promotionPromptClaimId: sql`gen_random_uuid()`,
        promotionPromptClaimedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        inArray(
          signalDispositions.id,
          candidates.map((row) => row.id),
        ),
      )
      .returning();
    return claimed.map((row) => {
      if (!row.promotionPromptClaimId) throw new Error('ticket prompt lease was not created');
      return { ...row, promotionPromptClaimId: row.promotionPromptClaimId };
    });
  });
}

/**
 * Marks a leased ticket reminder delivered exactly once.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param signalId - Leased ticket identifier.
 * @param claimId - Lease token returned by the claim.
 */
export function acknowledgeSignalPrompt(
  db: Db,
  tenantId: string,
  signalId: string,
  claimId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(signalDispositions)
      .set({
        promotionSuggestedAt: sql`now()`,
        promotionPromptClaimId: null,
        promotionPromptClaimedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(signalDispositions.id, signalId),
          eq(signalDispositions.promotionPromptClaimId, claimId),
          isNull(signalDispositions.promotionSuggestedAt),
        ),
      )
      .returning({ id: signalDispositions.id });
    return rows[0] ?? null;
  });
}

/**
 * Releases a failed ticket-reminder lease so another sweep can retry it.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param signalId - Leased ticket identifier.
 * @param claimId - Lease token returned by the claim.
 */
export function releaseSignalPrompt(db: Db, tenantId: string, signalId: string, claimId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(signalDispositions)
      .set({
        promotionPromptClaimId: null,
        promotionPromptClaimedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(signalDispositions.id, signalId),
          eq(signalDispositions.promotionPromptClaimId, claimId),
          isNull(signalDispositions.promotionSuggestedAt),
        ),
      )
      .returning({ id: signalDispositions.id });
    return rows[0] ?? null;
  });
}
