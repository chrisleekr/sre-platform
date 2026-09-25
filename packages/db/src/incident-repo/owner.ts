import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant } from '../rls';
import {
  entityServiceMappings,
  incidentServiceAssignments,
  incidentSignals,
  incidents,
  services,
} from '../schema';

// Explicit qualification survives Drizzle's single-table select rendering.
const incidentTenant = sql`${incidents}."tenant_id"`;
const incidentIdColumn = sql`${incidents}."id"`;
const incidentService = sql`${incidents}."service"`;

// Keep teamless selections in the winning tier so they cannot inherit an unrelated legacy owner.
const ownerTeamsSql = () => sql<string[]>`(
  with candidate_identities as (
    select candidate ->> 'key' as candidate_key,
      max(candidate ->> 'kind') as kind,
      max(candidate ->> 'stableId') as stable_id,
      count(distinct jsonb_build_array(candidate ->> 'kind', candidate ->> 'stableId')) as identities
    from ${incidentSignals} owner_signal
    cross join lateral jsonb_array_elements(coalesce(owner_signal.affected_entities, '[]'::jsonb)) candidate
    where owner_signal.tenant_id = ${incidentTenant}
      and owner_signal.incident_id = ${incidentIdColumn}
    group by candidate ->> 'key'
  ), candidate_services as (
    select candidate_identities.*,
      owner_mapping.service_name as mapped_service,
      resolved_service.name as service_name,
      resolved_service.team
    from candidate_identities
    left join ${entityServiceMappings} owner_mapping
      on owner_mapping.tenant_id = ${incidentTenant}
      and owner_mapping.candidate_key = candidate_identities.candidate_key
    left join ${services} resolved_service
      on resolved_service.tenant_id = ${incidentTenant}
      and resolved_service.name = coalesce(owner_mapping.service_name,
        case when candidate_identities.identities = 1 and candidate_identities.kind = 'service'
          then candidate_identities.stable_id end)
  ), selected_services as (
    select 1 as priority, assigned_service.team
    from ${incidentServiceAssignments} owner_assignment
    join ${services} assigned_service
      on assigned_service.tenant_id = owner_assignment.tenant_id
      and assigned_service.name = owner_assignment.service_name
    where owner_assignment.tenant_id = ${incidentTenant}
      and owner_assignment.incident_id = ${incidentIdColumn}
    union all
    select 2, team from candidate_services
    where service_name is not null or (identities > 1 and mapped_service is null)
    union all
    select 3, legacy_service.team from ${services} legacy_service
    where legacy_service.tenant_id = ${incidentTenant}
      and legacy_service.name = ${incidentService}
  )
  select coalesce(array_agg(distinct team order by team) filter (where team is not null and team <> ''), array[]::text[])
  from selected_services
  where priority = (select min(priority) from selected_services)
)`;

/** Formats the authoritative team set for the queue without parsing team names. */
export const responsibleOwnerSql = () =>
  sql<string | null>`nullif(array_to_string(${ownerTeamsSql()}, ', '), '')`;

/** Read current owner teams and the incident fingerprint in one tenant-scoped query.
 * @param db - Database connection used for the read.
 * @param tenantId - Tenant that owns the incident and catalog services.
 * @param incidentId - Incident whose ownership and monitor identity are requested.
 */
export async function getIncidentOwnerContext(db: Db, tenantId: string, incidentId: string) {
  const [context] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ teams: ownerTeamsSql(), fingerprint: incidents.fingerprint })
      .from(incidents)
      .where(and(eq(incidents.tenantId, tenantId), eq(incidents.id, incidentId)))
      .limit(1),
  );
  return context ?? null;
}
