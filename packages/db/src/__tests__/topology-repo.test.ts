import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  services,
  serviceDependencies,
  upsertService,
  listServices,
  deleteService,
  addDependency,
  listDependencies,
  removeDependency,
  updateService,
  updateDependency,
  type DbHandle,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

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
    // Edges reference services (FK), so delete them first.
    await admin.db.delete(serviceDependencies).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(services).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('topology repo + RLS', () => {
  test('registers services and dependencies and reads them back', async () => {
    await upsertService(app.db, tenantA, {
      name: 'checkout',
      team: 'payments',
      criticality: 'tier1',
    });
    await upsertService(app.db, tenantA, { name: 'orders-db' });
    await addDependency(app.db, tenantA, {
      upstream: 'checkout',
      downstream: 'orders-db',
      syncType: 'sync',
      circuitBreaker: false,
    });

    const svcs = await listServices(app.db, tenantA);
    expect(svcs.map((s) => s.name)).toEqual(expect.arrayContaining(['checkout', 'orders-db']));
    expect(svcs.find((s) => s.name === 'checkout')?.criticality).toBe('tier1');

    const deps = await listDependencies(app.db, tenantA);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({
      upstream: 'checkout',
      downstream: 'orders-db',
      syncType: 'sync',
    });
  });

  test('rejects a dependency edge to an unregistered service (graph integrity via composite FK)', async () => {
    await upsertService(app.db, tenantA, { name: 'web' });
    await expect(
      addDependency(app.db, tenantA, { upstream: 'web', downstream: 'ghost' }),
    ).rejects.toThrow();
  });

  test('rejects a self-dependency edge (CHECK constraint guards every writer)', async () => {
    await upsertService(app.db, tenantA, { name: 'solo' });
    await expect(
      addDependency(app.db, tenantA, { upstream: 'solo', downstream: 'solo' }),
    ).rejects.toThrow();
  });

  test('upsertService is idempotent on (tenant, name) and updates in place', async () => {
    await upsertService(app.db, tenantA, { name: 'api', criticality: 'tier2' });
    await upsertService(app.db, tenantA, { name: 'api', criticality: 'tier1' });
    const svcs = await listServices(app.db, tenantA);
    expect(svcs.filter((s) => s.name === 'api')).toHaveLength(1);
    expect(svcs.find((s) => s.name === 'api')?.criticality).toBe('tier1');
  });

  test('another tenant cannot see the graph (RLS)', async () => {
    await upsertService(app.db, tenantA, { name: 'tenant-a-only' });
    const bServices = await listServices(app.db, tenantB);
    expect(bServices.some((s) => s.name === 'tenant-a-only')).toBe(false);
    const bDeps = await listDependencies(app.db, tenantB);
    expect(bDeps).toHaveLength(0);
  });

  test('a service can be deleted once its edges are removed (FK RESTRICT until then)', async () => {
    await upsertService(app.db, tenantA, { name: 'x' });
    await upsertService(app.db, tenantA, { name: 'y' });
    await addDependency(app.db, tenantA, { upstream: 'x', downstream: 'y' });
    // The edge references x and y, so removing the edge first is required.
    await removeDependency(app.db, tenantA, 'x', 'y');
    await deleteService(app.db, tenantA, 'x');
    const svcs = await listServices(app.db, tenantA);
    expect(svcs.some((s) => s.name === 'x')).toBe(false);
  });

  test('updateService patches only provided keys (preserves omitted)', async () => {
    await upsertService(app.db, tenantA, {
      name: 'patch-svc',
      team: 'x',
      criticality: 'tier1',
    });
    const updated = await updateService(app.db, tenantA, 'patch-svc', { team: 'y' });
    expect(updated?.team).toBe('y');
    // criticality was omitted from the patch, so it must survive (not reset to default).
    expect(updated?.criticality).toBe('tier1');
    const svcs = await listServices(app.db, tenantA);
    expect(svcs.find((s) => s.name === 'patch-svc')?.criticality).toBe('tier1');
  });

  test('updateService returns null for a missing service', async () => {
    const updated = await updateService(app.db, tenantA, 'nope', { team: 'z' });
    expect(updated).toBeNull();
  });

  test('updateDependency patches only provided keys', async () => {
    await upsertService(app.db, tenantA, { name: 'patch-up' });
    await upsertService(app.db, tenantA, { name: 'patch-down' });
    await addDependency(app.db, tenantA, {
      upstream: 'patch-up',
      downstream: 'patch-down',
      syncType: 'async',
      circuitBreaker: true,
      protocol: 'grpc',
    });
    const updated = await updateDependency(app.db, tenantA, 'patch-up', 'patch-down', {
      circuitBreaker: false,
    });
    expect(updated?.circuitBreaker).toBe(false);
    // syncType and protocol were omitted, so they must survive.
    expect(updated?.syncType).toBe('async');
    expect(updated?.protocol).toBe('grpc');
  });

  test('updateDependency returns null for a missing edge', async () => {
    const updated = await updateDependency(app.db, tenantA, 'patch-up', 'nope', {
      circuitBreaker: true,
    });
    expect(updated).toBeNull();
  });
});
