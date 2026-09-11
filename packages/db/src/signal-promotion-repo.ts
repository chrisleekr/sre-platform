import { scrubSecrets } from '@sre/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from './rls';
import { signalDispositions, tenantSignalPolicies } from './schema';
import { actionableSignalTicketFilter } from './signal-control-repo';

function bounded(value: string, max: number, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return normalized;
}

/**
 * Locks an open ticket and verifies any time-based criterion with the database clock.
 * @param tx - Existing tenant transaction.
 * @param signalId - Ticket to lock.
 * @param criterion - Requested declaration criterion.
 */
export async function lockSignalTicketForPromotionTx(tx: Tx, signalId: string, criterion?: string) {
  const rows = await tx
    .select()
    .from(signalDispositions)
    .where(and(eq(signalDispositions.id, signalId), actionableSignalTicketFilter()))
    .limit(1)
    .for('update');
  const ticket = rows[0] ?? null;
  if (!ticket || criterion !== 'unsolved') return ticket;
  const policies = await tx
    .select({ unsolvedAfterMinutes: tenantSignalPolicies.unsolvedAfterMinutes })
    .from(tenantSignalPolicies)
    .where(eq(tenantSignalPolicies.tenantId, ticket.tenantId))
    .limit(1);
  const threshold = policies.length === 0 ? 60 : policies[0]!.unsolvedAfterMinutes;
  if (threshold === null || ticket.reviewStartedAt === null) {
    throw new Error('unsolved promotion requires an enabled threshold and a started review');
  }
  const elapsed = await tx.execute<{ eligible: boolean }>(sql`
    select (${ticket.reviewStartedAt.toISOString()}::timestamptz + make_interval(mins => ${threshold})) <= now()
      as eligible
  `);
  if (!elapsed[0]?.eligible) throw new Error('the unsolved review threshold has not elapsed');
  return ticket;
}

/**
 * Records an attributed promotion inside the incident-creation transaction.
 * @param tx - Existing tenant transaction.
 * @param signalId - Promoted ticket.
 * @param input - Incident and actor audit.
 */
export async function markSignalPromotedTx(
  tx: Tx,
  signalId: string,
  input: {
    incidentId: string;
    userId: string | null;
    surface: 'dashboard' | 'slack';
    actor: string;
    criterion: string;
    reason: string;
  },
) {
  const rows = await tx
    .update(signalDispositions)
    .set({
      incidentId: input.incidentId,
      promotedAt: sql`coalesce(promoted_at, now())`,
      promotedByUserId: input.userId,
      promotedBySurface: input.surface,
      promotedByActor: bounded(input.actor, 500, 'promotion actor'),
      promotionCriterion: bounded(input.criterion, 100, 'promotion criterion'),
      promotionReason: bounded(scrubSecrets(input.reason), 2_000, 'promotion reason'),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(signalDispositions.id, signalId),
        isNull(signalDispositions.incidentId),
        isNull(signalDispositions.promotedAt),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
