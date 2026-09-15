import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  services,
  serviceDependencies,
  upsertService,
  addDependency,
  type DbHandle,
} from '@sre/db';
import { computeBlastRadius, renderBlastRadius } from '../blast-radius';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

/** Register service nodes for a tenant (idempotent). */
async function reg(tenant: string, names: string[]): Promise<void> {
  for (const name of names) {
    await upsertService(app.db, tenant, { name, team: 'core', criticality: 'tier1' });
  }
}

/** Add a dependency edge: `up` calls `down`. */
async function dep(
  tenant: string,
  up: string,
  down: string,
  opts: { syncType?: string; circuitBreaker?: boolean } = {},
): Promise<void> {
  await addDependency(app.db, tenant, { upstream: up, downstream: down, ...opts });
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(serviceDependencies).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(services).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('computeBlastRadius', () => {
  test('does not discard an unresolved resource scope when falling back to catalog names', async () => {
    await reg(tenantA, ['scoped-db', 'scoped-caller']);
    await dep(tenantA, 'scoped-caller', 'scoped-db');
    for (const field of ['cluster', 'namespace', 'dataSourceId', 'serviceNamespace', 'project']) {
      const scope = { [field]: 'unmatched', environment: 'production' };
      const result = await computeBlastRadius(app.db, tenantA, 'scoped-db', { scope });
      expect(result).toMatchObject({ mapped: false, scope });
      expect(Object.values(result.dependents).flat()).toEqual([]);
      expect(result.suspects).toEqual([]);
      expect(result.note).toMatch(/scope/i);
    }
    const catalog = await computeBlastRadius(app.db, tenantA, 'scoped-db');
    expect(catalog.mapped).toBe(true);
    expect(catalog.dependents.direct.map((item) => item.name)).toEqual(['scoped-caller']);
  });

  test('applies environment supplied through the shared scope to catalog dependency traversal', async () => {
    await reg(tenantA, ['env-db', 'env-prod', 'env-stage']);
    await addDependency(app.db, tenantA, {
      upstream: 'env-prod',
      downstream: 'env-db',
      environment: 'production',
    });
    await addDependency(app.db, tenantA, {
      upstream: 'env-stage',
      downstream: 'env-db',
      environment: 'staging',
    });
    const result = await computeBlastRadius(app.db, tenantA, 'env-db', {
      scope: { environment: 'production' },
    });
    expect(result.mapped).toBe(true);
    expect(result.dependents.direct.map((item) => item.name)).toEqual(['env-prod']);
    const legacy = await computeBlastRadius(app.db, tenantA, 'env-db', {
      environment: 'production',
    });
    expect(result).toEqual(legacy);
  });

  test('marks omitted stronger paths as truncated even when every caller was reached', async () => {
    await reg(tenantA, ['depth-root', 'depth-a', 'depth-b', 'depth-c']);
    await dep(tenantA, 'depth-a', 'depth-root');
    await dep(tenantA, 'depth-b', 'depth-a');
    await dep(tenantA, 'depth-c', 'depth-b');
    await dep(tenantA, 'depth-c', 'depth-root', { circuitBreaker: true });
    const bounded = await computeBlastRadius(app.db, tenantA, 'depth-root', { maxDepth: 2 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.dependents.insulated.map((node) => node.name)).toEqual(['depth-c']);
    const complete = await computeBlastRadius(app.db, tenantA, 'depth-root', { maxDepth: 3 });
    expect(complete.truncated).toBe(false);
    expect(complete.dependents.direct.map((node) => node.name)).toContain('depth-c');
  });
  test('reports synchronous exposure across multiple hops', async () => {
    await reg(tenantA, ['d_db', 'd_web', 'd_front']);
    await dep(tenantA, 'd_web', 'd_db'); // web calls db (sync)
    await dep(tenantA, 'd_front', 'd_web'); // front calls web (sync)

    const br = await computeBlastRadius(app.db, tenantA, 'd_db');

    expect(br.mapped).toBe(true);
    expect(br.dependents.direct.map((d) => d.name)).toEqual(['d_web', 'd_front']);
    expect(br.dependents.direct.find((d) => d.name === 'd_web')?.hops).toBe(1);
    expect(br.dependents.direct.find((d) => d.name === 'd_front')?.hops).toBe(2);
    expect(br.dependents.indirect).toHaveLength(0);
    expect(br.dependents.insulated).toHaveLength(0);
    expect(br.truncated).toBe(false);
  });

  test('retains transitive callers beyond an async boundary as uncertain exposure', async () => {
    await reg(tenantA, ['b_db', 'b_analytics', 'b_reports']);
    await dep(tenantA, 'b_analytics', 'b_db', { syncType: 'async' }); // analytics reads db async
    await dep(tenantA, 'b_reports', 'b_analytics'); // reports calls analytics (sync)

    const br = await computeBlastRadius(app.db, tenantA, 'b_db');

    expect(br.dependents.indirect.map((d) => d.name)).toEqual(['b_analytics', 'b_reports']);
    expect(br.dependents.indirect[0]?.via).toBe('async');
    expect(br.dependents.direct).toHaveLength(0);
    const all = [...br.dependents.direct, ...br.dependents.indirect, ...br.dependents.insulated];
    expect(all.find((d) => d.name === 'b_reports')).toMatchObject({ hops: 2, via: 'async' });
  });

  test('retains callers beyond a declared breaker because its fallback is not proven', async () => {
    await reg(tenantA, ['c_db', 'c_cache', 'c_web']);
    await dep(tenantA, 'c_cache', 'c_db', { circuitBreaker: true }); // sync but breaker-protected
    await dep(tenantA, 'c_web', 'c_cache');

    const br = await computeBlastRadius(app.db, tenantA, 'c_db');

    expect(br.dependents.insulated.map((d) => d.name)).toEqual(['c_cache', 'c_web']);
    expect(br.dependents.insulated[0]?.via).toBe('circuit_breaker');
    expect(br.dependents.direct).toHaveLength(0);
  });

  test('worst tier wins: a node reachable both directly and via an insulator is direct', async () => {
    await reg(tenantA, ['w_db', 'w_svc', 'w_mid']);
    await dep(tenantA, 'w_svc', 'w_db'); // svc calls db (sync) -> direct
    await dep(tenantA, 'w_mid', 'w_db'); // mid calls db (sync) -> direct
    await dep(tenantA, 'w_svc', 'w_mid', { syncType: 'async' }); // svc also calls mid async

    const br = await computeBlastRadius(app.db, tenantA, 'w_db');

    expect(br.dependents.direct.map((d) => d.name).sort()).toEqual(['w_mid', 'w_svc']);
    // svc must NOT also appear as indirect.
    expect(br.dependents.indirect.some((d) => d.name === 'w_svc')).toBe(false);
  });

  test('suspects: the direct downstream dependencies of the failing service, with sync type', async () => {
    await reg(tenantA, ['s_checkout', 's_orders', 's_pay']);
    await dep(tenantA, 's_checkout', 's_orders'); // checkout calls orders (sync)
    await dep(tenantA, 's_checkout', 's_pay', { syncType: 'async' }); // checkout calls pay (async)

    const br = await computeBlastRadius(app.db, tenantA, 's_checkout');

    expect(br.suspects.map((s) => s.name)).toEqual(['s_orders', 's_pay']);
    expect(br.suspects.find((s) => s.name === 's_orders')?.syncType).toBe('sync');
    expect(br.suspects.find((s) => s.name === 's_pay')?.syncType).toBe('async');
  });

  test('unmapped service: not registered -> mapped:false with a note, no error', async () => {
    const br = await computeBlastRadius(app.db, tenantA, 'ghost-never-registered');

    expect(br.mapped).toBe(false);
    expect(br.note).toMatch(/not registered/i);
    expect(br.dependents.direct).toHaveLength(0);
    expect(br.suspects).toHaveLength(0);
  });

  test('registered but isolated: mapped:true, empty, no note', async () => {
    await reg(tenantA, ['iso_lonely']);

    const br = await computeBlastRadius(app.db, tenantA, 'iso_lonely');

    expect(br.mapped).toBe(true);
    expect(br.note).toBeUndefined();
    expect(br.dependents.direct).toHaveLength(0);
    expect(br.suspects).toHaveLength(0);
  });

  test('cycle safe: a mutual A<->B call does not loop forever', async () => {
    await reg(tenantA, ['cy_db', 'cy_a', 'cy_b']);
    await dep(tenantA, 'cy_a', 'cy_db'); // a calls db
    await dep(tenantA, 'cy_a', 'cy_b'); // a calls b
    await dep(tenantA, 'cy_b', 'cy_a'); // b calls a  (cycle a<->b)

    const br = await computeBlastRadius(app.db, tenantA, 'cy_db');

    expect(br.dependents.direct.map((d) => d.name).sort()).toEqual(['cy_a', 'cy_b']);
  });

  test('RLS: a tenant traversal never reads another tenant graph, even with shared names', async () => {
    await reg(tenantA, ['rls_db', 'rls_web']);
    await dep(tenantA, 'rls_web', 'rls_db');
    // Tenant B has the same node names plus an extra hop that must never leak into A's result.
    await reg(tenantB, ['rls_db', 'rls_web', 'rls_extra']);
    await dep(tenantB, 'rls_web', 'rls_db');
    await dep(tenantB, 'rls_extra', 'rls_web');

    const a = await computeBlastRadius(app.db, tenantA, 'rls_db');
    const b = await computeBlastRadius(app.db, tenantB, 'rls_db');

    expect(a.dependents.direct.map((d) => d.name)).toEqual(['rls_web']);
    expect(b.dependents.direct.map((d) => d.name).sort()).toEqual(['rls_extra', 'rls_web']);
  });

  test('a cycle through the failing service never lists itself or falsely truncates', async () => {
    await reg(tenantA, ['origin-cycle', 'caller-cycle']);
    await dep(tenantA, 'caller-cycle', 'origin-cycle');
    await dep(tenantA, 'origin-cycle', 'caller-cycle');
    for (const maxDepth of [1, 10]) {
      const result = await computeBlastRadius(app.db, tenantA, 'origin-cycle', { maxDepth });
      expect(result.dependents.direct.map((node) => node.name)).toEqual(['caller-cycle']);
      expect(result.truncated).toBe(false);
    }
  });

  test('depth cap: the walk is bounded and flags truncation', async () => {
    await reg(tenantA, ['t0', 't1', 't2', 't3', 't4']);
    await dep(tenantA, 't1', 't0');
    await dep(tenantA, 't2', 't1');
    await dep(tenantA, 't3', 't2');
    await dep(tenantA, 't4', 't3');

    const br = await computeBlastRadius(app.db, tenantA, 't0', { maxDepth: 2 });

    expect(br.dependents.direct.map((d) => d.name)).toEqual(['t1', 't2']);
    expect(br.dependents.direct.some((d) => d.name === 't3')).toBe(false);
    expect(br.truncated).toBe(true);
  });

  test('does not flag truncation when the deepest edge only loops back to a known node', async () => {
    // A->X, Q->X, P->A, Q->P (all sync), cap 2. P sits at depth 2, and its only caller Q is already a
    // direct dependent at depth 1, so nothing is actually cut beyond the cap.
    await reg(tenantA, ['fp_x', 'fp_a', 'fp_q', 'fp_p']);
    await dep(tenantA, 'fp_a', 'fp_x');
    await dep(tenantA, 'fp_q', 'fp_x');
    await dep(tenantA, 'fp_p', 'fp_a');
    await dep(tenantA, 'fp_q', 'fp_p');

    const br = await computeBlastRadius(app.db, tenantA, 'fp_x', { maxDepth: 2 });

    expect(br.dependents.direct.map((d) => d.name).sort()).toEqual(['fp_a', 'fp_p', 'fp_q']);
    expect(br.truncated).toBe(false);
  });
});

describe('renderBlastRadius', () => {
  test('renders tiers, suspects, and a truncation note', () => {
    const text = renderBlastRadius({
      service: 'checkout',
      mapped: true,
      dependents: {
        direct: [{ name: 'web', criticality: 'tier1', team: 'payments', hops: 1 }],
        indirect: [{ name: 'analytics', criticality: 'tier2', team: null, hops: 2, via: 'async' }],
        insulated: [
          { name: 'cache', criticality: null, team: null, hops: 1, via: 'circuit_breaker' },
        ],
      },
      suspects: [{ name: 'orders-db', syncType: 'sync', criticality: 'tier1' }],
      truncated: true,
    });
    expect(text).toContain('Blast radius for "checkout"');
    expect(text).toContain('Synchronous exposure:');
    expect(text).toContain('web (tier1), team payments');
    expect(text).toContain('Exposure through async calls');
    expect(text).toContain('Exposure through declared circuit breakers');
    expect(text).toContain('not observed outages');
    expect(text).not.toContain('hard down');
    expect(text).toContain('depth cap reached');
    expect(text).toContain('orders-db (sync, tier1)');
  });

  test('renders an unavailable line for an unmapped service', () => {
    const text = renderBlastRadius({
      service: 'ghost',
      mapped: false,
      dependents: { direct: [], indirect: [], insulated: [] },
      suspects: [],
      truncated: false,
      note: 'service not registered in topology',
    });
    expect(text).toMatch(/unavailable/i);
    expect(text).toContain('ghost');
  });

  test('states no dependents when the graph is empty', () => {
    const text = renderBlastRadius({
      service: 'lonely',
      mapped: true,
      dependents: { direct: [], indirect: [], insulated: [] },
      suspects: [],
      truncated: false,
    });
    expect(text).toContain('No known dependents');
    expect(text).toContain('coverage may be incomplete');
    expect(text).not.toContain('nothing calls');
  });
});
