import type { Db } from '@sre/db';
import type { Redis } from 'ioredis';
import { Queue, type QueueOptions } from './queue';

/**
 * Dedicated error-budget evaluation stream, isolated from triage (`sre:jobs`), classify
 * (`sre:classify`) and runbooks (`sre:runbook`) so a slow metrics backend cannot head-of-line-block
 * triage: each rides its own Valkey stream and consumer group, drained by an independent consumer.
 * Reconcile scoping comes free from construction, because `Queue.reconcile()` only re-dispatches rows
 * whose `jobs.stream` matches. No reconcile driver runs on this stream: evaluations are periodic and
 * self-healing, so a lost dispatch is covered by the next window's fan-out.
 */
export const SLO_STREAM = 'sre:jobs:slo';
export const SLO_GROUP = 'slo-workers';
export const SLO_DEAD_STREAM = 'sre:jobs:slo:dead';

/**
 * Builds the queue isolated for scheduled error-budget evaluation.
 *
 * @param db - Database containing durable evaluation jobs.
 * @param redis - Valkey connection carrying evaluation doorbells.
 * @param opts - Optional stream and fail-fast dispatch connection settings.
 */
export function makeSloQueue(db: Db, redis: Redis, opts: QueueOptions = {}): Queue {
  return new Queue(db, redis, {
    stream: SLO_STREAM,
    group: SLO_GROUP,
    deadStream: SLO_DEAD_STREAM,
    ...opts,
  });
}
