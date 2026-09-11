import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, withTenant, type DbHandle } from '../index';

// withTenant JOINS an already-open transaction rather than nesting. `app.tenant_id` is
// transaction-scoped, so re-pointing it mid-transaction would silently move every later statement to a
// different tenant — an RLS gap. A joined tx is branded with its tenant and refuses to rebind.

const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let app: DbHandle;
const tenantA = randomUUID();
const tenantB = randomUUID();

beforeAll(() => {
  app = makeDb(APP_URL);
});

afterAll(async () => {
  if (app) await app.close();
});

// The postgres.js driver returns rows as a plain array (no `.rows` wrapper).
const currentTenant = async (
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
): Promise<string> =>
  (
    (await tx.execute(sql`select current_setting('app.tenant_id', true) as tenant`)) as unknown as {
      tenant: string;
    }[]
  )[0]!.tenant;

describe('withTenant tenant binding', () => {
  test('sets the RLS tenant on a fresh transaction', async () => {
    expect(await withTenant(app.db, tenantA, currentTenant)).toBe(tenantA);
  });

  test('joining with the SAME tenant keeps the binding', async () => {
    const seen = await withTenant(app.db, tenantA, (tx) =>
      withTenant(tx, tenantA, (inner) => currentTenant(inner)),
    );
    expect(seen).toBe(tenantA);
  });

  test('joining with a DIFFERENT tenant throws instead of rebinding RLS', async () => {
    await expect(
      withTenant(app.db, tenantA, async (tx) => {
        await withTenant(tx, tenantB, async () => undefined);
      }),
    ).rejects.toThrow(/refusing to rebind/);
  });

  test('an unbranded caller-supplied tx still gets its tenant set', async () => {
    // A raw drizzle tx never passed through withTenant carries no brand: it must be bound, not trusted.
    const seen = await app.db.transaction((tx) => withTenant(tx, tenantB, currentTenant));
    expect(seen).toBe(tenantB);
  });
});
