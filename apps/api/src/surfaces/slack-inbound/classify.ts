import {
  SLACK_CLASSIFY_PENDING,
  slackClassifyReservationKey,
  writeSlackClassifyReservation,
  type InboundCandidate,
} from '@sre/connectors';
import type { Tx } from '@sre/db';
import type { SlackConfig, SlackInboundDeps, SlackProcessorOutcome } from './contracts';

type DurableClassify = Awaited<ReturnType<SlackInboundDeps['classifyQueue']['insertClassify']>>;

/**
 * Persists classify work on the transaction that owns stable-message admission.
 *
 * @param deps - Runtime persistence and queue dependencies.
 * @param tx - Existing system transaction holding the stable-message lock.
 * @param config - Tenant-scoped Slack configuration.
 * @param payload - Scrubbed candidate written to the durable classify job.
 */
export async function insertSlackClassifyTx(
  deps: SlackInboundDeps,
  tx: Tx,
  config: SlackConfig,
  payload: InboundCandidate,
): Promise<DurableClassify> {
  return deps.classifyQueue.insertClassifyTx(tx, {
    tenantId: config.tenantId,
    type: 'classify',
    payload,
  });
}

/**
 * Updates advisory ordering state and dispatches classify work after its transaction commits.
 *
 * @param deps - Runtime cache and queue dependencies.
 * @param configId - Slack surface configuration receiving the event.
 * @param config - Tenant-scoped Slack configuration.
 * @param candidate - Normalized provider event used for ordering and idempotency.
 * @param durable - Committed classify owner returned by the durable insert.
 * @param successOutcome - Surface receipt outcome for newly accepted or recovered work.
 */
export async function dispatchSlackClassify(
  deps: SlackInboundDeps,
  configId: string,
  config: SlackConfig,
  candidate: InboundCandidate,
  durable: DurableClassify,
  successOutcome: 'classify_enqueued' | 'edit_enqueued',
): Promise<SlackProcessorOutcome> {
  if (durable.inserted || durable.matchedBy === 'intake') {
    const key = slackClassifyReservationKey(
      config.tenantId,
      candidate.channel,
      candidate.externalId,
    );
    await writeSlackClassifyReservation(
      deps.reservationRedis,
      key,
      SLACK_CLASSIFY_PENDING,
      candidate.eventAt,
      candidate.eventVersion,
    ).catch((error) => deps.onError?.(error, { configId }));
  }

  await deps.classifyQueue
    .publishJob(durable.jobId)
    .catch((error) => deps.onError?.(error, { configId }));
  return durable.matchedBy === 'event' ? 'dropped_duplicate' : successOutcome;
}
