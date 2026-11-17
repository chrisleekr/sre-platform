import { inArray, sql, type SQL } from 'drizzle-orm';
import { CLOSED_STATUSES, incidentRelations, incidents } from '../schema';

/** Shape of `recurrenceSummarySql`; `since` is a string because it round-trips through jsonb. */
export interface RecurrenceSummary {
  earlierEpisodes: number;
  since: string;
}

/**
 * Walks active recurrence links from an incident and counts the reachable episodes older than it, so
 * the list can say how many there are and since when. UNION over the bare id stops a corrupt link
 * cycle at its first repeated incident. Null when there are none.
 */
export function recurrenceSummarySql() {
  return sql<RecurrenceSummary | null>`(
    with recursive chain(id) as (
      select r.target_incident_id
      from ${incidentRelations} r
      where r.tenant_id = ${incidents.tenantId}
        and r.source_incident_id = ${incidents.id}
        and r.type = 'recurrence_of'
        and r.superseded_at is null
      union
      select r.target_incident_id
      from chain c
      join ${incidentRelations} r
        on r.tenant_id = ${incidents.tenantId}
        and r.source_incident_id = c.id
        and r.type = 'recurrence_of'
        and r.superseded_at is null
    )
    select jsonb_build_object('earlierEpisodes', count(distinct e.id), 'since', min(e.created_at))
    from chain c
    join ${incidents} e
      on e.tenant_id = ${incidents.tenantId}
      and e.id = c.id
      and e.archived_at is null
      and (e.created_at, e.id) < (${incidents.createdAt}, ${incidents.id})
    having count(*) > 0
  )`;
}

/**
 * A reused incident can record a recurrence link to a newer one, so only a strictly newer linking
 * episode hides a closed row, which also keeps the newest member of any link cycle listed. Hiding
 * makes a recurring alert read as one row. The open scope never lists closed rows, so it needs no
 * condition.
 */
export function hiddenEarlierEpisodeCondition(scope: 'open' | 'closed' | 'all'): SQL | undefined {
  if (scope === 'open') return undefined;
  const sourceInScope =
    scope === 'closed' ? sql`and ${inArray(sql`s.status`, CLOSED_STATUSES)}` : sql``;
  return sql`not (${inArray(incidents.status, CLOSED_STATUSES)} and exists (
    select 1
    from ${incidentRelations} r
    join ${incidents} s on s.tenant_id = r.tenant_id and s.id = r.source_incident_id
    where r.tenant_id = ${incidents.tenantId}
      and r.target_incident_id = ${incidents.id}
      and r.type = 'recurrence_of'
      and r.superseded_at is null
      and s.archived_at is null
      and (s.created_at, s.id) > (${incidents.createdAt}, ${incidents.id})
      ${sourceInScope}
  ))`;
}
