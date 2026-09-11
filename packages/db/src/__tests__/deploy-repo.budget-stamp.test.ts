import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, tenants, deployments, type DbHandle } from '../index';
import {
  upsertDeployments,
  listRecentDeployments,
  recentDeploysByService,
  listDeploymentsPage,
  HIGH_RISK_BUDGET_THRESHOLD,
} from '../deploy-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;

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
  await admin.db.insert(tenants).values([{ id: tenantA, name: 'budget-stamp' }]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(deployments).where(sql`tenant_id = ${tenantA}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantA}`);
    await admin.close();
  }
  if (app) await app.close();
});

// The advisory budget stamp must survive every read path AS A NUMBER. Two of the three reads go
// through `tx.execute`, which bypasses drizzle's column parsing, so postgres-js hands back a double
// precision column as a STRING. A string here would compare and sort wrong at every call site and
// would serialize as `"0.05"` on the wire, so the mapper's cast is the thing under test — not the
// column's existence. `highRisk` is a boolean and must never arrive as `'t'`/`'f'`.
describe('advisory budget stamp round-trip (C11/C13)', () => {
  const stamped = (over: Parameters<typeof deployRow>[0] = {}) =>
    deployRow({ budgetRemaining: 0.05, highRisk: true, ...over });

  test('the window read returns the stamp as a number and the risk flag as a boolean', async () => {
    const service = `stamp-window-${randomUUID().slice(0, 8)}`;
    await upsertDeployments(app.db, tenantA, [
      stamped({ service, sha: `w-${randomUUID()}`, deployedAt: new Date() }),
    ]);

    const [row] = (await recentDeploysByService(app.db, tenantA, 5)).filter(
      (r) => r.service === service,
    );
    expect(row).toBeDefined();
    expect(typeof row!.budgetRemaining).toBe('number');
    expect(row!.budgetRemaining).toBeCloseTo(0.05, 9);
    expect(row!.highRisk).toBe(true);
  });

  test('the flat read (behind fetch_recent_deploys) returns the stamp as a number', async () => {
    const service = `stamp-flat-${randomUUID().slice(0, 8)}`;
    await upsertDeployments(app.db, tenantA, [
      stamped({ service, sha: `f-${randomUUID()}`, deployedAt: new Date() }),
    ]);

    const [row] = await listRecentDeployments(app.db, tenantA, { service });
    expect(typeof row!.budgetRemaining).toBe('number');
    expect(row!.budgetRemaining).toBeCloseTo(0.05, 9);
    expect(row!.highRisk).toBe(true);
  });

  test('the keyset pager returns the stamp as a number', async () => {
    const service = `stamp-page-${randomUUID().slice(0, 8)}`;
    await upsertDeployments(app.db, tenantA, [
      stamped({ service, sha: `p-${randomUUID()}`, deployedAt: new Date() }),
    ]);

    const page = await listDeploymentsPage(app.db, tenantA, { limit: 10, filters: { service } });
    expect(page.deployments).toHaveLength(1);
    expect(typeof page.deployments[0]!.budgetRemaining).toBe('number');
    expect(page.deployments[0]!.budgetRemaining).toBeCloseTo(0.05, 9);
    expect(page.deployments[0]!.highRisk).toBe(true);
  });

  test('an unstamped deploy reads back as a null budget and a false risk flag on every path', async () => {
    const service = `stamp-none-${randomUUID().slice(0, 8)}`;
    // No service SLO, no evaluation: advisory only, so absence is null and never "risky".
    await upsertDeployments(app.db, tenantA, [
      deployRow({ service, sha: `n-${randomUUID()}`, deployedAt: new Date() }),
    ]);

    const flat = await listRecentDeployments(app.db, tenantA, { service });
    const window = (await recentDeploysByService(app.db, tenantA, 5)).filter(
      (r) => r.service === service,
    );
    const page = await listDeploymentsPage(app.db, tenantA, { limit: 10, filters: { service } });
    for (const row of [flat[0], window[0], page.deployments[0]]) {
      expect(row!.budgetRemaining).toBe(null);
      expect(row!.highRisk).toBe(false);
    }
  });

  test('re-polling the same deploy refreshes the stamp rather than keeping the first reading', async () => {
    const service = `stamp-refresh-${randomUUID().slice(0, 8)}`;
    const sha = `r-${randomUUID()}`;
    const deployedAt = new Date();
    await upsertDeployments(app.db, tenantA, [
      deployRow({ service, sha, deployedAt, budgetRemaining: 0.6, highRisk: false }),
    ]);
    // (tenant, source, sha) is the idempotency key: the same deploy re-polled after the budget burned
    // down must carry the newer reading, not a stale "healthy" one.
    await upsertDeployments(app.db, tenantA, [
      deployRow({ service, sha, deployedAt, budgetRemaining: 0.02, highRisk: true }),
    ]);

    const rows = await listRecentDeployments(app.db, tenantA, { service });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.budgetRemaining).toBeCloseTo(0.02, 9);
    expect(rows[0]!.highRisk).toBe(true);
  });

  test('the high-risk threshold is a named constant, not a literal scattered across writers', () => {
    expect(HIGH_RISK_BUDGET_THRESHOLD).toBe(0.1);
  });
});
