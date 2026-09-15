import { afterAll, beforeAll, expect, test, vi } from 'vitest';
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
  const first = await addDependency(app.db, tenantId, {
    upstream: input.upstream,
    downstream: input.downstream,
    environment: 'production',
  });
  const initialHistory = await versions();
  await addDependency(app.db, tenantId, {
    upstream: input.upstream,
    downstream: input.downstream,
    environment: 'production',
  });
  expect(await versions()).toEqual(initialHistory);
  await updateDependency(
    app.db,
    tenantId,
    'caller',
    'database',
    { syncType: first.syncType },
    'production',
  );
  expect(await versions()).toEqual(initialHistory);
  await addDependency(app.db, tenantId, { ...input, environment: 'production' });
  expect(await versions()).toHaveLength(2);
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
  const original = updated.find(
    (row) =>
      row.environment === 'production' &&
      row.validUntil &&
      row.declaration.confirmedByUserId === input.confirmedByUserId,
  )!;
  const replacement = updated.find((row) => row.environment === 'production' && !row.validUntil)!;
  expect(original.validUntil).toEqual(replacement.validFrom);
  expect(
    (await at(replacement.validFrom)).filter((row) => row.environment === 'production'),
  ).toEqual([replacement]);
  expect(await removeDependency(app.db, tenantId, 'caller', 'database', 'production')).toBe(1);
  const beforeNoop = await versions();
  expect(await removeDependency(app.db, tenantId, 'caller', 'database', 'production')).toBe(0);
  expect(await removeDependency(app.db, randomUUID(), 'caller', 'database', 'staging')).toBe(0);
  expect(await versions()).toEqual(beforeNoop);
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

test('reconfirmation by the same actor retains a new evidence time without changing the declaration', async () => {
  const input = {
    upstream: 'caller',
    downstream: 'database',
    environment: 'reconfirmation',
    rationale: 'Application config',
    confirmedByUserId: randomUUID(),
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-09-15T00:00:00.000Z'));
    const first = await addDependency(app.db, tenantId, input);
    const original = (await versions()).find((row) => row.environment === input.environment)!;
    vi.setSystemTime(new Date('2026-09-15T00:01:00.000Z'));
    const next = await addDependency(app.db, tenantId, input);
    const history = (await versions()).filter((row) => row.environment === input.environment);
    expect(history).toHaveLength(2);
    expect(next.lastConfirmedAt!.getTime()).toBeGreaterThan(first.lastConfirmedAt!.getTime());
    expect(history[0]).toEqual({ ...original, validUntil: history[1]!.validFrom });
    expect(history[1]!.declaration).toEqual({
      ...original.declaration,
      lastConfirmedAt: next.lastConfirmedAt!.toISOString(),
    });
    expect(history[1]!.validUntil).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
