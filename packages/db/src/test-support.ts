// Test-only helper (not exported from index.ts; kept off the package's public surface).
//
// Serializes role / database-ACL DDL (CREATE/DROP ROLE, DROP OWNED, GRANT/REVOKE ON DATABASE) across
// vitest's parallel workers. runtime-role.test.ts and migrate-role.test.ts both mutate the same
// pg_database ACL row and shared role catalogs; when their workers overlap (in setup, a test body,
// or teardown), concurrent catalog updates raise Postgres 'tuple concurrently updated'. Every
// such DDL runs inside a transaction that first takes a fixed-key advisory lock, so the writers take
// turns instead of colliding. All role-DDL test sites must use the SAME key or the guard is porous.
import type { Sql } from 'postgres';
import { attachMembership, type Identity } from './identity-repo';
import type { MembershipRole } from './schema';
import type { Db } from './client';

// Arbitrary fixed key shared by every role/DB-ACL DDL site in the test suite.
const ROLE_DDL_LOCK_KEY = 851217;

/**
 * Provides with role ddl lock.
 *
 * @param sql - Value supplied for sql.
 * @param fn - Value supplied for fn.
 */
export async function withRoleDdlLock<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  // Advisory lock is transaction-scoped: it auto-releases at COMMIT, and running the DDL on the same
  // tx that holds it means a second caller blocks until the first commits. Role DDL is transactional
  // in Postgres, so the CREATE/DROP ROLE + GRANT/REVOKE all commit together and become visible to
  // other sessions at release.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${ROLE_DDL_LOCK_KEY})`;
    // postgres-js types TransactionSql without Sql's connection-lifecycle members (END, reserve, ...)
    // which the DDL never touches; the tagged-template + unsafe surface it does use is identical. The
    // cast bridges that conservative typing.
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

/** Creates the legacy identity-to-tenant fixture used by integration tests only. */
export async function seedMembership(
  db: Db,
  identity: Identity,
  tenantId: string,
  role?: MembershipRole,
): Promise<string> {
  return (await attachMembership(db, identity, tenantId, role)).userId;
}
