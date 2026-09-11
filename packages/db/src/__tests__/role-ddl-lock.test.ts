// two test files (runtime-role, migrate-role) mutate the same pg_database ACL / role catalogs
// under vitest's parallel workers, so concurrent GRANT/REVOKE ON DATABASE + role DDL raise
// 'tuple concurrently updated'. withRoleDdlLock serializes those writers behind a shared advisory
// lock. This test drives two independent connections through the lock in a tight concurrent loop and
// asserts the collision never surfaces. RED with a pass-through (no lock); GREEN with the real lock.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeDb, type DbHandle } from '../index';
import { withRoleDdlLock } from '../test-support';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const ROLE_A = 'flake121_a';
const ROLE_B = 'flake121_b';

// Two SEPARATE pools = two backends, the precondition for the catalog race.
let admin: DbHandle;
let other: DbHandle;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  other = makeDb(ADMIN_URL);
  await withRoleDdlLock(admin.sql, async (tx) => {
    for (const role of [ROLE_A, ROLE_B]) {
      await tx.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await tx.unsafe(`CREATE ROLE ${role} NOLOGIN`);
    }
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    try {
      await withRoleDdlLock(admin.sql, async (tx) => {
        for (const role of [ROLE_A, ROLE_B]) await tx.unsafe(`DROP ROLE IF EXISTS ${role}`);
      });
    } finally {
      await admin.close();
    }
  }
  if (other) await other.close();
});

describe('withRoleDdlLock serializes concurrent database-ACL DDL', () => {
  it('concurrent GRANT/REVOKE ON DATABASE across two connections raises no tuple-concurrently-updated', async () => {
    const ITERATIONS = 40;
    const rejections: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const left = withRoleDdlLock(admin.sql, async (tx) => {
        await tx.unsafe(`GRANT CONNECT ON DATABASE sre_platform TO ${ROLE_A}`);
        await tx.unsafe(`REVOKE CONNECT ON DATABASE sre_platform FROM ${ROLE_A}`);
      });
      const right = withRoleDdlLock(other.sql, async (tx) => {
        await tx.unsafe(`GRANT CONNECT ON DATABASE sre_platform TO ${ROLE_B}`);
        await tx.unsafe(`REVOKE CONNECT ON DATABASE sre_platform FROM ${ROLE_B}`);
      });
      for (const s of await Promise.allSettled([left, right])) {
        if (s.status === 'rejected') rejections.push(String(s.reason?.message ?? s.reason));
      }
    }
    expect(rejections).toEqual([]);
  }, 30_000);
});
