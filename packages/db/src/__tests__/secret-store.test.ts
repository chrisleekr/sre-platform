import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, type DbHandle } from '../client';
import { makeSecretStore, type SecretStore } from '../secret-store';
import { withTenant } from '../rls';
import { tenants, tenantSecrets } from '../schema';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const KEY = Buffer.alloc(32, 7).toString('base64'); // deterministic 32-byte test key

let admin: DbHandle;
let app: DbHandle;
let store: SecretStore;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  store = makeSecretStore(app.db, KEY);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(tenantSecrets).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('SecretStore + RLS', () => {
  test('round-trips a secret per tenant', async () => {
    await store.put(tenantA, 'datadog', 'A-secret');
    await store.put(tenantB, 'datadog', 'B-secret');
    expect(await store.get(tenantA, 'datadog')).toBe('A-secret');
    expect(await store.get(tenantB, 'datadog')).toBe('B-secret');
  });

  test('RLS restricts visible rows to the active tenant', async () => {
    const visible = await withTenant(app.db, tenantA, (tx) => tx.select().from(tenantSecrets));
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((r) => r.tenantId === tenantA)).toBe(true);
  });

  test('no tenant context returns zero rows (deny by default)', async () => {
    const rows = await app.db.select().from(tenantSecrets);
    expect(rows.length).toBe(0);
  });

  test('same name across tenants yields different ciphertext (per-tenant subkeys)', async () => {
    const a = await admin.db
      .select()
      .from(tenantSecrets)
      .where(sql`tenant_id = ${tenantA} and name = 'datadog'`);
    const b = await admin.db
      .select()
      .from(tenantSecrets)
      .where(sql`tenant_id = ${tenantB} and name = 'datadog'`);
    expect(Buffer.from(a[0]!.ciphertext).equals(Buffer.from(b[0]!.ciphertext))).toBe(false);
  });

  test('upsert overwrites the existing secret', async () => {
    await store.put(tenantA, 'datadog', 'A-secret-2');
    expect(await store.get(tenantA, 'datadog')).toBe('A-secret-2');
  });

  test('tampered ciphertext fails GCM authentication', async () => {
    await store.put(tenantA, 'tamper', 'orig');
    await admin.db.execute(
      sql`update tenant_secrets set ciphertext = decode('00', 'hex') where tenant_id = ${tenantA} and name = 'tamper'`,
    );
    await expect(store.get(tenantA, 'tamper')).rejects.toThrow();
  });

  test('delete removes the secret; get then returns null', async () => {
    await store.put(tenantA, 'to-delete', 'gone-soon');
    expect(await store.get(tenantA, 'to-delete')).toBe('gone-soon');
    await store.delete(tenantA, 'to-delete');
    expect(await store.get(tenantA, 'to-delete')).toBeNull();
  });

  test('a delete under another tenant cannot remove this tenant’s secret (RLS)', async () => {
    await store.put(tenantA, 'rls-del', 'A-only');
    // A delete issued under tenant B's RLS-scoped connection sees no A row, so it removes nothing.
    await store.delete(tenantB, 'rls-del');
    expect(await store.get(tenantA, 'rls-del')).toBe('A-only');
  });

  test('has reports presence without decrypting; false for an absent name', async () => {
    await store.put(tenantA, 'present', 'value');
    expect(await store.has(tenantA, 'present')).toBe(true);
    expect(await store.has(tenantA, 'absent')).toBe(false);
  });

  test('has under another tenant cannot see this tenant’s secret (RLS)', async () => {
    await store.put(tenantA, 'rls-has', 'A-only');
    expect(await store.has(tenantB, 'rls-has')).toBe(false);
  });
});
