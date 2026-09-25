import {
  advanceResumeWatermark,
  getIncident,
  humanMessagesSince,
  listIncidentSignals,
  listResponseGroupSignals,
  recoveryVerificationStartedAt,
  resolveResponseRoot,
  serializeSignalFence,
  withTenant,
  type IncidentEvidence,
} from '@sre/db';
import type { Job, JobContext } from '@sre/queue';
import { processResponderActions } from './responder-actions';
import {
  readResponderProgress,
  saveResponderProgress,
  readResponderMessage,
} from './responder-progress';
import type { WorkerDisposition } from './disposition';
import { reloadIncidentEvidence, type WorkerEvidence } from './evidence';
import type { EngineToolRuntime, WorkerRuntime } from './runtime';
import { TRANSCRIPT_MAX_ROWS, splitResumeInput } from './transcript';

export class ResumeHandler {
  constructor(
    private readonly runtime: WorkerRuntime,
    private readonly disposition: WorkerDisposition,
    private readonly evidenceService: WorkerEvidence,
  ) {}

  async handle(job: Job, ctx: JobContext): Promise<void> {
    const { deps } = this.runtime;
    const payload = (job.payload ?? {}) as { incidentId?: string; humanMessageId: string };
    const incidentId = payload.incidentId;
    if (!incidentId) return;
    const incident = await getIncident(deps.appDb, job.tenantId, incidentId);
    if (!incident) return;
    const engineOwnerId = await resolveResponseRoot(deps.appDb, job.tenantId, incidentId);
    await this.runtime.withEngineLock(engineOwnerId, async () => {
      const fresh = await getIncident(deps.appDb, job.tenantId, incidentId);
      if (!fresh) return;
      await deps.clearResumeGate(incidentId);
      const base = fresh.lastResumeMessageId ?? null;
      const progress = await readResponderProgress(deps.appDb, job, incidentId, base);
      const batch = await humanMessagesSince(
        deps.appDb,
        job.tenantId,
        incidentId,
        progress?.afterMessageId ?? base,
        undefined,
        8,
      );
      const pending = progress?.pendingQuestionId
        ? await readResponderMessage(
            deps.appDb,
            job.tenantId,
            incidentId,
            progress.pendingQuestionId,
          )
        : null;
      if (batch.length === 0 && !pending) return;
      const lookAhead = await humanMessagesSince(
        deps.appDb,
        job.tenantId,
        incidentId,
        null,
        TRANSCRIPT_MAX_ROWS + 1,
      );
      const newest =
        batch.at(-1) ??
        (await readResponderMessage(
          deps.appDb,
          job.tenantId,
          incidentId,
          progress!.afterMessageId,
        ));
      if (!newest) return;
      const nonCommands = await processResponderActions(
        this.runtime,
        job,
        incidentId,
        batch,
        fresh.lifecycleVersion,
        ctx.signal,
        {
          newer: lookAhead,
          pending: pending ? [pending] : [],
          base,
          checkpoint: async (afterMessageId, pendingQuestionId) => {
            await saveResponderProgress(deps.appDb, job, {
              base,
              afterMessageId,
              pendingQuestionId,
            });
          },
        },
      );
      const unread = await humanMessagesSince(
        deps.appDb,
        job.tenantId,
        incidentId,
        newest.id,
        undefined,
        1,
      );
      if (unread.length > 0) {
        const successor = await withTenant(deps.appDb, job.tenantId, (tx) =>
          deps.queue.insertResumeTx(tx, job.tenantId, incidentId, unread[0]!.id),
        );
        if (successor.jobId) await deps.queue.publishResume(successor.jobId);
        return;
      }
      if (nonCommands.length === 0) {
        await advanceResumeWatermark(deps.appDb, job.tenantId, incidentId, newest.id);
        return;
      }
      const target = nonCommands[nonCommands.length - 1]!;
      const current = await getIncident(deps.appDb, job.tenantId, incidentId);
      if (!current) return;
      const admission = await this.disposition.admitRun(job, fresh, 'resume');
      if (!admission.admitted)
        throw new Error('manual investigation was rejected by automatic budget');
      const runId = admission.id;
      let toolRuntime: EngineToolRuntime | undefined;
      let executeRun: (() => Promise<boolean>) | null = null;
      try {
        const history = await deps.hub.history(job.tenantId, incidentId, {
          limit: TRANSCRIPT_MAX_ROWS,
        });
        const opener = await deps.hub.opener(job.tenantId, incidentId);
        const input = splitResumeInput(history, target.id, {
          opener,
          truncated: history.length >= TRANSCRIPT_MAX_ROWS,
          currentMessage: target,
        });
        if (!input) {
          await this.disposition.failRun(
            job.tenantId,
            incidentId,
            runId,
            'Resume context could not be reconstructed.',
          );
          return;
        }
        let evidence: IncidentEvidence[] = [];
        try {
          evidence = await reloadIncidentEvidence(deps, job.tenantId, incidentId);
        } catch {
          console.warn(
            JSON.stringify({
              level: 'warn',
              app: 'triage-worker',
              msg: 'evidence reload failed',
              event: 'evidence.reload_failed',
              tenantId: job.tenantId,
              incidentId,
            }),
          );
        }
        const screenshots = await this.evidenceService.interpretAttachments(
          job,
          current,
          ctx.signal,
        );
        const signals = await listIncidentSignals(deps.appDb, job.tenantId, incidentId);
        const responseSignals = await listResponseGroupSignals(
          deps.appDb,
          job.tenantId,
          incidentId,
        );
        const responseRootIncidentId = await resolveResponseRoot(
          deps.appDb,
          job.tenantId,
          incidentId,
        );
        const responseRoot =
          responseRootIncidentId === current.id
            ? current
            : await getIncident(deps.appDb, job.tenantId, responseRootIncidentId);
        const canVerifyRecovery =
          !!responseRoot &&
          (responseRoot.status === 'open' || responseRoot.status === 'mitigated') &&
          responseSignals.length > 0 &&
          responseSignals.every((signal) => signal.state === 'resolved');
        const maxChecks = canVerifyRecovery
          ? await this.disposition.recoveryMaxChecks(responseRoot!.recoveryMaxChecks ?? undefined)
          : 0;
        const recoveryAttempt = canVerifyRecovery
          ? Math.min((responseRoot!.recoveryAttempt ?? 0) + 1, maxChecks)
          : 0;
        const verificationStartedAt = canVerifyRecovery
          ? ((await recoveryVerificationStartedAt(
              deps.appDb,
              job.tenantId,
              responseRootIncidentId,
            )) ?? new Date())
          : null;
        const runtime = await this.runtime.tools(job.tenantId, current, { signal: ctx.signal });
        toolRuntime = runtime;
        executeRun = () =>
          this.disposition.runEngine(
            job.tenantId,
            current,
            runtime,
            () =>
              this.runtime.executeEngine(job, current.id, 'resume', ctx.signal, (engine) =>
                engine.resume(
                  {
                    incident: this.runtime.incidentInput(job.tenantId, current),
                    ...input,
                    evidence,
                    context:
                      [screenshots, runtime.platformIdentity].filter(Boolean).join('\n\n') ||
                      undefined,
                    ...(canVerifyRecovery
                      ? {
                          recoveryContext: {
                            attempt: recoveryAttempt,
                            maxChecks,
                            signalSummary: responseSignals
                              .map((signal) => signal.summary)
                              .join('\n'),
                          },
                        }
                      : {}),
                  },
                  runtime,
                ),
              ),
            {
              operation: 'resume',
              runId,
              resumeMessageId: newest.id,
              rcaFrozen: current.status === 'resolved' || current.status === 'closed',
              assessedMaterials: signals.flatMap((signal) =>
                signal.materialHash
                  ? [
                      {
                        signalId: signal.id,
                        signalVersion: signal.version,
                        materialHash: signal.materialHash,
                      },
                    ]
                  : [],
              ),
              ...(canVerifyRecovery
                ? {
                    recovery: {
                      responseRootIncidentId,
                      expectedLifecycleVersion: responseRoot!.lifecycleVersion,
                      expectedSignalFence: serializeSignalFence(responseSignals),
                      restoreInvestigationStatus: responseRoot!.investigationStatus,
                      verificationStartedAt: verificationStartedAt!,
                      attempt: recoveryAttempt,
                      maxChecks,
                      eventKey: `interactive-recovery:${newest.id}`,
                      transitionKey: `interactive-auto-resolve:${newest.id}`,
                      signals: responseSignals,
                      resumeMessageId: newest.id,
                    },
                  }
                : {}),
            },
          );
      } catch (error) {
        await this.disposition.failRun(
          job.tenantId,
          incidentId,
          runId,
          'Resume setup failed.',
          toolRuntime,
        );
        throw error;
      }
      await executeRun?.();
    });
  }
}
