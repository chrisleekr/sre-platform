import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
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
 * Joins one assessed incident into another after locking both investigations.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant that owns both incidents.
 * @param input - Source, target, and audit reason for the correction.
 */
export async function mergeIncidents(
  exec: Executor,
  tenantId: string,
  input: IncidentCorrectionInput,
) {
  return withTenant(exec, tenantId, async (tx) => {
    if (input.sourceIncidentId === input.targetIncidentId)
      throw new IncidentCorrectionConflictError('an incident cannot merge into itself');
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
    const source = locked.find((incident) => incident.id === input.sourceIncidentId)!;
    const target = locked.find((incident) => incident.id === input.targetIncidentId)!;
    const activeMergeLinks = await tx
      .select({
        sourceIncidentId: incidentRelations.sourceIncidentId,
        targetIncidentId: incidentRelations.targetIncidentId,
      })
      .from(incidentRelations)
      .where(
        and(
          eq(incidentRelations.type, 'merged_into'),
          isNull(incidentRelations.supersededAt),
          or(
            eq(incidentRelations.sourceIncidentId, source.id),
            eq(incidentRelations.targetIncidentId, source.id),
            eq(incidentRelations.sourceIncidentId, target.id),
          ),
        ),
      );
    if (activeMergeLinks.some((relation) => relation.sourceIncidentId === target.id))
      throw new IncidentCorrectionConflictError(
        'the merge target is already joined into another investigation',
      );
    if (activeMergeLinks.some((relation) => relation.sourceIncidentId === source.id))
      throw new IncidentCorrectionConflictError(
        'the merge source is already joined into another investigation',
      );
    if (activeMergeLinks.some((relation) => relation.targetIncidentId === source.id))
      throw new IncidentCorrectionConflictError(
        'split incidents already joined into the merge source before joining it elsewhere',
      );
    const activeCausalLinks = await tx
      .select({ id: incidentRelations.id })
      .from(incidentRelations)
      .where(
        and(
          eq(incidentRelations.type, 'caused_by'),
          isNull(incidentRelations.supersededAt),
          or(
            eq(incidentRelations.sourceIncidentId, source.id),
            eq(incidentRelations.targetIncidentId, source.id),
          ),
        ),
      )
      .limit(1);
    if (activeCausalLinks[0])
      throw new IncidentCorrectionConflictError(
        'reject or replace the merge source causal links before joining its evidence elsewhere',
      );
    if (!['open', 'mitigated'].includes(target.status))
      throw new IncidentCorrectionConflictError('the merge target must be active');
    if (
      !['assessed', 'degraded'].includes(source.investigationStatus) ||
      !['assessed', 'degraded'].includes(target.investigationStatus)
    )
      throw new IncidentCorrectionConflictError(
        'Both alerts must finish their independent investigations before they can be joined.',
      );
    await assertNoActiveIncidentJobsTx(tx, tenantId, ids);
    await assertNoPendingIncidentApprovalsTx(tx, ids);

    const bindings = await tx
      .select()
      .from(surfaceBindings)
      .where(eq(surfaceBindings.incidentId, source.id))
      .orderBy(surfaceBindings.createdAt, surfaceBindings.id)
      .for('update');
    const primary = bindings.find((binding) => binding.role === 'primary');
    if (!primary)
      throw new IncidentCorrectionConflictError('the merge source has no primary conversation');
    const signals = await tx
      .select({ id: incidentSignals.id })
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, source.id))
      .for('update');
    const correction = {
      signalIds: signals.map((signal) => signal.id),
      bindingIds: bindings.map((binding) => binding.id),
      primaryBindingId: primary.id,
      sourceLifecycle: {
        status: source.status,
        resolvedAt: source.resolvedAt?.toISOString() ?? null,
        closedAt: source.closedAt?.toISOString() ?? null,
      },
    };
    const correlationFeedback = await buildIncidentCorrelationFeedbackTx(
      tx,
      source.id,
      target.id,
      'group',
    );

    await tx
      .update(surfaceDeliveries)
      .set({
        state: 'blocked',
        operation: 'composite',
        reasonCode: 'incident_merged',
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(surfaceDeliveries.incidentId, source.id), eq(surfaceDeliveries.state, 'queued')),
      );
    await tx
      .update(surfaceDeliveries)
      .set({
        state: 'uncertain',
        operation: 'composite',
        reasonCode: 'incident_merged_in_flight',
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(surfaceDeliveries.incidentId, source.id), eq(surfaceDeliveries.state, 'sending')),
      );
    if (correction.signalIds.length) {
      await tx
        .update(incidentSignals)
        .set({ incidentId: target.id })
        .where(inArray(incidentSignals.id, correction.signalIds));
      await tx
        .update(incidentFeedback)
        .set({ incidentId: target.id })
        .where(
          and(
            eq(incidentFeedback.targetType, 'noise'),
            inArray(incidentFeedback.targetId, correction.signalIds),
          ),
        );
    }
    await tx
      .update(surfaceBindings)
      .set({
        incidentId: target.id,
        role: 'source',
        projectionMode: 'status',
        // Keep the remote post pointer so the correction can update the existing status in place. The
        // negative local fence forces the target's current lifecycle projection to replace its content.
        statusMessageVersion: -1,
        assignmentVersion: sql`${surfaceBindings.assignmentVersion} + 1`,
      })
      .where(inArray(surfaceBindings.id, correction.bindingIds));
    await tx
      .update(alertEpisodeIntakes)
      .set({ incidentId: target.id, updatedAt: sql`now()` })
      .where(eq(alertEpisodeIntakes.incidentId, source.id));
    await tx
      .update(incidents)
      .set({
        status: 'closed',
        closedAt: sql`now()`,
        lifecycleVersion: sql`${incidents.lifecycleVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(incidents.id, source.id));
    const relation = await recordIncidentRelationTx(tx, tenantId, {
      sourceIncidentId: input.sourceIncidentId,
      targetIncidentId: input.targetIncidentId,
      rationale: input.rationale,
      evidence: input.evidence,
      decidedByUserId: input.decidedByUserId,
      type: 'merged_into',
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
 * Reverse the active merge using the membership captured by that exact decision.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
