import { and, eq, sql } from 'drizzle-orm';
import type {
  AffectedEntityCandidate,
  AutomaticInvestigationBudgetLimits,
  InvestigationTriggerReason,
  SignalSource,
} from '@sre/contracts';
import type { Db } from '../client';
import { admitInvestigationRunTx } from '../investigation-run-repo';
import {
  listResponseGroupSignalsTx,
  lockResponseGroupWorkTx,
} from '../incident-relation-repo/causal';
import { incidentInvestigationMonitorKeys } from '../investigation-trigger';
import { withTenant, type Tx } from '../rls';
import {
  ACTIVE_STATUSES,
  incidentSignals,
  incidents,
  jobs,
  type InvestigationStatus,
  type SignalEventType,
  type SignalState,
} from '../schema';
import { recoveryRestoreStatus } from './recovery-state';

export interface SignalObservation {
  incidentId: string;
  dataSourceId?: string;
  provider?: string;
  providerFingerprint?: string;
  providerGroupKey?: string;
  /** Stable provider-neutral scope for rolling automatic-investigation budgets. */
  monitorKey?: string;
  alertName?: string;
  startsAt?: Date;
  endsAt?: Date | null;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  generatorUrl?: string;
  signalSource?: SignalSource;
  affectedEntities?: AffectedEntityCandidate[];
  materialHash?: string;
  surface: string;
  channel: string;
  /** Identity of the original firing message, even when this observation is a separate resolve post. */
  externalMessageId: string;
  state: SignalState;
  summary: string;
  contentHash: string;
  /** Identity of this observation. Edits include the edit timestamp. */
  eventKey: string;
  eventAt: Date;
  /** Exact provider ordering value when the provider is finer than JavaScript Date. */
  eventVersion?: string;
}

export interface SignalApplyResult {
  signal: typeof incidentSignals.$inferSelect;
  applied: boolean;
  eventType: SignalEventType;
  previousState: SignalState | null;
  allResolved: boolean;
  investigationTriggerReason: InvestigationTriggerReason;
}

export type SignalCorrectionResult =
  | {
      outcome: 'applied' | 'noop';
      signal: typeof incidentSignals.$inferSelect;
      incidentStatus: (typeof incidents.$inferSelect)['status'];
      lifecycleVersion: number;
      allResolved: boolean;
      signalFence: string;
    }
  | { outcome: 'not_found' }
  | { outcome: 'stale' }
  | { outcome: 'archived' }
  | { outcome: 'invalid' };

/**
 * Serializes the current set of incident signal states.
 *
 * @param signals - Value supplied for signals.
 */
export function serializeSignalFence(
  signals: Array<{ id: string; version: number; state: SignalState }>,
): string {
  return [...signals]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((signal) => `${signal.id}:${signal.version}:${signal.state}`)
    .join('|');
}

/**
 * Loads and serializes incident signal states in an existing transaction.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param incidentId - Incident targeted by the operation.
 */
export async function incidentSignalFenceTx(tx: Tx, incidentId: string): Promise<string> {
  const signals = await tx
    .select({
      id: incidentSignals.id,
      version: incidentSignals.version,
      state: incidentSignals.state,
    })
    .from(incidentSignals)
    .where(eq(incidentSignals.incidentId, incidentId));
  return serializeSignalFence(signals);
}

export interface RecoveryVerificationStart {
  incident: typeof incidents.$inferSelect;
  signals: (typeof incidentSignals.$inferSelect)[];
  restoreInvestigationStatus: InvestigationStatus;
  verificationStartedAt: Date;
}

export interface RecoveryVerificationOptions {
  attempt?: number;
  maxChecks?: number;
  runId?: string;
}

interface RecoveryCandidate {
  incident: typeof incidents.$inferSelect;
  signals: (typeof incidentSignals.$inferSelect)[];
  restoreInvestigationStatus: InvestigationStatus;
}

async function lockRecoveryCandidateTx(
  tx: Tx,
  tenantId: string,
  jobId: string,
  incidentId: string,
  expectedLifecycleVersion: number,
  expectedSignalFence: string,
): Promise<RecoveryCandidate | null> {
  const { rootIncidentId } = await lockResponseGroupWorkTx(tx, tenantId, incidentId);
  if (rootIncidentId !== incidentId) return null;
  const incidentRows = await tx
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for('update');
  const incident = incidentRows[0];
  if (!incident) return null;
  const completedBudget =
    incident.recoveryState !== 'verifying' &&
    incident.recoveryAttempt !== null &&
    incident.recoveryMaxChecks !== null &&
    incident.recoveryAttempt >= incident.recoveryMaxChecks;
  if (
    incident.recoveryState === 'verified' ||
    incident.recoveryState === 'not_verified' ||
    completedBudget
  )
    return null;

  const jobRows = await tx
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.tenantId, tenantId), eq(jobs.type, 'recovery.verify')))
    .limit(1)
    .for('update');
  const savedStatus = recoveryRestoreStatus(jobRows[0]?.payload);
  const restoreInvestigationStatus =
    savedStatus && savedStatus !== 'gathering' ? savedStatus : incident.investigationStatus;
  if (
    jobRows[0] &&
    restoreInvestigationStatus !== 'gathering' &&
    savedStatus !== restoreInvestigationStatus
  ) {
    await tx
      .update(jobs)
      .set({
        payload: sql`${jobs.payload} || ${JSON.stringify({ restoreInvestigationStatus })}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.tenantId, tenantId)));
  }

  const signals = await listResponseGroupSignalsTx(tx, tenantId, incidentId);
  const valid =
    incident.lifecycleVersion === expectedLifecycleVersion &&
    ACTIVE_STATUSES.includes(incident.status as (typeof ACTIVE_STATUSES)[number]) &&
    signals.length > 0 &&
    signals.every((signal) => signal.state === 'resolved') &&
    serializeSignalFence(signals) === expectedSignalFence;
  if (!valid) {
    if (
      incident.investigationStatus === 'gathering' &&
      restoreInvestigationStatus !== 'gathering'
    ) {
      await tx
        .update(incidents)
        .set({
          investigationStatus: restoreInvestigationStatus,
          recoveryState: null,
          recoverySummary: null,
          recoveryEvidenceIds: null,
          recoveryUnknowns: null,
          recoveryNextStep: null,
          recoveryUpdatedAt: null,
          recoveryRunId: null,
          recoveryAttempt: null,
          recoveryMaxChecks: null,
          recoveryNextCheckAt: null,
          recoveryScheduleReason: null,
          updatedAt: sql`now()`,
        })
        .where(eq(incidents.id, incidentId));
    }
    return null;
  }
  return { incident, signals, restoreInvestigationStatus };
}

async function startRecoveryVerificationTx(
  tx: Tx,
  candidate: RecoveryCandidate,
  attempt: number,
  maxChecks: number,
  runId?: string,
): Promise<RecoveryVerificationStart> {
  const started = await tx
    .update(incidents)
    .set({
      investigationStatus: 'gathering',
      recoveryState: 'verifying',
      recoverySummary: null,
      recoveryEvidenceIds: null,
      recoveryUnknowns: null,
      recoveryNextStep: null,
      recoveryUpdatedAt: sql`now()`,
      recoveryRunId: runId ?? null,
      recoveryAttempt: attempt,
      recoveryMaxChecks: maxChecks,
      recoveryNextCheckAt: null,
      recoveryScheduleReason: null,
      updatedAt: sql`now()`,
    })
    .where(eq(incidents.id, candidate.incident.id))
    .returning({ verificationStartedAt: incidents.recoveryUpdatedAt });
  return { ...candidate, verificationStartedAt: started[0]!.verificationStartedAt! };
}

async function markRecoveryBudgetExhaustedTx(tx: Tx, incidentId: string): Promise<void> {
  await tx
    .update(incidents)
    .set({
      recoveryState: 'not_verified',
      recoverySummary: 'Automatic recovery verification budget exhausted.',
      recoveryNextStep: 'Send a responder message to continue recovery verification.',
      recoveryUpdatedAt: sql`now()`,
      recoveryRunId: null,
      recoveryNextCheckAt: null,
      recoveryScheduleReason: null,
      updatedAt: sql`now()`,
    })
    .where(eq(incidents.id, incidentId));
}

/**
 * Starts recovery verification after validating lifecycle and signal fences.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the recovery state.
 * @param jobId - Durable recovery job being executed.
 * @param incidentId - Incident being verified.
 * @param expectedLifecycleVersion - Lifecycle version captured by the producer.
 * @param expectedSignalFence - Serialized signal state captured by the producer.
 * @param options - Attempt counters and optional run owner.
 */
export async function beginRecoveryVerification(
  db: Db,
  tenantId: string,
  jobId: string,
  incidentId: string,
  expectedLifecycleVersion: number,
  expectedSignalFence: string,
  options: RecoveryVerificationOptions = {},
): Promise<RecoveryVerificationStart | null> {
  const { attempt = 1, maxChecks = 3, runId } = options;
  return withTenant(db, tenantId, async (tx) => {
    const candidate = await lockRecoveryCandidateTx(
      tx,
      tenantId,
      jobId,
      incidentId,
      expectedLifecycleVersion,
      expectedSignalFence,
    );
    return candidate ? startRecoveryVerificationTx(tx, candidate, attempt, maxChecks, runId) : null;
  });
}

/**
 * Atomically validates recovery applicability, admits its paid run, and records the result.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the recovery state and budget.
 * @param jobId - Durable recovery job being admitted.
 * @param incidentId - Incident being verified.
 * @param expectedLifecycleVersion - Lifecycle version captured by the producer.
 * @param expectedSignalFence - Serialized signal state captured by the producer.
 * @param options - Recovery counters and automatic budget policy.
 */
export async function beginRecoveryInvestigation(
  db: Db,
  tenantId: string,
  jobId: string,
  incidentId: string,
  expectedLifecycleVersion: number,
  expectedSignalFence: string,
  options: {
    attempt: number;
    maxChecks: number;
    limits: AutomaticInvestigationBudgetLimits;
    onBudgetExhaustedTx?: (
      tx: Tx,
      runId: string,
      incident: typeof incidents.$inferSelect,
    ) => Promise<void>;
  },
) {
  return withTenant(db, tenantId, async (tx) => {
    const candidate = await lockRecoveryCandidateTx(
      tx,
      tenantId,
      jobId,
      incidentId,
      expectedLifecycleVersion,
      expectedSignalFence,
    );
    if (!candidate) return null;
    const monitorKeys = incidentInvestigationMonitorKeys(candidate.incident, candidate.signals);
    const admission = await admitInvestigationRunTx(tx, tenantId, incidentId, {
      jobId,
      operation: 'verify-recovery',
      trigger: {
        reason: 'recovery_verification',
        automatic: true,
        monitorKey: monitorKeys.length === 1 ? monitorKeys[0]! : null,
        monitorKeys,
      },
      limits: options.limits,
    });
    if (!admission.admitted) {
      await markRecoveryBudgetExhaustedTx(tx, incidentId);
      await options.onBudgetExhaustedTx?.(tx, admission.id, candidate.incident);
      return { admission, incident: candidate.incident, verification: null };
    }
    return {
      admission,
      incident: candidate.incident,
      verification: await startRecoveryVerificationTx(
        tx,
        candidate,
        options.attempt,
        options.maxChecks,
        admission.id,
      ),
    };
  });
}

/**
 * Restore progress only if this recovery attempt still owns the `gathering` state.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param investigationStatus - Investigation status restored after verification.
 * @param runId - Optional owner fence for the verification state.
 */
export async function restoreRecoveryVerification(
  db: Db,
  tenantId: string,
  incidentId: string,
  investigationStatus: InvestigationStatus,
  runId?: string,
): Promise<void> {
  if (investigationStatus === 'gathering') return;
  await withTenant(db, tenantId, (tx) =>
    restoreRecoveryVerificationTx(tx, incidentId, investigationStatus, runId),
  );
}

/**
 * Restores recovery progress inside the caller's transaction while the attempt still owns it.
 *
 * @param tx - Existing transaction that carries tenant scope.
 * @param incidentId - Incident whose recovery attempt is being restored.
 * @param investigationStatus - Stable investigation state to restore.
 * @param runId - Optional owner fence for the active recovery attempt.
 */
export async function restoreRecoveryVerificationTx(
  tx: Tx,
  incidentId: string,
  investigationStatus: InvestigationStatus,
  runId?: string,
): Promise<void> {
  if (investigationStatus === 'gathering') return;
  await tx
    .update(incidents)
    .set({
      investigationStatus,
      recoveryState: null,
      recoverySummary: null,
      recoveryEvidenceIds: null,
      recoveryUnknowns: null,
      recoveryNextStep: null,
      recoveryUpdatedAt: null,
      recoveryRunId: null,
      recoveryAttempt: null,
      recoveryMaxChecks: null,
      recoveryNextCheckAt: null,
      recoveryScheduleReason: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(incidents.id, incidentId),
        eq(incidents.investigationStatus, 'gathering'),
        runId ? eq(incidents.recoveryRunId, runId) : undefined,
      ),
    );
}
