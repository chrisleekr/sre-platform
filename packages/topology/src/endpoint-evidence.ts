import { and, desc, gte, lte, sql } from 'drizzle-orm';
import { agentToolCalls, withTenant, type Db } from '@sre/db';
import { networkProbeTopologyEvidence } from '@sre/connectors';
import type { TopologyEndpointEvidence } from '@sre/contracts';
import { readDiscoveredTopology } from './discovery-repo';
import { selectTopologySubject } from './selection';

/** Reuse tenant-audited network observations without inventing connector ownership or issuing probes.
 * @param db - Tenant-scoped application database.
 * @param tenantId - Workspace owning both discovery and audit evidence.
 * @param subjectKey - Exact endpoint identity from current discovered topology.
 */
export async function readTopologyEndpointEvidence(
  db: Db,
  tenantId: string,
  subjectKey: string,
): Promise<TopologyEndpointEvidence> {
  const note =
    'These on-demand probes ran from the platform during an investigation. They do not establish service identity, dependency ownership or overall availability. Shared IPs and certificates do not merge endpoints.';
  const graph = await readDiscoveredTopology(db, tenantId);
  const selected = selectTopologySubject(graph.operational, { key: subjectKey, kind: 'endpoint' });
  const entity =
    selected.status === 'resolved'
      ? graph.entities.find((item) => item.key === selected.subject.key)
      : undefined;
  if (entity?.ref.authority !== 'http-endpoint')
    return {
      status: 'unavailable',
      endpoint: null,
      probes: [],
      note: `No unambiguous HTTP endpoint matches this subject. ${note}`,
    };
  let target: URL;
  try {
    target = new URL(entity.ref.id);
  } catch {
    return { status: 'unavailable', endpoint: null, probes: [], note };
  }
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.hash
  )
    return { status: 'unavailable', endpoint: null, probes: [], note };
  const now = new Date();
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const effective = (field: string) =>
    sql`coalesce(nullif(${agentToolCalls.output}->${field}, 'null'::jsonb), nullif(${agentToolCalls.input}->${field}, 'null'::jsonb))`;
  const effectiveHost = effective('host');
  const effectivePort = sql`coalesce(${effective('port')}, '443'::jsonb)`;
  const expectedPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const whitespace =
    '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  const hostMatches = sql`jsonb_typeof(${effectiveHost}) = 'string' and lower(regexp_replace(btrim(${effectiveHost} #>> '{}', ${whitespace}), '^\\[|\\]$', '', 'g')) = ${host}`;
  const operations = ['resolve_dns', 'check_reachable', 'inspect_tls', 'http_meta'].filter(
    (operation) => operation !== 'inspect_tls' || target.protocol === 'https:',
  );
  const rows = await withTenant(db, tenantId, async (tx) =>
    (
      await Promise.all(
        operations.map((operation) =>
          tx
            .select()
            .from(agentToolCalls)
            .where(
              and(
                gte(agentToolCalls.createdAt, new Date(now.getTime() - 86_400_000)),
                lte(agentToolCalls.createdAt, now),
                sql`${agentToolCalls.tool} ~ ${`^networkprobe_[A-Za-z0-9_-]{22}_${operation}$`}`,
                operation === 'http_meta'
                  ? sql`${effective('url')} = to_jsonb(${target.href}::text)`
                  : and(
                      hostMatches,
                      operation === 'resolve_dns'
                        ? undefined
                        : sql`${effectivePort} = to_jsonb(${expectedPort}::integer)`,
                    ),
              ),
            )
            .orderBy(desc(agentToolCalls.createdAt), desc(agentToolCalls.id))
            .limit(1),
        ),
      )
    ).flat(),
  );
  const probes = new Map<string, TopologyEndpointEvidence['probes'][number]>();
  for (const row of rows) {
    const probe = networkProbeTopologyEvidence(target, row, now);
    if (probe && !probes.has(probe.kind))
      probes.set(probe.kind, { ...probe, stale: probe.stale || entity.stale });
  }
  return {
    status: probes.size ? 'observed' : 'unavailable',
    endpoint: target.href,
    probes: [...probes.values()],
    note: `${note}${probes.size ? '' : ' No matching probe evidence was recorded in the last 24 hours.'}`,
  };
}
