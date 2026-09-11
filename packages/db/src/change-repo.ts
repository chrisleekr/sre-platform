import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';

export const CHANGE_PROVIDERS = ['github', 'gitlab'] as const;
export const CHANGE_CATEGORIES = ['code', 'review', 'ci', 'release'] as const;

export type ChangeProvider = (typeof CHANGE_PROVIDERS)[number];
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

export interface ChangeFilters {
  from?: Date;
  to?: Date;
  provider?: ChangeProvider;
  dataSourceId?: string;
  repository?: string;
  category?: ChangeCategory;
  status?: string;
  search?: string;
}

export interface ChangePageCursor {
  occurredAt: Date;
  id: string;
  provider: ChangeProvider;
}

export interface ChangeRow {
  id: string;
  provider: ChangeProvider;
  dataSourceId: string | null;
  dataSourceName: string;
  category: ChangeCategory;
  eventType: string;
  action: string | null;
  repository: string | null;
  actor: string | null;
  ref: string | null;
  sha: string | null;
  summary: Record<string, unknown>;
  occurredAt: Date;
}

export interface ChangeSummary {
  total: number;
  failing: number;
  succeeded: number;
  latestAt: Date | null;
}

type RawChange = Omit<ChangeRow, 'occurredAt'> & { occurredAt: string };

function changesCte(): SQL {
  return sql`
    WITH changes AS (
      SELECT e.id, 'github'::text AS provider,
             e.connector_id AS "dataSourceId",
             coalesce(c.name, 'Disconnected GitHub source') AS "dataSourceName",
             CASE event_type
               WHEN 'push' THEN 'code'
               WHEN 'pull_request' THEN 'review'
               WHEN 'workflow_run' THEN 'ci'
             END::text AS category,
             e.event_type AS "eventType", e.action, e.repository_full_name AS repository,
             e.actor, e.ref, e.sha, e.summary, e.occurred_at AS "occurredAt"
      FROM github_events e
      LEFT JOIN connector_configs c ON c.id = e.connector_id
      WHERE e.event_type IN ('push', 'pull_request', 'workflow_run')
      UNION ALL
      SELECT e.id, 'gitlab'::text AS provider,
             e.connector_id AS "dataSourceId",
             coalesce(c.name, 'Disconnected GitLab source') AS "dataSourceName",
             CASE
               WHEN e.event_type IN ('push', 'tag_push') THEN 'code'
               WHEN e.event_type = 'merge_request' THEN 'review'
               WHEN e.event_type IN ('pipeline', 'job') THEN 'ci'
               WHEN e.event_type = 'release' THEN 'release'
             END::text AS category,
             e.event_type AS "eventType", e.action, e.project_full_path AS repository,
             e.actor, e.ref, e.sha, e.summary, e.occurred_at AS "occurredAt"
      FROM gitlab_events e
      LEFT JOIN connector_configs c ON c.id = e.connector_id
      WHERE e.event_type IN ('push', 'tag_push', 'merge_request', 'pipeline', 'job', 'release')
        AND (e.observation_key IS NULL OR NOT EXISTS (
          SELECT 1 FROM gitlab_events prior
          WHERE prior.tenant_id = e.tenant_id
            AND prior.connector_id = e.connector_id
            AND prior.observation_key = e.observation_key
            AND (prior.received_at, prior.id) < (e.received_at, e.id)
        ))
    )`;
}

function statusExpr(): SQL {
  return sql`lower(coalesce(summary->>'conclusion', summary->>'status', summary->>'state', action, ''))`;
}

function changeConditions(filters: ChangeFilters, before?: ChangePageCursor): SQL {
  const conditions: SQL[] = [];
  if (filters.from)
    conditions.push(sql`"occurredAt" >= ${filters.from.toISOString()}::timestamptz`);
  if (filters.to) conditions.push(sql`"occurredAt" <= ${filters.to.toISOString()}::timestamptz`);
  if (filters.provider) conditions.push(sql`provider = ${filters.provider}`);
  if (filters.dataSourceId) conditions.push(sql`"dataSourceId" = ${filters.dataSourceId}::uuid`);
  if (filters.repository) conditions.push(sql`repository = ${filters.repository}`);
  if (filters.category) conditions.push(sql`category = ${filters.category}`);
  if (filters.status) {
    const status = filters.status.toLowerCase();
    conditions.push(
      status === 'failed'
        ? sql`${statusExpr()} IN ('failed', 'failure', 'error', 'cancelled', 'canceled', 'timed_out')`
        : status === 'success'
          ? sql`${statusExpr()} IN ('success', 'succeeded', 'passed', 'completed', 'merged')`
          : status === 'active'
            ? sql`${statusExpr()} IN ('running', 'pending', 'queued', 'in_progress')`
            : sql`${statusExpr()} = ${status}`,
    );
  }
  if (filters.search) {
    const search = filters.search.toLowerCase();
    conditions.push(sql`position(${search} in lower(concat_ws(' ',
      "dataSourceName", repository, "eventType", action, actor, ref, sha,
      summary->>'title', summary->>'name', summary->>'message'
    ))) > 0`);
  }
  if (before) {
    conditions.push(sql`("occurredAt", id, provider) < (
      ${before.occurredAt.toISOString()}::timestamptz, ${before.id}::uuid, ${before.provider}
    )`);
  }
  return conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
}

/**
 * Unified, tenant-scoped source-control activity. Deployment events stay in the deployments model.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param opts - Optional query or behavior controls.
 */
export async function listChangesPage(
  db: Db,
  tenantId: string,
  opts: { limit?: number; before?: ChangePageCursor; filters?: ChangeFilters } = {},
): Promise<{ changes: ChangeRow[]; nextCursor: ChangePageCursor | null }> {
  const limit = opts.limit ?? 20;
  const where = changeConditions(opts.filters ?? {}, opts.before);
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute<RawChange>(sql`
      ${changesCte()}
      SELECT id, provider, "dataSourceId", "dataSourceName", category, "eventType", action, repository, actor, ref, sha,
             summary, "occurredAt"
      FROM changes
      ${where}
      ORDER BY "occurredAt" DESC, id DESC, provider DESC
      LIMIT ${limit + 1}
    `);
    const rows = [...result];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const changes = page.map((row) => ({ ...row, occurredAt: new Date(row.occurredAt) }));
    const last = changes.at(-1);
    return {
      changes,
      nextCursor:
        hasMore && last
          ? { occurredAt: last.occurredAt, id: last.id, provider: last.provider }
          : null,
    };
  });
}

/**
 * Projects a change row into its API summary.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param filters - Filters applied to the result set.
 */
export async function changeSummary(
  db: Db,
  tenantId: string,
  filters: ChangeFilters = {},
): Promise<ChangeSummary> {
  const where = changeConditions(filters);
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute<{
      total: number;
      failing: number;
      succeeded: number;
      latestAt: string | null;
    }>(sql`
      ${changesCte()}
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE ${statusExpr()} IN
               ('failed', 'failure', 'error', 'cancelled', 'canceled', 'timed_out'))::int AS failing,
             count(*) FILTER (WHERE ${statusExpr()} IN
               ('success', 'succeeded', 'passed', 'completed', 'merged'))::int AS succeeded,
             max("occurredAt") AS "latestAt"
      FROM changes
      ${where}
    `);
    const row = result[0];
    return {
      total: Number(row?.total ?? 0),
      failing: Number(row?.failing ?? 0),
      succeeded: Number(row?.succeeded ?? 0),
      latestAt: row?.latestAt ? new Date(row.latestAt) : null,
    };
  });
}
