import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { connectorConfigs, makeDb, tenants, deployments, type DbHandle } from '../index';
import {
  upsertDeployments,
  listRecentDeployments,
  recentDeploysByService,
  listDeploymentsPage,
  deploymentSummary,
  persistConnectorDeployments,
  recordConnectorPollFailure,
  deploymentBoundaryAsOf,
} from '../deploy-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

// The persisted deploy shape the poller stamps (source + sha are the idempotency key).
const deployRow = (over: Partial<Parameters<typeof upsertDeployments>[2][number]> = {}) => ({
  source: 'gitlab',
  repo: '71',
  ref: 'main',
  sha: `sha-${randomUUID()}`,
  service: 'checkout',
  status: 'success',
  deployedAt: new Date('2026-07-01T00:00:00Z'),
  ...over,
});

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(deployments).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('deploy repo + RLS', () => {
  test('selects the exact deployment boundary without a recent-history cutoff', async () => {
    const connectorId = randomUUID();
    const service = `boundary-${randomUUID()}`;
    const repository = 'acme/checkout';
    const revisions = ['oldest', 'current', 'after'];
    await upsertDeployments(
      app.db,
      tenantA,
      revisions.map((sha, index) =>
        deployRow({
          source: 'github',
          providerId: `${service}-${sha}`,
          repo: repository,
          service,
          sha,
          deployedAt: new Date(
            ['2025-01-01T00:00:00Z', '2025-02-01T00:00:00Z', '2025-03-01T00:00:00Z'][index]!,
          ),
        }),
      ),
      connectorId,
    );

    await expect(
      deploymentBoundaryAsOf(app.db, tenantA, {
        service,
        source: 'github',
        connectorId,
        repository,
        at: new Date('2025-02-15T00:00:00Z'),
      }),
    ).resolves.toMatchObject({
      current: { sha: 'current' },
      previous: { sha: 'oldest' },
      firstAfter: { sha: 'after' },
    });
    await expect(
      deploymentBoundaryAsOf(app.db, tenantB, {
        service,
        source: 'github',
        connectorId,
        repository,
        at: new Date('2025-02-15T00:00:00Z'),
      }),
    ).resolves.toEqual({ current: null, previous: null, firstAfter: null });
  });

  test('does not attribute an unscoped legacy deployment to a connector', async () => {
    const connectorId = randomUUID();
    const service = `legacy-boundary-${randomUUID()}`;
    const repository = 'acme/checkout';
    await upsertDeployments(app.db, tenantA, [
      deployRow({
        source: 'gitlab',
        providerId: `${service}-legacy`,
        repo: repository,
        service,
        sha: 'a'.repeat(40),
        deployedAt: new Date('2025-02-01T00:00:00Z'),
      }),
    ]);

    await expect(
      deploymentBoundaryAsOf(app.db, tenantA, {
        service,
        source: 'gitlab',
        connectorId,
        repository,
        at: new Date('2025-02-15T00:00:00Z'),
      }),
    ).resolves.toEqual({ current: null, previous: null, firstAfter: null });
  });

  test('upsertDeployments persists a deploy and is idempotent on (source, sha)', async () => {
    const sha = `sha-${randomUUID()}`;
    await upsertDeployments(app.db, tenantA, [deployRow({ sha, status: 'running' })]);
    // Re-deliver the SAME (source, sha) with an updated status: an upsert, not a second row.
    await upsertDeployments(app.db, tenantA, [deployRow({ sha, status: 'success' })]);

    const rows = await listRecentDeployments(app.db, tenantA, { service: 'checkout' });
    const forSha = rows.filter((r) => r.sha === sha);
    expect(forSha).toHaveLength(1); // idempotent: one row, not two
    expect(forSha[0]!.status).toBe('success'); // the later status won
  });

  test('a tenant cannot see another tenant’s deployments (RLS)', async () => {
    const shaA = `a-${randomUUID()}`;
    const shaB = `b-${randomUUID()}`;
    await upsertDeployments(app.db, tenantA, [deployRow({ sha: shaA })]);
    await upsertDeployments(app.db, tenantB, [deployRow({ sha: shaB })]);

    const aRows = await listRecentDeployments(app.db, tenantA, {});
    expect(aRows.some((r) => r.sha === shaA)).toBe(true);
    expect(aRows.some((r) => r.sha === shaB)).toBe(false); // B's deploy is invisible to A
  });

  test('keys GitHub deployment events by provider ID across repositories and environments', async () => {
    const sha = `shared-${randomUUID()}`;
    await upsertDeployments(app.db, tenantA, [
      deployRow({
        source: 'github',
        providerId: 'github-deploy-1',
        repo: 'acme/checkout',
        environment: 'staging',
        transientEnvironment: true,
        sha,
        status: 'pending',
      }),
      deployRow({
        source: 'github',
        providerId: 'github-deploy-2',
        repo: 'acme/orders',
        environment: 'production',
        sha,
        status: 'success',
      }),
    ]);
    await upsertDeployments(app.db, tenantA, [
      deployRow({
        source: 'github',
        providerId: 'github-deploy-1',
        repo: 'acme/checkout',
        environment: 'staging',
        transientEnvironment: true,
        sha,
        status: 'inactive',
      }),
    ]);

    const rows = (await listRecentDeployments(app.db, tenantA, {})).filter(
      (row) => row.sha === sha,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.providerId === 'github-deploy-1')).toMatchObject({
      repo: 'acme/checkout',
      environment: 'staging',
      transientEnvironment: true,
      status: 'inactive',
    });
    expect(rows.find((row) => row.providerId === 'github-deploy-2')).toMatchObject({
      repo: 'acme/orders',
      environment: 'production',
      transientEnvironment: false,
      status: 'success',
    });
  });

  test('keys ArgoCD history by Application UID and history ID while preserving ordered evidence', async () => {
    const sharedRevision = `shared-${randomUUID()}`;
    await upsertDeployments(app.db, tenantA, [
      deployRow({
        source: 'argocd',
        providerId: 'uid-checkout:7',
        repo: 'payments/argocd/checkout',
        sha: sharedRevision,
        revisions: [sharedRevision, 'config-a'],
        operationPhase: 'Succeeded',
      }),
      deployRow({
        source: 'argocd',
        providerId: 'uid-orders:7',
        repo: 'payments/argocd/orders',
        sha: sharedRevision,
        revisions: [sharedRevision, 'config-b'],
        operationPhase: 'Succeeded',
      }),
    ]);
    await upsertDeployments(app.db, tenantA, [
      deployRow({
        source: 'argocd',
        providerId: 'uid-checkout:7',
        repo: 'platform/argocd/checkout-renamed',
        sha: sharedRevision,
        revisions: [sharedRevision, 'config-a-updated'],
        operationPhase: 'Succeeded',
      }),
    ]);

    const rows = (await listRecentDeployments(app.db, tenantA)).filter(
      (row) => row.source === 'argocd' && row.sha === sharedRevision,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.providerId === 'uid-checkout:7')).toMatchObject({
      providerId: 'uid-checkout:7',
      repo: 'platform/argocd/checkout-renamed',
      revisions: [sharedRevision, 'config-a-updated'],
      operationPhase: 'Succeeded',
    });
    expect(rows.find((row) => row.repo.endsWith('/orders'))).toMatchObject({
      providerId: 'uid-orders:7',
      revisions: [sharedRevision, 'config-b'],
    });
  });

  test('does not attach a stale poll failure to a newer connector generation', async () => {
    const [config] = await admin.db
      .insert(connectorConfigs)
      .values({ tenantId: tenantA, type: 'argocd', settings: {}, enabled: true })
      .returning({ id: connectorConfigs.id, lifecycleVersion: connectorConfigs.lifecycleVersion });
    try {
      await recordConnectorPollFailure(
        app.db,
        tenantA,
        'argocd',
        'provider',
        3,
        {},
        {
          id: config!.id,
          lifecycleVersion: config!.lifecycleVersion + 1,
        },
      );
      let [row] = await admin.sql<Array<{ poll_error_count: number }>>`
        SELECT poll_error_count FROM connector_configs WHERE id = ${config!.id}
      `;
      expect(row?.poll_error_count).toBe(0);

      await recordConnectorPollFailure(app.db, tenantA, 'argocd', 'provider', 3, {}, config!);
      [row] = await admin.sql<Array<{ poll_error_count: number }>>`
        SELECT poll_error_count FROM connector_configs WHERE id = ${config!.id}
      `;
      expect(row?.poll_error_count).toBe(3);
    } finally {
      await admin.db.delete(connectorConfigs).where(sql`id = ${config!.id}`);
    }
  });

  // The nullable `url` column round-trips: upsert writes it, the repo read projects it.
  test('persists and returns a nullable url column', async () => {
    const sha = `sha-${randomUUID()}`;
    const service = `svc-url-${randomUUID().slice(0, 8)}`;
    await upsertDeployments(app.db, tenantA, [deployRow({ sha, service, url: 'https://gl/p/1' })]);

    const rows = await listRecentDeployments(app.db, tenantA, { service });
    const row = rows.find((r) => r.sha === sha);
    expect(row).toBeDefined();
    expect(row!.url).toBe('https://gl/p/1');
  });

  test('an empty successful poll preserves the existing provider cursor', async () => {
    const cursor = { updatedAfter: '2026-08-21T01:02:00.000Z' };
    await admin.db.insert(connectorConfigs).values({
      tenantId: tenantA,
      type: 'gitlab',
      settings: {},
      enabled: true,
      pollCursor: cursor,
    });
    try {
      await persistConnectorDeployments(app.db, tenantA, 'gitlab', [], {});
      const [row] = await admin.sql<{ poll_cursor: Record<string, unknown> }[]>`
        select poll_cursor from connector_configs
        where tenant_id = ${tenantA} and type = 'gitlab'
      `;
      expect(row?.poll_cursor).toEqual(cursor);
    } finally {
      await admin.db
        .delete(connectorConfigs)
        .where(sql`tenant_id = ${tenantA} and type = 'gitlab'`);
    }
  });

  test('a partial connector poll records project errors without losing successful poll evidence', async () => {
    await admin.db.insert(connectorConfigs).values({
      tenantId: tenantA,
      type: 'argocd',
      settings: {},
      enabled: true,
    });
    const cursor = {
      projects: [
        { project: 'payments', status: 'healthy' },
        { project: 'identity', status: 'unhealthy', failureCategory: 'unreachable' },
      ],
    };
    try {
      await persistConnectorDeployments(app.db, tenantA, 'argocd', [], cursor, {
        durationMs: 17,
        errorCount: 1,
        failureCategory: 'partial_project_failure',
      });
      const [row] = await admin.sql<
        Array<{
          poll_error_count: number;
          poll_failure_category: string | null;
          poll_cursor: Record<string, unknown>;
          poll_succeeded_at: Date | null;
        }>
      >`
        select poll_error_count, poll_failure_category, poll_cursor, poll_succeeded_at
        from connector_configs
        where tenant_id = ${tenantA} and type = 'argocd'
      `;
      expect(row).toMatchObject({
        poll_error_count: 1,
        poll_failure_category: 'partial_project_failure',
        poll_cursor: cursor,
      });
      expect(row?.poll_succeeded_at).not.toBeNull();
    } finally {
      await admin.db
        .delete(connectorConfigs)
        .where(sql`tenant_id = ${tenantA} and type = 'argocd'`);
    }
  });

  // Flat path: the flat read carries its OWN `deployed_at >= since` clause, physically
  // separate from the perService window query. `GET /deployments` (the panel) is this branch, so it
  // gets its own recency-window test: dropping the bound here would leave every other test green while
  // the panel silently serves unbounded history.
  test('flat listRecentDeployments excludes deploys outside the recency window', async () => {
    const service = `flat-old-${randomUUID().slice(0, 8)}`;
    const recentSha = `recent-${randomUUID()}`;
    const staleSha = `stale-${randomUUID()}`;
    await upsertDeployments(app.db, tenantA, [
      deployRow({ sha: recentSha, service, deployedAt: new Date() }),
      deployRow({
        sha: staleSha,
        service,
        deployedAt: new Date(Date.now() - 365 * 24 * 60 * 60_000), // ~1 year old
      }),
    ]);

    const rows = await listRecentDeployments(app.db, tenantA, { service });
    expect(rows.some((r) => r.sha === recentSha)).toBe(true);
    expect(rows.some((r) => r.sha === staleSha)).toBe(false); // outside the deployed_at window
  });
});

// Characterization of the CURRENT `recentDeploysByService` window result. Must
// stay GREEN through the two-fn collapse and the query rewrite: per-service cap honoured, newest-first
// by deployed_at, and null-service rows excluded (no graph node to attach to).
describe('recentDeploysByService window (characterization)', () => {
  test('caps rows per service, newest-first by deployed_at, and excludes null-service deploys', async () => {
    const svc = `win-${randomUUID().slice(0, 8)}`;
    // Capture the exact Date instances so assertions compare against stored values, not recomputed ones.
    const mid = new Date(Date.now() - 30 * 60_000);
    const newest = new Date(Date.now() - 10 * 60_000);
    const oldest = new Date(Date.now() - 50 * 60_000);
    await upsertDeployments(app.db, tenantA, [
      deployRow({ sha: `s1-${randomUUID()}`, service: svc, deployedAt: mid }),
      deployRow({ sha: `s2-${randomUUID()}`, service: svc, deployedAt: newest }),
      deployRow({ sha: `s3-${randomUUID()}`, service: svc, deployedAt: oldest }),
      deployRow({ sha: `null-${randomUUID()}`, service: null, deployedAt: new Date() }),
    ]);

    const rows = (await recentDeploysByService(app.db, tenantA, 2)).filter(
      (r) => r.service === svc,
    );
    // Per-service cap = 2, arriving newest-first (deployed_at DESC): the oldest of three is dropped.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.deployedAt.getTime())).toEqual([newest.getTime(), mid.getTime()]);
    // Null-service deploys are never returned (no graph node to attach to).
    const all = await recentDeploysByService(app.db, tenantA);
    expect(all.every((r) => r.service !== null)).toBe(true);
  });

  // The window read bounds the partition by the `deployed_at` recency window, so a very
  // old deploy is excluded even when it is the only row for its service.
  test('excludes deploys outside the recency window', async () => {
    const svc = `old-${randomUUID().slice(0, 8)}`;
    const recentSha = `recent-${randomUUID()}`;
    const staleSha = `stale-${randomUUID()}`;
    await upsertDeployments(app.db, tenantA, [
      deployRow({ sha: recentSha, service: svc, deployedAt: new Date() }),
      deployRow({
        sha: staleSha,
        service: svc,
        deployedAt: new Date(Date.now() - 365 * 24 * 60 * 60_000), // ~1 year old
      }),
    ]);

    const rows = (await recentDeploysByService(app.db, tenantA)).filter((r) => r.service === svc);
    expect(rows.some((r) => r.sha === recentSha)).toBe(true);
    expect(rows.some((r) => r.sha === staleSha)).toBe(false); // outside the deployed_at window
  });
});

// [RED] — the paginated deploy read for the dashboard panel. Unlike recentDeploys, this keyset
// reader returns the tenant's FULL history newest-first (deployed_at DESC, id DESC), so a >90d deploy is
// reachable by paging rather than silently dropped. Fetches limit+1 to set nextCursor without a COUNT;
// `before` returns rows strictly older than the cursor. A dedicated fresh tenant keeps the page contents
// deterministic (tenantA accumulates rows across the other tests). listDeploymentsPage does not exist yet.
describe('listDeploymentsPage keyset', () => {
  let tenantC: string;
  // Newest → oldest; `old` is >90d back, so a window-bounded read would exclude it but the keyset pager
  // must still reach it on a later page.
  const now = Date.now();
  const d1At = new Date(now - 1 * 60_000);
  const d2At = new Date(now - 2 * 60_000);
  const d3At = new Date(now - 3 * 60_000);
  const oldAt = new Date(now - 200 * 24 * 60 * 60_000);
  const sha1 = `p1-${randomUUID()}`;
  const sha2 = `p2-${randomUUID()}`;
  const sha3 = `p3-${randomUUID()}`;
  const shaOld = `pold-${randomUUID()}`;

  beforeAll(async () => {
    tenantC = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantC, name: 'C' });
    await upsertDeployments(app.db, tenantC, [
      deployRow({ sha: sha1, deployedAt: d1At, status: 'failed', environment: 'production' }),
      deployRow({ sha: sha2, deployedAt: d2At, status: 'running' }),
      deployRow({ sha: sha3, deployedAt: d3At }),
      deployRow({ sha: shaOld, deployedAt: oldAt }),
    ]);
  }, 30_000);

  afterAll(async () => {
    await admin.db.delete(deployments).where(sql`tenant_id = ${tenantC}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantC}`);
  });

  test('first page returns newest-first, keyed on (deployed_at desc, id desc), with a nextCursor', async () => {
    const page = await listDeploymentsPage(app.db, tenantC, { limit: 2 });
    expect(page.deployments.map((r) => r.sha)).toEqual([sha1, sha2]); // two newest, in order
    // deployed_at is non-increasing across the page.
    const times = page.deployments.map((r) => r.deployedAt.getTime());
    expect(times[0]!).toBeGreaterThanOrEqual(times[1]!);
    expect(page.nextCursor).not.toBeNull(); // a further page remains
    expect(page.nextCursor!.deployedAt.getTime()).toBe(d2At.getTime());
  });

  test('the `before` cursor returns the next older page, INCLUDING the >90d deploy', async () => {
    const first = await listDeploymentsPage(app.db, tenantC, { limit: 2 });
    const older = await listDeploymentsPage(app.db, tenantC, {
      limit: 2,
      before: first.nextCursor!,
    });
    expect(older.deployments.map((r) => r.sha)).toEqual([sha3, shaOld]); // includes the >90d row
    expect(older.nextCursor).toBeNull(); // last page: no rows strictly older remain
  });

  test('nextCursor is null when the whole set fits in one page', async () => {
    const page = await listDeploymentsPage(app.db, tenantC, { limit: 50 });
    expect(page.deployments.map((r) => r.sha)).toEqual([sha1, sha2, sha3, shaOld]);
    expect(page.nextCursor).toBeNull();
  });

  test('a tenant cannot page another tenant’s deployments (RLS)', async () => {
    const page = await listDeploymentsPage(app.db, tenantB, { limit: 50 });
    for (const sha of [sha1, sha2, sha3, shaOld]) {
      expect(page.deployments.some((r) => r.sha === sha)).toBe(false);
    }
  });

  test('filters the durable history and summarizes the whole selected window', async () => {
    const filters = { from: new Date(now - 2.5 * 60_000), service: 'checkout', source: 'gitlab' };
    const [page, summary] = await Promise.all([
      listDeploymentsPage(app.db, tenantC, { limit: 1, filters }),
      deploymentSummary(app.db, tenantC, filters),
    ]);

    expect(page.deployments.map((row) => row.sha)).toEqual([sha1]);
    expect(page.nextCursor).not.toBeNull();
    expect(summary).toMatchObject({
      total: 2,
      failed: 1,
      active: 1,
      environmentMissing: 1,
    });
    expect(summary.latestAt?.getTime()).toBe(d1At.getTime());
  });

  test('searches service and provider evidence without wildcard semantics', async () => {
    const page = await listDeploymentsPage(app.db, tenantC, {
      limit: 20,
      filters: { search: sha3 },
    });
    expect(page.deployments.map((row) => row.sha)).toEqual([sha3]);
  });

  test('groups provider failure vocabularies under the failed filter', async () => {
    const page = await listDeploymentsPage(app.db, tenantC, {
      filters: { status: 'failed' },
    });
    expect(page.deployments.map((row) => row.sha)).toEqual([sha1]);
  });
});

// two rows sharing a deployed_at must page deterministically via the `id` tiebreak. Exercises
// the `and(eq(deployed_at, cursor), lt(id, cursor.id))` branch (untested by the distinct-timestamp cases
// above): with equal deployed_at the cursor's deployed_at equals the next row's, so only the id comparison
// separates them — a bug there would either skip the older twin or return it twice. A fresh tenant keeps the
// two tie rows the only rows in scope so `limit: 1` addresses them deterministically.
describe('listDeploymentsPage keyset tie-break', () => {
  let tenantT: string;
  const ts = new Date('2026-06-15T12:00:00Z'); // identical deployed_at for both rows
  const shaA = `tieA-${randomUUID()}`;
  const shaB = `tieB-${randomUUID()}`;

  beforeAll(async () => {
    tenantT = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantT, name: 'T' });
    await upsertDeployments(app.db, tenantT, [
      deployRow({ sha: shaA, deployedAt: ts }),
      deployRow({ sha: shaB, deployedAt: ts }),
    ]);
  }, 30_000);

  afterAll(async () => {
    await admin.db.delete(deployments).where(sql`tenant_id = ${tenantT}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantT}`);
  });

  test('rows sharing a deployed_at page one-at-a-time by id desc — no skip, no duplicate', async () => {
    const first = await listDeploymentsPage(app.db, tenantT, { limit: 1 });
    expect(first.deployments).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    // Both rows share this deployed_at, so the cursor's deployed_at equals the next row's: only the id
    // tiebreak advances the page.
    expect(first.nextCursor!.deployedAt.getTime()).toBe(ts.getTime());

    const second = await listDeploymentsPage(app.db, tenantT, {
      limit: 1,
      before: first.nextCursor!,
    });
    expect(second.deployments).toHaveLength(1);
    expect(second.nextCursor).toBeNull(); // only two rows exist

    // The twin is returned exactly once across the two pages — never skipped, never repeated.
    const seen = [first.deployments[0]!.sha, second.deployments[0]!.sha];
    expect(new Set(seen)).toEqual(new Set([shaA, shaB]));
  });
});
