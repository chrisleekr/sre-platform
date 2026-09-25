import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { CausalFinding } from '@sre/contracts';
import type { Db } from '../client';
import { withTenant, type Tx } from '../rls';
import {
  ACTIVE_STATUSES,
  incidentRelations,
  incidentSignals,
  incidents,
  investigationRuns,
} from '../schema';
import { filterIncidentEvidenceIdsTx } from '../tool-call-repo';
import {
  IncidentCorrectionConflictError,
  lockCausalGraphTx,
  lockIncidentWorkTx,
  recordIncidentRelationTx,
} from './core';

const MAX_CAUSAL_CANDIDATES = 5;
const MIN_CAUSAL_CONFIDENCE = 80;

async function listLiveCausalEdgesTx(tx: Tx, tenantId: string) {
  await lockCausalGraphTx(tx, tenantId);
  const rows = await tx
    .select({
      sourceIncidentId: incidentRelations.sourceIncidentId,
      targetIncidentId: incidentRelations.targetIncidentId,
    })
    .from(incidentRelations)
    .where(and(eq(incidentRelations.type, 'caused_by'), isNull(incidentRelations.supersededAt)));
  const incidentIds = [
    ...new Set(rows.flatMap((row) => [row.sourceIncidentId, row.targetIncidentId])),
  ];
  if (incidentIds.length === 0) return [];
  const visible = new Set(
    (
      await tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(and(inArray(incidents.id, incidentIds), isNull(incidents.archivedAt)))
    ).map((incident) => incident.id),
  );
  return rows.filter(
    (row) => visible.has(row.sourceIncidentId) && visible.has(row.targetIncidentId),
  );
}

function responseSignalFence(
  signals: Array<{ id: string; version: number; state: string }>,
): string {
  return [...signals]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((signal) => `${signal.id}:${signal.version}:${signal.state}`)
    .join('|');
}

/** One active candidate authorized for model reference by its bounded ordinal. */
export interface CausalCandidate {
  ref: number;
  incidentId: string;
  relationId: string;
}

/**
 * Lists the bounded active possible-related candidates exposed to an investigation model.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param incidentId - Incident whose candidates are exposed.
 */
export async function listCausalCandidatesTx(
  tx: Tx,
  incidentId: string,
): Promise<CausalCandidate[]> {
  const rows = await tx
    .select({
      id: incidentRelations.id,
      sourceIncidentId: incidentRelations.sourceIncidentId,
      targetIncidentId: incidentRelations.targetIncidentId,
    })
    .from(incidentRelations)
    .where(
      and(
        eq(incidentRelations.type, 'possible_related'),
        isNull(incidentRelations.supersededAt),
        or(
          eq(incidentRelations.sourceIncidentId, incidentId),
          eq(incidentRelations.targetIncidentId, incidentId),
        ),
      ),
    )
    .orderBy(asc(incidentRelations.createdAt), asc(incidentRelations.id))
    .limit(MAX_CAUSAL_CANDIDATES);
  return rows.map((row, index) => ({
    ref: index + 1,
    incidentId: row.sourceIncidentId === incidentId ? row.targetIncidentId : row.sourceIncidentId,
    relationId: row.id,
  }));
}

async function assertAcyclicCausalEdgeTx(
  tx: Tx,
  tenantId: string,
  sourceIncidentId: string,
  targetIncidentId: string,
): Promise<void> {
  const rows = await listLiveCausalEdgesTx(tx, tenantId);
  const parentByChild = new Map(rows.map((row) => [row.sourceIncidentId, row.targetIncidentId]));
  for (
    let cursor: string | undefined = targetIncidentId;
    cursor;
    cursor = parentByChild.get(cursor)
  ) {
    if (cursor === sourceIncidentId)
      throw new IncidentCorrectionConflictError('causal relationships cannot form a cycle');
  }
}

/**
 * Promotes conclusive, evidence-backed model findings into directional causal relationships.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns both incidents.
 * @param incidentId - Incident investigated by the decision run.
 * @param decisionRunId - Conclusive investigation run supporting the decision.
 * @param findings - Model findings over server-authorized candidate references.
 * @param allowedEvidenceIds - Durable evidence accepted for the completed run.
 * @param candidates - Exact prompt-time candidate references exposed to the model.
 */
export async function promoteCausalFindingsTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  decisionRunId: string,
  findings: CausalFinding[],
  allowedEvidenceIds: string[],
  candidates: CausalCandidate[],
): Promise<Array<typeof incidentRelations.$inferSelect>> {
  if (findings.length === 0) return [];
  await lockCausalGraphTx(tx, tenantId);
  const decisionRuns = await tx
    .select({ evidenceIds: investigationRuns.evidenceIds })
    .from(investigationRuns)
    .where(
      and(
        eq(investigationRuns.id, decisionRunId),
        eq(investigationRuns.tenantId, tenantId),
        eq(investigationRuns.incidentId, incidentId),
        eq(investigationRuns.outcome, 'conclusive'),
        isNotNull(investigationRuns.completedAt),
      ),
    )
    .limit(1);
  const decisionRun = decisionRuns[0];
  if (!decisionRun) return [];
  const candidateByRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  const runEvidence = new Set(decisionRun.evidenceIds);
  const allowed = new Set(
    await filterIncidentEvidenceIdsTx(
      tx,
      incidentId,
      allowedEvidenceIds.filter((id) => runEvidence.has(id)),
    ),
  );
  // A promotion merges response groups and recordIncidentRelationTx then locks every merged member.
  // Signal writers take group work locks before incident rows, so take all of them now, sorted,
  // before the pair's row lock below. The graph lock keeps membership stable meanwhile.
  const endpointIds = [
    incidentId,
    ...findings.flatMap((finding) => candidateByRef.get(finding.candidateRef)?.incidentId ?? []),
  ];
  const groupIds = new Set<string>();
  for (const endpointId of new Set(endpointIds))
    for (const memberId of await listResponseGroupIncidentIdsTx(tx, tenantId, endpointId))
      groupIds.add(memberId);
  await lockIncidentWorkTx(tx, tenantId, [...groupIds]);
  const promoted: Array<typeof incidentRelations.$inferSelect> = [];
  for (const finding of [...findings].sort((left, right) => right.confidence - left.confidence)) {
    if (finding.confidence < MIN_CAUSAL_CONFIDENCE) continue;
    const candidate = candidateByRef.get(finding.candidateRef);
    if (!candidate) continue;
    const evidenceIds = [...new Set(finding.evidenceIds)].filter((id) => allowed.has(id));
    if (evidenceIds.length === 0) continue;
    const sourceIncidentId =
      finding.direction === 'candidate_caused_this' ? incidentId : candidate.incidentId;
    const targetIncidentId =
      finding.direction === 'candidate_caused_this' ? candidate.incidentId : incidentId;
    const visiblePair = await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          inArray(incidents.id, [sourceIncidentId, targetIncidentId]),
          isNull(incidents.archivedAt),
        ),
      )
      .orderBy(incidents.id)
      .for('update');
    if (visiblePair.length !== 2) continue;
    const currentCandidate = await tx
      .select({ id: incidentRelations.id })
      .from(incidentRelations)
      .where(
        and(
          eq(incidentRelations.id, candidate.relationId),
          eq(incidentRelations.type, 'possible_related'),
          isNull(incidentRelations.supersededAt),
          or(
            and(
              eq(incidentRelations.sourceIncidentId, sourceIncidentId),
              eq(incidentRelations.targetIncidentId, targetIncidentId),
            ),
            and(
              eq(incidentRelations.sourceIncidentId, targetIncidentId),
              eq(incidentRelations.targetIncidentId, sourceIncidentId),
            ),
          ),
        ),
      )
      .limit(1);
    if (!currentCandidate[0]) continue;
    const activeParent = await tx
      .select()
      .from(incidentRelations)
      .where(
        and(
          eq(incidentRelations.type, 'caused_by'),
          eq(incidentRelations.sourceIncidentId, sourceIncidentId),
          isNull(incidentRelations.supersededAt),
        ),
      )
      .limit(1);
    if (activeParent[0] && activeParent[0].targetIncidentId !== targetIncidentId) continue;
    try {
      await assertAcyclicCausalEdgeTx(tx, tenantId, sourceIncidentId, targetIncidentId);
    } catch (error) {
      if (error instanceof IncidentCorrectionConflictError) continue;
      throw error;
    }
    promoted.push(
      await recordIncidentRelationTx(tx, tenantId, {
        sourceIncidentId,
        targetIncidentId,
        type: 'caused_by',
        rationale: finding.rationale,
        evidence: evidenceIds.map((id) => `evidence:${id}`),
        evidenceIds,
        confidence: Math.round(finding.confidence),
        decisionRunId,
        decidedBy: 'agent',
      }),
    );
  }
  return promoted;
}

/**
 * Resolves the response root by following active caused-by edges from child to cause.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the causal response graph.
 * @param incidentId - Incident whose response root is requested.
 */
export async function resolveResponseRootTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
): Promise<string> {
  const rows = await listLiveCausalEdgesTx(tx, tenantId);
  const parentByChild = new Map(rows.map((row) => [row.sourceIncidentId, row.targetIncidentId]));
  const visited = new Set<string>();
  let current = incidentId;
  while (parentByChild.has(current)) {
    if (visited.has(current)) throw new Error('causal relationship cycle detected');
    visited.add(current);
    current = parentByChild.get(current)!;
  }
  return current;
}

/**
 * Resolves one incident's live response root under tenant isolation.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the response graph.
 * @param incidentId - Incident whose response root is requested.
 */
export async function resolveResponseRoot(db: Db, tenantId: string, incidentId: string) {
  return withTenant(db, tenantId, (tx) => resolveResponseRootTx(tx, tenantId, incidentId));
}

/**
 * Lists a response root followed by every transitive causal descendant.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the causal response graph.
 * @param incidentId - Any incident in the response group.
 */
export async function listResponseGroupIncidentIdsTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
): Promise<string[]> {
  const rootId = await resolveResponseRootTx(tx, tenantId, incidentId);
  const rows = await listLiveCausalEdgesTx(tx, tenantId);
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.targetIncidentId) ?? [];
    children.push(row.sourceIncidentId);
    childrenByParent.set(row.targetIncidentId, children);
  }
  const ordered = [rootId];
  const seen = new Set(ordered);
  for (let index = 0; index < ordered.length; index++) {
    for (const childId of childrenByParent.get(ordered[index]!) ?? []) {
      if (seen.has(childId)) throw new Error('causal relationship cycle detected');
      seen.add(childId);
      ordered.push(childId);
    }
  }
  return ordered;
}

/**
 * Lists one causal response group under tenant isolation.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the response group.
 * @param incidentId - Any incident in the response group.
 */
export async function listResponseGroupIncidentIds(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<string[]> {
  return withTenant(db, tenantId, (tx) => listResponseGroupIncidentIdsTx(tx, tenantId, incidentId));
}

/**
 * Locks a stable response graph and every member's work fence in deterministic order.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the response group.
 * @param incidentId - Any incident in the response group.
 */
export async function lockResponseGroupWorkTx(tx: Tx, tenantId: string, incidentId: string) {
  const incidentIds = await listResponseGroupIncidentIdsTx(tx, tenantId, incidentId);
  await lockIncidentWorkTx(tx, tenantId, incidentIds);
  return { rootIncidentId: incidentIds[0]!, incidentIds };
}

/**
 * Loads every signal governed by the incident's current response root.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the response group.
 * @param incidentId - Any incident in the response group.
 */
export async function listResponseGroupSignalsTx(tx: Tx, tenantId: string, incidentId: string) {
  const incidentIds = await listResponseGroupIncidentIdsTx(tx, tenantId, incidentId);
  return tx.select().from(incidentSignals).where(inArray(incidentSignals.incidentId, incidentIds));
}

/**
 * Loads every response-group signal under tenant isolation.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the response group.
 * @param incidentId - Any incident in the response group.
 */
export async function listResponseGroupSignals(db: Db, tenantId: string, incidentId: string) {
  return withTenant(db, tenantId, (tx) => listResponseGroupSignalsTx(tx, tenantId, incidentId));
}

/**
 * Builds a recovery candidate only when the complete causal response group is cleared.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the response group.
 * @param incidentId - Any incident in the response group.
 */
export async function prepareResponseGroupRecoveryTx(tx: Tx, tenantId: string, incidentId: string) {
  let rootIncidentId = await resolveResponseRootTx(tx, tenantId, incidentId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${rootIncidentId}:response-recovery`}, 0))`,
  );
  rootIncidentId = await resolveResponseRootTx(tx, tenantId, incidentId);
  const signals = await listResponseGroupSignalsTx(tx, tenantId, rootIncidentId);
  if (signals.length === 0 || signals.some((signal) => signal.state !== 'resolved')) return null;
  const rows = await tx
    .select({ status: incidents.status, lifecycleVersion: incidents.lifecycleVersion })
    .from(incidents)
    .where(eq(incidents.id, rootIncidentId))
    .limit(1);
  const root = rows[0];
  if (!root || !ACTIVE_STATUSES.includes(root.status as (typeof ACTIVE_STATUSES)[number]))
    return null;
  return {
    rootIncidentId,
    lifecycleVersion: root.lifecycleVersion,
    signalFence: responseSignalFence(signals),
  };
}
