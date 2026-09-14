import { and, eq, isNull, sql } from 'drizzle-orm';
import { serviceDependencyHistory, type serviceDependencies } from './schema';
import type { Tx } from './rls';

/** Serialize infrequent catalog writes so a concurrent edit cannot create overlapping versions. */
export async function lockTopologyTx(tx: Tx, tenantId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:topology`}, 0))`,
  );
}

/** Close the prior declaration and retain the replacement inside the same tenant transaction. */
export async function recordDependencyVersionTx(
  tx: Tx,
  tenantId: string,
  key: { upstream: string; downstream: string; environment: string },
  next?: typeof serviceDependencies.$inferSelect,
) {
  const [clock] = (await tx.execute(sql`select clock_timestamp() as at`)) as unknown as Array<{
    at: Date;
  }>;
  const at = new Date(clock!.at);
  await tx
    .update(serviceDependencyHistory)
    .set({ validUntil: at })
    .where(
      and(
        eq(serviceDependencyHistory.upstream, key.upstream),
        eq(serviceDependencyHistory.downstream, key.downstream),
        eq(serviceDependencyHistory.environment, key.environment),
        isNull(serviceDependencyHistory.validUntil),
      ),
    );
  if (next)
    await tx.insert(serviceDependencyHistory).values({
      tenantId,
      upstream: key.upstream,
      downstream: key.downstream,
      environment: key.environment,
      validFrom: at,
      declaration: {
        syncType: next.syncType,
        circuitBreaker: next.circuitBreaker,
        protocol: next.protocol,
        rationale: next.rationale,
        confirmedByUserId: next.confirmedByUserId,
        lastConfirmedAt: next.lastConfirmedAt?.toISOString() ?? null,
      },
    });
}
