import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant } from '../rls';
import { ACTIVE_STATUSES, CLOSED_STATUSES } from '../schema';

export interface IncidentFreeStatusSnapshot {
  state: 'running' | 'paused' | 'never_observed';
  asOf: Date;
  startedAt: Date | null;
  qualifyingActiveCount: number;
  scope: { severities: ['sev1', 'sev2'] };
  lastIncident: { id: string; title: string | null; severity: string } | null;
}

interface IncidentFreeStatusRow extends Record<string, unknown> {
  asOf: Date | string;
  qualifyingActiveCount: number;
  startedAt: Date | string | null;
  lastIncidentId: string | null;
  lastIncidentTitle: string | null;
  lastIncidentSeverity: string | null;
  lastIncidentArchivedAt: Date | string | null;
}

/**
 * Reads one tenant's SEV1/SEV2 incident-free status from a single database snapshot.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose incident history is projected.
 */
export async function readIncidentFreeStatus(
  db: Db,
  tenantId: string,
): Promise<IncidentFreeStatusSnapshot> {
  const activeStatuses = sql.join(
    ACTIVE_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const closedStatuses = sql.join(
    CLOSED_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.execute<IncidentFreeStatusRow>(sql`
      with qualifying as (
        select id, title, severity, status, resolved_at, closed_at, archived_at
        from incidents
        where tenant_id = ${tenantId}
          and purpose = 'incident'
          and severity in ('sev1', 'sev2')
      ), snapshot as (
        select
          clock_timestamp() as "asOf",
          count(*) filter (
            where status in (${activeStatuses}) and archived_at is null
          )::int as "qualifyingActiveCount",
          max(coalesce(resolved_at, closed_at)) filter (
            where status in (${closedStatuses})
          ) as "startedAt"
        from qualifying
      ), latest_terminal as (
        select id, title, severity, archived_at
        from qualifying
        where status in (${closedStatuses})
          and coalesce(resolved_at, closed_at) is not null
        order by coalesce(resolved_at, closed_at) desc, id desc
        limit 1
      )
      select
        snapshot."asOf",
        snapshot."qualifyingActiveCount",
        snapshot."startedAt",
        latest_terminal.id as "lastIncidentId",
        latest_terminal.title as "lastIncidentTitle",
        latest_terminal.severity as "lastIncidentSeverity",
        latest_terminal.archived_at as "lastIncidentArchivedAt"
      from snapshot
      left join latest_terminal on true
    `),
  );
  const row = rows[0]!;
  const qualifyingActiveCount = Number(row.qualifyingActiveCount);
  const startedAt = row.startedAt ? new Date(row.startedAt) : null;
  const state = qualifyingActiveCount > 0 ? 'paused' : startedAt ? 'running' : 'never_observed';
  const lastIncident =
    state === 'running' &&
    row.lastIncidentId &&
    row.lastIncidentSeverity &&
    row.lastIncidentArchivedAt === null
      ? {
          id: row.lastIncidentId,
          title: row.lastIncidentTitle,
          severity: row.lastIncidentSeverity,
        }
      : null;
  return {
    state,
    asOf: new Date(row.asOf),
    startedAt: state === 'running' ? startedAt : null,
    qualifyingActiveCount,
    scope: { severities: ['sev1', 'sev2'] },
    lastIncident,
  };
}
