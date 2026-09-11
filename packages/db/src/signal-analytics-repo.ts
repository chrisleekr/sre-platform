import { and, count, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { signalDispositions } from './schema';

/**
 * Returns ticket promotion statistics and creation-to-promotion age.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 */
export function signalPromotionStats(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        ticketCount: count(),
        promotedCount: sql<number>`count(*) filter (where ${signalDispositions.promotedAt} is not null)`,
        averagePromotionAgeSeconds: sql<
          number | null
        >`avg(extract(epoch from (${signalDispositions.promotedAt} - ${signalDispositions.createdAt}))) filter (where ${signalDispositions.promotedAt} is not null)`,
      })
      .from(signalDispositions)
      .where(
        and(
          eq(signalDispositions.disposition, 'ticket'),
          eq(signalDispositions.classificationMode, 'enforce'),
          eq(signalDispositions.effectiveDisposition, 'ticket'),
        ),
      );
    const ticketCount = Number(rows[0]?.ticketCount ?? 0);
    const promotedCount = Number(rows[0]?.promotedCount ?? 0);
    return {
      ticketCount,
      promotedCount,
      promotionRate: ticketCount === 0 ? null : promotedCount / ticketCount,
      averagePromotionAgeSeconds:
        rows[0]?.averagePromotionAgeSeconds === null
          ? null
          : Number(rows[0]?.averagePromotionAgeSeconds ?? 0),
    };
  });
}
