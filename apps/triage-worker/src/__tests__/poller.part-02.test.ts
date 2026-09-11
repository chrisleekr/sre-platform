// Pure-unit (no Postgres/Valkey): the poll handler resolves one connector, snapshots it, and caches
// the result; on failure it keeps the last-good snapshots (or a sanitized error marker) and does not
// rethrow (the cadence re-polls; a pollable connector is never dead-lettered). The scheduler enqueues
// one poll job per (tenant x enabled connector) and honours the per-window guard.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { NormalizedSnapshot } from '@sre/connectors';

import {
  connectorConfigs,
  githubRepositories,
  listRecentDeployments,
  makeDb,
  resolveGitHubRepositories,
  serviceRepositories,
  syncGitHubRepositories,
  tenants,
  withTenant,
  type DbHandle,
} from '@sre/db';

import { makePollHandler } from '../poller';

import { persistDeploys } from '../persist-deploys';

import { createFixture } from './poller.fixture';

const __fixture = createFixture();

// --- MR1: persist polled deploys -----------------------------------------------------------
describe('makePollHandler deploy persistence (MR1)', () => {
  test('forwards the polled snapshots to the injected persistDeploys', async () => {
    const snaps = [__fixture.gitlabDeploySnap('t1', 'checkout', 'sha-1')];
    const gitlab = __fixture.fakeConnector('gitlab', async () => snaps);
    const provider = () => async () => [gitlab];
    const { cache } = __fixture.fakeCache();

    const persistCalls: { tenantId: string; snapshots: NormalizedSnapshot[] }[] = [];
    const persistDeploys = async (tenantId: string, snapshots: NormalizedSnapshot[]) => {
      persistCalls.push({ tenantId, snapshots });
    };
    const handler = makePollHandler({
      connectorProvider: provider,
      cache,
      ttlSec: 90,
      persistDeploys,
    });

    await handler({
      id: 'j1',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'gitlab' },
      attempts: 1,
    });

    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]).toMatchObject({ tenantId: 't1' });
    expect(persistCalls[0]!.snapshots).toBe(snaps);
  });

  test('forwards GitHub cursor and bounded provider evidence to persistence and telemetry', async () => {
    const snapshots = [__fixture.githubDeploySnap('t1', '91')];
    const evidence = {
      cursor: { recentHeadProviderId: '91', activeProviderIds: [] },
      durationMs: 42,
      rateLimitRemaining: 4900,
      rateLimitResetAt: '2026-08-22T10:00:00.000Z',
    };
    const github = {
      ...__fixture.fakeConnector('github', async () => snapshots),
      pollEvidence: () => evidence,
    };
    const persistDeploys = vi.fn(async () => {});
    const onOutcome = vi.fn();
    const { cache } = __fixture.fakeCache();
    const handler = makePollHandler({
      connectorProvider: () => async () => [github],
      cache,
      ttlSec: 90,
      persistDeploys,
      onOutcome,
    });

    await handler({
      id: 'j1',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'github' },
      attempts: 1,
    });

    expect(persistDeploys).toHaveBeenCalledWith('t1', snapshots, 'github', evidence, undefined);
    expect(onOutcome).toHaveBeenCalledWith({
      tenantId: 't1',
      connectorId: __fixture.CONNECTOR_IDS.github,
      connectorName: 'Test github',
      connectorType: 'github',
      status: 'success',
      snapshotCount: 1,
      errorCount: 0,
      keptLastGood: false,
      durationMs: 42,
      rateLimitRemaining: 4900,
      rateLimitResetAt: '2026-08-22T10:00:00.000Z',
    });
  });

  test('does not cache a poll whose connector generation became stale before persistence', async () => {
    const snapshots = [__fixture.githubDeploySnap('t1', 'stale')];
    const connector = {
      ...__fixture.fakeConnector('github', async () => snapshots),
      generation: { id: randomUUID(), lifecycleVersion: 2 },
    };
    const persistDeploys = vi.fn(async () => false);
    const { cache, sets } = __fixture.fakeCache();
    const handler = makePollHandler({
      connectorProvider: () => async () => [connector],
      cache,
      ttlSec: 90,
      persistDeploys,
    });

    await handler({
      id: 'stale-job',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'github' },
      attempts: 1,
    });

    expect(persistDeploys).toHaveBeenCalledWith(
      't1',
      snapshots,
      'github',
      undefined,
      connector.generation,
    );
    expect(sets).toEqual([]);
  });

  test('preserves a provider backlog category and evidence after a failed GitHub poll', async () => {
    const github = {
      ...__fixture.fakeConnector('github', async () => {
        throw new Error('sensitive provider detail');
      }),
      pollEvidence: () => ({
        failureCategory: 'backlog' as const,
        durationMs: 30,
        rateLimitRemaining: 10,
      }),
    };
    const onOutcome = vi.fn();
    const { cache } = __fixture.fakeCache();
    const handler = makePollHandler({
      connectorProvider: () => async () => [github],
      cache,
      ttlSec: 90,
      onOutcome,
    });

    await handler({
      id: 'j1',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'github' },
      attempts: 1,
    });
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorType: 'github',
        status: 'failure',
        failureCategory: 'backlog',
        durationMs: 30,
        rateLimitRemaining: 10,
      }),
    );
    expect(JSON.stringify(onOutcome.mock.calls)).not.toContain('sensitive provider detail');
  });

  test('a persistence failure does not publish unfenced cache data and reports a sanitized outcome', async () => {
    const snaps = [__fixture.gitlabDeploySnap('t1', 'checkout', 'sha-1')];
    const gitlab = __fixture.fakeConnector('gitlab', async () => snaps);
    const provider = () => async () => [gitlab];
    const { cache, sets } = __fixture.fakeCache();
    const onOutcome = vi.fn();

    const handler = makePollHandler({
      connectorProvider: provider,
      cache,
      ttlSec: 90,
      persistDeploys: async () => {
        throw new Error('pg down');
      },
      onOutcome,
    });

    await handler({
      id: 'j1',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'gitlab' },
      attempts: 1,
    });

    expect(sets).toEqual([]);
    expect(onOutcome).toHaveBeenCalledWith({
      tenantId: 't1',
      connectorId: __fixture.CONNECTOR_IDS.gitlab,
      connectorName: 'Test gitlab',
      connectorType: 'gitlab',
      status: 'failure',
      snapshotCount: 1,
      errorCount: 1,
      keptLastGood: true,
      failureCategory: 'persistence',
    });
    expect(JSON.stringify(onOutcome.mock.calls)).not.toContain('pg down');
  });
});

// persistDeploys end-to-end against Postgres: a polled deploy snapshot lands in `deployments` and is
// readable back through the RLS-scoped repo.
describe('persistDeploys (DB-backed)', () => {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  let admin: DbHandle;
  let app: DbHandle;
  let tenantId: string;

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'DEPLOY-PERSIST' });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.execute(sql`delete from deployments where tenant_id = ${tenantId}`);
      await admin.db.delete(serviceRepositories).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(githubRepositories).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
      await admin.close();
    }
    if (app) await app.close();
  });

  test('persists a polled deploy snapshot, readable via listRecentDeployments', async () => {
    const service = `checkout-${randomUUID().slice(0, 8)}`;
    const sha = `sha-${randomUUID()}`;
    await persistDeploys(app.db, tenantId, [__fixture.gitlabDeploySnap(tenantId, service, sha)]);

    const rows = await listRecentDeployments(app.db, tenantId, { service });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sha).toBe(sha);
    expect(rows[0]!.service).toBe(service);
  });

  test('counts Kubernetes snapshots without deployment rows and scopes the count to one connector', async () => {
    const [current, other] = await withTenant(app.db, tenantId, (tx) =>
      tx
        .insert(connectorConfigs)
        .values([
          { tenantId, type: 'kubernetes', name: 'Primary cluster', pollSnapshotCount: 9 },
          { tenantId, type: 'kubernetes', name: 'Other cluster', pollSnapshotCount: 17 },
        ])
        .returning(),
    );
    const snapshots: NormalizedSnapshot[] = ['pod/monitoring/reader', 'node/worker'].map(
      (entityId) => ({
        tenantId,
        source: 'kubernetes',
        entityId,
        metrics: {},
        metadata: {},
        observedAt: new Date(),
      }),
    );
    const readCount = (id: string) =>
      withTenant(app.db, tenantId, (tx) =>
        tx
          .select({ count: connectorConfigs.pollSnapshotCount })
          .from(connectorConfigs)
          .where(sql`${connectorConfigs.id} = ${id}`),
      );
    expect(
      await persistDeploys(app.db, tenantId, snapshots, 'kubernetes', undefined, current!),
    ).toBe(true);
    expect(await readCount(current!.id)).toEqual([{ count: 2 }]);
    expect(await readCount(other!.id)).toEqual([{ count: 17 }]);
    expect(
      (await listRecentDeployments(app.db, tenantId, {})).filter(
        (row) => row.source === 'kubernetes',
      ),
    ).toEqual([]);

    await persistDeploys(app.db, tenantId, [], 'kubernetes', undefined, current!);
    expect(await readCount(current!.id)).toEqual([{ count: 0 }]);
    expect(await readCount(other!.id)).toEqual([{ count: 17 }]);
  });

  test('learns service-to-repository mappings from Argo CD without one-connector-per-repo setup', async () => {
    const githubSourceId = '00000000-0000-4000-8000-000000000001';
    await syncGitHubRepositories(app.db, tenantId, githubSourceId, '7001', [
      {
        installationId: '7001',
        repositoryId: '202',
        owner: 'acme',
        name: 'checkout',
        fullName: 'acme/checkout',
        defaultBranch: 'main',
        private: true,
        archived: false,
        htmlUrl: 'https://github.com/acme/checkout',
      },
    ]);
    const snapshot: NormalizedSnapshot = {
      tenantId,
      source: 'argocd',
      entityId: 'application:argocd/checkout',
      metrics: {},
      metadata: {
        kind: 'application',
        applicationName: 'checkout',
        sources: [{ repoURL: 'https://github.com/acme/checkout.git', path: 'deploy' }],
      },
      observedAt: new Date(),
    };

    await persistDeploys(app.db, tenantId, [snapshot], 'argocd');

    expect(
      await resolveGitHubRepositories(app.db, tenantId, githubSourceId, 'checkout'),
    ).toMatchObject([{ fullName: 'acme/checkout', source: 'mapping', confirmed: false }]);
  });

  test('rejects deployment, repository mapping, and health writes from a stale connector generation', async () => {
    const service = `stale-${randomUUID().slice(0, 8)}`;
    const sha = `sha-${randomUUID()}`;
    const repository = `acme/${service}`;
    const relationship: NormalizedSnapshot = {
      tenantId,
      source: 'argocd',
      entityId: `application:argocd/${service}`,
      metrics: {},
      metadata: {
        kind: 'application',
        applicationName: service,
        sources: [{ repoURL: `https://github.com/${repository}.git`, path: 'deploy' }],
      },
      observedAt: new Date(),
    };
    const [config] = await admin.db
      .insert(connectorConfigs)
      .values({ tenantId, type: 'argocd', settings: {}, enabled: true })
      .returning({ id: connectorConfigs.id, lifecycleVersion: connectorConfigs.lifecycleVersion });
    try {
      const applied = await persistDeploys(
        app.db,
        tenantId,
        [__fixture.gitlabDeploySnap(tenantId, service, sha), relationship],
        'argocd',
        undefined,
        { id: config!.id, lifecycleVersion: config!.lifecycleVersion + 1 },
      );
      expect(applied).toBe(false);
      expect(await listRecentDeployments(app.db, tenantId, { service })).toEqual([]);
      expect(
        await admin.db
          .select({ repositoryFullName: serviceRepositories.repositoryFullName })
          .from(serviceRepositories)
          .where(sql`tenant_id = ${tenantId} and service = ${service}`),
      ).toEqual([]);

      const current = await persistDeploys(
        app.db,
        tenantId,
        [__fixture.gitlabDeploySnap(tenantId, service, sha), relationship],
        'argocd',
        undefined,
        config!,
      );
      expect(current).toBe(true);
      expect(await listRecentDeployments(app.db, tenantId, { service })).toHaveLength(1);
      expect(
        await withTenant(app.db, tenantId, (tx) =>
          tx
            .select({ count: connectorConfigs.pollSnapshotCount })
            .from(connectorConfigs)
            .where(sql`${connectorConfigs.id} = ${config!.id}`),
        ),
      ).toEqual([{ count: 2 }]);
      expect(
        await admin.db
          .select({ repositoryFullName: serviceRepositories.repositoryFullName })
          .from(serviceRepositories)
          .where(sql`tenant_id = ${tenantId} and service = ${service}`),
      ).toEqual([{ repositoryFullName: repository }]);
    } finally {
      await admin.db
        .delete(connectorConfigs)
        .where(sql`tenant_id = ${tenantId} and type = 'argocd'`);
    }
  });

  test('is idempotent: re-polling the same (source, sha) upserts one row', async () => {
    const service = `orders-${randomUUID().slice(0, 8)}`;
    const sha = `sha-${randomUUID()}`;
    const snap = __fixture.gitlabDeploySnap(tenantId, service, sha);
    await persistDeploys(app.db, tenantId, [snap]);
    await persistDeploys(app.db, tenantId, [snap]);

    const rows = await listRecentDeployments(app.db, tenantId, { service });
    expect(rows).toHaveLength(1);
  });

  // A deploy snapshot with no status persists 'pending' (the DeployStatus default), never
  // the empty string. The shared decoder makes the write and serve paths agree on the 'pending' fallback.
  test('persists a missing status as the "pending" fallback, never empty', async () => {
    const service = `nostatus-${randomUUID().slice(0, 8)}`;
    const sha = `sha-${randomUUID()}`;
    const snap = __fixture.gitlabDeploySnap(tenantId, service, sha);
    delete (snap.metadata as Record<string, unknown>).status; // no status in the connector metadata

    await persistDeploys(app.db, tenantId, [snap]);

    const rows = await listRecentDeployments(app.db, tenantId, { service });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });

  test('persists GitHub provider identity, inactive status, cursor, duration, and rate evidence atomically', async () => {
    await admin.db.insert(connectorConfigs).values({
      tenantId,
      type: 'github',
      settings: { repo: 'acme/checkout' },
      enabled: true,
    });
    const resetAt = '2026-08-22T10:00:00.000Z';
    try {
      await persistDeploys(
        app.db,
        tenantId,
        [__fixture.githubDeploySnap(tenantId, '91')],
        'github',
        {
          cursor: { recentHeadProviderId: '91', activeProviderIds: [] },
          durationMs: 42,
          rateLimitRemaining: 4900,
          rateLimitResetAt: resetAt,
        },
      );
      const [deployment] = await listRecentDeployments(app.db, tenantId, {
        service: 'checkout',
      });
      expect(deployment).toMatchObject({
        source: 'github',
        providerId: '91',
        status: 'inactive',
        repo: 'acme/checkout',
      });
      const [health] = await admin.sql<
        Array<{
          poll_cursor: Record<string, unknown>;
          poll_duration_ms: number;
          poll_rate_limit_remaining: number;
          poll_rate_limit_reset_at: Date | string;
        }>
      >`
        SELECT poll_cursor, poll_duration_ms, poll_rate_limit_remaining, poll_rate_limit_reset_at
        FROM connector_configs WHERE tenant_id = ${tenantId} AND type = 'github'
      `;
      expect(health).toMatchObject({
        poll_cursor: { recentHeadProviderId: '91', activeProviderIds: [] },
        poll_duration_ms: 42,
        poll_rate_limit_remaining: 4900,
      });
      expect(new Date(health!.poll_rate_limit_reset_at).toISOString()).toBe(resetAt);
    } finally {
      await admin.db
        .delete(connectorConfigs)
        .where(sql`tenant_id = ${tenantId} and type = 'github'`);
    }
  });

  test('persists only completed ArgoCD history with structured deployment evidence', async () => {
    const live: NormalizedSnapshot = {
      tenantId,
      source: 'argocd',
      entityId: 'application:payments/argocd/checkout',
      metrics: {},
      metadata: {
        kind: 'application',
        applicationId: 'payments/argocd/checkout',
        syncStatus: 'OutOfSync',
        healthStatus: 'Degraded',
        operationPhase: 'Running',
      },
      observedAt: new Date(),
    };
    const completed: NormalizedSnapshot = {
      tenantId,
      source: 'argocd',
      entityId: 'deployment:uid-checkout:7',
      metrics: {},
      metadata: {
        kind: 'deployment',
        providerId: 'uid-checkout:7',
        repo: 'payments/argocd/checkout',
        service: 'checkout',
        sha: 'release-app',
        revisions: ['release-app', 'release-config'],
        operationPhase: 'Succeeded',
        status: 'success',
        deployedAt: '2026-08-22T01:02:00Z',
      },
      observedAt: new Date('2026-08-22T01:02:00Z'),
    };

    await persistDeploys(app.db, tenantId, [live, completed], 'argocd', { durationMs: 17 });

    const rows = (await listRecentDeployments(app.db, tenantId, { service: 'checkout' })).filter(
      (row) => row.source === 'argocd',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: 'uid-checkout:7',
      revisions: ['release-app', 'release-config'],
      operationPhase: 'Succeeded',
    });
  });
});
