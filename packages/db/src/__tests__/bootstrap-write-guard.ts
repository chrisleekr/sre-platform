import { randomUUID } from 'node:crypto';
import { runBootstrap, type BootstrapReport } from '../bootstrap';
import { makeDb, type DbHandle } from '../client';

type Discovery = (issuer: string) => Promise<unknown>;

const APPLICATION_NAME_PREFIX = 'sre-bootstrap-zero-write-guard-';
const REJECTION_MESSAGE = 'bootstrap tenant write guard rejected insert';

function databaseUrlWithApplicationName(databaseUrl: string, applicationName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

async function installGuard(admin: DbHandle): Promise<void> {
  await admin.sql`
    create or replace function sre_test_reject_bootstrap_tenant_write()
    returns trigger
    language plpgsql
    as $guard$
    begin
      if current_setting('application_name', true) like 'sre-bootstrap-zero-write-guard-%' then
        raise exception 'bootstrap tenant write guard rejected insert into %', tg_table_name;
      end if;
      return new;
    end
    $guard$
  `;
  await admin.sql`
    create trigger sre_test_reject_bootstrap_tenant_insert
    before insert on tenants
    for each row execute function sre_test_reject_bootstrap_tenant_write()
  `;
  await admin.sql`
    create trigger sre_test_reject_bootstrap_membership_insert
    before insert on memberships
    for each row execute function sre_test_reject_bootstrap_tenant_write()
  `;
}

async function removeGuard(admin: DbHandle): Promise<void> {
  await admin.sql`drop trigger if exists sre_test_reject_bootstrap_tenant_insert on tenants`;
  await admin.sql`drop trigger if exists sre_test_reject_bootstrap_membership_insert on memberships`;
  await admin.sql`drop function if exists sre_test_reject_bootstrap_tenant_write()`;
}

async function proveGuardRejects(databaseUrl: string, table: 'tenants' | 'memberships') {
  const probe = makeDb(databaseUrl);
  try {
    let message = '';
    try {
      if (table === 'tenants') {
        await probe.sql`
          insert into tenants (id, name, slug)
          values (${randomUUID()}, 'guard probe', ${`guard-probe-${randomUUID()}`})
        `;
      } else {
        await probe.sql`
          insert into memberships (user_id, tenant_id)
          values (${randomUUID()}, ${randomUUID()})
        `;
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message.includes(REJECTION_MESSAGE)) {
      throw new Error(
        `tenant write guard was not active for ${table}: ${message || 'insert succeeded'}`,
      );
    }
  } finally {
    await probe.close();
  }
}

/**
 * Counts marker-owned tenants and memberships for diagnostic assertions.
 *
 * @param admin - Administrative test connection used for the query.
 * @param marker - Unique bootstrap fixture marker.
 */
export async function markerTenantState(
  admin: DbHandle,
  marker: string,
): Promise<{ tenants: number; memberships: number }> {
  const pattern = `%${marker}%`;
  const [counts] = await admin.sql<Array<{ tenants: number; memberships: number }>>`
    select
      (select count(*)::int from tenants where name like ${pattern}) as tenants,
      (select count(*)::int from memberships where user_id in (
        select id from users
        where issuer like ${pattern} or subject like ${pattern} or coalesce(email, '') like ${pattern}
      )) as memberships
  `;
  if (!counts) throw new Error('tenant count query returned no row');
  return counts;
}

/**
 * Runs bootstrap through a uniquely named connection whose tenant and membership inserts are rejected.
 *
 * @param admin - Administrative test connection used to manage temporary triggers.
 * @param databaseUrl - Disposable test database URL.
 * @param env - Valid bootstrap declaration.
 * @param discover - Isolated discovery loader.
 */
export async function runBootstrapRejectingTenantWrites(
  admin: DbHandle,
  databaseUrl: string,
  env: Record<string, string | undefined>,
  discover: Discovery,
): Promise<BootstrapReport> {
  const applicationName = `${APPLICATION_NAME_PREFIX}${randomUUID()}`;
  const guardedUrl = databaseUrlWithApplicationName(databaseUrl, applicationName);
  await installGuard(admin);
  try {
    const saved = process.env.DATABASE_URL;
    let run: Promise<BootstrapReport>;
    try {
      process.env.DATABASE_URL = guardedUrl;
      run = runBootstrap(env, discover);
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
    const report = await run;
    await proveGuardRejects(guardedUrl, 'tenants');
    await proveGuardRejects(guardedUrl, 'memberships');
    return report;
  } finally {
    await removeGuard(admin);
  }
}
