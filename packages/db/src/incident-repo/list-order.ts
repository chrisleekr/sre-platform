import type { SQL } from 'drizzle-orm';
import { and, asc, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import { incidents } from '../schema';
import { humanAttentionCondition } from './detail';

/**
 * Incident list orderings. `priority` is the triage order (human attention, severity, lifecycle,
 * recent activity) and is only offered for the bounded open scope, because its keys are derived
 * from mutable state and cannot back a stable keyset.
 */
export type IncidentSort = 'priority' | 'newest' | 'oldest' | 'severity';

/**
 * A keyset cursor for the paginated incident reader. `severityRank` is present only for the
 * `severity` ordering, whose leading key is the rank.
 */
export interface IncidentPageCursor {
  createdAt: Date;
  id: string;
  severityRank?: number;
}

const SEVERITY_RANK: Record<string, number> = { sev1: 1, sev2: 2, sev3: 3 };
const UNKNOWN_SEVERITY_RANK = 99;

// Every rank `incidentSeverityRank` can return. Cursor decoders accept only these, so a forged rank
// outside Postgres int range is refused as a bad cursor instead of failing the query.
export const INCIDENT_SEVERITY_RANKS: ReadonlySet<number> = new Set([
  ...Object.values(SEVERITY_RANK),
  UNKNOWN_SEVERITY_RANK,
]);

// Rank used by the severity ordering; lower sorts first. Must match `severityRankSql`.
export function incidentSeverityRank(severity: string): number {
  // hasOwn, so a severity such as "constructor" cannot resolve to an inherited Object property.
  return Object.hasOwn(SEVERITY_RANK, severity) ? SEVERITY_RANK[severity]! : UNKNOWN_SEVERITY_RANK;
}

// Literal ranks, not bind parameters: an all-parameter CASE resolves to text in Postgres.
const severityRankSql = () =>
  sql<number>`case ${incidents.severity} when 'sev1' then 1 when 'sev2' then 2 when 'sev3' then 3 else 99 end`;

function createdAtAfter(cursor: IncidentPageCursor, direction: 'asc' | 'desc'): SQL {
  const past = direction === 'desc' ? lt : gt;
  return or(
    past(incidents.createdAt, cursor.createdAt),
    and(eq(incidents.createdAt, cursor.createdAt), past(incidents.id, cursor.id)),
  )!;
}

export function keysetCondition(sort: IncidentSort, cursor: IncidentPageCursor): SQL {
  if (sort === 'oldest') return createdAtAfter(cursor, 'asc');
  if (sort === 'severity') {
    const rank = cursor.severityRank ?? UNKNOWN_SEVERITY_RANK;
    return or(
      sql`${severityRankSql()} > ${rank}::int`,
      and(sql`${severityRankSql()} = ${rank}::int`, createdAtAfter(cursor, 'desc')),
    )!;
  }
  return createdAtAfter(cursor, 'desc');
}

export function incidentOrder(sort: IncidentSort): SQL[] {
  switch (sort) {
    case 'priority':
      return [
        sql`case when ${humanAttentionCondition()} then 0 else 1 end`,
        severityRankSql(),
        sql`case ${incidents.status} when 'open' then 1 when 'mitigated' then 2 else 99 end`,
        desc(incidents.updatedAt),
        desc(incidents.createdAt),
        desc(incidents.id),
      ];
    case 'oldest':
      return [asc(incidents.createdAt), asc(incidents.id)];
    case 'severity':
      return [severityRankSql(), desc(incidents.createdAt), desc(incidents.id)];
    case 'newest':
      return [desc(incidents.createdAt), desc(incidents.id)];
  }
}
