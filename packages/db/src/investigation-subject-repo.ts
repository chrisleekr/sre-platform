import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Tx } from './rls';
import {
  ACTIVE_STATUSES,
  incidents,
  investigationSubjects,
  jobs,
  type InvestigationSubjectKind,
  type InvestigationSubjectSnapshot,
  type InvestigationSubjectState,
} from './schema';

export interface InvestigationSubjectInput {
  kind: InvestigationSubjectKind;
  sourceId: string;
  subjectId: string;
  fingerprint: string;
  sourcePath: string;
  state: InvestigationSubjectState;
  summary: string;
  snapshot: InvestigationSubjectSnapshot;
  contentHash: string;
  observedAt: Date;
  syncEnabled: boolean;
}

/**
 * Inserts investigation subject tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param input - Validated input for the operation.
 */
export async function insertInvestigationSubjectTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  input: InvestigationSubjectInput,
) {
  const rows = await tx
    .insert(investigationSubjects)
    .values({
      tenantId,
      incidentId,
      kind: input.kind,
      sourceId: input.sourceId,
      subjectId: input.subjectId,
      fingerprint: input.fingerprint,
      sourcePath: input.sourcePath,
      capturedState: input.state,
      capturedSummary: input.summary,
      capturedSnapshot: input.snapshot,
      capturedHash: input.contentHash,
      observedAt: input.observedAt,
      currentState: input.state,
      currentSummary: input.summary,
      currentSnapshot: input.snapshot,
      currentHash: input.contentHash,
      lastSyncedAt: input.observedAt,
      syncEnabled: input.syncEnabled,
    })
    .returning();
  return rows[0]!;
}

/**
 * Returns investigation subject.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function getInvestigationSubject(db: Db, tenantId: string, incidentId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(investigationSubjects)
      .where(eq(investigationSubjects.incidentId, incidentId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Finds latest subject incident tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param fingerprint - Value supplied for fingerprint.
 */
export async function findLatestSubjectIncidentTx(
  tx: Tx,
  fingerprint: string,
): Promise<{ incidentId: string; status: (typeof incidents.$inferSelect)['status'] } | null> {
  const rows = await tx
    .select({ incidentId: incidents.id, status: incidents.status })
    .from(investigationSubjects)
    .innerJoin(incidents, eq(incidents.id, investigationSubjects.incidentId))
    .where(eq(investigationSubjects.fingerprint, fingerprint))
    .orderBy(desc(incidents.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface InvestigationSubjectIdentity {
  kind: InvestigationSubjectKind;
  sourceId: string;
  subjectId: string;
}

/**
 * Lists active investigation subjects.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param identities - Value supplied for identities.
 */
export async function listActiveInvestigationSubjects(
  db: Db,
  tenantId: string,
  identities: InvestigationSubjectIdentity[],
): Promise<Array<InvestigationSubjectIdentity & { incidentId: string }>> {
  if (identities.length === 0) return [];
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        kind: investigationSubjects.kind,
        sourceId: investigationSubjects.sourceId,
        subjectId: investigationSubjects.subjectId,
        incidentId: investigationSubjects.incidentId,
      })
      .from(investigationSubjects)
      .innerJoin(incidents, eq(incidents.id, investigationSubjects.incidentId))
      .where(
        and(
          inArray(incidents.status, ACTIVE_STATUSES),
          sql`(${investigationSubjects.kind}, ${investigationSubjects.sourceId}, ${investigationSubjects.subjectId}) in (${sql.join(
            identities.map(
              (identity) => sql`(${identity.kind}, ${identity.sourceId}, ${identity.subjectId})`,
            ),
            sql`, `,
          )})`,
        ),
      ),
  );
}

/**
 * Lists active subjects whose synchronization loop has no queued or processing job.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose subjects are inspected.
 * @param limit - Maximum candidates returned by one recovery sweep.
 */
export async function listMissingSubjectSyncCandidates(
  db: Db,
  tenantId: string,
  limit = 100,
): Promise<string[]> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ incidentId: investigationSubjects.incidentId })
      .from(investigationSubjects)
      .innerJoin(incidents, eq(incidents.id, investigationSubjects.incidentId))
      .where(
        and(
          eq(investigationSubjects.syncEnabled, true),
          inArray(incidents.status, ACTIVE_STATUSES),
          sql`not exists (
            select 1
            from ${jobs}
            where ${jobs.tenantId} = ${tenantId}
              and ${jobs.type} = 'subject.sync'
              and ${jobs.status} in ('queued', 'processing')
              and ${jobs.payload}->>'incidentId' = ${investigationSubjects.incidentId}::text
          )`,
        ),
      )
      .orderBy(investigationSubjects.lastSyncedAt, investigationSubjects.incidentId)
      .limit(limit),
  );
  return rows.map((row) => row.incidentId);
}

/**
 * Updates investigation subject tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param incidentId - Incident targeted by the operation.
 * @param observation - Value supplied for observation.
 */
export async function updateInvestigationSubjectTx(
  tx: Tx,
  incidentId: string,
  observation: {
    state: InvestigationSubjectState;
    summary: string;
    snapshot: InvestigationSubjectSnapshot;
    contentHash: string;
    observedAt: Date;
  },
): Promise<{ changed: boolean; previousState: InvestigationSubjectState | null }> {
  const rows = await tx
    .select({ state: investigationSubjects.currentState, hash: investigationSubjects.currentHash })
    .from(investigationSubjects)
    .where(eq(investigationSubjects.incidentId, incidentId))
    .limit(1)
    .for('update');
  const current = rows[0];
  if (!current) return { changed: false, previousState: null };
  const changed = current.hash !== observation.contentHash || current.state !== observation.state;
  await tx
    .update(investigationSubjects)
    .set({
      ...(changed
        ? {
            currentState: observation.state,
            currentSummary: observation.summary,
            currentSnapshot: observation.snapshot,
            currentHash: observation.contentHash,
          }
        : {}),
      lastSyncedAt: observation.observedAt,
      updatedAt: sql`now()`,
    })
    .where(eq(investigationSubjects.incidentId, incidentId));
  return { changed, previousState: current.state };
}
