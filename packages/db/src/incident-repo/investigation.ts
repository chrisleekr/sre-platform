import type { IncidentFindingPayload, InvestigationGap } from '@sre/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant, type Tx } from '../rls';
import {
  ACTIVE_STATUSES,
  incidentMessages,
  incidents,
  type RankedHypothesisRecord,
} from '../schema';
import { filterIncidentDataEvidenceIdsTx, filterIncidentEvidenceIdsTx } from '../tool-call-repo';

export interface DegradeMessage {
  author: 'agent' | 'human' | 'system';
  kind: string;
  content: string;
  summary?: string;
  finding?: IncidentFindingPayload;
  originMessageId?: string;
}

export interface PersistedMessage {
  id: string;
  incidentId: string;
  author: string;
  kind: string;
  content: string;
  summary: string | null;
  finding: IncidentFindingPayload | null;
  createdAt: Date;
}

/**
 * Moves an actively gathering incident to degraded inside the caller's transaction.
 * @param tx - Existing tenant transaction.
 * @param id - Incident to degrade.
 */
export async function degradeIncidentTx(tx: Tx, id: string): Promise<boolean> {
  const won = await tx
    .update(incidents)
    .set({ investigationStatus: 'degraded', updatedAt: sql`now()` })
    .where(
      and(
        eq(incidents.id, id),
        eq(incidents.investigationStatus, 'gathering'),
        inArray(incidents.status, ACTIVE_STATUSES),
      ),
    )
    .returning({ id: incidents.id });
  return won.length > 0;
}

/**
 * Provides degrade incident with messages.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Value supplied for id.
 * @param messages - Durable incident messages written with the state change.
 */
export async function degradeIncidentWithMessages(
  db: Db,
  tenantId: string,
  id: string,
  messages: DegradeMessage[],
): Promise<PersistedMessage[] | null> {
  return withTenant(db, tenantId, async (tx) => {
    if (!(await degradeIncidentTx(tx, id))) return null;

    const rows = await tx
      .insert(incidentMessages)
      .values(
        messages.map((m) => ({
          tenantId,
          incidentId: id,
          author: m.author,
          kind: m.kind,
          content: m.content,
          summary: m.summary,
          finding: m.finding,
          originMessageId: m.originMessageId,
        })),
      )
      .onConflictDoNothing()
      .returning();
    return rows.map((r) => ({
      id: r.id,
      incidentId: r.incidentId,
      author: r.author,
      kind: r.kind,
      content: r.content,
      summary: r.summary,
      finding: r.finding,
      createdAt: r.createdAt,
    }));
  });
}

/**
 * Starts investigating with messages.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Value supplied for id.
 * @param messages - Durable incident messages written with the state change.
 */
export async function startInvestigatingWithMessages(
  db: Db,
  tenantId: string,
  id: string,
  messages: DegradeMessage[],
): Promise<PersistedMessage[] | null> {
  return withTenant(db, tenantId, async (tx) => {
    const won = await tx
      .update(incidents)
      .set({ investigationStatus: 'gathering', updatedAt: sql`now()` })
      .where(
        and(
          eq(incidents.id, id),
          eq(incidents.investigationStatus, 'queued'),
          inArray(incidents.status, ACTIVE_STATUSES),
        ),
      )
      .returning({ id: incidents.id });
    if (won.length === 0) return null;

    const rows = await tx
      .insert(incidentMessages)
      .values(
        messages.map((m) => ({
          tenantId,
          incidentId: id,
          author: m.author,
          kind: m.kind,
          content: m.content,
          summary: m.summary,
          finding: m.finding,
        })),
      )
      .returning();
    return rows.map((r) => ({
      id: r.id,
      incidentId: r.incidentId,
      author: r.author,
      kind: r.kind,
      content: r.content,
      summary: r.summary,
      finding: r.finding,
      createdAt: r.createdAt,
    }));
  });
}

export interface TriageResultUpdate {
  humanMessageFence?: string | null;
  provider: string;
  sessionId: string;
  summary: string;
  confidence: number;
  /** Ranked root-cause hypotheses with evidence, when the engine emits them. */
  rankedHypotheses?: RankedHypothesisRecord[];
  currentState?: string | null;
  impact?: string | null;
  assessmentEvidenceIds?: string[];
  /** Explicit, classified gaps in the latest assessment. */
  unknowns?: InvestigationGap[];
  /** Safest next diagnostic step, or null when the assessment is complete. */
  nextStep?: string | null;
  /** The provider model that produced the result (e.g. claude-opus-4-8). */
  engineModel?: string;
  /** Immutable run promoted as the source of this trusted assessment. */
  trustedAssessmentRunId?: string;
  /**
   * The hub id of the human reply this result answers, set only for a resume. Present → the
   * conditional UPDATE applies exactly-once (redelivery of the same reply is a no-op) and stamps the
   * incident so a later blind triage cannot overwrite it. Absent → a plain triage completion, which
   * applies only while no resume has stamped the incident.
   */
  resumeMessageId?: string;
  /** A newer external signal caused this assessment, so it may supersede an earlier human resume. */
  assessmentCause?: 'signal';
}

/**
 * Applies triage result tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param id - Value supplied for id.
 * @param result - Validated operation result to persist.
 */
export async function applyTriageResultTx(
  tx: Tx,
  id: string,
  result: TriageResultUpdate,
): Promise<boolean> {
  if (!(await humanMessageFenceMatchesTx(tx, id, result.humanMessageFence))) return false;
  const hypotheses = result.rankedHypotheses ?? [];
  const proposedFactualEvidenceIds = [
    ...(result.assessmentEvidenceIds ?? []),
    ...hypotheses.flatMap((hypothesis) => [
      ...(hypothesis.supportingEvidenceIds ?? []),
      ...(hypothesis.contradictingEvidenceIds ?? []),
    ]),
  ];
  const [factualEvidenceIds, attemptedEvidenceIds] = await Promise.all([
    filterIncidentDataEvidenceIdsTx(tx, id, proposedFactualEvidenceIds),
    filterIncidentEvidenceIdsTx(
      tx,
      id,
      (result.unknowns ?? []).flatMap((gap) => gap.attemptedEvidenceIds),
    ),
  ]);
  const factual = new Set(factualEvidenceIds);
  const attempted = new Set(attemptedEvidenceIds);
  const keepFactual = (ids: string[] | undefined) =>
    [...new Set(ids ?? [])].filter((evidenceId) => factual.has(evidenceId));
  const keepAttempted = (ids: string[] | undefined) =>
    [...new Set(ids ?? [])].filter((evidenceId) => attempted.has(evidenceId));
  const rankedHypotheses = result.rankedHypotheses?.map((hypothesis) => ({
    ...hypothesis,
    ...(hypothesis.supportingEvidenceIds !== undefined
      ? { supportingEvidenceIds: keepFactual(hypothesis.supportingEvidenceIds) }
      : {}),
    ...(hypothesis.contradictingEvidenceIds !== undefined
      ? { contradictingEvidenceIds: keepFactual(hypothesis.contradictingEvidenceIds) }
      : {}),
  }));
  const unknowns = result.unknowns?.map((gap) => ({
    ...gap,
    attemptedEvidenceIds: keepAttempted(gap.attemptedEvidenceIds),
  }));
  const updated = await tx
    .update(incidents)
    .set({
      engineProvider: result.provider,
      engineSessionId: result.sessionId,
      // undefined is omitted by drizzle, so the column stays null for engines that
      // don't emit a model or ranked hypotheses (single-turn Claude/OpenAI today).
      engineModel: result.engineModel,
      rcaSummary: result.summary,
      confidence: result.confidence,
      rankedHypotheses,
      currentState: result.currentState ?? null,
      impact: result.impact ?? null,
      assessmentEvidenceIds: keepFactual(result.assessmentEvidenceIds),
      unknowns: unknowns ?? [],
      nextStep: result.nextStep ?? null,
      assessmentUpdatedAt: sql`now()`,
      trustedAssessmentRunId: result.trustedAssessmentRunId,
      // Stamp the applied resume's reply id (RESUME only); a plain triage leaves it untouched.
      lastResumeMessageId: result.resumeMessageId,
      investigationStatus: 'assessed',
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(incidents.id, id),
        result.resumeMessageId !== undefined
          ? sql`${incidents.lastResumeMessageId} is distinct from ${result.resumeMessageId}`
          : result.assessmentCause === 'signal'
            ? inArray(incidents.status, ACTIVE_STATUSES)
            : sql`${incidents.lastResumeMessageId} is null`,
      ),
    )
    .returning({ id: incidents.id });
  return updated.length > 0;
}

/** Serialize publication with human appends and reject input not consumed by the run.
 * @param tx - Existing tenant transaction.
 * @param id - Current case.
 * @param fence - Latest consumed message, undefined for callers without a model run.
 */
export async function humanMessageFenceMatchesTx(
  tx: Tx,
  id: string,
  fence: string | null | undefined,
): Promise<boolean> {
  if (fence === undefined) return true;
  const locked = await tx
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.id, id))
    .for('update');
  if (!locked[0]) return false;
  const [latest] = await tx
    .select({ id: incidentMessages.id })
    .from(incidentMessages)
    .where(
      and(
        eq(incidentMessages.incidentId, id),
        eq(incidentMessages.author, 'human'),
        eq(incidentMessages.kind, 'text'),
      ),
    )
    .orderBy(desc(incidentMessages.createdAt), desc(incidentMessages.id))
    .limit(1);
  return (latest?.id ?? null) === fence;
}

/**
 * Applies triage result.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Value supplied for id.
 * @param result - Validated operation result to persist.
 */
export async function applyTriageResult(
  db: Db,
  tenantId: string,
  id: string,
  result: TriageResultUpdate,
): Promise<void> {
  await withTenant(db, tenantId, (tx) => applyTriageResultTx(tx, id, result));
}

/**
 * Advances resume watermark.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param resumeMessageId - resume message id targeted by the operation.
 */
export async function advanceResumeWatermark(
  db: Db,
  tenantId: string,
  incidentId: string,
  resumeMessageId: string,
): Promise<void> {
  await withTenant(db, tenantId, (tx) => advanceResumeWatermarkTx(tx, incidentId, resumeMessageId));
}

/**
 * Advances the responder watermark inside an existing tenant transaction.
 * @param tx - Existing tenant transaction.
 * @param incidentId - Incident whose responder turn completed.
 * @param resumeMessageId - Human message answered by the run.
 */
export async function advanceResumeWatermarkTx(
  tx: Tx,
  incidentId: string,
  resumeMessageId: string,
): Promise<void> {
  await tx
    .update(incidents)
    .set({
      lastResumeMessageId: resumeMessageId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(incidents.id, incidentId),
        sql`${incidents.lastResumeMessageId} is distinct from ${resumeMessageId}`,
      ),
    );
}

export interface HumanMessage {
  id: string;
  content: string;
  originSurface: string | null;
  /** Server-set idempotency key; lets a worker recognise a platform control without reading text. */
  originMessageId: string | null;
  authorUserId: string | null;
  createdAt: Date;
}

/**
 * Provides human messages since.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param afterMessageId - after message id targeted by the operation.
 * @param newestLimit - Bound a context snapshot to the newest input rows; omitted when draining queued requests.
 * @param oldestLimit - Bound an oldest-first page when draining queued requests.
 */
export async function humanMessagesSince(
  db: Db,
  tenantId: string,
  incidentId: string,
  afterMessageId: string | null,
  newestLimit?: number,
  oldestLimit?: number,
): Promise<HumanMessage[]> {
  return withTenant(db, tenantId, async (tx) => {
    const query = tx
      .select({
        id: incidentMessages.id,
        content: incidentMessages.content,
        originSurface: incidentMessages.originSurface,
        originMessageId: incidentMessages.originMessageId,
        authorUserId: incidentMessages.authorUserId,
        createdAt: incidentMessages.createdAt,
      })
      .from(incidentMessages)
      .where(
        and(
          eq(incidentMessages.incidentId, incidentId),
          eq(incidentMessages.author, 'human'),
          eq(incidentMessages.kind, 'text'),
          afterMessageId
            ? sql`(${incidentMessages.createdAt}, ${incidentMessages.id}) > (
                select w.created_at, w.id from ${incidentMessages} w where w.id = ${afterMessageId}
              )`
            : undefined,
        ),
      );
    return newestLimit === undefined
      ? oldestLimit === undefined
        ? query.orderBy(incidentMessages.createdAt, incidentMessages.id)
        : query.orderBy(incidentMessages.createdAt, incidentMessages.id).limit(oldestLimit)
      : (
          await query
            .orderBy(desc(incidentMessages.createdAt), desc(incidentMessages.id))
            .limit(newestLimit)
        ).reverse();
  });
}

/**
 * Provides incident tenant.
 *
 * @param db - Database connection used for the operation.
 * @param incidentId - Incident targeted by the operation.
 */
export async function incidentTenant(db: Db, incidentId: string): Promise<string | null> {
  const rows = await db
    .select({ tenantId: incidents.tenantId })
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1);
  return rows[0]?.tenantId ?? null;
}
