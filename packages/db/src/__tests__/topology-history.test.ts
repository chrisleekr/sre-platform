import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { makeDb, type DbHandle } from '../client';
import { withTenant } from '../rls';
import { tenants, services, serviceDependencies, serviceDependencyHistory } from '../schema';
import { addDependency, updateDependency, removeDependency } from '../topology-repo';

const tenantId = randomUUID();
let admin: DbHandle;
let app: DbHandle;
beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'History lifecycle' });
  await admin.db
    .insert(services)
    .values(['caller', 'database'].map((name) => ({ tenantId, name })));
});
afterAll(async () => {
  await admin.db.delete(serviceDependencies).where(eq(serviceDependencies.tenantId, tenantId));
  await admin.db.delete(services).where(eq(services.tenantId, tenantId));
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await admin.close();
  await app.close();
});
const versions = () =>
  withTenant(app.db, tenantId, (tx) =>
    tx.select().from(serviceDependencyHistory).orderBy(serviceDependencyHistory.validFrom),
  );
const at = (time: Date) =>
  withTenant(app.db, tenantId, (tx) =>
    tx
      .select()
      .from(serviceDependencyHistory)
      .where(
        sql`valid_from <= ${time.toISOString()}::timestamptz and (valid_until is null or valid_until > ${time.toISOString()}::timestamptz)`,
      ),
  );

test('edit, delete and recreate close only the exact environment with half-open validity boundaries', async () => {
  const input = {
    upstream: 'caller',
    downstream: 'database',
    rationale: 'Application config',
    confirmedByUserId: randomUUID(),
  };
  await addDependency(app.db, tenantId, { ...input, environment: 'production' });
  await addDependency(app.db, tenantId, { ...input, environment: 'staging' });
  await updateDependency(
    app.db,
    tenantId,
    'caller',
    'database',
    { syncType: 'async' },
    'production',
  );
  const updated = await versions();
  const original = updated.find((row) => row.environment === 'production' && row.validUntil)!;
  const replacement = updated.find((row) => row.environment === 'production' && !row.validUntil)!;
  expect(original.validUntil).toEqual(replacement.validFrom);
  expect(
    (await at(replacement.validFrom)).filter((row) => row.environment === 'production'),
  ).toEqual([replacement]);
  await removeDependency(app.db, tenantId, 'caller', 'database', 'production');
  const deleted = (await versions()).find((row) => row.id === replacement.id)!;
  expect(deleted.validUntil).not.toBeNull();
  expect((await at(deleted.validUntil!)).map((row) => row.environment)).toEqual(['staging']);
  await addDependency(app.db, tenantId, { ...input, environment: 'production', protocol: 'HTTPS' });
  const final = await versions();
  expect(final.find((row) => row.id === original.id)).toEqual(original);
  expect(final.find((row) => row.id === deleted.id)).toEqual(deleted);
  expect(final.filter((row) => !row.validUntil)).toHaveLength(2);
  expect(final.find((row) => row.environment === 'staging')?.validUntil).toBeNull();
  expect(
    await withTenant(app.db, randomUUID(), (tx) => tx.select().from(serviceDependencyHistory)),
  ).toEqual([]);
});
