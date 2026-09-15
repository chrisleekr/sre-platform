import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { serviceDependencies, services } from './schema';
import { lockTopologyTx, recordDependencyVersionTx } from './topology-history';

// The service dependency graph CRUD. Tenant scoping is by RLS (withTenant sets
// app.tenant_id); tenant_id is written on insert so the RLS WITH CHECK binds the row to the session.

export interface NewService {
  name: string;
  team?: string | null;
  criticality?: string | null;
}

export interface NewDependency {
  upstream: string;
  downstream: string;
  syncType?: string;
  circuitBreaker?: boolean;
  protocol?: string | null;
  environment?: string;
  rationale?: string | null;
  confirmedByUserId?: string | null;
}

/**
 * Register or update a service node (idempotent on (tenant, name)).
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function upsertService(db: Db, tenantId: string, input: NewService) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(services)
      .values({
        tenantId,
        name: input.name,
        team: input.team ?? null,
        criticality: input.criticality ?? null,
      })
      .onConflictDoUpdate({
        target: [services.tenantId, services.name],
        set: {
          team: input.team ?? null,
          criticality: input.criticality ?? null,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return rows[0]!;
  });
}

export interface ServicePatch {
  team?: string | null;
  criticality?: string | null;
}

/**
 * Updates service.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param name - Stable name targeted by the operation.
 * @param patch - Validated fields to update.
 */
export async function updateService(db: Db, tenantId: string, name: string, patch: ServicePatch) {
  return withTenant(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if ('team' in patch) set.team = patch.team ?? null;
    if ('criticality' in patch) set.criticality = patch.criticality ?? null;
    const rows = await tx.update(services).set(set).where(eq(services.name, name)).returning();
    return rows[0] ?? null;
  });
}

/**
 * Lists services.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 */
export async function listServices(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) => tx.select().from(services).orderBy(services.name));
}

/**
 * Remove a service. Fails if a dependency still references it (FK RESTRICT); remove edges first.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param name - Stable name targeted by the operation.
 */
export async function deleteService(db: Db, tenantId: string, name: string): Promise<void> {
  await withTenant(db, tenantId, (tx) => tx.delete(services).where(eq(services.name, name)));
}

/**
 * Add or update a dependency edge. Both endpoints must be registered services (composite FK).
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function addDependency(db: Db, tenantId: string, input: NewDependency) {
  return withTenant(db, tenantId, async (tx) => {
    await lockTopologyTx(tx, tenantId);
    const evidence = {
      environment: input.environment ?? '',
      rationale: input.rationale ?? null,
      confirmedByUserId: input.confirmedByUserId ?? null,
      lastConfirmedAt: input.confirmedByUserId ? new Date() : null,
    };
    const rows = await tx
      .insert(serviceDependencies)
      .values({
        tenantId,
        upstream: input.upstream,
        downstream: input.downstream,
        syncType: input.syncType ?? 'sync',
        circuitBreaker: input.circuitBreaker ?? false,
        protocol: input.protocol ?? null,
        ...evidence,
      })
      .onConflictDoUpdate({
        target: [
          serviceDependencies.tenantId,
          serviceDependencies.upstream,
          serviceDependencies.downstream,
          serviceDependencies.environment,
        ],
        set: {
          syncType: input.syncType ?? 'sync',
          circuitBreaker: input.circuitBreaker ?? false,
          protocol: input.protocol ?? null,
          updatedAt: sql`now()`,
          ...evidence,
        },
      })
      .returning();
    const row = rows[0]!;
    await recordDependencyVersionTx(tx, tenantId, row, row);
    return row;
  });
}

export interface DependencyPatch {
  syncType?: string;
  circuitBreaker?: boolean;
  protocol?: string | null;
  rationale?: string | null;
  confirmedByUserId?: string | null;
}

/**
 * Updates dependency.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param upstream - Upstream service in the dependency edge.
 * @param downstream - Downstream service in the dependency edge.
 * @param patch - Validated fields to update.
 * @param environment - Exact declaration scope, empty for unscoped.
 */
export async function updateDependency(
  db: Db,
  tenantId: string,
  upstream: string,
  downstream: string,
  patch: DependencyPatch,
  environment: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    await lockTopologyTx(tx, tenantId);
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if ('syncType' in patch) set.syncType = patch.syncType;
    if ('circuitBreaker' in patch) set.circuitBreaker = patch.circuitBreaker;
    if ('protocol' in patch) set.protocol = patch.protocol ?? null;
    if ('rationale' in patch) set.rationale = patch.rationale ?? null;
    if ('confirmedByUserId' in patch) {
      set.confirmedByUserId = patch.confirmedByUserId ?? null;
      set.lastConfirmedAt = patch.confirmedByUserId ? new Date() : null;
    }
    const rows = await tx
      .update(serviceDependencies)
      .set(set)
      .where(
        and(
          eq(serviceDependencies.upstream, upstream),
          eq(serviceDependencies.downstream, downstream),
          eq(serviceDependencies.environment, environment),
        ),
      )
      .returning();
    const row = rows[0];
    if (row) await recordDependencyVersionTx(tx, tenantId, row, row);
    return row ?? null;
  });
}

/**
 * Lists dependencies.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 */
export async function listDependencies(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) => tx.select().from(serviceDependencies));
}

/**
 * Remove an exact scoped dependency and return the number of deleted rows.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param upstream - Upstream service in the dependency edge.
 * @param downstream - Downstream service in the dependency edge.
 * @param environment - Exact declaration scope, empty for unscoped.
 */
export async function removeDependency(
  db: Db,
  tenantId: string,
  upstream: string,
  downstream: string,
  environment: string,
): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    await lockTopologyTx(tx, tenantId);
    const rows = await tx
      .delete(serviceDependencies)
      .where(
        and(
          eq(serviceDependencies.upstream, upstream),
          eq(serviceDependencies.downstream, downstream),
          eq(serviceDependencies.environment, environment),
        ),
      )
      .returning();
    if (rows.length)
      await recordDependencyVersionTx(tx, tenantId, { upstream, downstream, environment });
    return rows.length;
  });
}
