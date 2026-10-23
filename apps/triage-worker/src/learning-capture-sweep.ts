import { listLearningCaptureCandidates, listTenants, type Db } from '@sre/db';
import type { Queue } from '@sre/queue';
import type { Redis } from 'ioredis';
import { makeRedisWindowGuard, runOncePerWindow } from './poller';
import { recoverMissingSubjectSyncJobs as enqueueForEachTenant } from './subject-sync-recovery';

const LEARNING_CAPTURE_SWEEP_MS = 5 * 60_000;

/**
 * Builds the guarded sweep that queues one automatic knowledge pass per recently resolved or closed
 * incident. The pass itself decides whether anything is worth saving.
 *
 * @param redis - Shared guard connection.
 * @param adminDb - System database used to enumerate tenants.
 * @param appDb - RLS database used to find each tenant's candidates.
 * @param queue - Runbook-generation queue.
 */
export function makeLearningCaptureSweep(
  redis: Redis,
  adminDb: Db,
  appDb: Db,
  queue: Pick<Queue, 'enqueue'>,
) {
  const guard = makeRedisWindowGuard(redis, 'learning:capture');
  return (now = Date.now()) =>
    runOncePerWindow(
      guard,
      () =>
        enqueueForEachTenant({
          listTenants: () => listTenants(adminDb),
          listCandidates: (tenantId) => listLearningCaptureCandidates(appDb, tenantId),
          enqueue: async (tenantId, incidentId) => {
            await queue.enqueue({
              tenantId,
              type: 'runbook.generate',
              payload: { incidentId, automatic: true },
            });
          },
          onError: (error, context) =>
            console.error(
              JSON.stringify({
                level: 'error',
                app: 'triage-worker',
                event: 'knowledge.capture_sweep_failed',
                ...context,
                errorType: error instanceof Error ? error.name : 'UnknownError',
              }),
            ),
        }),
      LEARNING_CAPTURE_SWEEP_MS,
      now,
    );
}
