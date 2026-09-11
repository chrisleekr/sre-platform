import type { InboundCandidate } from '@sre/connectors';
import {
  getPreviousSlackMonitorEpisodeTx,
  joinAlertCohortTx,
  listSignalsByExternalRoot,
  recordIncidentRelationTx,
} from '@sre/db';
import type { Job } from '@sre/queue';
import type { ClassifyAttachments } from './attachments';
import { DEGRADED_SEVERITY } from './contracts';
import { ClassifyCore, providerAlertTitle, serviceForChannel } from './core';

/** Routes provider-shaped Slack alerts by stable episode identity before general LLM classification. */
export class StructuredFiringRouter {
  constructor(
    private readonly core: ClassifyCore,
    private readonly attachments: ClassifyAttachments,
  ) {}

  /** Returns true when deterministic episode routing fully handled the candidate. */
  async handle(
    candidate: InboundCandidate,
    scrubbedCandidate: InboundCandidate,
    job: Job,
    fingerprint: string,
    scrubbedText: string,
  ): Promise<boolean> {
    if (
      candidate.author !== 'bot' ||
      candidate.alertKind !== 'firing' ||
      !candidate.producerId ||
      scrubbedCandidate.signalState !== 'firing' ||
      !scrubbedCandidate.observations?.length
    )
      return false;
    const signals = this.core.signalsFor(scrubbedCandidate);
    const monitorKeys = signals.flatMap((signal) => (signal.monitorKey ? [signal.monitorKey] : []));
    if (monitorKeys.length !== signals.length) return false;
    const routed = await this.core.withRoutingFence(job.tenantId, candidate, async () => {
      await this.openEpisode(
        candidate,
        candidate.producerId!,
        scrubbedCandidate,
        job,
        fingerprint,
        scrubbedText,
        signals,
      );
      await this.emitOutcome(candidate, job, 'provider_alert_opened');
    });
    if (routed.status === 'superseded') await this.emitOutcome(candidate, job, 'superseded');
    return true;
  }

  private async openEpisode(
    candidate: InboundCandidate,
    producerId: string,
    scrubbedCandidate: InboundCandidate,
    job: Job,
    fingerprint: string,
    scrubbedText: string,
    signals: ReturnType<ClassifyCore['signalsFor']>,
  ): Promise<void> {
    const sourceScopeKey = `slack:${candidate.channel}:producer:${producerId}`;
    await this.core.openNewIncident(
      job.tenantId,
      fingerprint,
      { channel: candidate.channel, threadId: candidate.externalId },
      {
        service: serviceForChannel(candidate.channel),
        severity: DEGRADED_SEVERITY,
        title: providerAlertTitle(scrubbedText, scrubbedCandidate.observations),
      },
      scrubbedCandidate.raw,
      scrubbedText,
      this.core.openerFor(candidate, scrubbedText),
      this.attachments.foldIntoOwner(job.tenantId, scrubbedCandidate, scrubbedText),
      {
        signals,
        onRoutedTx: async (tx, routed) => {
          const members = await listSignalsByExternalRoot(
            tx,
            job.tenantId,
            'slack',
            candidate.channel,
            candidate.externalId,
          );
          let cohortJobId: string | null = null;
          for (const signal of members) {
            const cohort = await joinAlertCohortTx(tx, job.tenantId, {
              sourceScopeKey,
              dataSourceId: null,
              signalId: signal.id,
              observedAt: signal.firstSeenAt,
              windowMs: 120_000,
            });
            if (!cohortJobId && cohort.state === 'collecting')
              cohortJobId = (
                await this.core.deps.queue.insertCohortAnalysisTx(
                  tx,
                  job.tenantId,
                  cohort.id,
                  new Date(cohort.windowEndsAt.getTime() + 2_000),
                )
              ).jobId;
            await this.recordRecurrence(candidate, producerId, job, routed.incidentId, signal, tx);
          }
          return cohortJobId ? [cohortJobId] : [];
        },
      },
    );
  }

  private async recordRecurrence(
    candidate: InboundCandidate,
    producerId: string,
    job: Job,
    incidentId: string,
    signal: Awaited<ReturnType<typeof listSignalsByExternalRoot>>[number],
    tx: Parameters<typeof getPreviousSlackMonitorEpisodeTx>[0],
  ): Promise<void> {
    if (!signal.monitorKey) return;
    const previous = await getPreviousSlackMonitorEpisodeTx(
      tx,
      candidate.channel,
      producerId,
      signal.monitorKey,
      signal.id,
    );
    if (!previous || previous.incidentId === incidentId) return;
    await recordIncidentRelationTx(tx, job.tenantId, {
      sourceIncidentId: incidentId,
      targetIncidentId: previous.incidentId,
      type: 'recurrence_of',
      rationale: 'A new Slack-delivered episode started for the same monitor scope.',
      evidence: [
        `monitor_key:${signal.monitorKey}`,
        `previous_signal:${previous.id}`,
        `current_signal:${signal.id}`,
      ],
      decidedBy: 'system',
    });
  }

  private emitOutcome(
    candidate: InboundCandidate,
    job: Job,
    outcome: 'belongs_to' | 'provider_alert_opened' | 'superseded',
  ): Promise<void> {
    return this.core.emitOutcome({
      intakeId: candidate.intakeId,
      tenantId: job.tenantId,
      channel: candidate.channel,
      messageId: candidate.externalId,
      author: candidate.author,
      outcome,
      attempts: job.attempts,
    });
  }
}
