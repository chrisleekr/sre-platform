import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type Executor } from '../rls';
import { buildIncidentCorrelationFeedbackTx } from '../incident-correlation-repo';
import {
  alertEpisodeIntakes,
  incidentFeedback,
  incidentRelations,
  incidentSignals,
  incidents,
  surfaceBindings,
  surfaceDeliveries,
} from '../schema';

import {
  IncidentCorrectionConflictError,
  assertNoActiveIncidentJobsTx,
  assertNoPendingIncidentApprovalsTx,
  assertVisibleIncidentPair,
  lockCausalGraphTx,
  lockIncidentWorkTx,
  recordIncidentRelationTx,
  type IncidentCorrectionInput,
} from './core';

/**
 * Reverses a recorded incident merge and restores the source investigation.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant that owns both incidents.
 * @param input - Source, target, and audit reason for the correction.
 */
export async function splitMergedIncident(
  exec: Executor,
  tenantId: string,
  input: IncidentCorrectionInput,
) {
  return withTenant(exec, tenantId, async (tx) => {
    await lockCausalGraphTx(tx, tenantId);
    const ids = [input.sourceIncidentId, input.targetIncidentId].sort();
    await lockIncidentWorkTx(tx, tenantId, ids);
    const locked = await tx
      .select()
      .from(incidents)
      .where(inArray(incidents.id, ids))
      .orderBy(incidents.id)
      .for('update');
    assertVisibleIncidentPair(locked);
    await assertNoActiveIncidentJobsTx(tx, tenantId, ids);
    await assertNoPendingIncidentApprovalsTx(tx, ids);
    const source = locked.find((incident) => incident.id === input.sourceIncidentId)!;
    const target = locked.find((incident) => incident.id === input.targetIncidentId)!;
    const relations = await tx
      .select()
      .from(incidentRelations)
      .where(
        and(
          eq(incidentRelations.sourceIncidentId, input.sourceIncidentId),
          eq(incidentRelations.targetIncidentId, input.targetIncidentId),
          eq(incidentRelations.type, 'merged_into'),
          isNull(incidentRelations.supersededAt),
        ),
      )
      .limit(1)
      .for('update');
    const merged = relations[0];
    if (!merged?.correction)
      throw new IncidentCorrectionConflictError(
        'no reversible merge exists for this incident pair',
      );
    const correction = merged.correction;

    if (correction.signalIds.length) {
      await tx
        .update(incidentSignals)
        .set({ incidentId: input.sourceIncidentId })
        .where(
          and(
            inArray(incidentSignals.id, correction.signalIds),
            eq(incidentSignals.incidentId, input.targetIncidentId),
          ),
        );
      await tx
        .update(incidentFeedback)
        .set({ incidentId: input.sourceIncidentId })
        .where(
          and(
            eq(incidentFeedback.targetType, 'noise'),
            inArray(incidentFeedback.targetId, correction.signalIds),
          ),
        );
    }
    await tx
      .update(surfaceDeliveries)
      .set({
        state: 'blocked',
        operation: 'composite',
        reasonCode: 'incident_split',
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(surfaceDeliveries.bindingId, correction.bindingIds),
          eq(surfaceDeliveries.state, 'queued'),
        ),
      );
    await tx
      .update(surfaceDeliveries)
      .set({
        state: 'uncertain',
        operation: 'composite',
        reasonCode: 'incident_split_in_flight',
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(surfaceDeliveries.bindingId, correction.bindingIds),
          eq(surfaceDeliveries.state, 'sending'),
        ),
      );
    await tx
      .update(surfaceBindings)
      .set({
        incidentId: input.sourceIncidentId,
        role: 'source',
        projectionMode: 'status',
        statusMessageVersion: -1,
        assignmentVersion: sql`${surfaceBindings.assignmentVersion} + 1`,
      })
      .where(
        and(
          inArray(surfaceBindings.id, correction.bindingIds),
          eq(surfaceBindings.incidentId, input.targetIncidentId),
        ),
      );
    await tx
      .update(surfaceBindings)
      .set({ role: 'primary', projectionMode: 'full' })
      .where(
        and(
          eq(surfaceBindings.id, correction.primaryBindingId),
          eq(surfaceBindings.incidentId, input.sourceIncidentId),
        ),
      );
    await tx
      .update(alertEpisodeIntakes)
      .set({ incidentId: input.sourceIncidentId, updatedAt: sql`now()` })
      .where(inArray(alertEpisodeIntakes.bindingId, correction.bindingIds));
    await tx
      .update(incidents)
      .set({
        status: correction.sourceLifecycle.status,
        closedAt: correction.sourceLifecycle.closedAt
          ? new Date(correction.sourceLifecycle.closedAt)
          : null,
        resolvedAt: correction.sourceLifecycle.resolvedAt
          ? new Date(correction.sourceLifecycle.resolvedAt)
          : null,
        lifecycleVersion: sql`${incidents.lifecycleVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(incidents.id, input.sourceIncidentId));
    await tx
      .update(incidentRelations)
      .set({ supersededAt: sql`now()` })
      .where(eq(incidentRelations.id, merged.id));
    const correlationFeedback = merged.correlationFeedback
      ? { ...merged.correlationFeedback, decision: 'separate' as const }
      : await buildIncidentCorrelationFeedbackTx(
          tx,
          input.sourceIncidentId,
          input.targetIncidentId,
          'separate',
        );
    const relation = await recordIncidentRelationTx(tx, tenantId, {
      sourceIncidentId: input.sourceIncidentId,
      targetIncidentId: input.targetIncidentId,
      rationale: input.rationale,
      evidence: input.evidence,
      decidedByUserId: input.decidedByUserId,
      type: 'split_from',
      decidedBy: 'human',
      correction,
      correlationFeedback,
    });
    const result = { source, target, relation, correction };
    await input.onCorrectedTx?.(tx, result);
    return result;
  });
}

/**
 * Records incident relation.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
