import type { Sql } from 'postgres';

// Startup guard for the RLS invariant. Postgres bypasses ALL row-level security for a
// role that is a superuser or carries BYPASSRLS, even under `FORCE ROW LEVEL SECURITY`. So if the
// app's runtime connection ever runs as such a role, every tenant policy is silently void and the
// isolation guarantee is a lie. This module probes the live role and refuses to boot on that role.

export interface RuntimeRole {
  role: string;
  isSuper: boolean;
  bypassRls: boolean;
}

// Fail-closed: enforce unless the operator explicitly opts out for local dev via
// ALLOW_SUPERUSER_APP_DB=true. The opt-out is refused in production so a leaked env var
// cannot silently disarm RLS on a prod host. NODE_ENV is only consulted to refuse the
// opt-out in prod, never to disable enforcement.
/**
 * Checks whether runtime database role enforcement is enabled.
 *
 * @param env - Environment values used to derive the configuration.
 */
export function shouldEnforceRuntimeRole(env: NodeJS.ProcessEnv): boolean {
  const override = env.ALLOW_SUPERUSER_APP_DB === 'true';
  if (override && env.NODE_ENV === 'production') {
    throw new Error('ALLOW_SUPERUSER_APP_DB must never be set in production');
  }
  return !override;
}

// The probe is point-in-time at boot; post-boot `ALTER ROLE`/`SET ROLE` are out of scope, so
// role attributes should be managed as code.
/**
 * Reads the effective database role and RLS bypass capability.
 *
 * @param sql - Value supplied for sql.
 */
export async function probeRuntimeRole(sql: Sql): Promise<RuntimeRole> {
  const rows = await sql<
    { role: string; is_super: boolean; rolbypassrls: boolean }[]
  >`select current_user as role, current_setting('is_superuser')::bool as is_super, rolbypassrls from pg_roles where rolname = current_user`;
  const row = rows[0];
  // pg_roles always has the current_user row; a miss means a broken connection, so fail loud.
  if (!row) throw new Error('probeRuntimeRole: current_user not found in pg_roles');
  return { role: row.role, isSuper: row.is_super, bypassRls: row.rolbypassrls };
}

/**
 * Asserts that the runtime database role cannot bypass tenant RLS.
 *
 * @param handle - Value supplied for handle.
 * @param opts - Optional query or behavior controls.
 */
export async function assertRuntimeRoleScoped(
  handle: { sql: Sql },
  opts: { enforce: boolean },
): Promise<void> {
  const probe = await probeRuntimeRole(handle.sql);
  if (!probe.isSuper && !probe.bypassRls) return;

  const flag = probe.isSuper ? 'is a superuser' : 'has BYPASSRLS';
  const msg = `runtime role "${probe.role}" ${flag}; it bypasses row-level security and voids tenant isolation. Set APP_DATABASE_URL to the non-superuser app_user role.`;
  if (opts.enforce) throw new Error(msg);
  console.warn(`[db] ${msg}`);
}
