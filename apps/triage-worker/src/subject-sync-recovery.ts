import { listMissingSubjectSyncCandidates, listTenants, type Db } from '@sre/db';
import type { Queue } from '@sre/queue';
import type { Redis } from 'ioredis';
import { makeRedisWindowGuard, runOncePerWindow } from './poller';

const SUBJECT_SYNC_RECOVERY_MS = 60_000;

interface SubjectSyncRecoveryDeps {
  listTenants(): Promise<Array<{ id: string }>>;
  listCandidates(tenantId: string): Promise<string[]>;
  enqueue(tenantId: string, incidentId: string): Promise<void>;
  onError(error: unknown, context: { tenantId?: string; incidentId?: string }): void;
}

/**
 * Recreates missing synchronization jobs without disturbing active loops.
 *
 * @param deps - Tenant discovery, candidate lookup, queue, and telemetry dependencies.
 */
export async function recoverMissingSubjectSyncJobs(
  deps: SubjectSyncRecoveryDeps,
): Promise<number> {
  let scheduled = 0;
  let tenants: Array<{ id: string }>;
  try {
    tenants = await deps.listTenants();
  } catch (error) {
    deps.onError(error, {});
    return 0;
  }
  for (const tenant of tenants) {
    let candidates: string[];
    try {
      candidates = await deps.listCandidates(tenant.id);
    } catch (error) {
      deps.onError(error, { tenantId: tenant.id });
      continue;
    }
    for (const incidentId of candidates) {
      try {
        await deps.enqueue(tenant.id, incidentId);
        scheduled++;
      } catch (error) {
        deps.onError(error, { tenantId: tenant.id, incidentId });
      }
    }
  }
  return scheduled;
}

/**
 * Builds the guarded production recovery sweep for missing subject synchronization jobs.
 *
 * @param redis - Shared guard connection.
 * @param adminDb - System database used to enumerate tenants.
 * @param appDb - RLS database used to inspect each tenant's subjects.
 * @param queue - Durable subject synchronization queue.
 */
export function makeSubjectSyncRecovery(
  redis: Redis,
  adminDb: Db,
  appDb: Db,
  queue: Pick<Queue, 'enqueue'>,
) {
  const guard = makeRedisWindowGuard(redis, 'subject-sync:recovery');
  return (now = Date.now()) =>
    runOncePerWindow(
      guard,
      async () => {
        const scheduled = await recoverMissingSubjectSyncJobs({
          listTenants: () => listTenants(adminDb),
          listCandidates: (tenantId) => listMissingSubjectSyncCandidates(appDb, tenantId),
          enqueue: async (tenantId, incidentId) => {
            await queue.enqueue({ tenantId, type: 'subject.sync', payload: { incidentId } });
          },
          onError: (error, context) =>
            console.error(
              JSON.stringify({
                level: 'error',
                app: 'triage-worker',
                event: 'subject.sync_recovery_failed',
                ...context,
                errorType: error instanceof Error ? error.name : 'UnknownError',
              }),
            ),
        });
        if (scheduled > 0) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              app: 'triage-worker',
              event: 'subject.sync_recovered',
              scheduled,
            }),
          );
        }
        return scheduled;
      },
      SUBJECT_SYNC_RECOVERY_MS,
      now,
    );
}
