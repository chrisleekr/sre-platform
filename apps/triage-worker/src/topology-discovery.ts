import type { Job } from '@sre/queue';
import type {
  TopologyCollection,
  TopologyDiscovery,
  TopologyScanProgress,
  TopologyRuntimeScope,
} from '@sre/contracts';
import type { ConnectorProvider } from './poller';
import { makeRedisWindowGuard, PollScheduler, type PollDispatcher } from './poller';
import {
  persistTopologyDiscovery,
  recordTopologyDiscoveryFailure,
  readTopologyScans,
  listTopologyDiscovery,
  runtimeScopesFromInventory,
  type Db,
} from '@sre/db';
import type { Redis } from 'ioredis';
import { topologyReadIssue } from '@sre/connectors';

/** Discover independently of snapshot polling; failures never erase the last-good topology.
 * @param deps - Tenant connector resolver and generation-fenced persistence ports.
 */
export function makeTopologyDiscoveryHandler(deps: {
  connectorProvider: ConnectorProvider;
  runtimeScopes?: (tenantId: string) => Promise<TopologyRuntimeScope[]>;
  cooldown?: {
    active: (tenantId: string, connectorId: string) => Promise<boolean>;
    defer: (tenantId: string, connectorId: string, delayMs: number) => Promise<void>;
  };
  continueScan?: (
    tenantId: string,
    connectorId: string,
    pageCount: number,
    collections: string[],
  ) => Promise<void>;
  scans?: (
    tenantId: string,
    generation: { id: string; lifecycleVersion: number },
  ) => Promise<Record<string, TopologyScanProgress>>;
  persist: (
    tenantId: string,
    generation: { id: string; lifecycleVersion: number },
    result: TopologyDiscovery,
  ) => Promise<boolean>;
  failed: (
    tenantId: string,
    generation: { id: string; lifecycleVersion: number },
    at: Date,
    issue?: TopologyCollection['issue'],
  ) => Promise<void>;
}) {
  return async (job: Job) => {
    if (job.type !== 'topology.discover') return;
    const id = (job.payload as { connectorId?: string } | null)?.connectorId;
    if (!id) return;
    const connector = (await deps.connectorProvider(job.tenantId)()).find((c) => c.id === id);
    if (!connector?.topology || !connector.generation) return;
    if (await deps.cooldown?.active(job.tenantId, id)) return;
    const attemptedAt = new Date();
    const requested = (job.payload as { collections?: unknown }).collections;
    if (
      requested !== undefined &&
      (!Array.isArray(requested) ||
        requested.length > 32 ||
        !requested.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 256))
    )
      return;
    const collections = requested as string[] | undefined;
    const scans = await deps.scans?.(job.tenantId, connector.generation);
    let result: TopologyDiscovery;
    try {
      result = await connector.topology.discover({
        scans,
        ...(deps.runtimeScopes ? { runtimeScopes: await deps.runtimeScopes(job.tenantId) } : {}),
        ...(collections ? { collections } : {}),
      });
    } catch (error) {
      const failure = error as { status?: unknown; failureCategory?: unknown } | null;
      const issue =
        topologyReadIssue(error) ??
        (failure?.status === 401 ||
        failure?.status === 403 ||
        failure?.failureCategory === 'permission_denied'
          ? 'permission_denied'
          : failure?.status === 429 || failure?.failureCategory === 'rate_limited'
            ? 'rate_limited'
            : failure?.status === 400 || failure?.status === 422
              ? 'request_rejected'
              : failure?.failureCategory === 'backlog'
                ? 'limit'
                : 'unreachable');
      await deps.failed(job.tenantId, connector.generation, attemptedAt, issue);
      return;
    }
    // Persistence failures remain queue failures, never mislabeled provider outages.
    const saved = await deps.persist(job.tenantId, connector.generation, {
      ...result,
      observedAt: attemptedAt.toISOString(),
    });
    if (saved && result.collections.some((collection) => collection.issue === 'rate_limited')) {
      const delays = result.collections
        .filter((collection) => collection.issue === 'rate_limited')
        .map((collection) =>
          Number.isFinite(collection.retryAfterMs)
            ? Math.max(300_000, Math.min(collection.retryAfterMs!, 86_400_000))
            : 300_000,
        );
      await deps.cooldown?.defer(job.tenantId, id, Math.max(...delays));
    }
    const pageCount = (job.payload as { pageCount?: unknown }).pageCount ?? 0;
    const nextCollections = result.collections
      .filter(
        (collection) =>
          collection.scan?.cursor &&
          collection.completeness !== 'unavailable' &&
          (!collection.issue || collection.issue === 'limit' || collection.issue === 'sampling') &&
          collection.scan.cursor !== scans?.[collection.key]?.cursor,
      )
      .map((collection) => collection.key);
    if (
      saved &&
      nextCollections.length > 0 &&
      Number.isSafeInteger(pageCount) &&
      Number(pageCount) >= 0 &&
      Number(pageCount) < 20 &&
      !result.collections.some((collection) => collection.issue === 'rate_limited')
    )
      await deps.continueScan?.(job.tenantId, id, Number(pageCount) + 1, nextCollections);
  };
}

/** Wire discovery onto the existing durable polling queue with an independent five-minute cadence.
 * @param deps - Tenant database, connector resolver and scheduler infrastructure.
 */
export function makeTopologyDiscoveryRuntime(deps: {
  db: Db;
  redis: Redis;
  dispatch: PollDispatcher;
  connectorProvider: ConnectorProvider;
  listTenants: () => Promise<{ id: string }[]>;
}) {
  return {
    handler: makeTopologyDiscoveryHandler({
      connectorProvider: deps.connectorProvider,
      cooldown: {
        active: async (tenantId, id) =>
          (await deps.redis.exists(`topology:cooldown:${tenantId}:${id}`)) === 1,
        defer: async (tenantId, id, delay) => {
          await deps.redis.set(`topology:cooldown:${tenantId}:${id}`, '1', 'PX', delay);
        },
      },
      runtimeScopes: async (tenantId) =>
        runtimeScopesFromInventory(await listTopologyDiscovery(deps.db, tenantId)),
      continueScan: async (tenantId, connectorId, pageCount, collections) => {
        await deps.dispatch.enqueue({
          tenantId,
          type: 'topology.discover',
          payload: { connectorId, pageCount, collections },
        });
      },
      scans: (tenantId, generation) => readTopologyScans(deps.db, tenantId, generation),
      persist: (tenantId, generation, result) =>
        persistTopologyDiscovery(deps.db, tenantId, generation, result),
      failed: (tenantId, generation, at, issue) =>
        recordTopologyDiscoveryFailure(deps.db, tenantId, generation, at, issue),
    }),
    scheduler: new PollScheduler({
      jobType: 'topology.discover',
      intervalMs: 300_000,
      guard: makeRedisWindowGuard(deps.redis, 'topology:sched'),
      dispatch: deps.dispatch,
      connectorProvider: deps.connectorProvider,
      listTenants: deps.listTenants,
    }),
  };
}
