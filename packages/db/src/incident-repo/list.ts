import type { SQL } from 'drizzle-orm';
import {
  and,
  cosineDistance,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import type { Db } from '../client';
import type { Embedder } from '../embedder';
import { withTenant, type Executor } from '../rls';
import {
  ACTIVE_STATUSES,
  CLOSED_STATUSES,
  approvals,
  inboundChannels,
  inboundSideEffects,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  services,
  surfaceBindings,
  type IncidentStatus,
} from '../schema';

import {
  activeSignalCountSql,
  attentionColumns,
  humanAttentionCondition,
  signalCountSql,
  summaryColumns,
  type IncidentAttentionReason,
  type IncidentSummary,
} from './detail';
import {
  incidentOrder,
  incidentSeverityRank,
  keysetCondition,
  type IncidentPageCursor,
  type IncidentSort,
} from './list-order';
import { responsibleOwnerSql } from './owner';

/**
 * An incident as the dashboard lists it: the summary, operational priority facts, signal counts, and
 * the conversation it was born in. Channel identity remains useful context even though the dashboard
 * is a single prioritized response queue.
 */
export interface IncidentListItem extends IncidentSummary {
  /** The channel the incident's thread lives in; null only for an incident with no surface binding. */
  originChannel: string | null;
  /** The channel's display name; null when the tenant has no inbound subscription naming it. */
  originChannelName: string | null;
  nextStep: string | null;
  assessmentUpdatedAt: Date | null;
  recoveryState: 'verifying' | 'monitoring' | 'verified' | 'not_verified' | null;
  recoveryNextStep: string | null;
  recoveryUpdatedAt: Date | null;
  recoveryAttempt: number | null;
  recoveryMaxChecks: number | null;
  recoveryNextCheckAt: Date | null;
  recoveryScheduleReason: string | null;
  updatedAt: Date;
  occurrenceCount: number;
  signalCount: number;
  activeSignalCount: number;
  operatorDecision: string | null;
  pendingApprovalCount: number;
  requiresHumanAttention: boolean;
  attentionReason: IncidentAttentionReason | null;
  /** Owning service team when the affected service resolves to the tenant's service catalog. */
  responsibleOwner: string | null;
  /** Direct response parent when this incident is a causal symptom. */
  causalParentId: string | null;
}

const listColumns = {
  ...summaryColumns,
  nextStep: incidents.nextStep,
  assessmentUpdatedAt: incidents.assessmentUpdatedAt,
  recoveryState: incidents.recoveryState,
  recoveryNextStep: incidents.recoveryNextStep,
  recoveryUpdatedAt: incidents.recoveryUpdatedAt,
  recoveryAttempt: incidents.recoveryAttempt,
  recoveryMaxChecks: incidents.recoveryMaxChecks,
  recoveryNextCheckAt: incidents.recoveryNextCheckAt,
  recoveryScheduleReason: incidents.recoveryScheduleReason,
  updatedAt: incidents.updatedAt,
  occurrenceCount: incidents.occurrenceCount,
  signalCount: signalCountSql().mapWith(Number),
  activeSignalCount: activeSignalCountSql().mapWith(Number),
  responsibleOwner: responsibleOwnerSql(),
  causalParentId: sql<string | null>`(
      select ${incidentRelations.targetIncidentId}
      from ${incidentRelations}
      where ${incidentRelations.tenantId} = ${incidents.tenantId}
        and ${incidentRelations.sourceIncidentId} = ${incidents.id}
        and ${incidentRelations.type} = 'caused_by'
        and ${incidentRelations.supersededAt} is null
      limit 1
    )`,
  ...attentionColumns,
} as const;

/**
 * Lists incidents.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param opts - Optional query or behavior controls.
 */
export async function listIncidents(
  db: Db,
  tenantId: string,
  opts: { status?: IncidentStatus; limit?: number } = {},
): Promise<IncidentListItem[]> {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        ...listColumns,
        originChannel: surfaceBindings.channel,
        originChannelName: inboundChannels.channelName,
      })
      .from(incidents)
      // `surface` plus `role=primary` is load-bearing: a merged incident may own several Slack source
      // bindings, but only its primary binding identifies the full dashboard conversation.
      // The tenant predicates make each join SELF-isolating: RLS already scopes every table, but this
      // function takes any Db — including the admin (RLS-bypassing) handle — and a Slack channel id is
      // only unique per workspace, so the join key alone would not isolate tenants. Correctness must not
      // depend on which connection is passed.
      .leftJoin(
        surfaceBindings,
        and(
          eq(surfaceBindings.tenantId, incidents.tenantId),
          eq(surfaceBindings.surface, 'slack'),
          eq(surfaceBindings.incidentId, incidents.id),
          eq(surfaceBindings.role, 'primary'),
        ),
      )
      .leftJoin(
        inboundChannels,
        and(
          eq(inboundChannels.tenantId, surfaceBindings.tenantId),
          eq(inboundChannels.surface, surfaceBindings.surface),
          eq(inboundChannels.channel, surfaceBindings.channel),
        ),
      )
      .leftJoin(
        services,
        and(eq(services.tenantId, incidents.tenantId), eq(services.name, incidents.service)),
      )
      .where(
        and(
          isNull(incidents.archivedAt),
          opts.status ? eq(incidents.status, opts.status) : undefined,
        ),
      )
      .orderBy(desc(incidents.createdAt))
      .limit(opts.limit ?? 100),
  );
}

export type { IncidentPageCursor, IncidentSort } from './list-order';
export { INCIDENT_SEVERITY_RANKS } from './list-order';

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function incidentSearchCondition(query: string): SQL<boolean> {
  const pattern = `%${escapeLike(query)}%`;
  return sql<boolean>`(${or(
    ilike(incidents.title, pattern),
    ilike(incidents.service, pattern),
    ilike(incidents.alertSource, pattern),
    ilike(surfaceBindings.channel, pattern),
    ilike(inboundChannels.channelName, pattern),
    sql<boolean>`${incidents.id}::text ilike ${pattern} escape '\\'`,
  )})`;
}

/**
 * Lists incidents page.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param opts - Optional query or behavior controls.
 */
export async function listIncidentsPage(
  db: Db,
  tenantId: string,
  opts: {
    scope: 'open' | 'closed' | 'all';
    attention?: 'human' | 'automation';
    query?: string;
    severity?: string;
    /** Defaults to `priority` for the open scope and `newest` otherwise. `priority` never pages. */
    sort?: IncidentSort;
    limit?: number;
    before?: IncidentPageCursor;
  },
): Promise<{ incidents: IncidentListItem[]; nextCursor: IncidentPageCursor | null }> {
  const limit = opts.limit ?? 50;
  const sort = opts.sort ?? (opts.scope === 'open' ? 'priority' : 'newest');
  const where: SQL[] = [isNull(incidents.archivedAt)];
  if (opts.scope !== 'all') {
    const statuses = opts.scope === 'open' ? ACTIVE_STATUSES : CLOSED_STATUSES;
    where.push(inArray(incidents.status, statuses));
  }
  if (opts.scope === 'open' && opts.attention) {
    where.push(
      opts.attention === 'human'
        ? humanAttentionCondition()
        : sql<boolean>`not ${humanAttentionCondition()}`,
    );
  }
  if (opts.query) where.push(incidentSearchCondition(opts.query));
  if (opts.severity) where.push(eq(incidents.severity, opts.severity));
  if (opts.before) {
    // Priority keys on mutable attention state, so a createdAt keyset would skip eligible rows.
    if (sort === 'priority') throw new Error('priority ordering does not support cursors');
    where.push(keysetCondition(sort, opts.before));
  }
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        ...listColumns,
        originChannel: surfaceBindings.channel,
        originChannelName: inboundChannels.channelName,
      })
      .from(incidents)
      .leftJoin(
        surfaceBindings,
        and(
          eq(surfaceBindings.tenantId, incidents.tenantId),
          eq(surfaceBindings.incidentId, incidents.id),
          eq(surfaceBindings.surface, 'slack'),
          eq(surfaceBindings.role, 'primary'),
        ),
      )
      .leftJoin(
        inboundChannels,
        and(
          eq(inboundChannels.tenantId, surfaceBindings.tenantId),
          eq(inboundChannels.surface, surfaceBindings.surface),
          eq(inboundChannels.channel, surfaceBindings.channel),
        ),
      )
      .leftJoin(
        services,
        and(eq(services.tenantId, incidents.tenantId), eq(services.name, incidents.service)),
      )
      .where(and(...where))
      .orderBy(...incidentOrder(sort))
      .limit(limit + 1),
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last && sort !== 'priority'
      ? {
          createdAt: last.createdAt,
          id: last.id,
          ...(sort === 'severity' ? { severityRank: incidentSeverityRank(last.severity) } : {}),
        }
      : null;
  return { incidents: page, nextCursor };
}

/**
 * Counts incidents by scope.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param purpose - Optional operational-purpose filter; omitted for the shared case list.
 */
export async function countIncidentsByScope(
  db: Db,
  tenantId: string,
  purpose?: 'incident' | 'health_check',
): Promise<{
  all: number;
  open: number;
  needsHuman: number;
  automation: number;
  closed: number;
}> {
  // Status predicates are derived from the two lifecycle constants.
  const [row] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        all: sql<number>`count(*) filter (where ${isNull(incidents.archivedAt)})`.mapWith(Number),
        open: sql<number>`count(*) filter (where ${inArray(incidents.status, ACTIVE_STATUSES)} and ${isNull(incidents.archivedAt)})`.mapWith(
          Number,
        ),
        closed:
          sql<number>`count(*) filter (where ${inArray(incidents.status, CLOSED_STATUSES)} and ${isNull(incidents.archivedAt)})`.mapWith(
            Number,
          ),
        needsHuman:
          sql<number>`count(*) filter (where ${inArray(incidents.status, ACTIVE_STATUSES)} and ${isNull(incidents.archivedAt)} and ${humanAttentionCondition()})`.mapWith(
            Number,
          ),
        automation:
          sql<number>`count(*) filter (where ${inArray(incidents.status, ACTIVE_STATUSES)} and ${isNull(incidents.archivedAt)} and not ${humanAttentionCondition()})`.mapWith(
            Number,
          ),
      })
      .from(incidents)
      .where(purpose ? eq(incidents.purpose, purpose) : undefined),
  );
  return {
    all: row?.all ?? 0,
    open: row?.open ?? 0,
    needsHuman: row?.needsHuman ?? 0,
    automation: row?.automation ?? 0,
    closed: row?.closed ?? 0,
  };
}

/**
 * Lists active incidents.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param opts - Optional query or behavior controls.
 */
export async function listActiveIncidents(
  db: Db,
  tenantId: string,
  opts: { since: Date; limit?: number },
): Promise<IncidentSummary[]> {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select(summaryColumns)
      .from(incidents)
      .where(
        and(
          inArray(incidents.status, ACTIVE_STATUSES),
          isNull(incidents.archivedAt),
          gte(incidents.updatedAt, opts.since),
        ),
      )
      .orderBy(desc(incidents.updatedAt))
      .limit(opts.limit ?? 100),
  );
}

/**
 * Distinct active service identities for the operational topology inventory.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 */
export async function listActiveIncidentServices(db: Db, tenantId: string): Promise<string[]> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .selectDistinct({ service: incidents.service })
      .from(incidents)
      .where(
        and(
          eq(incidents.purpose, 'incident'),
          inArray(incidents.status, ACTIVE_STATUSES),
          isNull(incidents.archivedAt),
        ),
      )
      .orderBy(incidents.service),
  );
  return rows.map((row) => row.service);
}

/**
 * Retrieves nearest active.
 *
 * @param db - Database connection used for the operation.
 * @param embedder - Embedding provider used for semantic retrieval.
 * @param tenantId - Tenant whose records are read or changed.
 * @param options - Optional query or behavior controls.
 */
export async function retrieveNearestActive(
  db: Db,
  embedder: Embedder,
  tenantId: string,
  options: { text: string; k: number; since: Date },
): Promise<IncidentSummary[]> {
  const { text, k, since } = options;
  const [qvec] = await embedder.embed([text]);
  const distance = cosineDistance(incidents.embedding, qvec!);
  return withTenant(db, tenantId, (tx) =>
    tx
      .select(summaryColumns)
      .from(incidents)
      .where(
        and(
          inArray(incidents.status, ACTIVE_STATUSES),
          gte(incidents.updatedAt, since),
          isNotNull(incidents.embedding),
        ),
      )
      .orderBy(distance)
      .limit(k),
  );
}

/**
 * Store the correlation-shortlist embedding for an incident (best-effort seed at open). RLS-scoped.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Value supplied for id.
 * @param vec - Embedding vector to persist.
 */
export async function setIncidentEmbedding(
  db: Db,
  tenantId: string,
  id: string,
  vec: number[],
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.update(incidents).set({ embedding: vec }).where(eq(incidents.id, id)),
  );
}

/**
 * Increments incident occurrence once.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param messageKey - Value supplied for message key.
 */
export async function bumpIncidentOccurrenceOnce(
  db: Executor,
  tenantId: string,
  incidentId: string,
  messageKey: string,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const claimed = await tx
      .insert(inboundSideEffects)
      .values({ tenantId, incidentId, messageKey })
      .onConflictDoNothing({
        target: [inboundSideEffects.tenantId, inboundSideEffects.messageKey],
      })
      .returning({ id: inboundSideEffects.id });
    if (!claimed[0]) return false; // already applied for this surface message
    await tx
      .update(incidents)
      .set({ occurrenceCount: sql`${incidents.occurrenceCount} + 1`, updatedAt: sql`now()` })
      .where(eq(incidents.id, incidentId));
    return true;
  });
}

/**
 * Snapshot visible terminal incidents that are old enough for the configured deletion policy.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param idleBefore - Timestamp before which a terminal incident is considered idle.
 */
export async function listIdleTerminalIncidentCandidates(
  db: Db,
  tenantId: string,
  idleBefore: Date,
): Promise<Array<{ id: string; lifecycleVersion: number }>> {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({ id: incidents.id, lifecycleVersion: incidents.lifecycleVersion })
      .from(incidents)
      .where(
        and(
          inArray(incidents.status, CLOSED_STATUSES),
          isNull(incidents.archivedAt),
          sql`not exists (select 1 from ${incidentSignals} s where s.incident_id = ${incidents.id} and s.tenant_id = ${incidents.tenantId} and s.state <> 'resolved')`,
          sql`not exists (select 1 from ${approvals} a where a.incident_id = ${incidents.id} and a.tenant_id = ${incidents.tenantId} and a.decision is null)`,
          sql`greatest(${incidents.updatedAt}, coalesce((select max(m.created_at) from ${incidentMessages} m where m.incident_id = ${incidents.id} and m.tenant_id = ${incidents.tenantId}), ${incidents.updatedAt})) < ${idleBefore.toISOString()}::timestamptz`,
        ),
      ),
  );
}
