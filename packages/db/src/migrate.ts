import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { adminUrl } from './env';

const APP_ROLE = 'app_user';

/**
 * Provides app role password.
 *
 * @param env - Environment values used to derive the configuration.
 */

export function appRolePassword(env: NodeJS.ProcessEnv = process.env): string {
  const pw = env.APP_DB_PASSWORD;
  if (pw) return pw;
  // The insecure-default opt-out is refused in production so a leaked flag cannot seat the weak
  // 'app' credential on a prod host (parity with shouldEnforceRuntimeRole).
  if (env.ALLOW_INSECURE_APP_DB_PASSWORD === 'true' && env.NODE_ENV === 'production') {
    throw new Error('ALLOW_INSECURE_APP_DB_PASSWORD must never be set in production');
  }
  // No explicit password: the only remaining value is the insecure 'app' default. Allow it
  // strictly for local dev / tests, NEVER by a merely-absent NODE_ENV (a deployed host that
  // forgets NODE_ENV must not silently get the weak credential). Fail-closed, matching.
  const localAllowed =
    env.NODE_ENV === 'test' ||
    env.NODE_ENV === 'development' ||
    env.ALLOW_INSECURE_APP_DB_PASSWORD === 'true';
  if (!localAllowed) {
    throw new Error(
      `APP_DB_PASSWORD must be set (NODE_ENV=${env.NODE_ENV ?? 'unset'}); the insecure 'app' default is allowed only for NODE_ENV=test|development or ALLOW_INSECURE_APP_DB_PASSWORD=true`,
    );
  }
  return 'app';
}

// Injection-safe LOGIN role upsert. quote_ident/quote_literal bind role/password as parameters
// then return escaped tokens; only those tokens are interpolated. Running top-level statements
// (not a DO $$ ... $$ body) matters: a password containing `$$` closes a dollar-quoted body early
// (quote_literal doubles single-quotes but does NOT escape `$`), so the DO form breaks provisioning.
// A top-level `'...'` literal treats `$$` as plain data (no dollar-quote scanning), closing that
// breakout. Existence check runs in JS on the single max:1 migration connection (no TOCTOU). It is
// an upsert so a rotated APP_DB_PASSWORD applies on re-migrate (config is the source of truth).
/**
 * Creates login role.
 *
 * @param client - Value supplied for client.
 * @param role - Value supplied for role.
 * @param password - Value supplied for password.
 */
export async function createLoginRole(client: Sql, role: string, password: string): Promise<void> {
  const [esc] = await client<{ ident: string; pwlit: string }[]>`
    SELECT quote_ident(${role}) AS ident, quote_literal(${password}) AS pwlit`;
  if (!esc) throw new Error('createLoginRole: failed to escape role identifiers');
  const [exists] = await client<
    { one: number }[]
  >`SELECT 1 AS one FROM pg_roles WHERE rolname = ${role}`;
  if (exists) {
    // Honor a rotated password on re-run (config is the source of truth).
    await client.unsafe(`ALTER ROLE ${esc.ident} LOGIN PASSWORD ${esc.pwlit}`);
    return;
  }
  await client.unsafe(`CREATE ROLE ${esc.ident} LOGIN PASSWORD ${esc.pwlit}`);
}
/**
 * Tables that carry tenant_id but deliberately do NOT enforce RLS.
 * `jobs`: the worker dispatches across tenants.
 * `surface_inbound_events`: system-only intake persists receipts before tenant resolution, and the
 * app role has no access to it.
 * `memberships`, `tenant_identity_bindings`, `workspace_foundings`, `tenant_invitations`:
 * control-plane tables read before any tenant context exists. A binding resolves the tenant, a
 * founding creates one, and an invitation is matched before the invited user has a membership.
 * `notifications`: recipient-scoped inbox rows are read by user before and outside tenant context.
 * `impersonation_sessions`: platform audit of a target tenant, read only after administrator auth.
 */
const NON_RLS_TENANT_TABLES = [
  'jobs',
  'impersonation_sessions',
  'memberships',
  'notifications',
  'surface_inbound_events',
  'tenant_identity_bindings',
  'tenant_invitations',
  'workspace_foundings',
];

/**
 * Ordinary ('r') and partitioned ('p') tables. Both can carry tenant_id and both honour RLS, but they
 * are DIFFERENT relkinds: filtering on 'r' alone would make a partitioned table invisible to both the
 * FORCE pass and the coverage assertion at once, i.e. the day someone partitions a hot table it would
 * silently lose owner-side RLS with a green CI. https://www.postgresql.org/docs/17/catalog-pg-class.html
 */
const TABLE_RELKINDS = ['r', 'p'];

/**
 * The one tenant_isolation clause from schema/rls.ts, as Postgres re-renders it from the parse tree.
 * The guard pins the policy body to this EXACTLY rather than pattern-matching it: a substring test for
 * `app.tenant_id` would happily pass `USING (tenant_id = ... OR current_setting('app.support') = 'on')`
 * — a clause that mentions the GUC and still hands over every tenant's rows.
 *
 * Coupled to the deparsed form on purpose. If a Postgres upgrade ever renders it differently the
 * migration ABORTS (fail closed, loud, one-line fix here) rather than silently stopping checking.
 */
const TENANT_CLAUSE =
  "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";

/**
 * FORCE ROW LEVEL SECURITY on every table whose policies drizzle-kit just created. drizzle-kit emits
 * ENABLE (implied by declaring a policy) but has no FORCE, and the migration role OWNS these tables:
 * an owner bypasses a merely-ENABLEd policy, so without this RLS would not bind at all for anything
 * connecting as the owner. Catalog-driven (relrowsecurity AND NOT relforcerowsecurity) so it can never
 * drift from what the schema actually declared.
 */
async function forceRls(client: Sql): Promise<void> {
  // Catalogs are pg_catalog-qualified throughout: pg_catalog is only searched implicitly when it is not
  // named in search_path, so a caller with `search_path = evil, pg_catalog` could otherwise resolve
  // pg_class to a fake view that reports full coverage.
  const rows = await client<{ ident: string }[]>`
    SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS ident
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = ANY(${TABLE_RELKINDS})
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity`;
  for (const { ident } of rows) {
    // Schema-qualified: an unqualified name is re-resolved through search_path ("$user", public), so a
    // schema named after the connecting role could shadow the public table and send FORCE to the wrong
    // relation, leaving the real one unforced. quote_ident comes back from Postgres already escaped.
    await client.unsafe(`ALTER TABLE ${ident} FORCE ROW LEVEL SECURITY`);
  }
}

/**
 * Asserts that rls coverage.
 *
 * @param client - Value supplied for client.
 */
export async function assertRlsCoverage(client: Sql): Promise<void> {
  const rows = await client<{ table_name: string; reason: string }[]>`
    SELECT c.relname AS table_name,
           CASE
             WHEN NOT c.relrowsecurity THEN 'RLS not enabled'
             WHEN NOT c.relforcerowsecurity THEN 'RLS not FORCEd (owner bypasses it)'
             WHEN p.polname IS NULL THEN 'no tenant_isolation policy'
             WHEN EXISTS (
               SELECT 1 FROM pg_catalog.pg_policy x
               WHERE x.polrelid = c.oid AND x.polpermissive AND x.polname <> 'tenant_isolation')
               THEN 'an extra PERMISSIVE policy widens access (permissive policies are OR-ed)'
             WHEN p.polqual IS NULL OR p.polwithcheck IS NULL
               THEN 'tenant_isolation is missing its USING or WITH CHECK clause'
             ELSE 'tenant_isolation is not PERMISSIVE/FOR ALL, or its clause is not the canonical '
                  || 'tenant clause (USING and WITH CHECK must both be exactly it)'
           END AS reason
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
    WHERE n.nspname = 'public'
      AND c.relkind = ANY(${TABLE_RELKINDS})
      AND NOT (c.relname = ANY(${NON_RLS_TENANT_TABLES}))
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'tenant_id'
          AND a.attnum > 0
          AND NOT a.attisdropped)
      AND NOT COALESCE(
        c.relrowsecurity
        AND c.relforcerowsecurity
        AND p.polname IS NOT NULL
        AND p.polpermissive
        AND p.polcmd = '*'
        AND p.polqual IS NOT NULL
        AND p.polwithcheck IS NOT NULL
        AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = ${TENANT_CLAUSE}
        AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = ${TENANT_CLAUSE}
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_policy x
          WHERE x.polrelid = c.oid AND x.polpermissive AND x.polname <> 'tenant_isolation'),
        false)`;
  if (rows.length > 0) {
    const detail = rows.map((r) => `${r.table_name} (${r.reason})`).join(', ');
    throw new Error(`RLS coverage gap: ${detail}`);
  }
}

/**
 * Runs migrations.
 *
 * @param url - Value supplied for url.
 */
export async function runMigrations(url: string = adminUrl()): Promise<void> {
  const client = postgres(url, { max: 1 });
  try {
    const db = drizzle(client);
    const here = dirname(fileURLToPath(import.meta.url));

    // The order is the invariant. pgvector must exist before the migration's vector() column DDL.
    // Remove inherited app grants before new tables commit, then publish the final grants atomically.
    await client.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await createLoginRole(client, APP_ROLE, appRolePassword());
    await client.unsafe(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${APP_ROLE};
    `);
    await migrate(db, { migrationsFolder: join(here, '..', 'migrations') });

    await client.begin(async (tx) => {
      await tx.unsafe(`
        GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
        REVOKE ALL ON TABLE public.platform_operators FROM ${APP_ROLE};
        GRANT SELECT ON TABLE public.platform_operators TO ${APP_ROLE};
        REVOKE UPDATE, DELETE ON TABLE public.admin_actions FROM ${APP_ROLE};
        REVOKE INSERT, UPDATE, DELETE ON TABLE public.impersonation_sessions FROM ${APP_ROLE};
        REVOKE INSERT, UPDATE, DELETE ON TABLE public.platform_admin_invitations FROM ${APP_ROLE};
        GRANT UPDATE (accepted_at, accepted_user_id)
          ON TABLE public.platform_admin_invitations TO ${APP_ROLE};
        REVOKE INSERT, UPDATE, DELETE ON TABLE public.identity_providers FROM ${APP_ROLE};
        REVOKE ALL ON TABLE public.platform_settings FROM ${APP_ROLE};
        REVOKE ALL ON TABLE public.platform_secrets FROM ${APP_ROLE};
        REVOKE ALL ON TABLE public.oidc_attempts, public.mailbox_proofs FROM ${APP_ROLE};
        REVOKE INSERT, UPDATE, DELETE ON TABLE public.browser_sessions FROM ${APP_ROLE};
        REVOKE ALL ON TABLE public.surface_inbound_events FROM ${APP_ROLE};
      `);
    });
    await forceRls(client);
    await assertRlsCoverage(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  runMigrations()
    .then(() => {
      console.log('migrations + RLS applied');
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
