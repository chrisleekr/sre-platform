import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, createIncident, recordSurfaceBinding, type DbHandle } from '../index';
import { tenants, incidents, surfaceBindings, surfaceWorkingPosts } from '../schema';
import { getWorkingPost, setWorkingPost, clearWorkingPost } from '../working-post-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let incidentA: string;
let bindingA: string;
let bindingB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  for (const id of [tenantA, tenantB]) {
    await admin.db.insert(tenants).values({ id, name: 'WP' });
  }
  incidentA = (
    await createIncident(app.db, tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  bindingA = (
    await recordSurfaceBinding(app.db, tenantA, {
      incidentId: incidentA,
      surface: 'slack',
      channel: 'C-WORKING',
      threadId: 'root-a',
    })
  ).id;
  bindingB = (
    await recordSurfaceBinding(app.db, tenantA, {
      incidentId: incidentA,
      surface: 'slack',
      channel: 'C-WORKING',
      threadId: 'root-b',
      role: 'source',
    })
  ).id;
}, 30_000);

afterAll(async () => {
  if (admin) {
    for (const id of [tenantA, tenantB]) {
      await admin.db.delete(surfaceWorkingPosts).where(sql`tenant_id = ${id}`);
      await admin.db.delete(surfaceBindings).where(sql`tenant_id = ${id}`);
      await admin.db.delete(incidents).where(sql`tenant_id = ${id}`);
      await admin.db.delete(tenants).where(sql`id = ${id}`);
    }
    await admin.close();
  }
  if (app) await app.close();
});

describe('working-post-repo', () => {
  test('set → get → clear is tenant-scoped', async () => {
    expect(await getWorkingPost(app.db, tenantA, bindingA)).toBeNull();

    await setWorkingPost(app.db, tenantA, bindingA, '1699.0001');
    expect(await getWorkingPost(app.db, tenantA, bindingA)).toBe('1699.0001');

    await setWorkingPost(app.db, tenantA, bindingA, '1699.0002');
    expect(await getWorkingPost(app.db, tenantA, bindingA)).toBe('1699.0002');

    await setWorkingPost(app.db, tenantA, bindingB, '1699.0003');
    expect(await getWorkingPost(app.db, tenantA, bindingB)).toBe('1699.0003');
    await clearWorkingPost(app.db, tenantA, bindingA);
    expect(await getWorkingPost(app.db, tenantA, bindingA)).toBeNull();
    expect(await getWorkingPost(app.db, tenantA, bindingB)).toBe('1699.0003');
    await clearWorkingPost(app.db, tenantA, bindingB);
  });

  test('tenant B cannot read or clear tenant A working post (RLS)', async () => {
    // A stores a working post on ITS OWN binding. The repo query carries no tenant predicate, so a
    // non-null read under B here would prove RLS is off (this is the genuine cross-tenant probe).
    await setWorkingPost(app.db, tenantA, bindingA, '1699.0009');
    // B reads A's binding directly: RLS excludes the row, so B sees nothing.
    expect(await getWorkingPost(app.db, tenantB, bindingA)).toBeNull();
    // B's clear on A's binding is a no-op under RLS: A's stored ts survives untouched.
    await clearWorkingPost(app.db, tenantB, bindingA);
    expect(await getWorkingPost(app.db, tenantA, bindingA)).toBe('1699.0009');
    await clearWorkingPost(app.db, tenantA, bindingA);
  });
});
