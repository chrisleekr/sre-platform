// RED start-state for GitLab: migrate.ts creates app_user via raw password interpolation into a
// client.unsafe DDL string with an insecure `?? 'app'` default and no fail-closed. Phase B adds two
// exported helpers to ./migrate (re-exported from ./index); this test drives them.
//   - appRolePassword(env): env.APP_DB_PASSWORD if set; else 'app' when NODE_ENV is undefined/test/
//     development; else THROWS (deployed env). Pure, no DB.
//   - createLoginRole(sql, role, password): idempotent CREATE ROLE ... LOGIN with the password
//     properly ESCAPED — no SQL injection. Runs against a live admin (superuser) Postgres.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appRolePassword, createLoginRole } from '../migrate';
import { makeDb, type DbHandle } from '../index';
import { withRoleDdlLock } from '../test-support';

describe('appRolePassword (fail-closed default)', () => {
  it('throws for an empty env (unset NODE_ENV now fails closed)', () => {
    expect(() => appRolePassword({})).toThrow(/APP_DB_PASSWORD/);
  });

  it('returns app under NODE_ENV=test', () => {
    expect(appRolePassword({ NODE_ENV: 'test' })).toBe('app');
  });

  it('returns app under NODE_ENV=development', () => {
    expect(appRolePassword({ NODE_ENV: 'development' })).toBe('app');
  });

  it('returns app under the explicit ALLOW_INSECURE_APP_DB_PASSWORD escape hatch', () => {
    expect(appRolePassword({ ALLOW_INSECURE_APP_DB_PASSWORD: 'true' })).toBe('app');
  });

  it('refuses the insecure escape hatch in production (parity with)', () => {
    expect(() =>
      appRolePassword({ ALLOW_INSECURE_APP_DB_PASSWORD: 'true', NODE_ENV: 'production' }),
    ).toThrow(/must never be set in production/);
  });

  it('throws under NODE_ENV=production with no APP_DB_PASSWORD', () => {
    expect(() => appRolePassword({ NODE_ENV: 'production' })).toThrow(/APP_DB_PASSWORD/);
  });

  it('throws under NODE_ENV=staging with no APP_DB_PASSWORD', () => {
    expect(() => appRolePassword({ NODE_ENV: 'staging' })).toThrow(/APP_DB_PASSWORD/);
  });

  it('returns the explicit APP_DB_PASSWORD in a deployed env', () => {
    expect(appRolePassword({ NODE_ENV: 'production', APP_DB_PASSWORD: 's3cret' })).toBe('s3cret');
  });

  it('honours APP_DB_PASSWORD even when NODE_ENV is undefined', () => {
    expect(appRolePassword({ APP_DB_PASSWORD: 'x' })).toBe('x');
  });
});

// Throwaway roles carry a fixed prefix and hold no grants, so a plain DROP ROLE IF EXISTS self-heals
// setup and teardown even if a prior broken run leaked one. itest85_pwned is the injection canary.
const ROLE_QUOTE = 'itest85_quote';
const ROLE_INJ = 'itest85_inj';
const ROLE_PWNED = 'itest85_pwned';
const ROLE_NASTY = 'itest85_nasty';
const THROWAWAY_ROLES = [ROLE_QUOTE, ROLE_INJ, ROLE_PWNED, ROLE_NASTY] as const;

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

let admin: DbHandle;

async function dropThrowawayRoles(): Promise<void> {
  // One shared advisory lock serializes this role/DB-ACL DDL against runtime-role.test.ts.
  await withRoleDdlLock(admin.sql, async (tx) => {
    for (const role of THROWAWAY_ROLES) {
      // Constant, prefixed names (never user input) — unsafe interpolation is fine here.
      const [exists] = await tx`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
      if (!exists) continue;
      // A database CONNECT grant is a dependency that blocks DROP ROLE. DROP OWNED revokes the
      // role's privileges (incl. shared-object grants like the database) and drops its owned objects.
      await tx.unsafe(`DROP OWNED BY ${role}`);
      await tx.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });
}

describe('createLoginRole (escaped, idempotent role creation)', () => {
  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    await dropThrowawayRoles();
  }, 30_000);

  // Bound the leak window: a mid-suite crash must not leave a LOGIN role alive past one test.
  // Per-test connections (e.g. the ROLE_NASTY conn) are closed inside their own test body/finally
  // before this runs, so the DROP ROLE cannot block on an open session.
  afterEach(async () => {
    if (admin) await dropThrowawayRoles();
  });

  afterAll(async () => {
    if (admin) {
      await dropThrowawayRoles();
      await admin.close();
    }
  });

  it('creates a LOGIN role whose quote-bearing password round-trips and authenticates', async () => {
    // Both a single-quote (breaks a DSN and a naive '...' literal) and $$ (closes a dollar-quoted
    // DO body early). Proves quote_literal escaping survives AND the role can actually log in.
    const nasty = "O'Br$$ien#1";
    // PUBLIC may lack CONNECT if a prior migration revoked it; grant explicitly so login is testable.
    // Locked + committed together so the role is visible to the connection opened right after.
    await withRoleDdlLock(admin.sql, async (tx) => {
      await createLoginRole(tx, ROLE_NASTY, nasty);
      await tx.unsafe(`GRANT CONNECT ON DATABASE sre_platform TO ${ROLE_NASTY}`);
    });
    // Host:port from the admin DSN so this works against any DB (Testcontainers uses a random port).
    const conn = makeDb(
      `postgres://${ROLE_NASTY}:${encodeURIComponent(nasty)}@${new URL(ADMIN_URL).host}/sre_platform`,
    );
    try {
      const rows = await conn.sql<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await conn.close();
    }
  });

  it('does NOT execute an injected CREATE ROLE embedded in the password (the money test)', async () => {
    await expect(
      withRoleDdlLock(admin.sql, (tx) =>
        createLoginRole(tx, ROLE_INJ, "x'; CREATE ROLE itest85_pwned; --"),
      ),
    ).resolves.toBeUndefined();
    // If escaping were broken, the injected CREATE ROLE would have run. It must not exist.
    const pwned = await admin.sql`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE_PWNED}`;
    expect(pwned).toHaveLength(0);
    // The intended role is still created, proving the payload landed as a literal password.
    const inj = await admin.sql`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE_INJ} AND rolcanlogin`;
    expect(inj).toHaveLength(1);
  });

  it('is idempotent: a second call with the same role+password does not throw', async () => {
    await expect(
      withRoleDdlLock(admin.sql, (tx) => createLoginRole(tx, ROLE_QUOTE, "O'Brien#1")),
    ).resolves.toBeUndefined();
    await expect(
      withRoleDdlLock(admin.sql, (tx) => createLoginRole(tx, ROLE_QUOTE, "O'Brien#1")),
    ).resolves.toBeUndefined();
  });
});
