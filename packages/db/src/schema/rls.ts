// The one tenant-isolation policy, declared once and attached to every tenant-scoped table so the
// clause cannot drift between them: a single mistranscribed table would silently expose that table
// to every tenant.
//
// Emits `CREATE POLICY "tenant_isolation" ON <t> AS PERMISSIVE FOR ALL TO public USING (...) WITH
// CHECK (...)`, plus the `ENABLE ROW LEVEL SECURITY` that declaring a policy implies (so tables must
// NOT also call .enableRLS()). `FORCE ROW LEVEL SECURITY` is not expressible in drizzle-kit and stays
// raw in migrate.ts — without it RLS would not bind for the table owner.
//
// nullif(..., '') maps an unset/empty app.tenant_id to NULL, so `tenant_id = NULL` is never true:
// no tenant context means no rows, rather than a match on the empty string.
import { sql } from 'drizzle-orm';
import { pgPolicy } from 'drizzle-orm/pg-core';

const CLAUSE = sql`tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Provides tenant isolation.
 */
export const tenantIsolation = () =>
  pgPolicy('tenant_isolation', {
    as: 'permissive',
    for: 'all',
    using: CLAUSE,
    // Spelled out rather than relied upon. Postgres WOULD reuse USING as the row-check for a FOR ALL
    // policy that omits WITH CHECK, so omitting it is not a hole today; stating both keeps the write
    // path from depending on that fallback, so narrowing `for:` later cannot silently drop the check.
    // https://www.postgresql.org/docs/17/sql-createpolicy.html
    withCheck: CLAUSE,
  });
