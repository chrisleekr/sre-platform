import type { Db } from '@sre/db';
import type { Redis } from 'ioredis';
import { Queue, type QueueOptions } from './queue';

/**
 * Dedicated runbook-generation stream, isolated from triage (`sre:jobs`) and classify
 * (`sre:classify`) so a runbook backlog cannot head-of-line-block triage: each rides its own Valkey
 * stream + consumer group, drained by an independent consumer. Reconcile scoping comes free
 * from construction — `Queue.reconcile()` only re-dispatches rows whose `jobs.stream` matches, so a
 * runbook reconcile never scoops a stuck triage/classify row and vice versa.
 */
export const RUNBOOK_STREAM = 'sre:runbook';
export const RUNBOOK_GROUP = 'runbook-workers';
export const RUNBOOK_DEAD_STREAM = 'sre:runbook:dead';

/**
 * Builds the queue isolated for runbook generation work.
 *
 * @param db - Database containing durable runbook jobs.
 * @param redis - Valkey connection carrying runbook doorbells.
 * @param opts - Optional stream and fail-fast dispatch connection settings.
 */
export function makeRunbookQueue(db: Db, redis: Redis, opts: QueueOptions = {}): Queue {
  return new Queue(db, redis, {
    stream: RUNBOOK_STREAM,
    group: RUNBOOK_GROUP,
    deadStream: RUNBOOK_DEAD_STREAM,
    ...opts,
  });
}
