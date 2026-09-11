import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant } from '../rls';
import { incidentSignals, incidents } from '../schema';

/**
 * Earliest provider onset, falling back to first receipt for sources without provider time.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function incidentSignalOnset(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<Date | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        onset: sql<
          string | null
        >`min(coalesce(${incidentSignals.startsAt}, ${incidentSignals.firstSeenAt}))::text`,
      })
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incidentId));
    return rows[0]?.onset ? new Date(rows[0].onset) : null;
  });
}

/**
 * Database-clock boundary for an interactive recovery turn's fresh-evidence fence.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function recoveryVerificationStartedAt(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<Date | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ startedAt: sql<string>`clock_timestamp()::text` })
      .from(incidents)
      .where(eq(incidents.id, incidentId))
      .limit(1);
    return rows[0]?.startedAt ? new Date(rows[0].startedAt) : null;
  });
}
