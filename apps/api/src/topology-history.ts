import { serviceDependencyHistory, withTenant, type Db } from '@sre/db';
import { sql } from 'drizzle-orm';

/** Read declarations valid at a past time without presenting current runtime as historical evidence. */
export async function readTopologyDeclarationSnapshot(db: Db, tenantId: string, at: string) {
  const history = await withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(serviceDependencyHistory)
      .where(
        sql`valid_from <= ${at}::timestamptz and (valid_until is null or valid_until > ${at}::timestamptz)`,
      ),
  );
  const edges = history.map((row) => ({
    upstream: row.upstream,
    downstream: row.downstream,
    environment: row.environment,
    ...row.declaration,
  }));
  const names = new Set(edges.flatMap((edge) => [edge.upstream, edge.downstream]));
  return {
    nodes: [...names].sort().map((name) => ({
      name,
      team: null,
      criticality: null,
      sources: ['catalog'],
      lastDeployAt: null,
      recentDeploys: [],
    })),
    edges,
    infrastructure: [],
    coverage: [],
    runtimeBindings: [],
    incidents: [],
    incidentMappings: [],
    historicalAt: new Date(at).toISOString(),
  };
}

/** Read the latest declaration changes within the requesting tenant. */
export function readTopologyDeclarationChanges(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        validFrom: serviceDependencyHistory.validFrom,
        validUntil: serviceDependencyHistory.validUntil,
        upstream: serviceDependencyHistory.upstream,
        downstream: serviceDependencyHistory.downstream,
        environment: serviceDependencyHistory.environment,
      })
      .from(serviceDependencyHistory)
      .orderBy(sql`valid_from desc`)
      .limit(100),
  );
}
