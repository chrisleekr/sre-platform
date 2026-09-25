import type { Db } from '@sre/db';
import type { Redis } from 'ioredis';
import { Queue, type QueueOptions } from './queue';

/**
 * Connector poll stream, shared by the API (StatusCake wakeup producer) and the triage worker
 * (consumer and reconcile driver). `jobs.stream` stores this name and `Queue.reconcile()` filters on
 * it, so a producer and consumer that disagree would orphan every wakeup. Both sides build the queue
 * here for that reason. Dead letters use the default dead stream.
 */
export const POLL_STREAM = 'sre:jobs:poll';
export const POLL_GROUP = 'poll';

/**
 * Builds the queue for connector poll and StatusCake wakeup jobs.
 *
 * @param db - Database containing durable poll jobs.
 * @param redis - Valkey connection carrying poll doorbells.
 * @param opts - Optional stuck-handler, deadline and fail-fast dispatch connection settings.
 */
export function makePollQueue(db: Db, redis: Redis, opts: QueueOptions = {}): Queue {
  return new Queue(db, redis, { stream: POLL_STREAM, group: POLL_GROUP, ...opts });
}
