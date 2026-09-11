import type { InboundCandidate } from '@sre/connectors';
import type { Job } from '@sre/queue';
import type { ClassifyCore } from './core';
import { persistDeterministicDisposition } from './semantic-routing';
import { scrubInboundCandidate } from './scrub-candidate';

/** Keeps terminal supersession checks and their durable log outcome consistent. */
export class SupersessionGuard {
  constructor(private readonly core: ClassifyCore) {}

  /**
   * Stops a stale event before model work while retaining its terminal disposition.
   * @param candidate - Stable inbound event.
   * @param job - Durable classify job.
   */
  async stop(candidate: InboundCandidate, job: Job): Promise<boolean> {
    if (!(await this.core.isSuperseded(job.tenantId, candidate))) return false;
    await this.retain(candidate, job);
    await this.emit(candidate, job);
    return true;
  }

  /**
   * Applies one side effect only while the adapter's stable-message fence still permits it.
   * @param candidate - Stable inbound event.
   * @param job - Durable classify job.
   * @param fn - Incident-writing operation guarded by the fence.
   */
  async fenced<T>(
    candidate: InboundCandidate,
    job: Job,
    fn: () => Promise<T>,
  ): Promise<{ executed: true; value: T } | { executed: false }> {
    const result = await this.core.withRoutingFence(job.tenantId, candidate, fn);
    if (result.status === 'superseded') {
      await this.retain(candidate, job);
      await this.emit(candidate, job);
      return { executed: false };
    }
    return { executed: true, value: result.value };
  }

  private async retain(candidate: InboundCandidate, job: Job): Promise<void> {
    const { scrubbedText, scrubbedCandidate } = scrubInboundCandidate(candidate);
    await persistDeterministicDisposition({
      core: this.core,
      candidate,
      scrubbedCandidate,
      job,
      scrubbedText,
      disposition: 'log',
      reason: 'A stale provider event was retained without changing current signal state.',
    });
  }

  private emit(candidate: InboundCandidate, job: Job): Promise<void> {
    return this.core.emitOutcome({
      intakeId: candidate.intakeId,
      tenantId: job.tenantId,
      channel: candidate.channel,
      messageId: candidate.externalId,
      author: candidate.author,
      outcome: 'superseded',
      attempts: job.attempts,
    });
  }
}
