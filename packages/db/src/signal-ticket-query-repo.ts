import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { signalDispositions } from './schema';

/**
 * Finds the latest current ticket attached to a surface thread, including an already promoted one.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param surface - Surface adapter identifier.
 * @param channel - Surface channel identifier.
 * @param threadId - Surface thread identifier.
 */
export function findSignalTicketByThread(
  db: Db,
  tenantId: string,
  surface: string,
  channel: string,
  threadId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(signalDispositions)
      .where(
        and(
          eq(signalDispositions.surface, surface),
          eq(signalDispositions.channel, channel),
          eq(signalDispositions.threadId, threadId),
          eq(signalDispositions.disposition, 'ticket'),
          isNull(signalDispositions.supersededAt),
          or(
            isNotNull(signalDispositions.incidentId),
            and(
              eq(signalDispositions.classificationMode, 'enforce'),
              eq(signalDispositions.effectiveDisposition, 'ticket'),
              isNull(signalDispositions.resolvedAt),
              isNull(signalDispositions.correlatedIncidentId),
            ),
          ),
        ),
      )
      .orderBy(desc(signalDispositions.createdAt))
      .limit(1);
    return rows[0] ?? null;
  });
}
