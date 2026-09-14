// Queue-driven connector poller. A scheduler fans out one poll job per (tenant x enabled
// connector) onto a SEPARATE Valkey stream; a consumer group runs the poll handler, which resolves
// the one named connector, snapshots it, and writes the result to the SnapshotCache. A poll failure
// keeps the last-good snapshots (or a sanitized error marker) and does NOT rethrow — the cadence
// re-polls, so a temporarily-broken connector is never dead-lettered. Ports are injected (guard,
// dispatcher, provider, listTenants) so the orchestration is pure-unit testable with no
// Postgres/Valkey; the redis/Queue adapters are wired in index.ts.

import type { Redis } from 'ioredis';
import type { Job } from '@sre/queue';
import type { SnapshotCache } from '@sre/queue';
import {
  type ConnectorPollEvidence,
  type IDataSourceConnector,
  type NormalizedSnapshot,
} from '@sre/connectors';

/** Resolves a tenant's enabled connectors (mirrors ToolContext['resolveConnectors']). */
export type ConnectorProvider = (tenantId: string) => () => Promise<IDataSourceConnector[]>;

/** Default poll cadence: one enqueue fan-out per window across all replicas. */
export const POLL_INTERVAL_MS = 30_000;

/** How long a cached snapshot set stays fresh. Sized above the poll interval so a skipped tick
 * (contended window, slow poll) does not blank the panels between successful polls. */
export const SNAPSHOT_TTL_SEC = 120;

export interface PollHandlerDeps {
  /** Separate administrative control plane, never exposed through the investigation connector. */
  reconcileGitLabHooks?: (tenantId: string, connectorId: string) => Promise<void>;
  connectorProvider: ConnectorProvider;
  cache: SnapshotCache;
  ttlSec: number;
  /** Persist polled deploy snapshots and fence the connector generation before cache publication. */
  persistDeploys?: (
    tenantId: string,
    snapshots: NormalizedSnapshot[],
    connectorType: string,
    evidence?: ConnectorPollEvidence,
    generation?: { id: string; lifecycleVersion: number },
  ) => Promise<boolean | void>;
  /** Safe operational telemetry. Raw connector errors are deliberately excluded from this shape. */
  onOutcome?: (outcome: PollOutcome) => void | Promise<void>;
}

export interface PollOutcome {
  tenantId: string;
  connectorId: string;
  connectorName: string;
  connectorType: string;
  status: 'success' | 'failure';
  snapshotCount: number;
  errorCount: number;
  keptLastGood: boolean;
  failureCategory?: 'provider' | 'persistence' | 'rate_limited' | 'backlog';
  durationMs?: number;
  rateLimitRemaining?: number;
  rateLimitResetAt?: string;
  generation?: { id: string; lifecycleVersion: number };
}

interface PollPayload {
  connectorId?: string;
  /** Rolling-upgrade compatibility for jobs queued before connector instances had IDs. */
  connectorType?: string;
}

async function emitOutcome(deps: PollHandlerDeps, outcome: PollOutcome): Promise<void> {
  try {
    await deps.onOutcome?.(outcome);
  } catch {
    // Telemetry must never change poll delivery or cache state.
  }
}

function countSnapshotErrors(snapshots: NormalizedSnapshot[]): number {
  return snapshots.filter(
    (snapshot) => typeof snapshot.metadata.error === 'string' && snapshot.metadata.error.length > 0,
  ).length;
}

/**
 * Handle one `poll` job: resolve the single connector named in the payload, snapshot it, and cache
 * the result under the job's tenant. On a snapshot failure it keeps the last-good snapshots (or a
 * sanitized error marker) and does not rethrow (the cadence re-polls; never dead-letter a pollable
 * connector). A vanished/disabled connector (removed since enqueue) is a no-op.
 */
export function makePollHandler(deps: PollHandlerDeps): (job: Job) => Promise<void> {
  return async (job: Job): Promise<void> => {
    if (job.type !== 'poll') return;
    const { connectorId, connectorType: legacyType } = (job.payload ?? {}) as PollPayload;
    if (!connectorId && !legacyType) return;

    const connectors = await deps.connectorProvider(job.tenantId)();
    const legacyMatches = legacyType
      ? connectors.filter((candidate) => candidate.type === legacyType)
      : [];
    const connector = connectorId
      ? connectors.find((candidate) => candidate.id === connectorId)
      : legacyMatches.length === 1
        ? legacyMatches[0]
        : undefined;
    if (!connector) return; // disabled/removed since enqueue
    if (connector.capabilities?.polling === 'none') return;
    const connectorType = connector.type;
    const cacheGeneration = connector.generation;

    try {
      if (connectorType === 'gitlab') await deps.reconcileGitLabHooks?.(job.tenantId, connector.id);
      const snapshots = await connector.snapshot();
      const evidence = connector.pollEvidence?.();
      try {
        const persisted = await deps.persistDeploys?.(
          job.tenantId,
          snapshots,
          connectorType,
          evidence,
          connector.generation,
        );
        if (persisted === false) return;
      } catch {
        await emitOutcome(deps, {
          tenantId: job.tenantId,
          connectorId: connector.id,
          connectorName: connector.name,
          connectorType,
          status: 'failure',
          snapshotCount: snapshots.length,
          errorCount: 1,
          keptLastGood: true,
          failureCategory: 'persistence',
          ...(evidence?.durationMs !== undefined ? { durationMs: evidence.durationMs } : {}),
          ...(evidence?.rateLimitRemaining !== undefined
            ? { rateLimitRemaining: evidence.rateLimitRemaining }
            : {}),
          ...(evidence?.rateLimitResetAt ? { rateLimitResetAt: evidence.rateLimitResetAt } : {}),
          ...(connector.generation ? { generation: connector.generation } : {}),
        });
        return;
      }
      // Persist cooldown/cursor evidence first, but never replace last-good data with a failed read.
      if (snapshots.length === 0 && (evidence?.errorCount ?? 0) > 0)
        throw new Error('poll returned no snapshots with failure evidence');
      await deps.cache.set(job.tenantId, connectorType, snapshots, deps.ttlSec, cacheGeneration);
      await emitOutcome(deps, {
        tenantId: job.tenantId,
        connectorId: connector.id,
        connectorName: connector.name,
        connectorType,
        status: 'success',
        snapshotCount: snapshots.length,
        errorCount: countSnapshotErrors(snapshots),
        keptLastGood: false,
        ...(evidence?.durationMs !== undefined ? { durationMs: evidence.durationMs } : {}),
        ...(evidence?.rateLimitRemaining !== undefined
          ? { rateLimitRemaining: evidence.rateLimitRemaining }
          : {}),
        ...(evidence?.rateLimitResetAt ? { rateLimitResetAt: evidence.rateLimitResetAt } : {}),
      });
    } catch {
      const evidence = connector.pollEvidence?.();
      // A poll failure must not blank the panel or dead-letter (which would stop re-polling a
      // connector that may recover — the next cadence re-polls regardless). Keep the last-good
      // snapshots (the dashboard marks them stale via observedAt); if there are none, surface a
      // SANITIZED error marker — never the raw error, which can carry a credential-bearing URL
      // (CWE-209). Do NOT rethrow.
      const last = await deps.cache.get(job.tenantId, connectorType, cacheGeneration);
      const value: NormalizedSnapshot[] =
        last.length > 0
          ? last
          : [
              {
                tenantId: job.tenantId,
                source: connectorType,
                entityId: connector.id,
                metrics: {},
                metadata: { error: 'poll failed', dataSource: connector.name },
                observedAt: new Date(),
              },
            ];
      await deps.cache.set(job.tenantId, connectorType, value, deps.ttlSec, cacheGeneration);
      await emitOutcome(deps, {
        tenantId: job.tenantId,
        connectorId: connector.id,
        connectorName: connector.name,
        connectorType,
        status: 'failure',
        snapshotCount: value.length,
        errorCount: Math.max(countSnapshotErrors(value), evidence?.errorCount ?? 0),
        keptLastGood: last.length > 0,
        failureCategory:
          evidence?.failureCategory === 'rate_limited' || evidence?.failureCategory === 'backlog'
            ? evidence.failureCategory
            : 'provider',
        ...(evidence?.durationMs !== undefined ? { durationMs: evidence.durationMs } : {}),
        ...(evidence?.rateLimitRemaining !== undefined
          ? { rateLimitRemaining: evidence.rateLimitRemaining }
          : {}),
        ...(evidence?.rateLimitResetAt ? { rateLimitResetAt: evidence.rateLimitResetAt } : {}),
        ...(connector.generation ? { generation: connector.generation } : {}),
      });
    }
  };
}

/** Acquire the per-window scheduling lock; resolves true iff this caller won the window. */
export type WindowGuard = (windowId: number, ttlSec: number) => Promise<boolean>;

/** Narrow queue port the scheduler needs: enqueue only. The real `Queue` satisfies it structurally. */
export interface PollDispatcher {
  enqueue(input: { tenantId: string; type: string; payload: unknown }): Promise<string>;
}

/**
 * Redis-backed window guard using the SET NX + EX idiom (mirrors the alert-router dedup): only the
 * first replica to write `<keyPrefix>:<windowId>` within a window wins and enqueues. Each scheduler
 * passes a distinct `keyPrefix` so independent cadences never contend on one lock.
 */
export function makeRedisWindowGuard(redis: Redis, keyPrefix = 'poll:sched'): WindowGuard {
  return async (windowId, ttlSec) => {
    const won = await redis.set(`${keyPrefix}:${windowId}`, '1', 'EX', ttlSec, 'NX');
    return won !== null;
  };
}

/**
 * Run an action at most once per `intervalMs` window across replicas: the window guard (SET NX)
 * admits one caller per time bucket. `nowMs` is injected so the cadence is deterministic under test.
 * Returns true iff the action ran this call.
 */
export async function runOncePerWindow(
  guard: WindowGuard,
  action: () => Promise<number>,
  intervalMs: number,
  nowMs: number,
): Promise<boolean> {
  const windowId = Math.floor(nowMs / intervalMs);
  if (!(await guard(windowId, Math.max(1, Math.ceil(intervalMs / 1000))))) return false;
  await action();
  return true;
}

export interface PollSchedulerDeps {
  /** Discovery uses the same durable scheduling path, with its own cadence and window lock. */
  jobType?: 'poll' | 'topology.discover';
  guard: WindowGuard;
  dispatch: PollDispatcher;
  connectorProvider: ConnectorProvider;
  listTenants: () => Promise<{ id: string }[]>;
  intervalMs?: number;
  /** Window-lock TTL; defaults to the interval so it self-clears before the next window. */
  windowTtlSec?: number;
}

/**
 * Enqueues poll jobs on a cadence, guarded so exactly one replica fans out per window. Mirrors
 * MetricSubscriber.start/stop: idempotent start, error-swallowing tick. Each won window enumerates
 * tenants x enabled connectors and enqueues a poll job for each. No reconcile: poll jobs are periodic
 * and self-healing — a lost dispatch is covered by the next window's enqueue, so only the one-shot
 * triage queue needs a reconcile driver.
 */
export class PollScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PollSchedulerDeps) {}

  /** True while the interval is active. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** One scheduling pass. Returns the number of poll jobs enqueued (0 if the window was contended). */
  async tick(): Promise<number> {
    const intervalMs = this.deps.intervalMs ?? POLL_INTERVAL_MS;
    const ttlSec = this.deps.windowTtlSec ?? Math.max(1, Math.ceil(intervalMs / 1000));
    // Date.now is fine in app code; the window is a coarse, monotonically-increasing bucket.
    const windowId = Math.floor(Date.now() / intervalMs);
    if (!(await this.deps.guard(windowId, ttlSec))) return 0;

    let enqueued = 0;
    const tenants = await this.deps.listTenants();
    for (const { id: tenantId } of tenants) {
      const connectors = await this.deps.connectorProvider(tenantId)();
      for (const connector of connectors) {
        if (
          this.deps.jobType === 'topology.discover'
            ? !connector.topology
            : connector.capabilities?.polling === 'none'
        )
          continue;
        await this.deps.dispatch.enqueue({
          tenantId,
          type: this.deps.jobType ?? 'poll',
          payload: { connectorId: connector.id },
        });
        enqueued++;
      }
    }
    return enqueued;
  }

  /** Begin scheduling. Idempotent: a second call while running is a no-op. */
  start(intervalMs: number = POLL_INTERVAL_MS): void {
    if (this.timer !== null) return;
    // A failed pass must not crash the interval; the next tick retries.
    this.timer = setInterval(() => void this.tick().catch(() => {}), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
