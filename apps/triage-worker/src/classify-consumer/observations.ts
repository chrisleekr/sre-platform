import type { InboundCandidate, InboundObservation } from '@sre/connectors';
import type { InvestigationTriggerReason } from '@sre/contracts';
import {
  getIncidentLifecycleTx,
  getSignalByExternal,
  prepareResponseGroupRecoveryTx,
  withTenant,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import { RetryableError, type Job } from '@sre/queue';
import type { AuthorizedResolutionCandidate, SignalGroupTarget } from './contracts';
import type { ClassifyCore } from './core';

export class ObservationHandler {
  constructor(private readonly core: ClassifyCore) {}

  async applyResolvedSignal(
    candidate: InboundCandidate,
    job: Job,
    target: AuthorizedResolutionCandidate,
    observation?: InboundObservation,
  ): Promise<void> {
    const { deps } = this.core;
    const { hub } = deps;
    if (!hub) throw new RetryableError('resolution correlation is not configured');
    let message: HubMessage | null = null;
    let recoveryJobId: string | null = null;
    const summary = observation?.summary ?? candidate.text;
    const contentHash = observation?.contentHash ?? candidate.contentHash;
    const eventKey = observation?.eventKey ?? candidate.eventKey;
    const eventAt = observation?.eventAt ?? candidate.eventAt;
    const eventVersion = observation?.eventVersion ?? candidate.eventVersion;
    const observed = await withTenant(deps.appDb, job.tenantId, async (tx) => {
      const result = await hub.observeSignalTx(
        tx,
        job.tenantId,
        {
          incidentId: target.incidentId,
          surface: 'slack',
          channel: target.channel,
          externalMessageId: target.externalMessageId,
          state: 'resolved',
          summary,
          contentHash,
          eventKey,
          eventAt: new Date(eventAt),
          eventVersion,
          provider: observation?.provider,
          providerGroupKey: observation?.providerGroupKey,
          monitorKey: observation?.monitorKey,
          alertName: observation?.alertName,
          materialHash: observation?.materialHash,
        },
        summary,
      );
      message = result.message;
      if (!result.observation.applied || !result.observation.allResolved) return result.observation;
      const recovery = await prepareResponseGroupRecoveryTx(tx, job.tenantId, target.incidentId);
      if (!recovery) return result.observation;
      recoveryJobId = (
        await deps.queue.insertRecoveryTx(
          tx,
          job.tenantId,
          recovery.rootIncidentId,
          recovery.lifecycleVersion,
          recovery.signalFence,
        )
      ).jobId;
      return result.observation;
    });
    if (message) await this.core.publishAppended(message);
    if (recoveryJobId) await this.core.publishJob(recoveryJobId);
    await this.core.emitOutcome({
      intakeId: candidate.intakeId,
      tenantId: job.tenantId,
      channel: candidate.channel,
      messageId: candidate.externalId,
      author: candidate.author,
      outcome: observed.applied
        ? 'resolved_signal'
        : message
          ? 'resolution_duplicate'
          : 'resolution_stale',
      attempts: job.attempts,
    });
  }

  async applyObservationGroup(
    candidate: InboundCandidate,
    job: Job,
    targets: SignalGroupTarget[],
    observations: InboundObservation[],
    mode: 'resolution' | 'edit',
  ): Promise<void> {
    const { deps } = this.core;
    const { hub } = deps;
    if (!hub) throw new RetryableError('resolution correlation is not configured');
    const messages: HubMessage[] = [];
    const jobIds = new Set<string>();
    let anyApplied = false;
    await withTenant(deps.appDb, job.tenantId, async (tx) => {
      const incidentState = new Map<string, { applied: boolean; allResolved: boolean }>();
      const appliedSignals: {
        incidentId: string;
        signalId: string;
        version: number;
        investigationTriggerReason: InvestigationTriggerReason;
      }[] = [];
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index]!;
        const observation = observations[index]!;
        const result = await hub.observeSignalTx(
          tx,
          job.tenantId,
          {
            incidentId: target.incidentId,
            surface: 'slack',
            channel: target.channel,
            externalMessageId: target.externalMessageId,
            state: observation.state,
            summary: observation.summary,
            contentHash: observation.contentHash,
            eventKey: observation.eventKey,
            eventAt: new Date(observation.eventAt),
            eventVersion: observation.eventVersion,
            provider: observation.provider,
            providerGroupKey: observation.providerGroupKey,
            monitorKey: observation.monitorKey,
            alertName: observation.alertName,
            materialHash: observation.materialHash,
          },
          observation.summary,
        );
        if (result.message) messages.push(result.message);
        anyApplied ||= result.observation.applied;
        const state = incidentState.get(target.incidentId) ?? {
          applied: false,
          allResolved: false,
        };
        state.applied ||= result.observation.applied;
        state.allResolved = result.observation.allResolved;
        incidentState.set(target.incidentId, state);
        if (result.observation.applied) {
          appliedSignals.push({
            incidentId: target.incidentId,
            signalId: result.observation.signal.id,
            version: result.observation.signal.version,
            investigationTriggerReason: result.observation.investigationTriggerReason,
          });
        }
      }
      for (const [incidentId, state] of incidentState) {
        if (!state.applied) continue;
        const lifecycle = await getIncidentLifecycleTx(tx, incidentId);
        if (!lifecycle) throw new Error('signal incident disappeared');
        if (state.allResolved) {
          const recovery = await prepareResponseGroupRecoveryTx(tx, job.tenantId, incidentId);
          if (!recovery) continue;
          const { jobId } = await deps.queue.insertRecoveryTx(
            tx,
            job.tenantId,
            recovery.rootIncidentId,
            recovery.lifecycleVersion,
            recovery.signalFence,
          );
          if (jobId) jobIds.add(jobId);
        } else if (mode === 'edit') {
          for (const signal of appliedSignals.filter((item) => item.incidentId === incidentId)) {
            const { jobId } = await deps.queue.insertReassessmentTx(
              tx,
              job.tenantId,
              incidentId,
              signal.signalId,
              signal.version,
              signal.investigationTriggerReason,
            );
            if (jobId) jobIds.add(jobId);
          }
        }
      }
    });
    for (const current of messages) await this.core.publishAppended(current);
    for (const jobId of jobIds) await this.core.publishJob(jobId);
    await this.core.emitOutcome({
      intakeId: candidate.intakeId,
      tenantId: job.tenantId,
      channel: candidate.channel,
      messageId: candidate.externalId,
      author: candidate.author,
      outcome:
        mode === 'edit'
          ? 'edited_signal'
          : anyApplied
            ? 'resolved_signal'
            : messages.length > 0
              ? 'resolution_duplicate'
              : 'resolution_stale',
      attempts: job.attempts,
    });
  }

  async handleEditedSignal(candidate: InboundCandidate, job: Job): Promise<boolean> {
    const { deps } = this.core;
    const { hub } = deps;
    if (!hub) throw new RetryableError('edited signal processing is not configured');
    const signal = await getSignalByExternal(
      deps.appDb,
      job.tenantId,
      'slack',
      candidate.channel,
      candidate.externalId,
    );
    if (!signal) {
      if (await this.core.hasPendingPredecessor(job.tenantId, candidate))
        throw new RetryableError('edited signal is not tracked yet');
      await this.core.emitOutcome({
        intakeId: candidate.intakeId,
        tenantId: job.tenantId,
        channel: candidate.channel,
        messageId: candidate.externalId,
        author: candidate.author,
        outcome: 'edited_untracked',
        attempts: job.attempts,
      });
      return false;
    }
    let message: HubMessage | null = null;
    let jobId: string | null = null;
    await withTenant(deps.appDb, job.tenantId, async (tx) => {
      const result = await hub.observeSignalTx(
        tx,
        job.tenantId,
        { incidentId: signal.incidentId, ...this.core.signalFor(candidate) },
        candidate.text,
      );
      message = result.message;
      if (!result.observation.applied) return result.observation;
      const lifecycle = await getIncidentLifecycleTx(tx, signal.incidentId);
      if (!lifecycle) throw new Error('edited signal incident disappeared');
      if (result.observation.allResolved) {
        const recovery = await prepareResponseGroupRecoveryTx(tx, job.tenantId, signal.incidentId);
        if (!recovery) return result.observation;
        jobId = (
          await deps.queue.insertRecoveryTx(
            tx,
            job.tenantId,
            recovery.rootIncidentId,
            recovery.lifecycleVersion,
            recovery.signalFence,
          )
        ).jobId;
      } else {
        jobId = (
          await deps.queue.insertReassessmentTx(
            tx,
            job.tenantId,
            signal.incidentId,
            result.observation.signal.id,
            result.observation.signal.version,
            result.observation.investigationTriggerReason,
          )
        ).jobId;
      }
      return result.observation;
    });
    if (message) await this.core.publishAppended(message);
    if (jobId) await this.core.publishJob(jobId);
    await this.core.emitOutcome({
      intakeId: candidate.intakeId,
      tenantId: job.tenantId,
      channel: candidate.channel,
      messageId: candidate.externalId,
      author: candidate.author,
      outcome: 'edited_signal',
      attempts: job.attempts,
    });
    return true;
  }
}
