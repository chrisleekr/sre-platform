import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { lockCausalGraphTx } from '../incident-relation-repo/core';
import { withTenant, type Tx } from '../rls';
import {
  ACTIVE_STATUSES,
  CLOSED_STATUSES,
  approvals,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  jobs,
  surfaceDeliveries,
  type IncidentStatus,
  type InvestigationStatus,
  type SignalState,
} from '../schema';

/**
 * Sets investigation status.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Value supplied for id.
 * @param investigationStatus - Investigation status restored after verification.
 */
export async function setInvestigationStatus(
  db: Db,
  tenantId: string,
  id: string,
  investigationStatus: InvestigationStatus,
): Promise<void> {
  await withTenant(db, tenantId, (tx) => setInvestigationStatusTx(tx, id, investigationStatus));
}

/**
 * Sets investigation progress inside an existing tenant transaction.
 * @param tx - Existing tenant transaction.
 * @param id - Incident whose progress changes.
 * @param investigationStatus - New investigation progress.
 */
export async function setInvestigationStatusTx(
  tx: Tx,
  id: string,
  investigationStatus: InvestigationStatus,
): Promise<void> {
  await tx
    .update(incidents)
    .set({ investigationStatus, updatedAt: sql`now()` })
    .where(eq(incidents.id, id));
}

export type LifecycleTransitionStatus =
  | 'forbidden'
  | 'applied'
  | 'noop'
  | 'invalid'
  | 'stale'
  | 'archived'
  | 'active_sibling'
  | 'precondition_failed'
  | 'merged'
  | 'not_found';

export interface LifecycleTransitionResult {
  outcome: LifecycleTransitionStatus;
  from: IncidentStatus | null;
  to: IncidentStatus;
  version: number | null;
}

const ALLOWED_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ['mitigated', 'resolved', 'closed'],
  mitigated: ['open', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open'],
};

/**
 * Serialize and validate one operational lifecycle transition. The caller owns the audit append.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param id - Value supplied for id.
 * @param to - Target lifecycle status.
 * @param opts - Optional query or behavior controls.
 */
export async function transitionIncidentTx(
  tx: Tx,
  id: string,
  to: IncidentStatus,
  opts: {
    expectedVersion?: number;
    expectedSignals?: Array<{ id: string; version: number; state: SignalState }>;
    idleBefore?: Date;
  } = {},
): Promise<LifecycleTransitionResult> {
  const rows = await tx
    .select({
      id: incidents.id,
      status: incidents.status,
      version: incidents.lifecycleVersion,
      tenantId: incidents.tenantId,
      fingerprint: incidents.fingerprint,
      updatedAt: incidents.updatedAt,
      archivedAt: incidents.archivedAt,
    })
    .from(incidents)
    .where(eq(incidents.id, id))
    .limit(1)
    .for('update');
  const row = rows[0];
  if (!row) return { outcome: 'not_found', from: null, to, version: null };
  const from = row.status as IncidentStatus;
  const merged = await tx
    .select({ id: incidentRelations.id })
    .from(incidentRelations)
    .where(
      and(
        eq(incidentRelations.sourceIncidentId, id),
        eq(incidentRelations.type, 'merged_into'),
        isNull(incidentRelations.supersededAt),
      ),
    )
    .limit(1);
  if (merged[0]) return { outcome: 'merged', from, to, version: row.version };
  if (from === to) return { outcome: 'noop', from, to, version: row.version };
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== row.version) {
    return { outcome: 'stale', from, to, version: row.version };
  }
  if (row.archivedAt) {
    return { outcome: 'archived', from, to, version: row.version };
  }
  if (opts.expectedSignals && opts.expectedSignals.length > 0) {
    const expected = new Map(opts.expectedSignals.map((signal) => [signal.id, signal]));
    const signalRows = await tx
      .select({
        id: incidentSignals.id,
        version: incidentSignals.version,
        state: incidentSignals.state,
      })
      .from(incidentSignals)
      .where(
        and(eq(incidentSignals.incidentId, id), inArray(incidentSignals.id, [...expected.keys()])),
      )
      .for('update');
    if (
      signalRows.length !== expected.size ||
      signalRows.some((signal) => {
        const wanted = expected.get(signal.id);
        return !wanted || wanted.version !== signal.version || wanted.state !== signal.state;
      })
    ) {
      return { outcome: 'precondition_failed', from, to, version: row.version };
    }
  }
  if (opts.idleBefore) {
    const recentMessage = await tx
      .select({ id: incidentMessages.id })
      .from(incidentMessages)
      .where(
        and(eq(incidentMessages.incidentId, id), gte(incidentMessages.createdAt, opts.idleBefore)),
      )
      .limit(1);
    if (row.updatedAt >= opts.idleBefore || recentMessage[0]) {
      return { outcome: 'precondition_failed', from, to, version: row.version };
    }
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { outcome: 'invalid', from, to, version: row.version };
  }

  if (
    CLOSED_STATUSES.includes(from as (typeof CLOSED_STATUSES)[number]) &&
    ACTIVE_STATUSES.includes(to as (typeof ACTIVE_STATUSES)[number])
  ) {
    const sibling = await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          eq(incidents.tenantId, row.tenantId),
          eq(incidents.fingerprint, row.fingerprint),
          sql`${incidents.id} <> ${row.id}`,
          inArray(incidents.status, ACTIVE_STATUSES),
        ),
      )
      .limit(1);
    if (sibling[0]) return { outcome: 'active_sibling', from, to, version: row.version };
  }

  const nextVersion = row.version + 1;
  const updated = await tx
    .update(incidents)
    .set({
      status: to,
      lifecycleVersion: nextVersion,
      mitigatedAt: to === 'mitigated' ? sql`now()` : to === 'open' ? null : undefined,
      resolvedAt: to === 'resolved' ? sql`now()` : to === 'open' ? null : undefined,
      closedAt: to === 'closed' ? sql`now()` : to === 'open' ? null : undefined,
      updatedAt: sql`now()`,
    })
    .where(eq(incidents.id, id))
    .returning({ version: incidents.lifecycleVersion });
  return { outcome: 'applied', from, to, version: updated[0]!.version };
}

export type IncidentArchiveStatus =
  | 'applied'
  | 'noop'
  | 'not_found'
  | 'stale'
  | 'active'
  | 'active_signals'
  | 'pending_approvals'
  | 'work_in_progress'
  | 'precondition_failed';

export interface IncidentArchiveResult {
  outcome: IncidentArchiveStatus;
  archivedAt: Date | null;
  lifecycleVersion: number | null;
}

/**
 * Sets incident archived tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param id - Value supplied for id.
 * @param archived - Desired archive state.
 * @param opts - Optional query or behavior controls.
 */
export async function setIncidentArchivedTx(
  tx: Tx,
  id: string,
  archived: boolean,
  opts: {
    expectedVersion?: number;
    idleBefore?: Date;
    allowActiveSignalsForClosed?: boolean;
  } = {},
): Promise<IncidentArchiveResult> {
  const owners = await tx
    .select({ tenantId: incidents.tenantId })
    .from(incidents)
    .where(eq(incidents.id, id))
    .limit(1);
  if (!owners[0]) return { outcome: 'not_found', archivedAt: null, lifecycleVersion: null };
  if (archived) await lockCausalGraphTx(tx, owners[0].tenantId);
  const rows = await tx
    .select({
      tenantId: incidents.tenantId,
      status: incidents.status,
      lifecycleVersion: incidents.lifecycleVersion,
      archivedAt: incidents.archivedAt,
      updatedAt: incidents.updatedAt,
      investigationStatus: incidents.investigationStatus,
    })
    .from(incidents)
    .where(eq(incidents.id, id))
    .limit(1)
    .for('update');
  const row = rows[0];
  if (!row) return { outcome: 'not_found', archivedAt: null, lifecycleVersion: null };
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== row.lifecycleVersion) {
    return {
      outcome: 'stale',
      archivedAt: row.archivedAt,
      lifecycleVersion: row.lifecycleVersion,
    };
  }
  if (!archived) {
    return {
      outcome: 'noop',
      archivedAt: row.archivedAt,
      lifecycleVersion: row.lifecycleVersion,
    };
  }
  if ((row.archivedAt !== null) === archived) {
    return {
      outcome: 'noop',
      archivedAt: row.archivedAt,
      lifecycleVersion: row.lifecycleVersion,
    };
  }

  if (archived) {
    if (!CLOSED_STATUSES.includes(row.status as (typeof CLOSED_STATUSES)[number])) {
      return {
        outcome: 'active',
        archivedAt: null,
        lifecycleVersion: row.lifecycleVersion,
      };
    }
    if (row.investigationStatus === 'gathering') {
      return {
        outcome: 'work_in_progress',
        archivedAt: null,
        lifecycleVersion: row.lifecycleVersion,
      };
    }
    const pendingJob = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, row.tenantId),
          inArray(jobs.status, ['queued', 'processing']),
          sql`${jobs.payload}->>'incidentId' = ${id}`,
        ),
      )
      .limit(1);
    if (pendingJob[0]) {
      return {
        outcome: 'work_in_progress',
        archivedAt: null,
        lifecycleVersion: row.lifecycleVersion,
      };
    }
    if (opts.idleBefore) {
      const recentMessage = await tx
        .select({ id: incidentMessages.id })
        .from(incidentMessages)
        .where(
          and(
            eq(incidentMessages.incidentId, id),
            gte(incidentMessages.createdAt, opts.idleBefore),
          ),
        )
        .limit(1);
      if (row.updatedAt >= opts.idleBefore || recentMessage[0]) {
        return {
          outcome: 'precondition_failed',
          archivedAt: null,
          lifecycleVersion: row.lifecycleVersion,
        };
      }
    }
    const activeSignal = await tx
      .select({ id: incidentSignals.id })
      .from(incidentSignals)
      .where(and(eq(incidentSignals.incidentId, id), sql`${incidentSignals.state} <> 'resolved'`))
      .limit(1);
    if (activeSignal[0] && !(row.status === 'closed' && opts.allowActiveSignalsForClosed)) {
      return {
        outcome: 'active_signals',
        archivedAt: null,
        lifecycleVersion: row.lifecycleVersion,
      };
    }
    const pendingApproval = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.incidentId, id), isNull(approvals.decision)))
      .limit(1);
    if (pendingApproval[0]) {
      return {
        outcome: 'pending_approvals',
        archivedAt: null,
        lifecycleVersion: row.lifecycleVersion,
      };
    }
    const sendingDelivery = await tx
      .select({ id: surfaceDeliveries.id })
      .from(surfaceDeliveries)
      .where(and(eq(surfaceDeliveries.incidentId, id), eq(surfaceDeliveries.state, 'sending')))
      .limit(1);
    if (sendingDelivery[0]) {
      return {
        outcome: 'work_in_progress',
        archivedAt: null,
        lifecycleVersion: row.lifecycleVersion,
      };
    }
    await tx
      .update(surfaceDeliveries)
      .set({
        state: 'blocked',
        operation: 'composite',
        reasonCode: 'incident_archived',
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(surfaceDeliveries.incidentId, id), eq(surfaceDeliveries.state, 'queued')));
    await tx
      .update(incidentRelations)
      .set({ supersededAt: sql`now()` })
      .where(
        and(
          isNull(incidentRelations.supersededAt),
          sql`(${incidentRelations.sourceIncidentId} = ${id} or ${incidentRelations.targetIncidentId} = ${id})`,
        ),
      );
  }

  const updated = await tx
    .update(incidents)
    .set({
      archivedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(incidents.id, id))
    .returning({ archivedAt: incidents.archivedAt });
  return {
    outcome: 'applied',
    archivedAt: updated[0]!.archivedAt,
    lifecycleVersion: row.lifecycleVersion,
  };
}
