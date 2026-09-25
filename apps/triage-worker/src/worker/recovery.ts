import {
  beginRecoveryInvestigation,
  restoreRecoveryVerification,
  type IncidentEvidence,
} from '@sre/db';
import { ProviderClearLockContendedError } from '@sre/hub';
import { LockContentionError, RetryableError, type Job, type JobContext } from '@sre/queue';
import { reloadIncidentEvidence } from './evidence';
import type { TriageResult } from '../engine/types';
import type { WorkerDisposition } from './disposition';
import { investigationRunCompletion, restrictEvidenceToReceipts } from './run-result';
import type { EngineToolRuntime, WorkerRuntime } from './runtime';
import { appendWorkerBudgetExhaustedTx, automaticInvestigationBudgetLimits } from './admission';
import { persistNonPromotingRun } from './terminal';
import { TRANSCRIPT_MAX_ROWS, modelPrior } from './transcript';

export class RecoveryHandler {
  constructor(
    private readonly runtime: WorkerRuntime,
    private readonly disposition: WorkerDisposition,
  ) {}

  async handle(job: Job, ctx: JobContext): Promise<void> {
    const { deps } = this.runtime;
    const payload = (job.payload ?? {}) as {
      incidentId?: string;
      lifecycleVersion?: number;
      signalFence?: string;
      attempt?: number;
      maxChecks?: number;
      scheduleReason?: string;
    };
    if (
      !payload.incidentId ||
      payload.lifecycleVersion === undefined ||
      payload.signalFence === undefined
    )
      return;
    await this.runtime.withEngineLock(payload.incidentId, async () => {
      const eventKey = `recovery:${job.id}`;
      const transitionKey = `auto-resolve:${job.id}`;
      const [committed, committedLifecycle] = await Promise.all([
        deps.hub.appendedByOrigin(job.tenantId, payload.incidentId!, eventKey),
        deps.hub.appendedByTransition(job.tenantId, payload.incidentId!, transitionKey),
      ]);
      if (committed || committedLifecycle) {
        if (committed) await deps.hub.publishAppended(committed);
        if (committedLifecycle) await deps.hub.publishAppended(committedLifecycle);
        return;
      }
      let providerHandled: boolean;
      try {
        providerHandled = await deps.hub.resolveProviderClear(
          job.tenantId,
          payload.incidentId!,
          {
            lifecycleVersion: payload.lifecycleVersion!,
            signalFence: payload.signalFence!,
          },
          transitionKey,
        );
      } catch (error) {
        // A connector write held the generation rows. Nothing was written; redeliver.
        if (error instanceof ProviderClearLockContendedError)
          throw new LockContentionError('provider clear evaluation contended; redelivering');
        throw error;
      }
      if (providerHandled) return;
      const maxChecks = await this.disposition.recoveryMaxChecks(payload.maxChecks);
      const attempt = Math.max(1, Math.min(maxChecks, payload.attempt ?? 1));
      const limits = await automaticInvestigationBudgetLimits(this.runtime);
      let budgetMessage: Awaited<ReturnType<typeof appendWorkerBudgetExhaustedTx>> | null = null;
      const prepared = await beginRecoveryInvestigation(
        deps.appDb,
        job.tenantId,
        job.id,
        payload.incidentId!,
        payload.lifecycleVersion!,
        payload.signalFence!,
        {
          attempt,
          maxChecks,
          limits,
          onBudgetExhaustedTx: async (tx, runId, incident) => {
            budgetMessage = await appendWorkerBudgetExhaustedTx(
              this.runtime,
              tx,
              job.tenantId,
              incident,
              runId,
            );
          },
        },
      );
      if (!prepared) return;
      if (!prepared.admission.admitted) {
        if (budgetMessage) await deps.hub.publishAppendedBestEffort(budgetMessage);
        return;
      }
      const runId = prepared.admission.id;
      const started = prepared.verification!;
      const {
        incident,
        signals: before,
        restoreInvestigationStatus,
        verificationStartedAt,
      } = started;
      let toolRuntime: EngineToolRuntime | undefined;
      let runCompleted = false;
      let finalizationStarted = false;
      try {
        const history = await deps.hub.history(job.tenantId, incident.id, {
          limit: TRANSCRIPT_MAX_ROWS,
        });
        let evidence: IncidentEvidence[] = [];
        try {
          evidence = await reloadIncidentEvidence(deps, job.tenantId, incident.id);
        } catch {
          console.warn(
            JSON.stringify({
              level: 'warn',
              app: 'triage-worker',
              event: 'recovery.evidence_reload_failed',
              tenantId: job.tenantId,
              incidentId: incident.id,
            }),
          );
        }
        const runtime = await this.runtime.tools(job.tenantId, incident, {
          mirrorSteps: false,
          signal: ctx.signal,
        });
        toolRuntime = runtime;
        let result: TriageResult;
        try {
          result = await this.runtime.executeEngine(
            job,
            incident.id,
            'verify-recovery',
            ctx.signal,
            (engine) =>
              engine.verifyRecovery(
                {
                  incident: this.runtime.incidentInput(job.tenantId, incident),
                  prior: modelPrior(history),
                  evidence,
                  signalSummary: before.map((signal) => signal.summary).join('\n'),
                  attempt,
                  maxChecks,
                  ...(payload.scheduleReason ? { scheduledReason: payload.scheduleReason } : {}),
                  ...(runtime.platformIdentity ? { context: runtime.platformIdentity } : {}),
                },
                runtime,
              ),
          );
        } catch (error) {
          runCompleted = await this.disposition.persistEngineFailure(
            job.tenantId,
            incident,
            runId,
            runtime,
            error,
            `recovery-degraded:${job.id}`,
            restoreInvestigationStatus,
            true,
          );
          await restoreRecoveryVerification(
            deps.appDb,
            job.tenantId,
            incident.id,
            restoreInvestigationStatus,
            runId,
          );
          if (!runCompleted) return;
          return this.disposition.throwEngineError(error);
        }
        result = restrictEvidenceToReceipts(result);
        if (
          result.outcome !== 'conclusive' &&
          !(
            result.outcome === 'inconclusive' &&
            result.disposition === 'recovery' &&
            result.recovery?.outcome === 'needs_human' &&
            result.recovery.recovered === false
          )
        ) {
          runCompleted = await persistNonPromotingRun({
            runtime: this.runtime,
            tenantId: job.tenantId,
            incidentId: incident.id,
            result,
            runId,
            completion: investigationRunCompletion,
            investigationStatus: restoreInvestigationStatus,
            recoveryRestoreStatus: restoreInvestigationStatus,
            originMessageId: eventKey,
          });
          return;
        }
        finalizationStarted = true;
        const finalized = await this.disposition.persistRecovery(
          job.tenantId,
          incident.id,
          result,
          {
            responseRootIncidentId: incident.id,
            verificationRunId: runId,
            recoveryJobId: job.id,
            expectedLifecycleVersion: incident.lifecycleVersion,
            expectedSignalFence: payload.signalFence!,
            restoreInvestigationStatus,
            verificationStartedAt,
            attempt,
            maxChecks,
            eventKey,
            transitionKey,
            signals: before,
          },
        );
        runCompleted = finalized.runCompleted;
        if (finalized.retryable)
          throw new RetryableError('recovery lifecycle changed; redelivering');
      } catch (error) {
        if (!runCompleted && !finalizationStarted)
          runCompleted = await this.disposition.failRun(
            job.tenantId,
            incident.id,
            runId,
            'Recovery setup failed.',
            toolRuntime,
          );
        await restoreRecoveryVerification(
          deps.appDb,
          job.tenantId,
          incident.id,
          restoreInvestigationStatus,
          runId,
        ).catch((restoreError) => {
          console.warn(
            JSON.stringify({
              level: 'warn',
              app: 'triage-worker',
              event: 'recovery.progress_restore_failed',
              tenantId: job.tenantId,
              incidentId: incident.id,
              error: restoreError instanceof Error ? restoreError.message : String(restoreError),
            }),
          );
        });
        throw error;
      }
    });
  }
}
