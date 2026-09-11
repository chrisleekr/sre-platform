// Characterization lock for the schema DDL that carries semantics nothing else asserts: the four
// indexes and the tenant_isolation RLS policies (declared in the Drizzle schema, emitted by
// drizzle-kit) plus FORCE ROW LEVEL SECURITY (not expressible in drizzle-kit, still applied raw by
// migrate.ts). Drop or rename an index and CI stays green while correlation falls back to a seq scan
// and job coalescing stops coalescing; mistranscribe a policy clause, or lose FORCE, and tenant
// isolation silently opens. Reads the LIVE catalog, so the assertions hold whoever emits the DDL.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import postgres from 'postgres';

import { assertRlsCoverage } from '../migrate';

import { createFixture } from './schema-ddl.fixture';

const __fixture = createFixture();

// The guard runs on every deploy; vitest does not. Its happy path is exercised implicitly by the global
// setup (runMigrations succeeds against a fully-covered schema), which proves only that it does not
// throw when it shouldn't. Nothing proved it throws when it SHOULD — invert its predicate and every
// test in the repo still passes while a leaky table ships. These probe a real unguarded table inside a
// transaction that always rolls back, so the shared DB is untouched.
describe('assertRlsCoverage actually fails closed', () => {
  class Rollback extends Error {}

  // ONE connection for all four probes, opened once. A client per probe would add four more
  // connections to a Postgres already shared by 128 test files; connection pressure surfaces as
  // timeouts in unrelated, timing-sensitive suites, not as a failure here.
  let probeClient: ReturnType<typeof postgres>;
  beforeAll(() => {
    probeClient = postgres(__fixture.ADMIN_URL, { max: 1 });
  });
  afterAll(async () => {
    if (probeClient) await probeClient.end({ timeout: 5 });
  });

  // Runs the DDL against a tx that is ALWAYS rolled back, and returns what assertRlsCoverage did.
  // The probe tables therefore never commit: concurrent suites never see them, and nothing is left
  // behind for the next test file.
  const probe = async (ddl: string): Promise<Error | null> => {
    let caught: Error | null = null;
    await probeClient
      .begin(async (tx) => {
        await tx.unsafe(ddl);
        try {
          await assertRlsCoverage(tx as unknown as ReturnType<typeof postgres>);
        } catch (e) {
          caught = e as Error;
        }
        throw new Rollback(); // never commit the probe table
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    return caught;
  };

  test('a tenant_id table with no RLS at all is named and throws', async () => {
    const err = await probe('CREATE TABLE leaky_probe (tenant_id uuid NOT NULL)');
    expect(err, 'an unguarded tenant_id table did NOT throw: the guard is broken').not.toBeNull();
    expect(err!.message).toContain('leaky_probe');
    expect(err!.message).toContain('RLS not enabled');
  }, 30_000);

  // RLS on but not FORCEd is the subtle one: the owner still bypasses the policy entirely, and this is
  // exactly the state drizzle-kit leaves behind (it emits ENABLE, never FORCE).
  test('a table with RLS enabled and a policy but NOT forced is named and throws', async () => {
    const err = await probe(`
      CREATE TABLE unforced_probe (tenant_id uuid NOT NULL);
      ALTER TABLE unforced_probe ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON unforced_probe
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
    `);
    expect(err, 'an unFORCEd table did NOT throw: RLS does not bind for the owner').not.toBeNull();
    expect(err!.message).toContain('unforced_probe');
    expect(err!.message).toContain('not FORCEd');
  }, 30_000);

  // A policy that satisfies EXISTS but leaks everything. Counting policies would wave this through.
  test('a table whose policy is USING (true) is named and throws', async () => {
    const err = await probe(`
      CREATE TABLE permissive_probe (tenant_id uuid NOT NULL);
      ALTER TABLE permissive_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE permissive_probe FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON permissive_probe USING (true) WITH CHECK (true);
    `);
    expect(
      err,
      'a USING(true) policy did NOT throw: the guard only counts policies',
    ).not.toBeNull();
    expect(err!.message).toContain('permissive_probe');
  }, 30_000);

  // The subtlest hole, and the one a reviewer had to find: tenant_isolation itself stays PERFECT, but a
  // SECOND permissive policy is OR-ed with it by Postgres, so it only ever ADDS rows. A guard that looks
  // up 'tenant_isolation' and stops looking sees nothing wrong.
  // https://www.postgresql.org/docs/17/ddl-rowsecurity.html
  test('a correct tenant_isolation policy plus a second PERMISSIVE policy is named and throws', async () => {
    const err = await probe(`
      CREATE TABLE widened_probe (tenant_id uuid NOT NULL);
      ALTER TABLE widened_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE widened_probe FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON widened_probe
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
      CREATE POLICY support_read ON widened_probe FOR SELECT USING (true);
    `);
    expect(
      err,
      'a second PERMISSIVE policy did NOT throw: permissive policies OR together, so the table is open',
    ).not.toBeNull();
    expect(err!.message).toContain('widened_probe');
    expect(err!.message).toContain('extra PERMISSIVE policy');
  }, 30_000);

  // A RESTRICTIVE policy can only narrow (it AND-s in), so it must NOT be rejected. Without this, the
  // fix above would be over-broad and would block a legitimate hardening.
  test('an extra RESTRICTIVE policy is allowed (it can only narrow access)', async () => {
    const err = await probe(`
      CREATE TABLE restricted_probe (tenant_id uuid NOT NULL);
      ALTER TABLE restricted_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE restricted_probe FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON restricted_probe
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
      CREATE POLICY extra_narrowing ON restricted_probe AS RESTRICTIVE USING (tenant_id IS NOT NULL);
    `);
    expect(err?.message ?? null).toBeNull();
  }, 30_000);

  // NULL-swallow: a FOR ALL policy may legally omit USING and WITH CHECK entirely (both are optional in
  // the CREATE POLICY synopsis). pg_get_expr(NULL) is NULL, and an un-COALESCEd conjunction would go
  // three-valued -> NOT(NULL) -> NULL -> WHERE discards the row -> the guard calls the table SAFE on the
  // strength of an expression it could not evaluate. Unknown must mean unguarded.
  test('a tenant_isolation policy with NO using/with-check clause is named and throws', async () => {
    const err = await probe(`
      CREATE TABLE nullqual_probe (tenant_id uuid NOT NULL);
      ALTER TABLE nullqual_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE nullqual_probe FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON nullqual_probe FOR ALL TO public;
    `);
    expect(
      err,
      'a clause-less policy did NOT throw: the guard treated NULL (unknown) as guarded',
    ).not.toBeNull();
    expect(err!.message).toContain('nullqual_probe');
  }, 30_000);

  // The mirror image: a correctly-guarded table must NOT throw, or the tests above could be passing
  // for the wrong reason (e.g. the guard throwing unconditionally).
  test('a correctly guarded table does not throw', async () => {
    const err = await probe(`
      CREATE TABLE guarded_probe (tenant_id uuid NOT NULL);
      ALTER TABLE guarded_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE guarded_probe FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON guarded_probe
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
    `);
    expect(err?.message ?? null).toBeNull();
  }, 30_000);
});
