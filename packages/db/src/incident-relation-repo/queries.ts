import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import { withTenant, type Executor, type Tx } from '../rls';
import { buildIncidentCorrelationFeedbackTx } from '../incident-correlation-repo';
import { incidentRelations, incidents } from '../schema';

import {
  assertVisibleIncidentPair,
  lockCausalGraphTx,
  lockIncidentWorkTx,
  recordIncidentRelationTx,
  type IncidentRelationInput,
} from './core';

/**
 * Records a typed relationship between two tenant-visible incidents.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant that owns both incidents.
 * @param input - Relationship endpoints and decision metadata.
 */
export async function recordIncidentRelation(
  exec: Executor,
  tenantId: string,
  input: IncidentRelationInput,
) {
  return withTenant(exec, tenantId, async (tx) => {
    if (input.type !== 'recurrence_of') await lockCausalGraphTx(tx, tenantId);
    return recordIncidentRelationTx(tx, tenantId, input);
  });
}

/**
 * Record a causal rejection only while neither side is physically joined into the other.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function recordUnrelatedIncidents(
  exec: Executor,
  tenantId: string,
  input: Omit<IncidentRelationInput, 'type' | 'decidedBy'> & {
    decidedByUserId: string;
    onRecordedTx?: (tx: Tx, relation: typeof incidentRelations.$inferSelect) => Promise<void>;
  },
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
    const { onRecordedTx, ...relationInput } = input;
    const correlationFeedback = await buildIncidentCorrelationFeedbackTx(
      tx,
      input.sourceIncidentId,
      input.targetIncidentId,
      'separate',
    );
    const relation = await recordIncidentRelationTx(tx, tenantId, {
      ...relationInput,
      type: 'unrelated',
      decidedBy: 'human',
      correlationFeedback,
    });
    await onRecordedTx?.(tx, relation);
    return relation;
  });
}

/**
 * Lists incident relations.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function listIncidentRelations(db: Db, tenantId: string, incidentId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const sourceIncident = alias(incidents, 'relation_source_incident');
    const targetIncident = alias(incidents, 'relation_target_incident');
    const rows = await tx
      .select({
        relation: incidentRelations,
        sourceIncident: {
          id: sourceIncident.id,
          title: sourceIncident.title,
          service: sourceIncident.service,
          severity: sourceIncident.severity,
          status: sourceIncident.status,
          investigationStatus: sourceIncident.investigationStatus,
          rcaSummary: sourceIncident.rcaSummary,
          confidence: sourceIncident.confidence,
          assessmentUpdatedAt: sourceIncident.assessmentUpdatedAt,
          createdAt: sourceIncident.createdAt,
        },
        targetIncident: {
          id: targetIncident.id,
          title: targetIncident.title,
          service: targetIncident.service,
          severity: targetIncident.severity,
          status: targetIncident.status,
          investigationStatus: targetIncident.investigationStatus,
          rcaSummary: targetIncident.rcaSummary,
          confidence: targetIncident.confidence,
          assessmentUpdatedAt: targetIncident.assessmentUpdatedAt,
          createdAt: targetIncident.createdAt,
        },
      })
      .from(incidentRelations)
      .innerJoin(sourceIncident, eq(sourceIncident.id, incidentRelations.sourceIncidentId))
      .innerJoin(targetIncident, eq(targetIncident.id, incidentRelations.targetIncidentId))
      .where(
        and(
          or(
            eq(incidentRelations.sourceIncidentId, incidentId),
            eq(incidentRelations.targetIncidentId, incidentId),
          ),
          isNull(incidentRelations.supersededAt),
          isNull(sourceIncident.archivedAt),
          isNull(targetIncident.archivedAt),
        ),
      )
      .orderBy(incidentRelations.createdAt, incidentRelations.id);
    return rows.map(({ relation, ...summaries }) => ({ ...relation, ...summaries }));
  });
}
