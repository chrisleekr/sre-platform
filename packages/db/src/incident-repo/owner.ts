import { sql } from 'drizzle-orm';
import { entityServiceMappings, incidentSignals, incidents, services } from '../schema';

const structuredOwnerSql = () => sql<string | null>`(
  select string_agg(distinct resolved_service.team, ', ' order by resolved_service.team)
  from ${incidentSignals} owner_signal
  cross join lateral jsonb_array_elements(
    coalesce(owner_signal.affected_entities, '[]'::jsonb)
  ) as candidate
  left join ${entityServiceMappings} owner_mapping
    on owner_mapping.tenant_id = owner_signal.tenant_id
    and owner_mapping.candidate_key = candidate ->> 'key'
  join ${services} resolved_service
    on resolved_service.tenant_id = owner_signal.tenant_id
    and resolved_service.name = coalesce(
      owner_mapping.service_name,
      case when candidate ->> 'kind' = 'service' then candidate ->> 'stableId' end
    )
  where owner_signal.tenant_id = ${incidents.tenantId}
    and owner_signal.incident_id = ${incidents.id}
    and resolved_service.team is not null
)`;

/** Resolves queue ownership without overriding an explicit entity mapping with legacy incident data. */
export const responsibleOwnerSql = () => sql<string | null>`(
  case
    when exists (
      select 1
      from ${incidentSignals} owner_signal
      cross join lateral jsonb_array_elements(
        coalesce(owner_signal.affected_entities, '[]'::jsonb)
      ) as candidate
      left join ${entityServiceMappings} owner_mapping
        on owner_mapping.tenant_id = owner_signal.tenant_id
        and owner_mapping.candidate_key = candidate ->> 'key'
      join ${services} resolved_service
        on resolved_service.tenant_id = owner_signal.tenant_id
        and resolved_service.name = coalesce(
          owner_mapping.service_name,
          case when candidate ->> 'kind' = 'service' then candidate ->> 'stableId' end
        )
      where owner_signal.tenant_id = ${incidents.tenantId}
        and owner_signal.incident_id = ${incidents.id}
    ) then ${structuredOwnerSql()}
    else coalesce(${structuredOwnerSql()}, ${services.team})
  end
)`;
