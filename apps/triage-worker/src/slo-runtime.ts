// Composition of the error-budget subsystem: its own queue, its evaluation handler, and its
// scheduler. It lives beside the worker entrypoint rather than inside it so the entrypoint stays a
// list of subsystems, and it is separate from `slo-scheduler.ts` so that module keeps its injected
// ports and unit-tests with no Postgres or Valkey.
//
// Nothing here can open an incident: the handler is given a burn-event sink and a metrics reader and
// no other write port.

import type { Redis } from 'ioredis';
import type { IDataSourceConnector } from '@sre/connectors';
import {
  BURN_EVENT_WINDOW_DAYS,
  getSlo,
  listEnabledSlos,
  listTenants,
  pruneBurnEvents,
  recordBurnEvent,
  recordEvalOutcome,
  type DbHandle,
} from '@sre/db';
import { scrubSecrets } from '@sre/contracts';
import { makeSloQueue, type Queue, type QueueOptions } from '@sre/queue';
import type { JobHandler } from '@sre/queue';
import { makeRedisWindowGuard } from './poller';
import { makeConnectorSliReaderFactory, makeSloEvalHandler, SloScheduler } from './slo-scheduler';

/**
 * Rows one retention sweep removes per tenant. The sweep runs daily and steady-state accumulation is
 * one row per objective per five-minute window, so a tenant at the objective ceiling produces about
 * 28,800 rows a day. This clears well over a day's worth per pass, so it keeps up and still drains a
 * backlog, while bounding both the lock set and the ids the delete returns to count them.
 */
const BURN_EVENT_PRUNE_BATCH = 50_000;

export interface SloRuntime {
  queue: Queue;
  handler: JobHandler;
  scheduler: SloScheduler;
}

/**
 * Builds the error-budget queue, handler and scheduler the worker loop drives.
 *
 * @param deps - Database handles, Valkey clients and the tenant connector resolver to wire together.
 */
export function makeSloRuntime(deps: {
  adminDb: DbHandle;
  appDb: DbHandle;
  redis: Redis;
  settingsRedis: Redis;
  connectorProvider: (tenantId: string) => () => Promise<IDataSourceConnector[]>;
  onStuck?: NonNullable<QueueOptions['onStuck']>;
}): SloRuntime {
  // Its own stream and consumer group, so a slow metrics backend cannot head-of-line-block triage.
  // Jobs live in Postgres (adminDb) like the others.
  const queue = makeSloQueue(deps.adminDb.db, deps.redis, {
    dispatchRedis: deps.settingsRedis,
    onStuck: deps.onStuck,
  });

  const handler = makeSloEvalHandler({
    resolveSlo: async (tenantId, sloId) => {
      const slo = await getSlo(deps.appDb.db, tenantId, sloId);
      return slo && slo.enabled ? slo : null;
    },
    persist: (tenantId, event) => recordBurnEvent(deps.appDb.db, tenantId, event),
    // The message comes from the tenant's own backend and is shown back to that tenant, but it can
    // quote the request that produced it, so it is scrubbed before it is stored. Truncation is the
    // repository's job.
    recordOutcome: (tenantId, sloId, error) =>
      recordEvalOutcome(
        deps.appDb.db,
        tenantId,
        sloId,
        error === null ? null : scrubSecrets(error),
      ),
    // A fresh reader per evaluation, not one shared reader: connector resolution decrypts every
    // credential the tenant stores, so its memo must die with the evaluation that needed it.
    readerFor: makeConnectorSliReaderFactory((tenantId) => deps.connectorProvider(tenantId)()),
    onError: (err, ctx) =>
      console.error(
        JSON.stringify({
          level: 'error',
          app: 'triage-worker',
          msg: 'slo evaluation skipped',
          tenantId: ctx.tenantId,
          sloId: ctx.sloId,
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
  });

  // The scheduler fans out one job per (tenant x enabled objective) per window; the handler evaluates
  // one objective and persists one burn event. Its own window-guard prefix keeps it from contending
  // with the poll cadence.
  const scheduler = new SloScheduler({
    guard: makeRedisWindowGuard(deps.redis, 'slo:sched'),
    dispatch: queue,
    listTenants: () => listTenants(deps.adminDb.db),
    listEnabledSlos: (tenantId) => listEnabledSlos(deps.appDb.db, tenantId),
    // Bounded per call so a first sweep over a long-neglected table cannot hold a long transaction.
    // Steady state is one row per objective per window, well inside one batch.
    pruneBurnEvents: (tenantId) =>
      pruneBurnEvents(deps.appDb.db, tenantId, BURN_EVENT_WINDOW_DAYS, BURN_EVENT_PRUNE_BATCH),
  });

  return { queue, handler, scheduler };
}
