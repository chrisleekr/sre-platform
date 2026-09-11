import { ThreadAlreadyBoundError } from '@sre/alerts';
import type { InboundCandidate } from '@sre/connectors';
import { RetryableError, type Job } from '@sre/queue';
import { ProviderUnavailableError } from '../engine/types';
import type { ClassifyAttachments } from './attachments';
import {
  CLASSIFY_FAIL_OPEN_ATTEMPTS,
  DEGRADED_SEVERITY,
  INBOUND_DEDUP_TTL_SEC,
  type ClassifyOutcome,
} from './contracts';
import { ClassifyCore, providerAlertTitle, serviceForChannel } from './core';
import type { ObservationHandler } from './observations';
import { persistDeterministicDisposition, persistEffectiveDisposition } from './semantic-routing';

/** Owns safety-first incident creation when ordinary classification cannot be trusted. */
export class DegradedSignalRouter {
  constructor(
    private readonly core: ClassifyCore,
    private readonly attachments: ClassifyAttachments,
    private readonly observations: ObservationHandler,
  ) {}

  /** Opens an investigation when an edited provider signal has no tracked predecessor. */
  async openUntrackedEdit(
    candidate: InboundCandidate,
    scrubbedCandidate: InboundCandidate,
    job: Job,
    fingerprint: string,
    scrubbedText: string,
  ): Promise<void> {
    const opened = await this.fenced(candidate, job, () =>
      this.core.openNewIncident(
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
        { signals: this.core.signalsFor(scrubbedCandidate) },
      ),
    );
    if (!opened) return;
    await persistDeterministicDisposition({
      core: this.core,
      candidate,
      scrubbedCandidate,
      job,
      scrubbedText,
      disposition: 'investigate',
      reason: 'An untracked provider edit failed open to an investigation.',
    });
  }

  /** Preserves a material signal as an investigation after bounded classifier failure. */
  async failOpen(
    error: unknown,
    candidate: InboundCandidate,
    scrubbedCandidate: InboundCandidate,
    job: Job,
    signal: AbortSignal,
    fingerprint: string,
    scrubbedText: string,
    mode: 'shadow' | 'enforce',
  ): Promise<void> {
    const tenantId = job.tenantId;
    if (signal.aborted) throw signal.reason;
    if (error instanceof ProviderUnavailableError && job.attempts < CLASSIFY_FAIL_OPEN_ATTEMPTS) {
      await this.core.emitOutcome({
        intakeId: candidate.intakeId,
        tenantId,
        channel: candidate.channel,
        messageId: candidate.externalId,
        author: candidate.author,
        outcome: 'retry',
        attempts: job.attempts,
        reason: 'provider_unavailable',
      });
      throw new RetryableError('classify provider unavailable');
    }
    await persistEffectiveDisposition({
      core: this.core,
      candidate,
      scrubbedCandidate,
      job,
      scrubbedText,
      disposition: 'investigate',
      mode,
      reason: 'Classifier failed open to investigation after its bounded retry policy.',
    });
    const outcome: ClassifyOutcome = {
      intakeId: candidate.intakeId,
      tenantId,
      channel: candidate.channel,
      messageId: candidate.externalId,
      author: candidate.author,
      outcome: 'fail_open',
      attempts: job.attempts,
      reason:
        error instanceof ProviderUnavailableError ? 'provider_unavailable' : 'classifier_error',
    };
    if (scrubbedCandidate.isEdit) {
      await this.observations.handleEditedSignal(scrubbedCandidate, job);
      await this.core.emitOutcome(outcome);
      return;
    }
    try {
      const routed = await this.core.routeOrRetry(
        {
          tenantId,
          source: 'slack',
          fingerprint,
          service: serviceForChannel(candidate.channel),
          severity: DEGRADED_SEVERITY,
          title: providerAlertTitle(scrubbedText, scrubbedCandidate.observations),
          investigationStatus: 'degraded',
          context: scrubbedCandidate.raw,
          opener: this.core.openerFor(candidate, scrubbedText),
          origin: {
            surface: 'slack',
            channel: candidate.channel,
            threadId: candidate.externalId,
          },
          dedupTtlSec: INBOUND_DEDUP_TTL_SEC,
          signals: this.core.signalsFor(scrubbedCandidate),
        },
        signal,
      );
      if (routed.reused && routed.incidentId)
        await this.attachments.foldIntoOwner(
          tenantId,
          scrubbedCandidate,
          scrubbedText,
        )(routed.incidentId);
    } catch (routeError) {
      if (signal.aborted) throw signal.reason;
      if (!(routeError instanceof ThreadAlreadyBoundError)) throw routeError;
      await this.attachments.foldIntoOwner(
        tenantId,
        scrubbedCandidate,
        scrubbedText,
      )(routeError.incidentId);
    }
    await this.core.emitOutcome(outcome);
  }

  private async fenced(
    candidate: InboundCandidate,
    job: Job,
    fn: () => Promise<unknown>,
  ): Promise<boolean> {
    const result = await this.core.withRoutingFence(job.tenantId, candidate, fn);
    if (result.status === 'executed') return true;
    await this.core.emitOutcome({
      intakeId: candidate.intakeId,
      tenantId: job.tenantId,
      channel: candidate.channel,
      messageId: candidate.externalId,
      author: candidate.author,
      outcome: 'superseded',
      attempts: job.attempts,
    });
    return false;
  }
}
