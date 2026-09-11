// Live-infra test (mirrors knowledge-repo.test.ts's two-DSN setup): the admin DSN connects as the
// superuser role (sre), the app DSN as the plain non-superuser (app_user). probeRuntimeRole reports
// what the runtime is actually running as; assertRuntimeRoleScoped is the startup guard that refuses
// a super/bypass-RLS role when enforce=true and warns-instead-of-throws when enforce=false.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeDb, type DbHandle } from '../client';
import {
  probeRuntimeRole,
  assertRuntimeRoleScoped,
  shouldEnforceRuntimeRole,
} from '../runtime-role';
import { withRoleDdlLock } from '../test-support';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let bypass: DbHandle;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  // Non-super BYPASSRLS role: the other half of the guard (a role that is not a superuser but still
  // bypasses every policy). Created idempotently via the admin (superuser) connection. REVOKE before
  // DROP: the CONNECT grant is a dependency that DROP ROLE alone refuses to remove.
  // Random per-run password: a hard-kill between CREATE and afterAll would otherwise leave a
  // BYPASSRLS role with a well-known password reachable on a long-lived dev DB (randomUUID is
  // hex+hyphens, safe to interpolate; CREATE ROLE cannot bind a password as a parameter).
  // withRoleDdlLock serializes this role/DB-ACL DDL against migrate-role.test.ts; it commits,
  // so app_bypass is visible to the bypass connection opened right after.
  const bypassPw = randomUUID();
  await withRoleDdlLock(admin.sql, async (tx) => {
    await tx`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_bypass') THEN
        REVOKE ALL ON DATABASE sre_platform FROM app_bypass;
        DROP ROLE app_bypass;
      END IF;
    END $$;`;
    await tx.unsafe(`CREATE ROLE app_bypass LOGIN PASSWORD '${bypassPw}' NOSUPERUSER BYPASSRLS`);
    await tx`GRANT CONNECT ON DATABASE sre_platform TO app_bypass`;
  });
  // Derive host:port from the admin DSN so this works against any DB (Testcontainers picks a random
  // host port); only the role/password differ.
  bypass = makeDb(`postgres://app_bypass:${bypassPw}@${new URL(ADMIN_URL).host}/sre_platform`);
}, 30_000);

afterAll(async () => {
  // Close the pool before dropping the role: a role cannot be dropped while it owns a live backend.
  if (bypass) await bypass.close();
  if (admin) {
    try {
      // Revoke the CONNECT grant first, else DROP ROLE fails on the dependency. Same shared lock.
      await withRoleDdlLock(admin.sql, async (tx) => {
        await tx`REVOKE ALL ON DATABASE sre_platform FROM app_bypass`;
        await tx`DROP ROLE IF EXISTS app_bypass`;
      });
    } finally {
      await admin.close();
    }
  }
  if (app) await app.close();
});

describe('probeRuntimeRole', () => {
  it('reports the admin DSN as a superuser', async () => {
    const probe = await probeRuntimeRole(admin.sql);
    expect(probe.isSuper).toBe(true);
  });

  it('reports the app DSN as a non-superuser without bypassrls', async () => {
    const probe = await probeRuntimeRole(app.sql);
    expect(probe.isSuper).toBe(false);
    expect(probe.bypassRls).toBe(false);
  });

  it('reports the app_bypass DSN as a non-superuser WITH bypassrls', async () => {
    const probe = await probeRuntimeRole(bypass.sql);
    expect(probe.isSuper).toBe(false);
    expect(probe.bypassRls).toBe(true);
  });
});

describe('assertRuntimeRoleScoped', () => {
  it('rejects the superuser role when enforce=true', async () => {
    await expect(assertRuntimeRoleScoped(admin, { enforce: true })).rejects.toThrow();
  });

  it('resolves for the app_user role when enforce=true', async () => {
    await expect(assertRuntimeRoleScoped(app, { enforce: true })).resolves.toBeUndefined();
    // Criterion-3: the clean path proceeds silently (no warn on a properly scoped role).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await assertRuntimeRoleScoped(app, { enforce: true });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects the non-super BYPASSRLS role when enforce=true', async () => {
    await expect(assertRuntimeRoleScoped(bypass, { enforce: true })).rejects.toThrow(/BYPASSRLS/);
  });

  it('warns instead of throwing for the superuser role when enforce=false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(assertRuntimeRoleScoped(admin, { enforce: false })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// Pure decision, no live DB: the fail-closed truth table for the enforcement opt-out.
describe('shouldEnforceRuntimeRole', () => {
  it('enforces when nothing is set (fail-closed, unset NODE_ENV)', () => {
    expect(shouldEnforceRuntimeRole({})).toBe(true);
  });

  it('still enforces under NODE_ENV=test (the carve-out is gone)', () => {
    expect(shouldEnforceRuntimeRole({ NODE_ENV: 'test' })).toBe(true);
  });

  it('enforces under NODE_ENV=production', () => {
    expect(shouldEnforceRuntimeRole({ NODE_ENV: 'production' })).toBe(true);
  });

  it('disarms only on the exact string ALLOW_SUPERUSER_APP_DB=true', () => {
    expect(shouldEnforceRuntimeRole({ ALLOW_SUPERUSER_APP_DB: 'true' })).toBe(false);
  });

  it('ignores a non-exact opt-out value (fail-closed)', () => {
    expect(shouldEnforceRuntimeRole({ ALLOW_SUPERUSER_APP_DB: 'TRUE' })).toBe(true);
  });

  it('throws if the opt-out is set in production', () => {
    expect(() =>
      shouldEnforceRuntimeRole({ ALLOW_SUPERUSER_APP_DB: 'true', NODE_ENV: 'production' }),
    ).toThrow(/must never be set in production/);
  });
});
