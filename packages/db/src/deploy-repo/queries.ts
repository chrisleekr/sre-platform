import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant } from '../rls';
import { connectorConfigs, deployments } from '../schema';

// Persisted-deploy CRUD (MR1). Tenant scoping is by RLS (withTenant sets app.tenant_id); tenant_id
// is written on insert so the RLS WITH CHECK binds the row to the session.

/**
 * How far back the recent-deploys read scans. Deploy history grows unbounded, but the dashboard
 * panel and the per-service topology window only care about recent activity, so the partition/scan is
 * bounded to keep the query on the (tenant, service, deployed_at desc) index instead of scanning a
 * tenant's whole history. Generous on purpose: a service that has not shipped in a quarter is not
 * "recent" for correlation. Widen it here if a use case needs deeper history.
 */
import type { DeployRow } from './writes';

const DEPLOY_WINDOW_DAYS = 90;

export interface DeploymentFilters {
  from?: Date;
  to?: Date;
  search?: string;
  service?: string;
  environment?: string;
  source?: string;
  status?: string;
}

export interface DeploymentSummary {
  total: number;
  failed: number;
  active: number;
  environmentMissing: number;
  latestAt: Date | null;
}

function deploymentConditions(filters: DeploymentFilters = {}): SQL[] {
  const conditions: SQL[] = [];
  if (filters.from) conditions.push(gte(deployments.deployedAt, filters.from));
  if (filters.to) conditions.push(lte(deployments.deployedAt, filters.to));
  if (filters.service) conditions.push(eq(deployments.service, filters.service));
  if (filters.environment) conditions.push(eq(deployments.environment, filters.environment));
  if (filters.source) conditions.push(eq(deployments.source, filters.source));
  if (filters.status) {
    conditions.push(
      filters.status.toLowerCase() === 'failed'
        ? sql`lower(${deployments.status}) in ('failed', 'failure', 'error')`
        : sql`lower(${deployments.status}) = ${filters.status.toLowerCase()}`,
    );
  }
  if (filters.search) {
    const search = filters.search.toLowerCase();
    conditions.push(sql`position(${search} in lower(concat_ws(' ',
      ${deployments.service}, ${deployments.repo}, ${deployments.ref}, ${deployments.sha},
      ${deployments.actor}, ${deployments.environment}, ${deployments.source}
    ))) > 0`);
  }
  return conditions;
}

/**
 * Upsert deploys idempotently on (tenant, source, sha): a re-polled deploy updates its row (later status wins) rather than inserting a duplicate. Empty input is a no-op.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param rows - Normalized rows to persist.
 * @param connectorId - Connector instance targeted by the operation.
 */

export interface RecentDeploysOpts {
  /** Filter to a single service (flat mode only). */
  service?: string;
  /**
   * Window mode: return at most this many deploys PER service (newest-first), across every service
   * that carries a non-null service tag. Drives the topology graph so a busy service can't starve the
   * others. When set, `service`/`limit` are ignored.
   */
  perService?: number;
  /** Flat-mode cap (newest-first across the whole tenant, or one service). Default 20. */
  limit?: number;
}

/**
 * Provides recent deploys.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param opts - Optional query or behavior controls.
 */
export async function recentDeploys(
  db: Db,
  tenantId: string,
  opts: RecentDeploysOpts = {},
): Promise<DeployRow[]> {
  return withTenant(db, tenantId, async (tx) => {
    // tx.execute bypasses drizzle's column parsing, so postgres-js returns raw values (deployed_at as a
    // string) — one mapper normalises both query shapes to DeployRow.
    type Raw = {
      id: string;
      connectorId: string | null;
      dataSourceName: string;
      source: string;
      providerId: string | null;
      repo: string;
      ref: string | null;
      environment: string | null;
      transientEnvironment: boolean;
      actor: string | null;
      sha: string;
      revisions: string[] | null;
      operationPhase: string | null;
      service: string | null;
      status: string;
      url: string | null;
      deployedAt: string;
      providerCreatedAt: string | null;
      providerUpdatedAt: string | null;
      // double precision arrives as a string through tx.execute; the mapper below casts it back.
      budgetRemaining: string | null;
      highRisk: boolean;
    };
    // Bind the window as a text interval literal ('90 days'::interval) so there is no untyped-parameter
    // operator-resolution ambiguity.
    const since = sql`now() - ${`${DEPLOY_WINDOW_DAYS} days`}::interval`;
    let rows: Raw[];
    if (opts.perService != null) {
      const result = await tx.execute<Raw>(sql`
        SELECT ranked.id, connector_id AS "connectorId",
               coalesce((select name from connector_configs where connector_configs.id = ranked.connector_id),
                        'Disconnected ' || source || ' source') AS "dataSourceName",
               source, provider_id AS "providerId", repo, ref, environment,
               transient_environment AS "transientEnvironment", actor, sha, revisions,
               operation_phase AS "operationPhase", service,
               status, url, deployed_at AS "deployedAt",
               provider_created_at AS "providerCreatedAt", provider_updated_at AS "providerUpdatedAt",
               budget_remaining AS "budgetRemaining", high_risk AS "highRisk"
        FROM (
          SELECT id, connector_id, source, provider_id, repo, ref, environment, transient_environment, actor, sha,
                 revisions, operation_phase,
                 service, status, url,
                 deployed_at, provider_created_at, provider_updated_at,
                 budget_remaining, high_risk,
                 row_number() OVER (PARTITION BY service ORDER BY deployed_at DESC, id DESC) AS rn
          FROM deployments
          WHERE service IS NOT NULL AND deployed_at >= ${since}
        ) ranked
        WHERE rn <= ${opts.perService}
        ORDER BY service, deployed_at DESC, id DESC
      `);
      rows = [...result];
    } else {
      const limit = opts.limit ?? 20;
      const serviceFilter = opts.service ? sql`AND service = ${opts.service}` : sql``;
      const result = await tx.execute<Raw>(sql`
        SELECT deployments.id, connector_id AS "connectorId",
               coalesce((select name from connector_configs where connector_configs.id = deployments.connector_id),
                        'Disconnected ' || source || ' source') AS "dataSourceName",
               source, provider_id AS "providerId", repo, ref, environment,
               transient_environment AS "transientEnvironment", actor, sha, revisions,
               operation_phase AS "operationPhase", service,
               status, url, deployed_at AS "deployedAt",
               provider_created_at AS "providerCreatedAt", provider_updated_at AS "providerUpdatedAt",
               budget_remaining AS "budgetRemaining", high_risk AS "highRisk"
        FROM deployments
        WHERE deployed_at >= ${since} ${serviceFilter}
        ORDER BY deployed_at DESC, id DESC
        LIMIT ${limit}
      `);
      rows = [...result];
    }
    return rows.map((r) => ({
      id: r.id,
      connectorId: r.connectorId,
      dataSourceName: r.dataSourceName,
      source: r.source,
      providerId: r.providerId,
      repo: r.repo,
      ref: r.ref,
      environment: r.environment,
      transientEnvironment: r.transientEnvironment,
      actor: r.actor,
      sha: r.sha,
      revisions: r.revisions,
      operationPhase: r.operationPhase,
      service: r.service,
      status: r.status,
      url: r.url,
      deployedAt: new Date(r.deployedAt),
      providerCreatedAt: r.providerCreatedAt ? new Date(r.providerCreatedAt) : null,
      providerUpdatedAt: r.providerUpdatedAt ? new Date(r.providerUpdatedAt) : null,
      budgetRemaining: r.budgetRemaining === null ? null : Number(r.budgetRemaining),
      highRisk: r.highRisk,
    }));
  });
}

// Thin adapters over the unified read. Retained as the stable names some call sites (and tests) use;
// they carry no divergent logic — just the two option shapes.

/**
 * Per-service most-recent deploys (window mode). See `recentDeploys`.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param perService - Value supplied for per service.
 */
export function recentDeploysByService(
  db: Db,
  tenantId: string,
  perService = 5,
): Promise<DeployRow[]> {
  return recentDeploys(db, tenantId, { perService });
}

/**
 * Recent deploys, newest-first, optionally filtered to one service (flat mode). See `recentDeploys`.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param opts - Optional query or behavior controls.
 */
export function listRecentDeployments(
  db: Db,
  tenantId: string,
  opts: { service?: string; limit?: number } = {},
): Promise<DeployRow[]> {
  return recentDeploys(db, tenantId, { service: opts.service, limit: opts.limit });
}

/** A (deployed_at, id) keyset cursor for the deploy-history page reader. */
export interface DeploymentPageCursor {
  deployedAt: Date;
  id: string;
}

/**
 * Lists deployments page.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param opts - Optional query or behavior controls.
 */
export async function listDeploymentsPage(
  db: Db,
  tenantId: string,
  opts: { limit?: number; before?: DeploymentPageCursor; filters?: DeploymentFilters } = {},
): Promise<{ deployments: DeployRow[]; nextCursor: DeploymentPageCursor | null }> {
  const limit = opts.limit ?? 20;
  const before = opts.before;
  const conditions = deploymentConditions(opts.filters);
  if (before) {
    conditions.push(
      or(
        lt(deployments.deployedAt, before.deployedAt),
        and(eq(deployments.deployedAt, before.deployedAt), lt(deployments.id, before.id)),
      )!,
    );
  }
  const cond = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        connectorId: deployments.connectorId,
        dataSourceName: sql<string>`coalesce(${connectorConfigs.name}, 'Disconnected ' || ${deployments.source} || ' source')`,
        source: deployments.source,
        providerId: deployments.providerId,
        repo: deployments.repo,
        ref: deployments.ref,
        environment: deployments.environment,
        transientEnvironment: deployments.transientEnvironment,
        actor: deployments.actor,
        sha: deployments.sha,
        revisions: deployments.revisions,
        operationPhase: deployments.operationPhase,
        service: deployments.service,
        status: deployments.status,
        url: deployments.url,
        deployedAt: deployments.deployedAt,
        providerCreatedAt: deployments.providerCreatedAt,
        providerUpdatedAt: deployments.providerUpdatedAt,
        budgetRemaining: deployments.budgetRemaining,
        highRisk: deployments.highRisk,
        id: deployments.id,
      })
      .from(deployments)
      .leftJoin(connectorConfigs, eq(connectorConfigs.id, deployments.connectorId))
      .where(cond)
      .orderBy(desc(deployments.deployedAt), desc(deployments.id))
      .limit(limit + 1),
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? { deployedAt: last.deployedAt, id: last.id } : null;
  return {
    deployments: page.map((r) => ({
      id: r.id,
      connectorId: r.connectorId,
      dataSourceName: r.dataSourceName,
      source: r.source,
      providerId: r.providerId,
      repo: r.repo,
      ref: r.ref,
      environment: r.environment,
      transientEnvironment: r.transientEnvironment,
      actor: r.actor,
      sha: r.sha,
      revisions: r.revisions,
      operationPhase: r.operationPhase,
      service: r.service,
      status: r.status,
      url: r.url,
      deployedAt: r.deployedAt,
      providerCreatedAt: r.providerCreatedAt,
      providerUpdatedAt: r.providerUpdatedAt,
      // The typed projection already returns a JS number here, unlike the raw-execute reads above.
      budgetRemaining: r.budgetRemaining,
      highRisk: r.highRisk,
    })),
    nextCursor,
  };
}

/**
 * Counts across the selected evidence window, not merely the currently loaded page.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param filters - Filters applied to the result set.
 */
export async function deploymentSummary(
  db: Db,
  tenantId: string,
  filters: DeploymentFilters = {},
): Promise<DeploymentSummary> {
  const conditions = deploymentConditions(filters);
  const [row] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        total: sql<number>`count(*)::int`.mapWith(Number),
        failed:
          sql<number>`count(*) filter (where lower(${deployments.status}) in ('failed', 'failure', 'error'))::int`.mapWith(
            Number,
          ),
        active:
          sql<number>`count(*) filter (where lower(${deployments.status}) in ('running', 'pending', 'blocked'))::int`.mapWith(
            Number,
          ),
        environmentMissing:
          sql<number>`count(*) filter (where ${deployments.environment} is null or ${deployments.environment} = '')::int`.mapWith(
            Number,
          ),
        latestAt: sql<Date | string | null>`max(${deployments.deployedAt})`,
      })
      .from(deployments)
      .where(conditions.length > 0 ? and(...conditions) : undefined),
  );
  const latestAt = row?.latestAt
    ? row.latestAt instanceof Date
      ? row.latestAt
      : new Date(row.latestAt)
    : null;
  return {
    total: row?.total ?? 0,
    failed: row?.failed ?? 0,
    active: row?.active ?? 0,
    environmentMissing: row?.environmentMissing ?? 0,
    latestAt: latestAt && !Number.isNaN(latestAt.getTime()) ? latestAt : null,
  };
}
