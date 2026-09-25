import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { IncidentCorrelationFeedback } from '@sre/contracts';
import { type Tx } from '../rls';
import { clearRecoveryTx } from '../signal-repo/recovery-state';
import { listResponseGroupIncidentIdsTx } from './causal';
import {
  approvals,
  incidentRelations,
  incidentSignals,
  incidents,
  jobs,
  type IncidentRelationDecider,
  type IncidentRelationType,
} from '../schema';

/** Reports a conflicting incident relation correction. */
export class IncidentCorrectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentCorrectionConflictError';
  }
}

export interface IncidentRelationInput {
  sourceIncidentId: string;
  targetIncidentId: string;
  type: IncidentRelationType;
  rationale: string;
  evidence: string[];
  decidedBy: IncidentRelationDecider;
  decidedByUserId?: string;
  correlationFeedback?: IncidentCorrelationFeedback;
  evidenceIds?: string[];
  confidence?: number;
  decisionRunId?: string;
  correction?: {
    signalIds: string[];
    bindingIds: string[];
    primaryBindingId: string;
    sourceLifecycle: {
      status: (typeof incidents.$inferSelect)['status'];
      resolvedAt: string | null;
      closedAt: string | null;
    };
  };
}

/**
 * Supersede the prior pair decision and append its evidence-backed replacement.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function recordIncidentRelationTx(
  tx: Tx,
  tenantId: string,
  input: IncidentRelationInput,
) {
  if (input.sourceIncidentId === input.targetIncidentId)
    throw new Error('an incident cannot relate to itself');
  const rationale = input.rationale.trim();
  if (!rationale) throw new Error('an incident relationship requires a rationale');
  if (input.correlationFeedback && (input.decidedBy !== 'human' || !input.decidedByUserId))
    throw new Error('correlation feedback requires an attributed responder');

  const found = await tx
    .select({ id: incidents.id })
    .from(incidents)
    .where(or(eq(incidents.id, input.sourceIncidentId), eq(incidents.id, input.targetIncidentId)));
  if (new Set(found.map((row) => row.id)).size !== 2)
    throw new Error('both incidents must exist in the tenant');
  if (input.type === 'unrelated') {
    const activeMerge = await tx
      .select({ id: incidentRelations.id })
      .from(incidentRelations)
      .where(
        and(
          eq(incidentRelations.type, 'merged_into'),
          isNull(incidentRelations.supersededAt),
          or(
            and(
              eq(incidentRelations.sourceIncidentId, input.sourceIncidentId),
              eq(incidentRelations.targetIncidentId, input.targetIncidentId),
            ),
            and(
              eq(incidentRelations.sourceIncidentId, input.targetIncidentId),
              eq(incidentRelations.targetIncidentId, input.sourceIncidentId),
            ),
          ),
        ),
      )
      .limit(1);
    if (activeMerge[0])
      throw new IncidentCorrectionConflictError(
        'Split the joined incidents before recording that they have different causes.',
      );
  }

  const current = await tx
    .select()
    .from(incidentRelations)
    .where(
      and(
        eq(incidentRelations.sourceIncidentId, input.sourceIncidentId),
        eq(incidentRelations.targetIncidentId, input.targetIncidentId),
        eq(incidentRelations.type, input.type),
        isNull(incidentRelations.supersededAt),
      ),
    )
    .limit(1);
  if (
    current[0] &&
    current[0].rationale === rationale &&
    JSON.stringify(current[0].evidence) === JSON.stringify(input.evidence) &&
    current[0].decidedBy === input.decidedBy &&
    JSON.stringify(current[0].correction) === JSON.stringify(input.correction ?? null) &&
    JSON.stringify(current[0].correlationFeedback) ===
      JSON.stringify(input.correlationFeedback ?? null) &&
    JSON.stringify(current[0].evidenceIds) === JSON.stringify(input.evidenceIds ?? []) &&
    current[0].confidence === (input.confidence ?? null) &&
    current[0].decisionRunId === (input.decisionRunId ?? null) &&
    current[0].decidedByUserId === (input.decidedByUserId ?? null)
  )
    return current[0];

  const previousCausal = await tx
    .select({ id: incidentRelations.id })
    .from(incidentRelations)
    .where(
      and(
        eq(incidentRelations.type, 'caused_by'),
        isNull(incidentRelations.supersededAt),
        or(
          and(
            eq(incidentRelations.sourceIncidentId, input.sourceIncidentId),
            eq(incidentRelations.targetIncidentId, input.targetIncidentId),
          ),
          and(
            eq(incidentRelations.sourceIncidentId, input.targetIncidentId),
            eq(incidentRelations.targetIncidentId, input.sourceIncidentId),
          ),
        ),
      ),
    )
    .limit(1);
  const changesMembership =
    input.type !== 'recurrence_of' && (input.type === 'caused_by' || Boolean(previousCausal[0]));
  const affectedIds = changesMembership
    ? [
        ...new Set([
          ...(await listResponseGroupIncidentIdsTx(tx, tenantId, input.sourceIncidentId)),
          ...(await listResponseGroupIncidentIdsTx(tx, tenantId, input.targetIncidentId)),
        ]),
      ]
    : [];
  if (affectedIds.length) {
    await lockIncidentWorkTx(tx, tenantId, affectedIds);
    // Invalidate work only when the group has signal or recovery state that predates this membership.
    const stale = await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          inArray(incidents.id, affectedIds),
          sql`(
        exists (select 1 from incident_signals where ${inArray(incidentSignals.incidentId, affectedIds)})
        or ${incidents.recoveryState} is not null or ${incidents.resolutionBasis} is not null
      )`,
        ),
      )
      .orderBy(incidents.id)
      .for('update');
    for (const incident of stale) await clearRecoveryTx(tx, tenantId, incident.id);
    if (stale.length)
      await tx
        .update(incidents)
        .set({ lifecycleVersion: sql`${incidents.lifecycleVersion} + 1` })
        .where(
          inArray(
            incidents.id,
            stale.map((incident) => incident.id),
          ),
        );
  }

  await tx
    .update(incidentRelations)
    .set({ supersededAt: sql`now()` })
    .where(
      and(
        or(
          and(
            eq(incidentRelations.sourceIncidentId, input.sourceIncidentId),
            eq(incidentRelations.targetIncidentId, input.targetIncidentId),
          ),
          and(
            eq(incidentRelations.sourceIncidentId, input.targetIncidentId),
            eq(incidentRelations.targetIncidentId, input.sourceIncidentId),
          ),
        ),
        inArray(
          incidentRelations.type,
          input.type === 'recurrence_of'
            ? ['recurrence_of']
            : ['possible_related', 'caused_by', 'merged_into', 'split_from', 'unrelated'],
        ),
        isNull(incidentRelations.supersededAt),
      ),
    );
  const rows = await tx
    .insert(incidentRelations)
    .values({ tenantId, ...input, rationale })
    .returning();
  return rows[0]!;
}

/**
 * Records a model cohort decision without weakening an established responder or causal decision.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Bounded model decision for one incident pair.
 */
export async function recordAgentCohortRelationTx(
  tx: Tx,
  tenantId: string,
  input: Omit<IncidentRelationInput, 'type' | 'decidedBy'> & {
    type: 'possible_related' | 'unrelated';
  },
) {
  await lockCausalGraphTx(tx, tenantId);
  await lockIncidentWorkTx(tx, tenantId, [input.sourceIncidentId, input.targetIncidentId]);
  const visible = await tx
    .select({ id: incidents.id })
    .from(incidents)
    .where(
      and(
        inArray(incidents.id, [input.sourceIncidentId, input.targetIncidentId]),
        isNull(incidents.archivedAt),
      ),
    )
    .orderBy(incidents.id)
    .for('update');
  if (visible.length !== 2) return null;
  const active = await tx
    .select({
      decidedBy: incidentRelations.decidedBy,
      type: incidentRelations.type,
    })
    .from(incidentRelations)
    .where(
      and(
        or(
          and(
            eq(incidentRelations.sourceIncidentId, input.sourceIncidentId),
            eq(incidentRelations.targetIncidentId, input.targetIncidentId),
          ),
          and(
            eq(incidentRelations.sourceIncidentId, input.targetIncidentId),
            eq(incidentRelations.targetIncidentId, input.sourceIncidentId),
          ),
        ),
        inArray(incidentRelations.type, [
          'possible_related',
          'caused_by',
          'merged_into',
          'split_from',
          'unrelated',
        ]),
        isNull(incidentRelations.supersededAt),
      ),
    );
  if (
    active.some(
      (relation) => relation.decidedBy === 'human' || relation.type !== 'possible_related',
    )
  )
    return null;
  return recordIncidentRelationTx(tx, tenantId, {
    ...input,
    decidedBy: 'agent',
  });
}

export interface IncidentCorrectionInput {
  sourceIncidentId: string;
  targetIncidentId: string;
  rationale: string;
  evidence: string[];
  decidedByUserId: string;
  onCorrectedTx?: (
    tx: Tx,
    result: {
      source: typeof incidents.$inferSelect;
      target: typeof incidents.$inferSelect;
      relation: typeof incidentRelations.$inferSelect;
      correction: {
        signalIds: string[];
        bindingIds: string[];
        primaryBindingId: string;
        sourceLifecycle: {
          status: (typeof incidents.$inferSelect)['status'];
          resolvedAt: string | null;
          closedAt: string | null;
        };
      };
    },
  ) => Promise<void>;
}

/**
 * Serialize incident-scoped job creation with evidence-moving merge and split corrections.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentIds - Identifiers considered by the operation.
 */
export async function lockIncidentWorkTx(
  tx: Tx,
  tenantId: string,
  incidentIds: string[],
): Promise<void> {
  for (const incidentId of [...new Set(incidentIds)].sort())
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${incidentId}:incident-work`}, 0))`,
    );
}

/**
 * Serializes causal graph snapshots and mutations for one tenant.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose causal graph is being read or changed.
 */
export async function lockCausalGraphTx(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:causal-graph`}, 0))`,
  );
}

/**
 * Resolve an incident that has been durably joined into another investigation.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param incidentId - Incident targeted by the operation.
 */
export async function getActiveMergedTargetTx(tx: Tx, incidentId: string): Promise<string | null> {
  const rows = await tx
    .select({ targetIncidentId: incidentRelations.targetIncidentId })
    .from(incidentRelations)
    .where(
      and(
        eq(incidentRelations.sourceIncidentId, incidentId),
        eq(incidentRelations.type, 'merged_into'),
        isNull(incidentRelations.supersededAt),
      ),
    )
    .limit(1);
  return rows[0]?.targetIncidentId ?? null;
}

export async function assertNoActiveIncidentJobsTx(
  tx: Tx,
  tenantId: string,
  incidentIds: string[],
): Promise<void> {
  const active = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        inArray(jobs.status, ['queued', 'processing']),
        or(...incidentIds.map((id) => sql`${jobs.payload}->>'incidentId' = ${id}`)),
      ),
    )
    .limit(1);
  if (active[0])
    throw new IncidentCorrectionConflictError(
      'Wait for both independent investigations to finish before joining or splitting them.',
    );
}

export async function assertNoPendingIncidentApprovalsTx(
  tx: Tx,
  incidentIds: string[],
): Promise<void> {
  const pending = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(inArray(approvals.incidentId, incidentIds), isNull(approvals.decision)))
    .limit(1);
  if (pending[0])
    throw new IncidentCorrectionConflictError(
      'Resolve pending responder approvals before joining or splitting these incidents.',
    );
}

export function assertVisibleIncidentPair(locked: Array<typeof incidents.$inferSelect>): void {
  if (locked.length !== 2 || locked.some((incident) => incident.archivedAt !== null)) {
    throw new IncidentCorrectionConflictError('both incidents must exist in the tenant');
  }
}

/**
 * Consolidate active work while retaining the exact membership needed to reverse the decision.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
