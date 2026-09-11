import { withTenant, type Db } from '@sre/db';
import { sql } from 'drizzle-orm';

const DEFAULT_MAX_DEPTH = 10;

/** One affected caller in the blast radius. `via` explains a non-direct tier. */
export interface BlastRadiusDependent {
  name: string;
  criticality: string | null;
  team: string | null;
  /** Minimum hop distance from the failing service (direct=conducting depth; boundary=core+1). */
  hops: number;
  via?: 'async' | 'circuit_breaker';
}

/** A direct (1-hop) downstream dependency of the failing service: a candidate root cause. */
export interface BlastRadiusSuspect {
  name: string;
  syncType: string;
  criticality: string | null;
}

export interface BlastRadius {
  service: string;
  /** False when the failing service is not registered as a topology node. */
  mapped: boolean;
  dependents: {
    direct: BlastRadiusDependent[];
    indirect: BlastRadiusDependent[];
    insulated: BlastRadiusDependent[];
  };
  suspects: BlastRadiusSuspect[];
  /** True when the direct-failure walk hit the depth cap; the radius may be larger. */
  truncated: boolean;
  note?: string;
}

/**
 * Renders a compact blast-radius brief for incident surfaces and prompts.
 *
 * @param br - Structured topology impact result to render.
 */
export function renderBlastRadius(br: BlastRadius): string {
  const title = `Blast radius for "${br.service}"`;
  if (!br.mapped) {
    return `${title}: ${br.note ?? 'service not registered in topology'} — blast radius unavailable.`;
  }
  const fmt = (d: BlastRadiusDependent): string =>
    `  - ${d.name}${d.criticality ? ` (${d.criticality})` : ''}${d.team ? `, team ${d.team}` : ''}`;
  const lines: string[] = [`${title}:`];
  const { direct, indirect, insulated } = br.dependents;
  if (direct.length + indirect.length + insulated.length === 0) {
    lines.push('- No known dependents (nothing calls this service).');
  } else {
    if (direct.length) lines.push('- Direct (hard down):', ...direct.map(fmt));
    if (indirect.length) lines.push('- Indirect (degraded, async):', ...indirect.map(fmt));
    if (insulated.length) lines.push('- Insulated (circuit breaker):', ...insulated.map(fmt));
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
 * @remarks Traversal stops at asynchronous or circuit-broken boundaries and is depth-bounded.
 * @param db - Database connection used for topology reads.
 * @param tenantId - Tenant whose topology graph should be traversed.
 * @param service - Failing service at the center of the traversal.
 * @param opts - Optional traversal depth limit.
 */
export async function computeBlastRadius(
  db: Db,
  tenantId: string,
  service: string,
  opts: { maxDepth?: number } = {},
): Promise<BlastRadius> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

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
      with recursive reach as (
        -- Callers reachable through an unbroken chain of conducting (sync, non-breaker) edges. UNION
        -- de-duplicates (node, depth), so a dense graph cannot enumerate one row per simple path
        -- (that grows exponentially); the depth cap terminates cycles.
        select sd.upstream as node, 1 as depth
        from service_dependencies sd
        where sd.downstream = ${service}
          and sd.sync_type = 'sync' and sd.circuit_breaker = false
        union
        select sd.upstream, r.depth + 1
        from service_dependencies sd
        join reach r on sd.downstream = r.node
        where sd.sync_type = 'sync' and sd.circuit_breaker = false
          and r.depth < ${maxDepth}
      ),
      direct_nodes as (
        select node, min(depth) as hops from reach group by node
      ),
      core as (
        select ${service} as node, 0 as depth
        union
        select node, hops from direct_nodes
      ),
      boundary as (
        select sd.upstream as node,
               min(c.depth) + 1 as hops,
               case when bool_or(not sd.circuit_breaker) then 'indirect' else 'insulated' end as tier
        from service_dependencies sd
        join core c on sd.downstream = c.node
        where not (sd.sync_type = 'sync' and sd.circuit_breaker = false)
          and sd.upstream <> ${service}
          and sd.upstream not in (select node from direct_nodes)
        group by sd.upstream
      ),
      truncation as (
        -- The walk was cut iff a node whose shortest distance is exactly the cap has a conducting edge
        -- to a caller not reached by any shorter path. Excluding known direct nodes avoids a false
        -- "truncated" when the deeper edge only loops back to an already-included node.
        select exists (
          select 1 from service_dependencies sd
          join direct_nodes dn on sd.downstream = dn.node
          where sd.sync_type = 'sync' and sd.circuit_breaker = false
            and dn.hops = ${maxDepth}
            and sd.upstream not in (select node from direct_nodes)
        ) as truncated
      )
      select d.node as name, 'direct' as tier, d.hops as hops,
             s.criticality, s.team, (select truncated from truncation) as truncated
      from direct_nodes d
      left join services s on s.name = d.node
      union all
      select b.node as name, b.tier, b.hops,
             s.criticality, s.team, (select truncated from truncation) as truncated
      from boundary b
      left join services s on s.name = b.node
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
      order by sd.downstream
    `)) as unknown as Array<Record<string, unknown>>;
    const suspects: BlastRadiusSuspect[] = suspectRows.map((r) => ({
      name: String(r.name),
      syncType: String(r.sync_type),
      criticality: (r.criticality as string | null) ?? null,
    }));

    return { service, mapped: true, dependents, suspects, truncated };
  });
}
