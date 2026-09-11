import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Tx } from './rls';
import { alertCohortMembers, alertCohorts, incidentSignals, incidents } from './schema';

export interface CohortMembershipInput {
  sourceScopeKey: string;
  dataSourceId?: string | null;
  signalId: string;
  observedAt: Date;
  windowMs: number;
}

/**
 * Place an episode into a fixed, provider-scoped burst cohort. The window is candidate generation only: membership never changes incident assignment and never authorizes a merge.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function joinAlertCohortTx(tx: Tx, tenantId: string, input: CohortMembershipInput) {
  if (!Number.isFinite(input.windowMs) || input.windowMs <= 0)
    throw new Error('alert cohort window must be positive');
  if (!input.sourceScopeKey.trim()) throw new Error('alert cohort source scope is required');

  // Two alerts in the same provider burst may arrive concurrently. Serialize only this tenant/source
  // key so both observe the same collecting window instead of creating parallel candidate cohorts.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${input.sourceScopeKey}:cohort`}, 0))`,
  );
  const existingMembership = await tx
    .select({ cohortId: alertCohortMembers.cohortId })
    .from(alertCohortMembers)
    .where(eq(alertCohortMembers.signalId, input.signalId))
    .limit(1);
  if (existingMembership[0]) {
    const rows = await tx
      .select()
      .from(alertCohorts)
      .where(eq(alertCohorts.id, existingMembership[0].cohortId))
      .limit(1);
    if (!rows[0]) throw new Error('alert cohort membership points to a missing cohort');
    return rows[0];
  }

  const candidates = await tx
    .select()
    .from(alertCohorts)
    .where(
      and(
        eq(alertCohorts.sourceScopeKey, input.sourceScopeKey),
        eq(alertCohorts.state, 'collecting'),
        lte(alertCohorts.windowStartedAt, input.observedAt),
        gte(alertCohorts.windowEndsAt, input.observedAt),
      ),
    )
    .orderBy(desc(alertCohorts.windowStartedAt))
    .limit(1)
    .for('update');

  const cohort =
    candidates[0] ??
    (
      await tx
        .insert(alertCohorts)
        .values({
          tenantId,
          sourceScopeKey: input.sourceScopeKey,
          dataSourceId: input.dataSourceId ?? null,
          anchorSignalId: input.signalId,
          windowStartedAt: input.observedAt,
          windowEndsAt: new Date(input.observedAt.getTime() + input.windowMs),
          lastAlertAt: input.observedAt,
        })
        .returning()
    )[0]!;

  await tx
    .insert(alertCohortMembers)
    .values({ tenantId, cohortId: cohort.id, signalId: input.signalId })
    .onConflictDoNothing();
  if (input.observedAt > cohort.lastAlertAt) {
    await tx
      .update(alertCohorts)
      .set({ lastAlertAt: input.observedAt, updatedAt: sql`now()` })
      .where(eq(alertCohorts.id, cohort.id));
  }
  return cohort;
}

/**
 * Loads at most five independent incidents for one coalesced cohort analysis.
 *
 * @param tx - Existing transaction that carries tenant scope.
 * @param cohort - Cohort whose final membership is rendered.
 */
async function loadAlertCohortAnalysisTx(tx: Tx, cohort: typeof alertCohorts.$inferSelect) {
  const members = await tx
    .select({
      incidentId: incidentSignals.incidentId,
      signalId: incidentSignals.id,
      summary: incidentSignals.summary,
      alertName: incidentSignals.alertName,
      state: incidentSignals.state,
      joinedAt: alertCohortMembers.joinedAt,
    })
    .from(alertCohortMembers)
    .innerJoin(incidentSignals, eq(incidentSignals.id, alertCohortMembers.signalId))
    .where(eq(alertCohortMembers.cohortId, cohort.id))
    .orderBy(asc(alertCohortMembers.joinedAt), asc(alertCohortMembers.id));
  const incidentIds = [...new Set(members.map((member) => member.incidentId))].slice(0, 5);
  if (incidentIds.length === 0) return { cohort, incidents: [] };
  const incidentRows = await tx
    .select({
      id: incidents.id,
      title: incidents.title,
      service: incidents.service,
      severity: incidents.severity,
      status: incidents.status,
    })
    .from(incidents)
    .where(inArray(incidents.id, incidentIds));
  const byId = new Map(incidentRows.map((incident) => [incident.id, incident]));
  return {
    cohort,
    incidents: incidentIds.flatMap((incidentId, index) => {
      const incident = byId.get(incidentId);
      if (!incident) return [];
      return [
        {
          ref: index + 1,
          ...incident,
          signals: members
            .filter((member) => member.incidentId === incidentId)
            .map(({ signalId, summary, alertName, state }) => ({
              id: signalId,
              summary,
              alertName,
              state,
            })),
        },
      ];
    }),
  };
}

/**
 * Seals a collecting cohort under its source lock and returns its final bounded snapshot.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the cohort.
 * @param cohortId - Cohort selected for analysis.
 * @param jobId - Durable analysis job allowed to reclaim an interrupted analysis.
 */
export async function claimAlertCohortAnalysis(
  db: Db,
  tenantId: string,
  cohortId: string,
  jobId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.select().from(alertCohorts).where(eq(alertCohorts.id, cohortId)).limit(1);
    const cohort = rows[0];
    if (!cohort || cohort.state === 'settled') return null;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${cohort.sourceScopeKey}:cohort`}, 0))`,
    );
    const claimed =
      cohort.state === 'collecting'
        ? await tx
            .update(alertCohorts)
            .set({ state: 'analyzing', analysisJobId: jobId, updatedAt: sql`now()` })
            .where(and(eq(alertCohorts.id, cohortId), eq(alertCohorts.state, 'collecting')))
            .returning()
        : cohort.analysisJobId === jobId
          ? [cohort]
          : [];
    return claimed[0] ? loadAlertCohortAnalysisTx(tx, claimed[0]) : null;
  });
}

/**
 * Marks a fixed cohort settled when its analysis job begins.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param cohortId - Cohort whose collection window ended.
 */
export async function settleAlertCohortTx(tx: Tx, cohortId: string): Promise<void> {
  await tx
    .update(alertCohorts)
    .set({ state: 'settled', updatedAt: sql`now()` })
    .where(and(eq(alertCohorts.id, cohortId), eq(alertCohorts.state, 'analyzing')));
}
