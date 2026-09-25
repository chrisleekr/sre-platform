import {
  getIncident,
  getInvestigationSubject,
  incidents,
  investigationSubjects,
  lockResponseGroupWorkTx,
  updateInvestigationSubjectTx,
  withTenant,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import { RetryableError, type Job } from '@sre/queue';
import { eq } from 'drizzle-orm';
import type { SubjectSyncObservation } from '../subject-sync';
import type { WorkerRuntime } from './runtime';
import {
  reconcileSubjectSignalProjectionTx,
  SUBJECT_SYNC_INTERVAL_MS,
} from './subject-signal-projection';

export class SubjectSyncHandler {
  constructor(private readonly runtime: WorkerRuntime) {}

  async handle(job: Job): Promise<void> {
    const { deps } = this.runtime;
    const incidentId = (job.payload as { incidentId?: unknown } | null)?.incidentId;
    if (typeof incidentId !== 'string') return;
    const [incident, subject] = await Promise.all([
      getIncident(deps.appDb, job.tenantId, incidentId),
      getInvestigationSubject(deps.appDb, job.tenantId, incidentId),
    ]);
    if (!incident || !subject) return;
    if (
      incident.archivedAt ||
      incident.status === 'resolved' ||
      incident.status === 'closed' ||
      !subject.syncEnabled
    )
      return;
    if (!deps.resolveInvestigationSubject)
      throw new RetryableError('subject synchronization is not configured');
    let current: SubjectSyncObservation;
    try {
      current = await deps.resolveInvestigationSubject(job.tenantId, subject);
    } catch {
      console.warn(
        JSON.stringify({
          level: 'warn',
          app: 'triage-worker',
          event: 'subject.sync_unavailable',
          tenantId: job.tenantId,
          incidentId,
          kind: subject.kind,
        }),
      );
      throw new RetryableError('subject observation unavailable');
    }
    let message: HubMessage | null = null;
    let workJobId: string | null = null;
    let syncJobId: string | null = null;
    let changed = false;
    let stopped = false;
    let repairedSignalCount = 0;
    let canonicalProjectionChanged = false;
    let staleBeyondInterval = false;
    let divergenceAgeMs = 0;
    await withTenant(deps.appDb, job.tenantId, async (tx) => {
      // Signal observation and job enqueue below take group work locks; they must precede the rows.
      await lockResponseGroupWorkTx(tx, job.tenantId, incidentId);
      const [lockedIncident] = await tx
        .select({
          status: incidents.status,
          archivedAt: incidents.archivedAt,
          lifecycleVersion: incidents.lifecycleVersion,
        })
        .from(incidents)
        .where(eq(incidents.id, incidentId))
        .limit(1)
        .for('update');
      const [lockedSubject] = await tx
        .select()
        .from(investigationSubjects)
        .where(eq(investigationSubjects.incidentId, incidentId))
        .limit(1)
        .for('update');
      if (
        !lockedIncident ||
        !lockedSubject ||
        lockedIncident.archivedAt ||
        lockedIncident.status === 'resolved' ||
        lockedIncident.status === 'closed' ||
        !lockedSubject.syncEnabled
      ) {
        stopped = true;
        return;
      }
      const updated = await updateInvestigationSubjectTx(tx, incidentId, current);
      changed = updated.changed;
      const projection = await reconcileSubjectSignalProjectionTx(
        tx,
        deps.hub,
        job.tenantId,
        incidentId,
        {
          subjectRowId: lockedSubject.id,
          fingerprint: lockedSubject.fingerprint,
          sourcePath: lockedSubject.sourcePath,
          previousState: lockedSubject.currentState,
          previousHash: lockedSubject.currentHash,
          lastSyncedAt: lockedSubject.lastSyncedAt,
          current,
        },
      );
      message = projection.message;
      repairedSignalCount = projection.repairedSignalCount;
      canonicalProjectionChanged = projection.canonicalObservationApplied;
      staleBeyondInterval = projection.staleBeyondInterval;
      divergenceAgeMs = projection.divergenceAgeMs;
      if (projection.canonicalObservationApplied || projection.repairedSignalCount > 0) {
        if (projection.allResolved) {
          workJobId = (
            await deps.queue.insertRecoveryTx(
              tx,
              job.tenantId,
              incidentId,
              lockedIncident.lifecycleVersion,
              projection.signalFence,
            )
          ).jobId;
        } else {
          if (projection.canonicalObservationApplied) {
            workJobId = (
              await deps.queue.insertReassessmentTx(
                tx,
                job.tenantId,
                incidentId,
                projection.canonicalSignalId,
                projection.canonicalSignalVersion,
                projection.investigationTriggerReason,
              )
            ).jobId;
          }
          for (const repaired of projection.repairedSignals) {
            const scheduled = await deps.queue.insertReassessmentTx(
              tx,
              job.tenantId,
              incidentId,
              repaired.id,
              repaired.version,
              'state_transition',
            );
            workJobId ??= scheduled.jobId;
          }
        }
      }
      syncJobId = (
        await deps.queue.insertSubjectSyncTx(
          tx,
          job.tenantId,
          incidentId,
          new Date(Date.now() + SUBJECT_SYNC_INTERVAL_MS),
        )
      ).jobId;
    });
    if (stopped) return;
    if (message) await deps.hub.publishAppended(message);
    if (workJobId) await deps.queue.publishJob(workJobId);
    if (syncJobId) await deps.queue.publishJob(syncJobId);
    if (staleBeyondInterval) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          app: 'triage-worker',
          event: 'subject.signal_projection_repaired',
          tenantId: job.tenantId,
          incidentId,
          kind: subject.kind,
          divergenceAgeMs,
          canonicalProjectionChanged,
          repairedSignalCount,
        }),
      );
    }
    console.info(
      JSON.stringify({
        level: 'info',
        app: 'triage-worker',
        event: 'subject.sync_completed',
        tenantId: job.tenantId,
        incidentId,
        kind: subject.kind,
        materialChanged: changed,
        canonicalProjectionChanged,
        repairedSignalCount,
        state: current.state,
        llmJobCreated: workJobId !== null,
      }),
    );
  }
}
