import {
  getActiveMergedTargetTx,
  investigationMonitorKeys,
  incidentSignals,
  incidents,
  jobs,
  lockIncidentWorkTx,
  recoveryRestoreStatus,
  type Db,
  type Executor,
  type InvestigationStatus,
  type Tx,
} from '@sre/db';
import type { InvestigationTrigger, InvestigationTriggerReason } from '@sre/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { coalesceKeyFilter, widenCoalescedTopologyPass } from './coalescing';
import {
  COALESCING_TYPES,
  IncidentMovedError,
  IncidentUnavailableError,
  type JobInput,
} from './contracts';
import { insertCohortAnalysisJobTx, insertRelationReassessmentJobTx } from './analysis-jobs';
import { insertReassessmentJobTx } from './reassessment';

export class QueueWriter {
  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly stream: string,
    private readonly streamMaxLen: number,
  ) {}

  private async incidentMonitorKeysTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
  ): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ monitorKey: incidentSignals.monitorKey })
      .from(incidentSignals)
      .where(
        and(eq(incidentSignals.tenantId, tenantId), eq(incidentSignals.incidentId, incidentId)),
      );
    if (rows.length === 0) return [];
    const incidentRows = await tx
      .select({ source: incidents.alertSource, fingerprint: incidents.fingerprint })
      .from(incidents)
      .where(and(eq(incidents.tenantId, tenantId), eq(incidents.id, incidentId)))
      .limit(1);
    const incident = incidentRows[0];
    if (!incident) return [];
    const fallback = `${incident.source}:${incident.fingerprint}`.slice(0, 500);
    return investigationMonitorKeys(rows.map((row) => row.monitorKey ?? fallback));
  }

  private async fenceIncidentJobTx(tx: Tx, input: JobInput): Promise<void> {
    const incidentId = (input.payload as { incidentId?: unknown } | null)?.incidentId;
    if (typeof incidentId !== 'string') return;
    await lockIncidentWorkTx(tx, input.tenantId, [incidentId]);
    // Human-commanded generations against an archived incident are refused at enqueue.
    if (input.type === 'runbook.generate' || input.type === 'postmortem.generate') {
      const rows = await tx
        .select({ archivedAt: incidents.archivedAt })
        .from(incidents)
        .where(and(eq(incidents.tenantId, input.tenantId), eq(incidents.id, incidentId)))
        .limit(1)
        .for('update');
      if (rows[0]?.archivedAt) throw new IncidentUnavailableError(incidentId);
    }
    const targetIncidentId = await getActiveMergedTargetTx(tx, incidentId);
    if (targetIncidentId) throw new IncidentMovedError(incidentId, targetIncidentId);
  }

  /**
   * Find the pending job a coalescing index just rejected our insert for. Coalescing indexes on `jobs`
   * key on tenant + type + one payload field: `incidentId` for incident-scoped work, `connectorId` for
   * topology passes ({@link coalesceKeyFilter}). A payload without that field can never conflict.
   * Returns the newest non-terminal match, or null when none survives.
   */
  private async findPendingByCoalesceKey(
    input: JobInput,
    exec: Executor = this.db,
  ): Promise<string | null> {
    const sameKey = coalesceKeyFilter(input.type, input.payload);
    if (!sameKey) return null;
    const rows = await exec
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, input.tenantId),
          eq(jobs.type, input.type),
          sameKey,
          inArray(jobs.status, ['queued', 'processing']),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Write the durable Postgres row, then dispatch onto the stream (Postgres-before-stream).
   *
   * Coalescing-aware for OPT-IN types only: a duplicate command for an incident that already has a
   * pending job of a {@link COALESCING_TYPES} type is absorbed by a partial-unique index, and this returns
   * the EXISTING job id instead of raising 23505 (which surfaced as an HTTP 500 on a double-clicked
   * generate-runbook). Bare `onConflictDoNothing()` with no target, like {@link insertResumeTx}: an
   * expression/partial index is not assignable to PgColumn under drizzle 0.45. DO NOTHING returns zero
   * rows, so the existing id needs the tenant-scoped follow-up SELECT.
   *
   * Every other type keeps the raw 23505. `jobs_resume_coalesce_idx` carries `type` as a KEY column, so it
   * constrains EVERY incident-scoped type, `triage` included — and a coalesced `triage` would silently DROP
   * the re-alert's newer payload and report the old job id as success. The throw is load-bearing there:
   * routeToIncident releases its dedup key and rethrows, so the newer alert body still reaches the engine.
   *
   * XADD fires ONLY on a fresh insert. Re-publishing a stream entry for a coalesced job would redeliver
   * work already queued (or worse, already running) — the exact duplicate the index exists to prevent.
   * A coalesced-away job needs no dispatch: the row that won the index slot carries its own entry.
   *
   * The conflict → SELECT window is racy: the pending job can go terminal in between, freeing the index
   * slot and leaving the SELECT empty. That is a real "no pending job now" state, not an error, so retry
   * the insert once rather than returning a bogus null the caller would 500 on. The retry either wins the
   * freed slot or coalesces onto whatever took it. Two rounds bound it; a third would mean the incident is
   * churning jobs faster than we can observe them, which is a genuine fault.
   */
  async enqueue(input: JobInput): Promise<string> {
    const coalescing = COALESCING_TYPES.has(input.type);
    for (let round = 0; round < 2; round++) {
      const durable = await this.db.transaction(async (tx) => {
        await this.fenceIncidentJobTx(tx, input);
        const insert = tx.insert(jobs).values({
          tenantId: input.tenantId,
          type: input.type,
          payload: input.payload as object,
          status: 'queued',
          stream: this.stream,
        });
        const inserted = await (coalescing ? insert.onConflictDoNothing() : insert).returning({
          id: jobs.id,
        });
        const id = inserted[0]?.id;
        if (id !== undefined) return { id, inserted: true };
        await widenCoalescedTopologyPass(tx, input);
        return { id: await this.findPendingByCoalesceKey(input, tx), inserted: false };
      });
      if (durable.id !== null && durable.inserted) {
        try {
          const streamId = await this.redis.xadd(
            this.stream,
            'MAXLEN',
            '~',
            this.streamMaxLen,
            '*',
            'jobId',
            durable.id,
          );
          await this.db
            .update(jobs)
            .set({ streamId, updatedAt: sql`now()` })
            .where(eq(jobs.id, durable.id))
            .catch((error) =>
              console.warn(
                JSON.stringify({
                  level: 'warn',
                  pkg: '@sre/queue',
                  event: 'queue.stream_id_write_failed',
                  jobId: durable.id,
                  errorType: error instanceof Error ? error.name : 'UnknownError',
                }),
              ),
            );
        } catch (error) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              pkg: '@sre/queue',
              event: 'queue.post_commit_dispatch_failed',
              jobId: durable.id,
              errorType: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        }
        return durable.id;
      }
      if (durable.id !== null) return durable.id;
    }
    throw new Error(`enqueue coalesced onto a job that is no longer pending (type=${input.type})`);
  }

  /**
   * Insert-only half of {@link enqueueResume}: writes the durable `resume` job on the passed tx, with the
   * partial-unique coalescing index (`jobs_resume_coalesce_idx`) as the source of truth. Returns the new
   * job id, or null when the durable index coalesced onto an already-pending resume. NO Redis, NO fast-gate
   * — the caller runs post-commit dispatch via {@link publishResume}.
   *
   * Split out so the resume insert can share the human reply's transaction: `jobs` is non-RLS
   * and app_user holds INSERT, so an app RLS tx inserts it fine; if that shared tx rolls back,
   * the resume vanishes with the message — atomic, no orphaned reply. The fast-gate is deliberately absent
   * here: arming it before a tx that can roll back would strand it armed-with-no-pending-job, coalescing a
   * real future reply into nothing. The durable index alone coalesces correctly.
   *
   * Bare DO NOTHING (no conflict target) covers the expression/partial index and typechecks under drizzle
   * 0.45 (an expression target is not assignable to PgColumn); it returns zero rows on conflict. jobs has
   * no other unique constraint (id is defaultRandom), so this only ever fires for the resume-coalesce index.
   */
  async insertResumeTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    humanMessageId: string,
  ): Promise<{ jobId: string | null }> {
    await this.fenceIncidentJobTx(tx, {
      tenantId,
      type: 'resume',
      payload: {
        incidentId,
        humanMessageId,
        investigationTrigger: {
          reason: 'human_continuation',
          automatic: false,
          monitorKey: null,
        } satisfies InvestigationTrigger,
      },
    });
    const inserted = await tx
      .insert(jobs)
      .values({
        tenantId,
        type: 'resume',
        payload: {
          incidentId,
          humanMessageId,
          investigationTrigger: {
            reason: 'human_continuation',
            automatic: false,
            monitorKey: null,
          } satisfies InvestigationTrigger,
        },
        status: 'queued',
        stream: this.stream,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    return { jobId: inserted[0]?.id ?? null };
  }

  /**
   * Coalesce recovery verification per incident while queued. A later all-cleared observation refreshes
   * the queued job's fences instead of creating a second engine run; a processing job may have one newer
   * queued successor, matching the resume index's clear-before-read semantics.
   */
  async insertRecoveryTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    lifecycleVersion: number,
    signalFence: string,
    options: {
      attempt?: number;
      maxChecks?: number;
      availableAt?: Date;
      scheduleReason?: string;
    } = {},
  ): Promise<{ jobId: string | null }> {
    await this.fenceIncidentJobTx(tx, {
      tenantId,
      type: 'recovery.verify',
      payload: { incidentId },
    });
    const incidentRows = await tx
      .select({
        investigationStatus: incidents.investigationStatus,
        resolutionPolicy: incidents.resolutionPolicy,
        recoveryState: incidents.recoveryState,
        recoveryAttempt: incidents.recoveryAttempt,
        recoveryMaxChecks: incidents.recoveryMaxChecks,
      })
      .from(incidents)
      .where(and(eq(incidents.id, incidentId), eq(incidents.tenantId, tenantId)))
      .limit(1);
    const incident = incidentRows[0];
    const currentStatus = incident?.investigationStatus;
    const exhaustedBudget =
      incident?.recoveryAttempt !== null &&
      incident?.recoveryAttempt !== undefined &&
      incident.recoveryMaxChecks !== null &&
      incident.recoveryMaxChecks !== undefined &&
      incident.recoveryAttempt >= incident.recoveryMaxChecks;
    const inFlightAttempt = incident?.recoveryState === 'verifying';
    // Model-backed recovery keeps its bounded check budget. Fresh exact provider-clear evidence can
    // enqueue another deterministic check without spending that budget.
    if (
      incident?.resolutionPolicy !== 'provider_clear' &&
      (incident?.recoveryState === 'not_verified' || (exhaustedBudget && !inFlightAttempt))
    )
      return { jobId: null };
    let restoreInvestigationStatus: InvestigationStatus | undefined =
      currentStatus && currentStatus !== 'gathering' ? currentStatus : undefined;
    if (currentStatus === 'gathering') {
      const related = await tx
        .select({ payload: jobs.payload })
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            eq(jobs.type, 'recovery.verify'),
            inArray(jobs.status, ['queued', 'processing']),
            sql`payload->>'incidentId' = ${incidentId}`,
          ),
        );
      restoreInvestigationStatus =
        related
          .map((row) => recoveryRestoreStatus(row.payload))
          .find((status) => status !== null && status !== 'gathering') ?? undefined;
    }
    const attempt =
      options.attempt ?? (inFlightAttempt ? (incident?.recoveryAttempt ?? undefined) : undefined);
    const maxChecks =
      options.maxChecks ??
      (inFlightAttempt ? (incident?.recoveryMaxChecks ?? undefined) : undefined);
    const monitorKeys = await this.incidentMonitorKeysTx(tx, tenantId, incidentId);
    const payload = {
      incidentId,
      lifecycleVersion,
      signalFence,
      investigationTrigger: {
        reason: 'recovery_verification',
        automatic: true,
        monitorKey: monitorKeys.length === 1 ? monitorKeys[0]! : null,
        ...(monitorKeys.length > 1 ? { monitorKeys } : {}),
      } satisfies InvestigationTrigger,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(maxChecks !== undefined ? { maxChecks } : {}),
      ...(options.scheduleReason ? { scheduleReason: options.scheduleReason } : {}),
      ...(restoreInvestigationStatus ? { restoreInvestigationStatus } : {}),
    };
    for (let round = 0; round < 2; round++) {
      const inserted = await tx
        .insert(jobs)
        .values({
          tenantId,
          type: 'recovery.verify',
          payload,
          status: 'queued',
          stream: this.stream,
          availableAt: options.availableAt,
        })
        .onConflictDoNothing()
        .returning({ id: jobs.id });
      if (inserted[0]) return { jobId: inserted[0].id };
      const refreshed = await tx
        .update(jobs)
        .set({
          // A repeated resolved observation may make a scheduled check due immediately, but it must
          // not reset that cycle's attempt/max budget. JSON merge retains scheduling fields omitted
          // by the fresh observation and overwrites the lifecycle/signal fences it did provide.
          payload: sql`${jobs.payload} || ${JSON.stringify(payload)}::jsonb`,
          availableAt: options.availableAt ?? sql`now()`,
          ...(options.availableAt ? { streamId: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            eq(jobs.type, 'recovery.verify'),
            eq(jobs.status, 'queued'),
            sql`payload->>'incidentId' = ${incidentId}`,
          ),
        )
        .returning({ id: jobs.id });
      if (refreshed[0]) return { jobId: null };
      // The conflicting queued row was claimed between INSERT and UPDATE. Retry the insert once so the
      // newer fences become the processing job's queued successor instead of disappearing.
    }
    throw new Error('recovery coalesce raced a job claim twice');
  }

  /** Coalesce alert edits per incident while queued, retaining the newest signal version to assess. */
  async insertReassessmentTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    signalId: string,
    signalVersion: number,
    triggerReason: InvestigationTriggerReason = 'material_change',
  ): Promise<{ jobId: string | null }> {
    await this.fenceIncidentJobTx(tx, {
      tenantId,
      type: 'signal.reassess',
      payload: { incidentId },
    });
    return insertReassessmentJobTx(tx, {
      tenantId,
      incidentId,
      signalId,
      signalVersion,
      triggerReason,
      stream: this.stream,
    });
  }

  /** Keep one delayed synchronization check queued per subject-backed incident. */
  async insertSubjectSyncTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    availableAt: Date,
  ): Promise<{ jobId: string | null }> {
    await this.fenceIncidentJobTx(tx, {
      tenantId,
      type: 'subject.sync',
      payload: { incidentId },
    });
    const inserted = await tx
      .insert(jobs)
      .values({
        tenantId,
        type: 'subject.sync',
        payload: { incidentId },
        status: 'queued',
        stream: this.stream,
        availableAt,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (inserted[0]) return { jobId: inserted[0].id };
    await tx
      .update(jobs)
      .set({ availableAt, streamId: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.type, 'subject.sync'),
          eq(jobs.status, 'queued'),
          sql`payload->>'incidentId' = ${incidentId}`,
        ),
      );
    return { jobId: null };
  }

  /** Keeps one delayed relationship-analysis job per fixed alert cohort. */
  async insertCohortAnalysisTx(
    tx: Tx,
    tenantId: string,
    cohortId: string,
    availableAt: Date,
  ): Promise<{ jobId: string | null }> {
    return insertCohortAnalysisJobTx(tx, tenantId, cohortId, this.stream, availableAt);
  }

  /** Keeps one causal-candidate reassessment pending per incident. */
  async insertRelationReassessmentTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
  ): Promise<{ jobId: string | null }> {
    await this.fenceIncidentJobTx(tx, {
      tenantId,
      type: 'relation.reassess',
      payload: { incidentId },
    });
    return insertRelationReassessmentJobTx(tx, tenantId, incidentId, this.stream);
  }

  /**
   * Insert-only half of {@link enqueue}, for a caller that already holds a tenant transaction. Writes the
   * durable `jobs` row on the passed tx and returns its id. NO Redis — the caller runs post-commit dispatch
   * via {@link publishJob}.
   *
   * Split out so the triage job can share the incident's transaction: `jobs` is non-RLS
   * and app_user holds INSERT, so an app RLS tx inserts it fine; if that shared tx rolls back, the job
   * vanishes with the incident — atomic, no incident whose triage was never queued. A crash after the
   * commit but before {@link publishJob} leaves a `queued` row with a null `stream_id`, which
   * {@link reconcile} re-dispatches.
   *
   * No ON CONFLICT, mirroring the non-coalescing {@link enqueue} branch: `jobs_resume_coalesce_idx` keys
   * on tenant + type + incidentId, so a duplicate `triage` for a still-pending incident raises 23505 —
   * load-bearing, because absorbing it would drop the re-alert's newer payload while reporting success.
   * The raise rolls the caller's tx back, which is exactly what routeToIncident needs to release its dedup
   * key and let the newer alert body through.
   */
  async insertJobTx(tx: Tx, input: JobInput): Promise<string> {
    await this.fenceIncidentJobTx(tx, input);
    const inserted = await tx
      .insert(jobs)
      .values({
        tenantId: input.tenantId,
        type: input.type,
        payload: input.payload as object,
        status: 'queued',
        stream: this.stream,
      })
      .returning({ id: jobs.id });
    return inserted[0]!.id;
  }
}
