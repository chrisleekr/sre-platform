import {
  SLACK_CLASSIFY_TERMINAL,
  slackClassifyReservationKey,
  type ClassifyCandidate,
  writeSlackClassifyReservation,
} from '@sre/connectors';
import type { Job, JobContext } from '@sre/queue';
import { ClassifyAttachments } from './classify-consumer/attachments';
import type { ClassifyHandlerDeps } from './classify-consumer/contracts';
import { ClassifyCore } from './classify-consumer/core';
import { MentionHandler } from './classify-consumer/mention';
import { PushHandler } from './classify-consumer/push';

export type {
  BreadcrumbPoster,
  ClassifyHandlerDeps,
  ClassifyOutcome,
  PermalinkResolver,
} from './classify-consumer/contracts';

/**
 * Build the Slack classification consumer and its correlation collaborators.
 *
 * @param deps - Runtime, persistence, queue, and surface dependencies.
 */
export function makeClassifyHandler(
  deps: ClassifyHandlerDeps,
): (job: Job, ctx?: JobContext) => Promise<void> {
  const core = new ClassifyCore(deps);
  const attachments = new ClassifyAttachments(core);
  const mentions = new MentionHandler(core, attachments);
  const push = new PushHandler(core, attachments);
  return async (
    job: Job,
    ctx: JobContext = { signal: new AbortController().signal },
  ): Promise<void> => {
    if (job.type !== 'classify') return;
    const candidate = job.payload as ClassifyCandidate;
    if (candidate.kind === 'mention') {
      await mentions.handle(candidate, job, ctx.signal);
      return;
    }
    await push.handle(candidate, job, ctx.signal);
    try {
      await writeSlackClassifyReservation(
        deps.reservationRedis ?? deps.redis,
        slackClassifyReservationKey(job.tenantId, candidate.channel, candidate.externalId),
        SLACK_CLASSIFY_TERMINAL,
        candidate.eventAt,
        candidate.eventVersion,
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          app: 'triage-worker',
          event: 'classify.reservation_update_failed',
          tenantId: job.tenantId,
          channel: candidate.channel,
          externalMessageId: candidate.externalId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
  };
}
