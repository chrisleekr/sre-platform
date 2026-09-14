import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';

export interface TopologyIncidentServices {
  incidentId: string;
  services: string[];
  incident: {
    id: string;
    service: string;
    title: string | null;
    severity: string;
    status: string;
    alertSource: string;
    createdAt: string;
  };
}

/**
 * Resolve active incidents using confirmed entity mappings before legacy service names.
 *
 * @param db - Application database connection.
 * @param tenantId - Workspace whose active incidents are projected.
 */
export async function listTopologyIncidentServices(
  db: Db,
  tenantId: string,
): Promise<TopologyIncidentServices[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.execute(sql`
      select i.id as incident_id, i.service, i.title, i.severity, i.status, i.alert_source, i.created_at,
        coalesce((select array_agg(a.service_name order by a.service_name) from incident_service_assignments a where a.tenant_id = i.tenant_id and a.incident_id = i.id), resolved.names,
          case when exists (
            select 1 from surface_bindings b
            where b.tenant_id = i.tenant_id and b.incident_id = i.id
              and i.service = b.surface || ':' || b.channel
          ) then array[]::text[] else array[i.service] end
        ) as services
      from incidents i
      left join lateral (
        select array_agg(distinct catalog.name order by catalog.name) as names
        from incident_signals signal
        cross join lateral jsonb_array_elements(coalesce(signal.affected_entities, '[]'::jsonb)) candidate
        left join entity_service_mappings mapping
          on mapping.tenant_id = signal.tenant_id and mapping.candidate_key = candidate ->> 'key'
        join services catalog
          on catalog.tenant_id = signal.tenant_id and catalog.name = coalesce(
            mapping.service_name,
            case when candidate ->> 'kind' = 'service' then candidate ->> 'stableId' end
          )
        where signal.tenant_id = i.tenant_id and signal.incident_id = i.id
      ) resolved on true
      where i.purpose = 'incident' and i.status in ('open', 'mitigated') and i.archived_at is null
      order by i.created_at desc, i.id
    `);
    return (
      rows as unknown as Array<{
        incident_id: string;
        services: string[];
        service: string;
        title: string | null;
        severity: string;
        status: string;
        alert_source: string;
        created_at: Date | string;
      }>
    ).map((row) => ({
      incidentId: row.incident_id,
      services: row.services,
      incident: {
        id: row.incident_id,
        service: row.service,
        title: row.title,
        severity: row.severity,
        status: row.status,
        alertSource: row.alert_source,
        createdAt: new Date(row.created_at).toISOString(),
      },
    }));
  });
}
