// C11 / C12 / C15 continued from the poller suite: the DB-backed advisory budget-risk stamp. Split
// into its own file to stay under the test-file size cap; every assertion is unchanged.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  createSlo,
  listRecentDeployments,
  makeDb,
  recordBurnEvent,
  slos,
  tenants,
  type DbHandle,
} from '@sre/db';

import { withRoleDdlLock } from '@sre/db/test-support';

import { makePollHandler } from '../poller';

import { persistDeploys } from '../persist-deploys';

import { createFixture } from './poller.fixture';

// Not a test of the per-tenant ceiling, so these create under a cap they never reach.
const SLO_CAP = 1_000;

const __fixture = createFixture();

// C11 / C12 / C15 — the advisory budget-risk stamp the poller writes onto each deploy row. It is
// ADVISORY: it never opens an incident, never blocks a deploy, and its absence is always null rather
// than an optimistic zero. Own tenant so the SLO rows can be cleaned up independently.
describe('deploy budget-risk stamp (DB-backed)', () => {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  let admin: DbHandle;
  let app: DbHandle;
  let tenantId: string;

  const newSlo = (service: string, name: string) => ({
    name,
    service,
    sliType: 'availability' as const,
    target: 0.999,
    windowDays: 30,
    metricQuery: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
    connectorType: 'prometheus',
  });

  /** Seed one objective for `service` and, when a budget is given, its latest burn event. */
  async function seedObjective(service: string, budgetPct: number | null): Promise<void> {
    const slo = await createSlo(
      app.db,
      tenantId,
      newSlo(service, `${service}-${randomUUID().slice(0, 8)}`),
      SLO_CAP,
    );
    if (budgetPct === null) return;
    await recordBurnEvent(app.db, tenantId, {
      sloId: slo.id,
      budgetPct,
      burnRate: 1,
      window: '1h',
    });
  }

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'DEPLOY-BUDGET' });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.execute(sql`delete from deployments where tenant_id = ${tenantId}`);
      await admin.db.delete(slos).where(sql`tenant_id = ${tenantId}`); // burn events cascade
      await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
      await admin.close();
    }
    if (app) await app.close();
  });

  test('C11: stamps the MINIMUM non-null budget across the service objectives', async () => {
    const service = `min-${randomUUID().slice(0, 8)}`;
    // Three objectives on one service: the tightest budget is the one a responder needs to see, and
    // an unevaluated objective must not be read as a zero that would drag the minimum down.
    await seedObjective(service, 0.42);
    await seedObjective(service, 0.05);
    await seedObjective(service, null);

    await persistDeploys(app.db, tenantId, [
      __fixture.gitlabDeploySnap(tenantId, service, `sha-${randomUUID()}`),
    ]);

    const [row] = await listRecentDeployments(app.db, tenantId, { service });
    expect(row!.budgetRemaining).toBeCloseTo(0.05, 9);
    // 0.05 is under the 0.1 high-risk threshold.
    expect(row!.highRisk).toBe(true);
  });

  test('C11: a healthy budget stamps the figure without flagging risk', async () => {
    const service = `ok-${randomUUID().slice(0, 8)}`;
    await seedObjective(service, 0.42);

    await persistDeploys(app.db, tenantId, [
      __fixture.gitlabDeploySnap(tenantId, service, `sha-${randomUUID()}`),
    ]);

    const [row] = await listRecentDeployments(app.db, tenantId, { service });
    expect(row!.budgetRemaining).toBeCloseTo(0.42, 9);
    expect(row!.highRisk).toBe(false);
  });

  test('C11: an objective with no burn event yet yields a null budget and no risk flag', async () => {
    const service = `pending-${randomUUID().slice(0, 8)}`;
    await seedObjective(service, null);

    await persistDeploys(app.db, tenantId, [
      __fixture.gitlabDeploySnap(tenantId, service, `sha-${randomUUID()}`),
    ]);

    const [row] = await listRecentDeployments(app.db, tenantId, { service });
    expect(row!.budgetRemaining).toBe(null);
    expect(row!.highRisk).toBe(false);
  });

  test('C11: a service with no objective at all yields a null budget and no risk flag', async () => {
    const service = `none-${randomUUID().slice(0, 8)}`;

    await persistDeploys(app.db, tenantId, [
      __fixture.gitlabDeploySnap(tenantId, service, `sha-${randomUUID()}`),
    ]);

    const [row] = await listRecentDeployments(app.db, tenantId, { service });
    expect(row!.budgetRemaining).toBe(null);
    expect(row!.highRisk).toBe(false);
  });

  test('C11: a deploy carrying no service is never flagged, and does not read another service budget', async () => {
    const service = `siblings-${randomUUID().slice(0, 8)}`;
    await seedObjective(service, 0.01);
    const sha = `sha-${randomUUID()}`;
    const withService = __fixture.gitlabDeploySnap(tenantId, service, `sha-${randomUUID()}`);
    const withoutService = __fixture.gitlabDeploySnap(tenantId, service, sha);
    delete (withoutService.metadata as Record<string, unknown>).service;

    await persistDeploys(app.db, tenantId, [withService, withoutService]);

    const flagged = await listRecentDeployments(app.db, tenantId, { service });
    expect(flagged[0]!.highRisk).toBe(true);
    const [unscoped] = (await listRecentDeployments(app.db, tenantId, { limit: 100 })).filter(
      (r) => r.sha === sha,
    );
    expect(unscoped!.service).toBe(null);
    expect(unscoped!.budgetRemaining).toBe(null);
    expect(unscoped!.highRisk).toBe(false);
  });

  test('C11: the budget for each distinct service is resolved once, not once per deploy row', async () => {
    const service = `batch-${randomUUID().slice(0, 8)}`;
    await seedObjective(service, 0.5);
    const shas = [1, 2, 3].map(() => `sha-${randomUUID()}`);

    await persistDeploys(
      app.db,
      tenantId,
      shas.map((sha) => __fixture.gitlabDeploySnap(tenantId, service, sha)),
    );

    const rows = await listRecentDeployments(app.db, tenantId, { service });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.budgetRemaining !== null && r.highRisk === false)).toBe(true);
  });

  test('C15: an un-parseable deploy timestamp does not sink the rest of the batch', async () => {
    const service = `badtime-${randomUUID().slice(0, 8)}`;
    await seedObjective(service, 0.5);
    const goodSha = `good-${randomUUID()}`;
    const badSha = `bad-${randomUUID()}`;
    const bad = __fixture.gitlabDeploySnap(tenantId, service, badSha);
    (bad.metadata as Record<string, unknown>).deployedAt = 'not-a-timestamp';

    // The batch upsert is one INSERT: an Invalid Date reaching the driver would throw and take every
    // deploy in this poll with it, not just the bad row.
    await expect(
      persistDeploys(app.db, tenantId, [
        __fixture.gitlabDeploySnap(tenantId, service, goodSha),
        bad,
      ]),
    ).resolves.toBe(true);

    const rows = await listRecentDeployments(app.db, tenantId, { service });
    expect(rows.map((r) => r.sha).sort()).toEqual([goodSha, badSha].sort());
    expect(rows.every((r) => Number.isFinite(r.deployedAt.getTime()))).toBe(true);
  });

  test('C12: an objective-read failure still persists the deploy, caches, and does not dead-letter', async () => {
    const service = `readfail-${randomUUID().slice(0, 8)}`;
    await seedObjective(service, 0.01);
    const sha = `sha-${randomUUID()}`;
    const snaps = [__fixture.gitlabDeploySnap(tenantId, service, sha)];
    const gitlab = __fixture.fakeConnector('gitlab', async () => snaps);
    const { cache, sets } = __fixture.fakeCache();
    const onOutcome = vi.fn();
    const handler = makePollHandler({
      connectorProvider: () => async () => [gitlab],
      cache,
      ttlSec: 90,
      persistDeploys: (tenant, snapshots, connectorType, evidence, generation) =>
        persistDeploys(app.db, tenant, snapshots, connectorType, evidence, generation),
      onOutcome,
    });

    // A realistic objective-read failure: the login role loses SELECT on `slos` for the duration of
    // this call. The deploy write itself is unaffected, so the stamp must degrade to null rather than
    // reject the promise (which is what makes the poller record failureCategory 'persistence' and
    // skip the cache write).
    const roleRows = await app.sql<Array<{ current_user: string }>>`SELECT current_user`;
    const loginRole = roleRows[0]!.current_user;
    const revoke = `REVOKE SELECT ON slos FROM "${loginRole}"`;
    const restore = `GRANT SELECT ON slos TO "${loginRole}"`;
    await withRoleDdlLock(admin.sql, (tx) => tx.unsafe(revoke));
    try {
      await handler({
        id: 'j1',
        tenantId,
        type: 'poll',
        payload: { connectorType: 'gitlab' },
        attempts: 1,
      });
    } finally {
      await withRoleDdlLock(admin.sql, (tx) => tx.unsafe(restore));
    }

    // The deploy landed, with the advisory stamp absent rather than guessed.
    const rows = await listRecentDeployments(app.db, tenantId, { service });
    expect(rows.map((r) => r.sha)).toEqual([sha]);
    expect(rows[0]!.budgetRemaining).toBe(null);
    expect(rows[0]!.highRisk).toBe(false);
    // The poll succeeded: last-good cache written, no persistence failure, nothing dead-lettered.
    expect(sets).toHaveLength(1);
    expect(onOutcome).toHaveBeenCalledTimes(1);
    const outcome = onOutcome.mock.calls[0]![0] as { status: string; failureCategory?: string };
    expect(outcome.status).toBe('success');
    expect(outcome.failureCategory).toBeUndefined();
    // And no raw permission error reaches the operator-visible outcome.
    expect(JSON.stringify(onOutcome.mock.calls)).not.toMatch(/permission denied/i);
  });
});
