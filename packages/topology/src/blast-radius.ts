import { withTenant, services, serviceDependencies, type Db } from '@sre/db';
import { sql } from 'drizzle-orm';
import { readDiscoveredTopology } from './discovery-repo';
import { selectTopologySubject } from './selection';
import { discoveredBlastRadius } from './discovered-impact';

const DEFAULT_MAX_DEPTH = 10;

import type { BlastRadius, BlastRadiusDependent, BlastRadiusSuspect } from '@sre/contracts';
export type { BlastRadius, BlastRadiusDependent, BlastRadiusSuspect } from '@sre/contracts';

/**
 * Renders a compact blast-radius brief for incident surfaces and prompts.
 *
 * @param br - Structured topology impact result to render.
 */
export function renderBlastRadius(br: BlastRadius): string {
  const title = `Blast radius for "${br.service}"${
    br.scope && Object.keys(br.scope).length
      ? ` [${Object.entries(br.scope)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}]`
      : ''
  }`;
  if (!br.mapped) {
    return `${title}: ${br.note ?? 'service not registered in topology'} — blast radius unavailable.`;
  }
  const fmt = (d: BlastRadiusDependent): string =>
    `  - ${d.name}${
      d.scope && Object.keys(d.scope).length
        ? ` [${Object.entries(d.scope)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}]`
        : ''
    }${d.criticality ? ` (${d.criticality})` : ''}${d.team ? `, team ${d.team}` : ''}`;
  const lines: string[] = [
    `${title}:`,
    'Potential exposure from known call evidence, not observed outages. Async calls and circuit breakers do not prove protection.',
  ];
  const { direct, indirect, insulated, unclassified = [] } = br.dependents;
  if (br.note) lines.push(br.note);
  if (direct.length + indirect.length + insulated.length + unclassified.length === 0) {
    lines.push('- No known dependents in this evidence. Dependency coverage may be incomplete.');
  } else {
    if (direct.length) lines.push('- Synchronous exposure:', ...direct.map(fmt));
    if (unclassified.length)
      lines.push('- Call-path exposure (sync/async behaviour unknown):', ...unclassified.map(fmt));
    if (indirect.length)
      lines.push('- Exposure through async calls (impact may be delayed):', ...indirect.map(fmt));
    if (insulated.length)
      lines.push(
        '- Exposure through declared circuit breakers (verify fallback):',
        ...insulated.map(fmt),
      );
  }
  if (br.truncated) lines.push('- (depth cap reached; the blast radius may extend further)');
  if (br.suspects.length) {
    lines.push('- Suspects (direct dependencies, candidate causes):');
    for (const s of br.suspects) {
      lines.push(`  - ${s.name} (${s.syncType}${s.criticality ? `, ${s.criticality}` : ''})`);
    }
  }
  return lines.join('\n');
}

/**
 * Computes affected callers and candidate dependencies for a failing service.
 *
 * @remarks Traversal includes all declared calls, retaining uncertainty across resilience boundaries.
 * @param db - Database connection used for topology reads.
 * @param tenantId - Tenant whose topology graph should be traversed.
 * @param service - Failing service at the center of the traversal.
 * @param opts - Traversal depth and exact identity or scope constraints.
 */
export async function computeBlastRadius(
  db: Db,
  tenantId: string,
  service: string,
  opts: {
    maxDepth?: number;
    environment?: string;
    subjectKey?: string;
    scope?: Record<string, string>;
  } = {},
): Promise<BlastRadius> {
  const environment = opts.environment || opts.scope?.environment;
  const requestedScope = { ...opts.scope, ...(environment ? { environment } : {}) };
  const discovery = await readDiscoveredTopology(db, tenantId);
  const selected = selectTopologySubject(discovery.operational, {
    key: opts.subjectKey,
    name: service,
    kind: 'service',
    scope: requestedScope,
  });
  if (selected.status === 'ambiguous' || (opts.subjectKey && selected.status === 'unmapped'))
    return {
      service,
      mapped: false,
      dependents: { direct: [], indirect: [], insulated: [] },
      suspects: [],
      truncated: false,
      candidates:
        selected.status === 'ambiguous'
          ? selected.candidates.map(({ key, name, scope }) => ({ key, name, scope }))
          : [],
      note:
        selected.status === 'ambiguous'
          ? 'Service identity is ambiguous. Select its environment or exact topology identity.'
          : 'The selected topology identity is unavailable in this workspace or scope.',
    };
  if (selected.status === 'resolved') {
    const declared = await withTenant(db, tenantId, async (tx) => ({
      services: await tx.select().from(services),
      edges: await tx.select().from(serviceDependencies),
    }));
    return discoveredBlastRadius(discovery.operational, selected.subject, declared, opts.maxDepth);
  }
  if (Object.entries(requestedScope).some(([key, value]) => key !== 'environment' && value))
    return {
      service,
      scope: requestedScope,
      mapped: false,
      dependents: { direct: [], indirect: [], insulated: [] },
      suspects: [],
      truncated: false,
      note: 'No discovered service matches the requested resource scope. Catalog names alone cannot establish its cluster, namespace or source identity.',
    };
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const scope = environment ? sql`(environment = ${environment} or environment = '')` : sql`true`;

  return withTenant(db, tenantId, async (tx) => {
    // Bound this read: the worker runs it on every triage job, and a very large or pathological graph
    // must never hang a pooled connection. SET LOCAL scopes the limit to this transaction.
    await tx.execute(sql`set local statement_timeout = '3s'`);
    // Edges require both endpoints registered (composite FK), so an unregistered service has no
    // edges. Distinguish "not a node" (note) from "registered but isolated" (mapped, no note).
    const mappedRows = (await tx.execute(
      sql`select 1 from services where name = ${service} limit 1`,
    )) as unknown as unknown[];
    if (mappedRows.length === 0) {
      return {
        service,
        mapped: false,
        dependents: { direct: [], indirect: [], insulated: [] },
        suspects: [],
        truncated: false,
        note: 'service not registered in topology',
      };
    }

    const depRows = (await tx.execute(sql`
      with recursive scoped_dependencies as (
        select * from service_dependencies where ${scope}
      ), reach as (
        -- Bound states by node, depth and exposure tier instead of enumerating every path.
        select sd.upstream as node, 1 as depth,
          case when sd.circuit_breaker then 2 when sd.sync_type = 'async' then 1 else 0 end as tier
        from scoped_dependencies sd
        where sd.downstream = ${service}
        union
        select sd.upstream, r.depth + 1,
          greatest(r.tier, case when sd.circuit_breaker then 2 when sd.sync_type = 'async' then 1 else 0 end)
        from scoped_dependencies sd
        join reach r on sd.downstream = r.node
        where r.depth < ${maxDepth}
          and sd.upstream <> ${service}
      ),
      exposure as (
        select node, min(tier) as tier from reach group by node
      ),
      reached as (
        select r.node, e.tier, min(r.depth) as hops
        from reach r join exposure e on e.node = r.node and e.tier = r.tier
        group by r.node, e.tier
      ),
      truncation as (
        -- Reaching a known caller matters when the omitted path has stronger exposure.
        select exists (
          select 1 from scoped_dependencies sd
          join reach r on sd.downstream = r.node
          where r.depth = ${maxDepth}
            and sd.upstream <> ${service}
            and not exists (
              select 1 from reached known where known.node = sd.upstream
                and known.tier <= greatest(r.tier,
                  case when sd.circuit_breaker then 2 when sd.sync_type = 'async' then 1 else 0 end)
            )
        ) as truncated
      )
      select d.node as name,
             case d.tier when 0 then 'direct' when 1 then 'indirect' else 'insulated' end as tier,
             d.hops as hops,
             s.criticality, s.team, (select truncated from truncation) as truncated
      from reached d
      left join services s on s.name = d.node
    `)) as unknown as Array<Record<string, unknown>>;

    const dependents: BlastRadius['dependents'] = { direct: [], indirect: [], insulated: [] };
    let truncated = false;
    for (const row of depRows) {
      truncated = Boolean(row.truncated);
      const tier = String(row.tier) as 'direct' | 'indirect' | 'insulated';
      const entry: BlastRadiusDependent = {
        name: String(row.name),
        criticality: (row.criticality as string | null) ?? null,
        team: (row.team as string | null) ?? null,
        hops: Number(row.hops),
      };
      if (tier === 'indirect') entry.via = 'async';
      else if (tier === 'insulated') entry.via = 'circuit_breaker';
      dependents[tier].push(entry);
    }
    for (const tier of ['direct', 'indirect', 'insulated'] as const) {
      dependents[tier].sort((a, b) => a.hops - b.hops || a.name.localeCompare(b.name));
    }

    // Suspects: the failing service's own direct (1-hop) downstream dependencies — candidate causes.
    const suspectRows = (await tx.execute(sql`
      select sd.downstream as name, sd.sync_type as sync_type, s.criticality
      from service_dependencies sd
      left join services s on s.name = sd.downstream
      where sd.upstream = ${service}
        and ${scope}
      order by sd.downstream
    `)) as unknown as Array<Record<string, unknown>>;
    const suspects: BlastRadiusSuspect[] = suspectRows.map((r) => ({
      name: String(r.name),
      syncType: String(r.sync_type),
      criticality: (r.criticality as string | null) ?? null,
    }));

    return {
      service,
      ...(environment ? { scope: { environment } } : {}),
      mapped: true,
      dependents,
      suspects,
      truncated,
    };
  });
}
