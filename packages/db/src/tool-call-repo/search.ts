import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant } from '../rls';
import { agentToolCalls } from '../schema';
import { evidenceSummary } from './summary';

import {
  projectEvidence,
  providerReferenceBaseUrl,
  safeEvidenceReference,
  type EvidenceDetail,
  type EvidenceListItem,
  type EvidencePageCursor,
  type EvidenceProjection,
} from './projection';

export interface IncidentEvidenceSearchMatch {
  evidenceId: string;
  tool: string;
  input: unknown;
  outcome: string;
  recordedAt: Date;
  projection: EvidenceProjection;
}

/**
 * Searches incident evidence.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param query - Validated query and boundary controls.
 * @param limit - Maximum number of rows to return.
 */
export async function searchIncidentEvidence(
  db: Db,
  tenantId: string,
  incidentId: string,
  query: string,
  limit = 10,
): Promise<IncidentEvidenceSearchMatch[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const patterns = [...new Set(normalized.split(/\s+/))]
    .slice(0, 12)
    .map((term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`);
  const matches = patterns.map((pattern) =>
    or(
      sql`${agentToolCalls.tool} ilike ${pattern} escape '\\'`,
      sql`${agentToolCalls.input}::text ilike ${pattern} escape '\\'`,
      sql`coalesce(${agentToolCalls.output}::text, '') ilike ${pattern} escape '\\'`,
    )!,
  );
  const relevance = sql.join(
    matches.map((match) => sql`case when ${match} then 1 else 0 end`),
    sql` + `,
  );
  const boundedLimit = Math.max(1, Math.min(limit, 20));
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: agentToolCalls.id,
        tool: agentToolCalls.tool,
        input: agentToolCalls.input,
        output: agentToolCalls.output,
        outcome: agentToolCalls.outcome,
        recordedAt: agentToolCalls.createdAt,
      })
      .from(agentToolCalls)
      .where(
        and(
          eq(agentToolCalls.incidentId, incidentId),
          sql`${agentToolCalls.tool} <> 'search_incident_evidence'`,
          or(...matches),
        ),
      )
      .orderBy(desc(relevance), desc(agentToolCalls.createdAt), desc(agentToolCalls.id))
      .limit(boundedLimit);
    return rows.map((row) => ({
      evidenceId: row.id,
      tool: row.tool,
      input: row.input,
      outcome: row.outcome,
      recordedAt: row.recordedAt,
      projection: projectEvidence(row.tool, row.input, row.output),
    }));
  });
}

/**
 * Lists incident evidence page.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param opts - Optional query or behavior controls.
 */
export async function listIncidentEvidencePage(
  db: Db,
  tenantId: string,
  incidentId: string,
  opts: { limit?: number; before?: EvidencePageCursor } = {},
): Promise<{ evidence: EvidenceListItem[]; nextCursor: EvidencePageCursor | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: agentToolCalls.id,
        tool: agentToolCalls.tool,
        outcome: agentToolCalls.outcome,
        latencyMs: agentToolCalls.latencyMs,
        recordedAt: agentToolCalls.createdAt,
        hasOutput: sql<boolean>`${agentToolCalls.output} is not null`,
        input: agentToolCalls.input,
      })
      .from(agentToolCalls)
      .where(
        and(
          eq(agentToolCalls.incidentId, incidentId),
          opts.before
            ? or(
                lt(agentToolCalls.createdAt, opts.before.createdAt),
                and(
                  eq(agentToolCalls.createdAt, opts.before.createdAt),
                  lt(agentToolCalls.id, opts.before.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(agentToolCalls.createdAt), desc(agentToolCalls.id))
      .limit(limit + 1);
    const more = rows.length > limit;
    const evidence = rows
      .slice(0, limit)
      .map(({ input, ...row }) => ({ ...row, summary: evidenceSummary(row.tool, input) }));
    const last = evidence.at(-1);
    return {
      evidence,
      nextCursor: more && last ? { createdAt: last.recordedAt, id: last.id } : null,
    };
  });
}

/**
 * One redacted evidence record, scoped to both tenant and incident.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param evidenceId - evidence id targeted by the operation.
 */
export async function getIncidentEvidence(
  db: Db,
  tenantId: string,
  incidentId: string,
  evidenceId: string,
): Promise<EvidenceDetail | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: agentToolCalls.id,
        tool: agentToolCalls.tool,
        outcome: agentToolCalls.outcome,
        latencyMs: agentToolCalls.latencyMs,
        recordedAt: agentToolCalls.createdAt,
        hasOutput: sql<boolean>`${agentToolCalls.output} is not null`,
        input: agentToolCalls.input,
        output: agentToolCalls.output,
      })
      .from(agentToolCalls)
      .where(and(eq(agentToolCalls.incidentId, incidentId), eq(agentToolCalls.id, evidenceId)))
      .limit(1);
    const row = rows[0];
    const referenceBaseUrl = row ? await providerReferenceBaseUrl(tx, row.tool) : null;
    return row
      ? {
          ...row,
          summary: evidenceSummary(row.tool, row.input),
          projection: projectEvidence(row.tool, row.input, row.output),
          referenceUrl: safeEvidenceReference(row.output, referenceBaseUrl),
        }
      : null;
  });
}

export interface IncidentEvidenceProgress {
  total: number;
  successful: number;
  failed: number;
  lastRecordedAt: Date | null;
}

/**
 * Factual completed-check progress. It intentionally makes no claim about a currently running job.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function getIncidentEvidenceProgress(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<IncidentEvidenceProgress> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        total: sql<number>`count(*)::int`,
        successful: sql<number>`count(*) filter (where ${agentToolCalls.outcome} = 'data')::int`,
        failed: sql<number>`count(*) filter (where ${agentToolCalls.outcome} <> 'data')::int`,
        lastRecordedAt: sql<Date | null>`max(${agentToolCalls.createdAt})`,
      })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.incidentId, incidentId));
    return rows[0] ?? { total: 0, successful: 0, failed: 0, lastRecordedAt: null };
  });
}
