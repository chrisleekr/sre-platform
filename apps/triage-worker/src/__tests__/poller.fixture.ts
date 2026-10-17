// Pure-unit (no Postgres/Valkey): the poll handler resolves one connector, snapshots it, and caches
// the result; on failure it keeps the last-good snapshots (or a sanitized error marker) and does not
// rethrow (the cadence re-polls; a pollable connector is never dead-lettered). The scheduler enqueues
// one poll job per (tenant x enabled connector) and honours the per-window guard.
import type { IDataSourceConnector, NormalizedSnapshot } from '@sre/connectors';
import type { SnapshotCache } from '@sre/queue';

// Deploy timestamps are relative to now because listRecentDeployments filters on a now()-relative
// window in SQL; fixed calendar dates age out and the DB-backed poller tests fail on a later date.
function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const DAY_MINUTES = 24 * 60;

export function createFixture() {
  const CONNECTOR_IDS = {
    github: '00000000-0000-4000-8000-000000000001',
    gitlab: '00000000-0000-4000-8000-000000000002',
    other: '00000000-0000-4000-8000-000000000003',
    secondary: '00000000-0000-4000-8000-000000000004',
  } as const;

  function snap(tenantId: string, entityId: string): NormalizedSnapshot {
    return {
      tenantId,
      source: 'kubernetes',
      entityId,
      metrics: {},
      metadata: {},
      observedAt: new Date(),
    };
  }

  // A gitlab deploy snapshot as the poller sees it post-MR1: metadata carries the deploy fields plus the
  // canonical `service`. Mirrors makeGitLabConnector.snapshot()'s shape.
  function gitlabDeploySnap(tenantId: string, service: string, sha: string): NormalizedSnapshot {
    return {
      tenantId,
      source: 'gitlab',
      entityId: sha,
      metrics: {},
      metadata: {
        repo: '71',
        ref: 'main',
        sha,
        service,
        status: 'success',
        deployedAt: isoMinutesAgo(DAY_MINUTES),
      },
      observedAt: new Date(),
    };
  }

  function githubDeploySnap(tenantId: string, providerId: string): NormalizedSnapshot {
    return {
      tenantId,
      source: 'github',
      entityId: providerId,
      metrics: {},
      metadata: {
        providerId,
        repo: 'acme/checkout',
        ref: 'main',
        sha: `sha-${providerId}`,
        service: 'checkout',
        status: 'inactive',
        deployedAt: isoMinutesAgo(DAY_MINUTES - 1),
        providerCreatedAt: isoMinutesAgo(DAY_MINUTES),
        providerUpdatedAt: isoMinutesAgo(DAY_MINUTES - 1),
      },
      observedAt: new Date(),
    };
  }

  function fakeConnector(
    type: IDataSourceConnector['type'],
    snapshot: IDataSourceConnector['snapshot'],
    identity?: { id: string; name: string },
  ): IDataSourceConnector {
    return {
      id:
        identity?.id ??
        (type === 'github'
          ? CONNECTOR_IDS.github
          : type === 'gitlab'
            ? CONNECTOR_IDS.gitlab
            : CONNECTOR_IDS.other),
      name: identity?.name ?? `Test ${type}`,
      type,
      snapshot,
      fetchTriageContext: async () => ({ source: type, data: {} }),
      tools: () => [],
      probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
    };
  }

  function fakeCache(): {
    cache: SnapshotCache;
    sets: { tenantId: string; source: string; snapshots: NormalizedSnapshot[]; ttlSec: number }[];
  } {
    const sets: {
      tenantId: string;
      source: string;
      snapshots: NormalizedSnapshot[];
      ttlSec: number;
    }[] = [];
    const cache: SnapshotCache = {
      set: async (tenantId, source, snapshots, ttlSec) => {
        sets.push({ tenantId, source, snapshots, ttlSec });
      },
      get: async () => [],
    };
    return { cache, sets };
  }

  return {
    CONNECTOR_IDS,
    snap,
    gitlabDeploySnap,
    githubDeploySnap,
    fakeConnector,
    fakeCache,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
