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
import { persistEffectiveDisposition } from './semantic-routing';

/** Owns safety-first incident creation when ordinary classification cannot be trusted. */
export class DegradedSignalRouter {
  constructor(
    private readonly core: ClassifyCore,
    private readonly attachments: ClassifyAttachments,
  ) {}

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
    try {
      const signals = this.core.signalsFor(scrubbedCandidate);
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
          signals,
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
}
