import { runStatusCakeSetup, type StatusCakeSetupDeps } from '@sre/agent-tools';
import type { SnapshotCache } from '@sre/queue';
import type { WindowGuard } from './poller';

// New uptime tests get their contact group within this window; each pass lists every test and
// contact group, so a shorter window spends StatusCake's 60 requests per minute free-plan budget.
const SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * Keeps each StatusCake connection's contact groups in line with its binding, at most once per
 * window per connection across replicas. Failures are logged and retried next window, never thrown
 * into the poll job.
 * @param deps - Setup dependencies plus a cross-replica window guard.
 * @param now - Clock, injectable for tests.
 */
export function makeStatusCakeSetupSync(
  deps: StatusCakeSetupDeps & { guardFor: (connectorId: string) => WindowGuard },
  now: () => number = Date.now,
) {
  return async (tenantId: string, connectorId: string): Promise<void> => {
    const windowId = Math.floor(now() / SYNC_INTERVAL_MS);
    if (!(await deps.guardFor(connectorId)(windowId, SYNC_INTERVAL_MS / 1000))) return;
    try {
      // Turning notifications off removes groups through the dashboard's setup call, so an idle
      // connection costs no StatusCake requests here.
      const run = await runStatusCakeSetup(deps, tenantId, connectorId, true, true);
      if (run.status === 'not_found' || run.status === 'off' || run.status === 'busy') return;
      const error = run.error;
      if (run.status === 'synced' && run.changes === 0 && !error) return;
      console.log(
        JSON.stringify({
          level: error ? 'warn' : 'info',
          app: 'triage-worker',
          msg: 'statuscake contact-group sync',
          tenantId,
          connectorId,
          changes: run.status === 'synced' ? run.changes : 0,
          ...(error ? { failureCategory: error.category } : {}),
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          app: 'triage-worker',
          msg: 'statuscake contact-group sync failed',
          tenantId,
          connectorId,
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  };
}

/**
 * Adapts the Valkey owned lease to the setup runner's lease port.
 * @param cache - Snapshot cache whose Valkey client holds the lease.
 */
export function statusCakeSetupLease(
  cache: Pick<SnapshotCache, 'acquireOwnedLease' | 'releaseOwnedLease'>,
): NonNullable<StatusCakeSetupDeps['lease']> {
  return {
    acquire: async (name, ttlSec) => (await cache.acquireOwnedLease?.(name, ttlSec)) ?? null,
    release: async (name, token) => {
      await cache.releaseOwnedLease?.(name, token);
    },
  };
}
