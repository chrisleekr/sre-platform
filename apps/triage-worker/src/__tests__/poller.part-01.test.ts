// Pure-unit (no Postgres/Valkey): the poll handler resolves one connector, snapshots it, and caches
// the result; on failure it keeps the last-good snapshots (or a sanitized error marker) and does not
// rethrow (the cadence re-polls; a pollable connector is never dead-lettered). The scheduler enqueues
// one poll job per (tenant x enabled connector) and honours the per-window guard.
import { describe, expect, test, vi } from 'vitest';

import type { IDataSourceConnector, NormalizedSnapshot } from '@sre/connectors';

import type { SnapshotCache } from '@sre/queue';

import { PollScheduler, makePollHandler, runOncePerWindow } from '../poller';

import type { PollDispatcher, WindowGuard } from '../poller';

import { serviceRepositoriesFromSnapshots } from '../persist-deploys';

import { createFixture } from './poller.fixture';

const __fixture = createFixture();

test('extracts GitHub and GitLab service relationships from Argo CD application sources', () => {
  expect(
    serviceRepositoriesFromSnapshots([
      {
        tenantId: 't1',
        source: 'argocd',
        entityId: 'application:argocd/checkout',
        metrics: {},
        metadata: {
          applicationName: 'checkout',
          sources: [
            { repoURL: 'https://github.com/acme/checkout.git', path: 'deploy/checkout' },
            { repoURL: 'github.com:acme/platform-config.git', path: 'apps/checkout' },
            { repoURL: 'https://gitlab.example.com/acme/ignored.git' },
          ],
        },
        observedAt: new Date(),
      },
    ]),
  ).toEqual([
    {
      service: 'checkout',
      provider: 'github',
      repositoryFullName: 'acme/checkout',
      path: 'deploy/checkout',
      source: 'argocd',
      confirmed: false,
    },
    {
      service: 'checkout',
      provider: 'github',
      repositoryFullName: 'acme/platform-config',
      path: 'apps/checkout',
      source: 'argocd',
      confirmed: false,
    },
    {
      service: 'checkout',
      provider: 'gitlab',
      repositoryFullName: 'acme/ignored',
      path: undefined,
      source: 'argocd',
      confirmed: false,
    },
  ]);
});

describe('makePollHandler', () => {
  test('resolves the one connector named by the job, snapshots it, and caches under the tenant', async () => {
    const snaps = [__fixture.snap('t1', 'pod-a')];
    const k8s = __fixture.fakeConnector('kubernetes', async () => snaps);
    const provider = () => async () => [k8s];
    const { cache, sets } = __fixture.fakeCache();
    const handler = makePollHandler({ connectorProvider: provider, cache, ttlSec: 90 });

    await handler({
      id: 'j1',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'kubernetes' },
      attempts: 1,
    });

    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ tenantId: 't1', source: 'kubernetes', ttlSec: 90 });
    expect(sets[0]!.snapshots).toBe(snaps);
  });

  test('polls the exact instance and rejects an ambiguous legacy type job', async () => {
    const primarySnapshot = vi.fn(async () => [__fixture.snap('t1', 'primary')]);
    const secondarySnapshots = [__fixture.snap('t1', 'secondary')];
    const secondarySnapshot = vi.fn(async () => secondarySnapshots);
    const connectors = [
      __fixture.fakeConnector('kubernetes', primarySnapshot, {
        id: __fixture.CONNECTOR_IDS.other,
        name: 'Primary cluster',
      }),
      __fixture.fakeConnector('kubernetes', secondarySnapshot, {
        id: __fixture.CONNECTOR_IDS.secondary,
        name: 'Secondary cluster',
      }),
    ];
    const { cache, sets } = __fixture.fakeCache();
    const handler = makePollHandler({
      connectorProvider: () => async () => connectors,
      cache,
      ttlSec: 90,
    });

    await handler({
      id: 'exact',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorId: __fixture.CONNECTOR_IDS.secondary },
      attempts: 1,
    });
    await handler({
      id: 'ambiguous-legacy',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'kubernetes' },
      attempts: 1,
    });

    expect(primarySnapshot).not.toHaveBeenCalled();
    expect(secondarySnapshot).toHaveBeenCalledTimes(1);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.snapshots).toBe(secondarySnapshots);
  });

  test('reports a safe successful outcome, including an empty snapshot count', async () => {
    const onOutcome = vi.fn();
    const provider = () => async () => [__fixture.fakeConnector('kubernetes', async () => [])];
    const { cache } = __fixture.fakeCache();
    const handler = makePollHandler({
      connectorProvider: provider,
      cache,
      ttlSec: 90,
      onOutcome,
    });

    await handler({
      id: 'j1',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'kubernetes' },
      attempts: 1,
    });

    expect(onOutcome).toHaveBeenCalledWith({
      tenantId: 't1',
      connectorId: __fixture.CONNECTOR_IDS.other,
      connectorName: 'Test kubernetes',
      connectorType: 'kubernetes',
      status: 'success',
      snapshotCount: 0,
      errorCount: 0,
      keptLastGood: false,
    });
  });

  test('ignores a stale poll job for an on-demand-only connector', async () => {
    const snapshot = vi.fn(async () => []);
    const connector: IDataSourceConnector = {
      ...__fixture.fakeConnector('prometheus', snapshot),
      capabilities: {
        alertLifecycle: 'none',
        availability: 'ready',
        configuration: 'tenant',
        instances: 'multiple',
        investigation: 'tools',
        polling: 'none',
        events: 'none',
      },
    };
    const { cache, sets } = __fixture.fakeCache();
    const handler = makePollHandler({
      connectorProvider: () => async () => [connector],
      cache,
      ttlSec: 90,
    });

    await handler({
      id: 'j-on-demand',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'prometheus' },
      attempts: 1,
    });

    expect(snapshot).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
  });

  test('a non-poll job is ignored', async () => {
    const { cache, sets } = __fixture.fakeCache();
    const provider = () => async () => [__fixture.fakeConnector('kubernetes', async () => [])];
    const handler = makePollHandler({ connectorProvider: provider, cache, ttlSec: 90 });

    await handler({ id: 'j', tenantId: 't1', type: 'triage', payload: {}, attempts: 1 });
    expect(sets).toHaveLength(0);
  });

  test('a snapshot failure with no cached data caches a sanitized error marker and does not rethrow', async () => {
    const k8s = __fixture.fakeConnector('kubernetes', async () => {
      throw new Error('cluster unreachable at https://10.0.0.1:6443');
    });
    const provider = () => async () => [k8s];
    const { cache, sets } = __fixture.fakeCache(); // get() returns [] — no last-good
    const onOutcome = vi.fn();
    const handler = makePollHandler({
      connectorProvider: provider,
      cache,
      ttlSec: 90,
      onOutcome,
    });

    // No rethrow: dead-lettering would stop re-polling a connector that may recover; the cadence retries.
    await expect(
      handler({
        id: 'j',
        tenantId: 't1',
        type: 'poll',
        payload: { connectorType: 'kubernetes' },
        attempts: 1,
      }),
    ).resolves.toBeUndefined();

    expect(sets).toHaveLength(1);
    const cached = sets[0]!.snapshots;
    expect(cached[0]!.metadata.error).toBe('poll failed');
    // The raw error (with its credential-bearing URL) never reaches the cache/dashboard.
    expect(JSON.stringify(cached)).not.toContain('10.0.0.1');
    expect(onOutcome).toHaveBeenCalledWith({
      tenantId: 't1',
      connectorId: __fixture.CONNECTOR_IDS.other,
      connectorName: 'Test kubernetes',
      connectorType: 'kubernetes',
      status: 'failure',
      snapshotCount: 1,
      errorCount: 1,
      keptLastGood: false,
      failureCategory: 'provider',
    });
    expect(JSON.stringify(onOutcome.mock.calls)).not.toContain('10.0.0.1');
  });

  test('a snapshot failure keeps the last-good snapshots (marked stale) when the cache has them', async () => {
    const k8s = __fixture.fakeConnector('kubernetes', async () => {
      throw new Error('transient');
    });
    const provider = () => async () => [k8s];
    const lastGood = [__fixture.snap('t1', 'pod-a')];
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
      get: async () => lastGood,
    };
    const onOutcome = vi.fn();
    const handler = makePollHandler({
      connectorProvider: provider,
      cache,
      ttlSec: 90,
      onOutcome,
    });

    await handler({
      id: 'j',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'kubernetes' },
      attempts: 1,
    });

    expect(sets).toHaveLength(1);
    expect(sets[0]!.snapshots).toBe(lastGood); // refreshed, not overwritten with an error
    expect(onOutcome).toHaveBeenCalledWith({
      tenantId: 't1',
      connectorId: __fixture.CONNECTOR_IDS.other,
      connectorName: 'Test kubernetes',
      connectorType: 'kubernetes',
      status: 'failure',
      snapshotCount: 1,
      errorCount: 0,
      keptLastGood: true,
      failureCategory: 'provider',
    });
  });
});

describe('PollScheduler', () => {
  function dispatcher(): {
    dispatch: PollDispatcher;
    enqueues: { tenantId: string; type: string; payload: unknown }[];
  } {
    const enqueues: { tenantId: string; type: string; payload: unknown }[] = [];
    const dispatch: PollDispatcher = {
      enqueue: async (input) => {
        enqueues.push(input);
        return `id-${enqueues.length}`;
      },
    };
    return { dispatch, enqueues };
  }

  test('enqueues one poll job per tenant and enabled connector', async () => {
    const { dispatch, enqueues } = dispatcher();
    const byTenant: Record<string, IDataSourceConnector[]> = {
      tA: [
        __fixture.fakeConnector('kubernetes', async () => []),
        __fixture.fakeConnector('gitlab', async () => []),
      ],
      tB: [__fixture.fakeConnector('kubernetes', async () => [])],
    };
    const provider = (tenantId: string) => async () => byTenant[tenantId] ?? [];
    const guard: WindowGuard = async () => true;
    const scheduler = new PollScheduler({
      guard,
      dispatch,
      connectorProvider: provider,
      listTenants: async () => [{ id: 'tA' }, { id: 'tB' }],
    });

    const enqueued = await scheduler.tick();

    expect(enqueued).toBe(3);
    expect(enqueues).toEqual([
      { tenantId: 'tA', type: 'poll', payload: { connectorId: __fixture.CONNECTOR_IDS.other } },
      { tenantId: 'tA', type: 'poll', payload: { connectorId: __fixture.CONNECTOR_IDS.gitlab } },
      { tenantId: 'tB', type: 'poll', payload: { connectorId: __fixture.CONNECTOR_IDS.other } },
    ]);
  });

  test('enqueues every same-type instance by immutable connector id', async () => {
    const { dispatch, enqueues } = dispatcher();
    const scheduler = new PollScheduler({
      guard: async () => true,
      dispatch,
      connectorProvider: () => async () => [
        __fixture.fakeConnector('kubernetes', async () => [], {
          id: __fixture.CONNECTOR_IDS.other,
          name: 'Primary cluster',
        }),
        __fixture.fakeConnector('kubernetes', async () => [], {
          id: __fixture.CONNECTOR_IDS.secondary,
          name: 'Secondary cluster',
        }),
      ],
      listTenants: async () => [{ id: 'tA' }],
    });

    expect(await scheduler.tick()).toBe(2);
    expect(enqueues).toEqual([
      { tenantId: 'tA', type: 'poll', payload: { connectorId: __fixture.CONNECTOR_IDS.other } },
      { tenantId: 'tA', type: 'poll', payload: { connectorId: __fixture.CONNECTOR_IDS.secondary } },
    ]);
  });

  test('does not enqueue on-demand-only connectors', async () => {
    const { dispatch, enqueues } = dispatcher();
    const prometheus: IDataSourceConnector = {
      ...__fixture.fakeConnector('prometheus', async () => []),
      capabilities: {
        alertLifecycle: 'none',
        availability: 'ready',
        configuration: 'tenant',
        instances: 'multiple',
        investigation: 'tools',
        polling: 'none',
        events: 'none',
      },
    };
    const scheduler = new PollScheduler({
      guard: async () => true,
      dispatch,
      connectorProvider: () => async () => [
        __fixture.fakeConnector('kubernetes', async () => []),
        prometheus,
      ],
      listTenants: async () => [{ id: 'tA' }],
    });

    expect(await scheduler.tick()).toBe(1);
    expect(enqueues).toEqual([
      { tenantId: 'tA', type: 'poll', payload: { connectorId: __fixture.CONNECTOR_IDS.other } },
    ]);
  });

  test('the window guard blocks a second enqueue pass in the same window', async () => {
    const { dispatch, enqueues } = dispatcher();
    const provider = () => async () => [__fixture.fakeConnector('kubernetes', async () => [])];
    // Mirrors redis SET NX: the window is granted once, then denied.
    let granted = false;
    const guard: WindowGuard = async () => {
      if (granted) return false;
      granted = true;
      return true;
    };
    const scheduler = new PollScheduler({
      guard,
      dispatch,
      connectorProvider: provider,
      listTenants: async () => [{ id: 'tA' }],
    });

    expect(await scheduler.tick()).toBe(1);
    expect(await scheduler.tick()).toBe(0); // guard denies the second pass
    expect(enqueues).toHaveLength(1);
  });
});

describe('runOncePerWindow', () => {
  test('runs the action on a won window and reports that it ran', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return 0;
    };
    const guard: WindowGuard = async () => true;
    expect(await runOncePerWindow(guard, run, 60_000, 1_800_000)).toBe(true);
    expect(calls).toBe(1);
  });

  test('skips the action on a contended window', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return 0;
    };
    const guard: WindowGuard = async () => false;
    expect(await runOncePerWindow(guard, run, 60_000, 1_800_000)).toBe(false);
    expect(calls).toBe(0);
  });

  test('derives the window id from nowMs / intervalMs and passes a self-clearing ttl', async () => {
    const seen: { windowId: number; ttlSec: number }[] = [];
    const guard: WindowGuard = async (windowId, ttlSec) => {
      seen.push({ windowId, ttlSec });
      return true;
    };
    // 1_830_000 / 60_000 = 30.5 -> floor 30; ttl = ceil(60_000/1000) = 60.
    await runOncePerWindow(guard, async () => 0, 60_000, 1_830_000);
    expect(seen).toEqual([{ windowId: 30, ttlSec: 60 }]);
  });
});
